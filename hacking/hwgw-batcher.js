/**
 * hwgw-batcher.js — HWGW Batch Orchestrator
 *
 * This is the brain of the batching system. It continuously schedules
 * W1 → H → W2 → G operation sequences ("batches") against a single
 * target server, timed so each operation lands 50ms apart in the
 * correct order. Multiple batches run simultaneously, each offset by
 * a fixed period, forming a pipeline that keeps RAM fully utilised.
 *
 * Designed to work across all BitNodes by reading live multipliers
 * from alainbryden's helpers.js rather than hardcoding constants.
 *
 * Usage:
 *   run hwgw-batcher.js <target> [--reserve <GB>] [--period <ms>]
 *                                 [--delta <ms>] [--hack-percent <0-1>]
 *                                 [--quiet]
 *
 * Args:
 *   target          The server to hack. Must already be rooted.
 *   --reserve       GB of home RAM to leave free (default: 32)
 *                   Do NOT use reserve.txt for this — that file stores dollar
 *                   amounts for stockmaster, not GB of RAM.
 *   --period        ms between consecutive batch starts (default: 200, must be >= 4×delta)
 *   --delta         ms between operations within a batch (default: 50)
 *   --hack-percent  Fraction of max money to steal per batch (default: 0.25)
 *   --quiet         Suppress terminal output, log to tail window only
 *
 * Port conventions (shared with workers):
 *   Port 1 — Worker completions: "ROLE:batchId:result"
 *   Port 2 — Prep signals:       "PREP_DONE:target" or "PREP_FAILED:target:reason"
 *
 * No helpers.js import — BN multipliers are read directly from daemon.js's cache
 * file via ns.read() (free), saving the 1.1 GB that helpers.js import plumbing costs.
 * See readBnMults() at the bottom of this file.
 */

// No imports needed — self-contained by design.

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// These come from the game's source code and don't change between versions.
// ─────────────────────────────────────────────────────────────────────────────

// Duration ratios relative to weaken time. These are fixed by the game engine
// and hold true in every BitNode — only the absolute weaken time changes.
const HACK_TIME_RATIO   = 0.25; // hack()   takes 25% as long as weaken()
const GROW_TIME_RATIO   = 0.80; // grow()   takes 80% as long as weaken()

// Security impact per thread. These are also fixed constants in the game source.
const WEAKEN_SECURITY_PER_THREAD = 0.05;  // Before ServerWeakenRate BN multiplier
const GROW_SECURITY_PER_THREAD   = 0.004;
const HACK_SECURITY_PER_THREAD   = 0.002;

// Port numbers — must match the workers
const WORKER_PORT = 1; // W1, H, W2, G completion reports
const PREP_PORT   = 2; // Prep done/failed signals

// Home server RAM policy — mirrors hwgw-prep.js.
// Only pull home into the exec pool when it has >1 TB of RAM installed,
// and even then always leave that first 1 TB completely untouched.
// World servers are always preferred (home is sorted last in getWorkerHosts).
const HOME_RAM_THRESHOLD = 1024; // GB — home excluded from pool below this
const HOME_RAM_RESERVE   = 1024; // GB — floor reserve on home (above --reserve)

// Script paths — resolved from /script-paths.json at startup.
// Falls back to bare filenames if the JSON doesn't exist (standalone mode).
// Uses ns.read() only (0 GB) so this adds no RAM overhead.
let SCRIPTS = null;
// RAM costs cached after resolveScripts() — never call getScriptRam() in hot paths.
// launchWorker() runs 4× per batch scheduled (potentially thousands of times per minute)
// and calculateBatchParams() runs once per prep cycle. Both use these constants.
let SCRIPT_RAM = { hack: 0, grow: 0, weaken: 0 };

function resolveScripts(ns) {
    if (SCRIPTS) return SCRIPTS;
    let paths = {};
    try {
        const raw = ns.read('/script-paths.json');
        if (raw && raw !== '') paths = JSON.parse(raw);
    } catch {}
    SCRIPTS = {
        weaken: paths['hwgw-weaken'] ?? "hacking/hwgw-weaken.js",
        hack:   paths['hwgw-hack']   ?? "hacking/hwgw-hack.js",
        grow:   paths['hwgw-grow']   ?? "hacking/hwgw-grow.js",
        prep:   paths['hwgw-prep']   ?? "hacking/hwgw-prep.js",
    };
    // Cache RAM once — these values never change at runtime
    SCRIPT_RAM.hack   = ns.getScriptRam(SCRIPTS.hack,   "home") || 0;
    SCRIPT_RAM.grow   = ns.getScriptRam(SCRIPTS.grow,   "home") || 0;
    SCRIPT_RAM.weaken = ns.getScriptRam(SCRIPTS.weaken, "home") || 0;
    return SCRIPTS;
}

// Module-level hackPct cache — populated once before the first calculateBatchParams call.
// Eliminates the need for ns.hackAnalyze (1.0 GB) in the batcher's static RAM cost.
let _hackPctCache = 0;

/**
 * Fetch hackAnalyze(target) at zero static RAM cost.
 * Priority: (1) manager's HACK_GATHER cache file, (2) fire-and-forget temp script.
 * The result is cached in _hackPctCache so the temp script only runs once per session.
 */
async function fetchHackPct(ns, target) {
    // Try manager's hackdata cache first (written every 5 min, covers all targets)
    try {
        const raw = ns.read('/Temp/hackdata-cache.txt');
        if (raw && raw !== '') {
            const hd = JSON.parse(raw)[target];
            if (hd && hd.hackPct > 0) { _hackPctCache = hd.hackPct; return _hackPctCache; }
        }
    } catch {}
    // Cache miss — write and exec a one-shot temp that calls ns.hackAnalyze
    // The temp script bears the 1.0 GB RAM cost only for its brief lifetime.
    ns.write('/Temp/hwgw-hackpct-once.js', [
        'export async function main(ns) {',
        '  const pct = ns.hackAnalyze(ns.args[0]);',
        '  ns.write("/Temp/hwgw-hackpct.txt", String(pct), "w");',
        '}',
    ].join('\n'), 'w');
    const pid = ns.exec('/Temp/hwgw-hackpct-once.js', 'home', 1, target);
    if (pid) {
        const dl = Date.now() + 5000;
        while (ns.isRunning(pid) && Date.now() < dl) await ns.sleep(50);
        try { _hackPctCache = parseFloat(ns.read('/Temp/hwgw-hackpct.txt')) || 0; } catch {}
    }
    return _hackPctCache;
}

// How many consecutive anomalous batch results trigger a desync recovery.
// Lower = more sensitive (more false positives). Higher = slower to recover.
const DESYNC_THRESHOLD = 3;

// Hard cap on concurrent batches per target regardless of available RAM.
// With PB-scale RAM, timingSlots can be 1500+ for long-weaken targets.
// Launching all of them in one tight loop means thousands of ns.exec()
// calls — by the time the last batch is scheduled, the first workers have
// already fired, making all the calculated delays stale. This causes an
// immediate desync cascade on the very first wave.
// 200 concurrent batches is more than enough to saturate income on any
// target: at period=200ms that covers 40 seconds of pipeline depth, far
// exceeding the weaken time of any profitable server.
const MAX_BATCHES_PER_TARGET = 200;

// ─────────────────────────────────────────────────────────────────────────────
// STOCK MARKET MANIPULATION
// When stockmaster.js is running and holds positions, HWGW can amplify profits
// by passing {stock: true} to hack/grow. This influences the stock's second-
// order forecast: hack pushes price down (good for shorts), grow pushes up
// (good for longs). Without this flag, hack/grow have ZERO stock effect.
// ─────────────────────────────────────────────────────────────────────────────

// Static map: server hostname → stock ticker symbol (from game source)
const SERVER_STOCK_SYMBOLS = {
    "foodnstuff": "FNS", "sigma-cosmetics": "SGC", "omega-net": "OMGA", "comptek": "CTK",
    "netlink": "NTLK", "syscore": "SYSC", "catalyst": "CTYS", "lexo-corp": "LXO",
    "alpha-ent": "APHE", "rho-construction": "RHOC", "aerocorp": "AERO", "global-pharm": "GPH",
    "omnia": "OMN", "defcomm": "DCOMM", "solaris": "SLRS", "icarus": "ICRS",
    "univ-energy": "UNV", "nova-med": "NVMD", "titan-labs": "TITN", "microdyne": "MDYN",
    "stormtech": "STM", "helios": "HLS", "vitalife": "VITA", "fulcrumtech": "FLCM",
    "4sigma": "FSIG", "kuai-gong": "KGI", "omnitek": "OMTK", "blade": "BLD",
    "clarkinc": "CLRK", "ecorp": "ECP", "megacorp": "MGCP", "fulcrumassets": "FLCM",
};

/**
 * Read stockmaster's probability file and determine stock manipulation flags
 * for a given target server. Returns {manipulateHack, manipulateGrow}.
 *
 * Logic (mirrors daemon.js updateStockPositions):
 *   - Own long shares → grow should manipulate (push price up)
 *   - Own short shares → hack should manipulate (push price down)
 *   - No position, prob >= 0.5 → grow manipulates (reinforce bullish trend)
 *   - No position, prob < 0.5 → hack manipulates (reinforce bearish trend)
 *
 * @param {NS} ns
 * @param {string} target — server hostname
 * @returns {{ manipulateHack: boolean, manipulateGrow: boolean }}
 */
function getStockManipulationFlags(ns, target) {
    const sym = SERVER_STOCK_SYMBOLS[target];
    if (!sym) return { manipulateHack: false, manipulateGrow: false };

    try {
        const raw = ns.read('/Temp/stock-probabilities.txt');
        if (!raw || raw === '') return { manipulateHack: false, manipulateGrow: false };
        const positions = JSON.parse(raw);
        const pos = positions[sym];
        if (!pos) return { manipulateHack: false, manipulateGrow: false };

        return {
            manipulateHack: pos.sharesShort > 0 || pos.prob < 0.5,
            manipulateGrow: pos.sharesLong > 0 || pos.prob >= 0.5,
        };
    } catch {
        return { manipulateHack: false, manipulateGrow: false };
    }
}

/** @param {NS} ns */
export async function main(ns) {
    // ── Parse arguments ───────────────────────────────────────────────────────
    const flags = ns.flags([
        ["reserve",      32],    // GB of home RAM to leave free.
                               // Do NOT read reserve.txt — that stores DOLLAR amounts, not RAM GB.
        ["period",       200],   // ms between batch starts. Must be >= 4×delta.
        ["delta",        50],    // ms between operations within a batch
        ["hack-percent", 0.25],  // fraction of max money to steal per batch
        ["quiet",        false], // suppress terminal output
    ]);

    const target      = ns.args[0];
    const period      = flags["period"];
    const delta       = flags["delta"];
    const hackPercent = flags["hack-percent"];
    const quiet       = flags["quiet"];

    // Resolve script paths from /script-paths.json (0 GB — uses ns.read only)
    resolveScripts(ns);

    if (!target) {
        ns.tprint("ERROR hwgw-batcher: no target specified.");
        ns.tprint("Usage: run hwgw-batcher.js <target> [--reserve GB] [--period ms] [--delta ms] [--hack-percent 0-1]");
        return;
    }

    // Home RAM reserve: always use the --reserve flag value (default 32 GB).
    // reserve.txt is NOT used here — it stores DOLLAR amounts for stockmaster,
    // not GB of RAM. hwgw-manager passes --reserve 32 explicitly.
    let reserveRam = flags["reserve"];
    if (reserveRam < 0) {
        // Note: reserve.txt stores DOLLAR amounts (aug purchase costs), NOT GB of RAM.
        // Reading it here would give values like 8,000,000,000 GB which breaks all
        // RAM calculations. When launched by hwgw-manager, --reserve is always set
        // explicitly (32 GB default). This fallback is only for standalone invocations.
        reserveRam = 32; // Safe default: 32 GB matches daemon.js's own default
    }

    // ── Logging helpers ───────────────────────────────────────────────────────
    const log       = (msg) => { ns.print(msg); if (!quiet) ns.tprint(msg); };
    const logAlways = (msg) => ns.print(msg);
    const logQuiet  = (msg) => ns.print(msg);

    // ── Exec host partition ───────────────────────────────────────────────────
    // If hwgw-manager is running, it writes the list of purchased servers it has
    // claimed as exclusive worker hosts to /Temp/hwgw-exec-hosts.txt. We read
    // that list here and restrict ALL worker launches and RAM calculations to
    // those hosts only. This is what enforces the partition with daemon.js.
    //
    // If the file doesn't exist (batcher launched standalone without manager),
    // execHosts is null and we fall back to using all rooted servers — the
    // original behaviour. This makes the batcher safe to run either way.
    let execHosts = null;
    try {
        // Prefer per-target slice file (written by manager's assignExecSlices).
        // This prevents multiple batchers competing for the same RAM pool,
        // which causes partial batch launches and immediate desyncs.
        // Falls back to the global file (single-target or standalone mode).
        const targetSliceRaw = ns.read(`/Temp/hwgw-exec-hosts-${target}.txt`);
        const globalRaw = ns.read('/Temp/hwgw-exec-hosts.txt');
        const raw = (targetSliceRaw && targetSliceRaw !== '') ? targetSliceRaw : globalRaw;
        if (raw && raw !== '') {
            execHosts = new Set(JSON.parse(raw));
            const src = (targetSliceRaw && targetSliceRaw !== '') ? 'target slice' : 'global list';
            logQuiet(`Worker partition active (${src}): ${execHosts.size} exec hosts.`);
        }
    } catch {
        logQuiet(`No exec hosts file found — workers will use all available servers.`);
    }
    ns.disableLog("sleep");
    ns.disableLog("exec");
    ns.disableLog("scp");
    ns.disableLog("getServerSecurityLevel");
    ns.disableLog("getServerMoneyAvailable");
    ns.disableLog("getServerMaxRam");
    ns.disableLog("getServerUsedRam");

    // ── BitNode awareness ─────────────────────────────────────────────────────
    // Read multipliers from daemon.js's cache file (free) instead of going
    // through helpers.js (which would cost 1.1 GB via ns.run + ns.isRunning).
    // getActiveSourceFiles was previously imported but never used — removed.
    const bnMults = readBnMults(ns);

    // Check whether hacking is viable at all in this BN.
    // ScriptHackMoney=0 means the server can't be hacked at all — exit.
    // ScriptHackMoneyGain=0 (BN8) means the player receives $0 but hacks still
    // drain the server and trigger stock manipulation — continue in that case.
    const hackIncomeViable = (bnMults.ScriptHackMoney ?? 1) * (bnMults.ScriptHackMoneyGain ?? 1) > 0;
    const hackViableAtAll  = (bnMults.ScriptHackMoney ?? 1) > 0;
    if (!hackViableAtAll) {
        logAlways(`INFO: Hacking is completely disabled in this BitNode. hwgw-batcher will not run.`);
        return;
    }
    if (!hackIncomeViable) {
        logAlways(`INFO: Hack income disabled this BN (ScriptHackMoneyGain=0). ` +
            `Running in stock-manipulation-only mode (effectiveHackPercent=0.002).`);
    }

    // Actual weaken per thread accounts for the BN's ServerWeakenRate multiplier.
    // In BN11, ServerWeakenRate = 2.0, so each thread removes 0.10 security
    // instead of the usual 0.05 — you need half as many weaken threads.
    const actualWeakenPerThread = WEAKEN_SECURITY_PER_THREAD * bnMults.ServerWeakenRate;

    // Check for Formulas.exe. With it, grow thread calculation is exact.
    // Without it we use a padded estimate. Since you earned SF5 from BN5,
    // you'll carry this into future bitnodes — but new players won't have it,
    // so we keep the fallback path working correctly.
    const hasFormulas = false; // Formulas path removed to save ns.getServer(2GB)+ns.getPlayer(0.5GB)

    log(`hwgw-batcher starting on target: "${target}"`);
    logQuiet(`  BitNode weaken/thread: ${actualWeakenPerThread.toFixed(4)} | Formulas: ${hasFormulas}`);
    logQuiet(`  Period: ${period}ms | Delta: ${delta}ms | HackPercent: ${(hackPercent*100).toFixed(1)}%`);
    logQuiet(`  Home RAM reserve: ${reserveRam}GB`);

    // ── State tracking ────────────────────────────────────────────────────────
    let batchId         = 0;        // Monotonically increasing, wraps at 10000
    let batchesInFlight = 0;        // How many batches are currently running
    let totalIncome     = 0;        // Cumulative money earned since start
    let anomalyCount    = 0;        // Consecutive anomalous batch results
    let startTime       = Date.now();

    // ── Main loop ─────────────────────────────────────────────────────────────
    // The outer loop handles the prep → batch cycle. Each time a desync is
    // detected (or on first start), we run prep before entering the batch loop.
    while (true) {

        // ── Step 1: Ensure server is prepped ─────────────────────────────────
        // The batch loop assumes the server is at min security + max money.
        // If it isn't, our thread calculations will be wrong and batches
        // will desync immediately. We always verify before batching.
        const prepped = await ensurePrepped(ns, target, reserveRam, log, logAlways, logQuiet);
        if (!prepped) {
            logAlways(`FATAL: Could not prep "${target}". Exiting batcher.`);
            return;
        }

        anomalyCount = 0; // Reset desync counter after a successful prep

        // ── Step 2: Calculate batch parameters ───────────────────────────────
        // All timing and thread calculations happen here, once, before we
        // enter the batch scheduling loop. We recalculate on each outer
        // loop iteration (i.e. after each prep cycle) because your hacking
        // level may have risen, changing weaken time and thread requirements.
        const hackPct = await fetchHackPct(ns, target);
        const params = calculateBatchParams(ns, target, hackPercent, delta, period,
                                            reserveRam, bnMults, hasFormulas, actualWeakenPerThread, execHosts, hackPct);

        if (!params) {
            logAlways(`ERROR: Could not calculate batch parameters for "${target}". Skipping.`);
            await ns.sleep(5000);
            continue;
        }

        logQuiet(`Batch params: W=${(params.weakenTime/1000).toFixed(1)}s | ` +
                 `threads: h${params.hackThreads}/g${params.growThreads}/w1:${params.w1Threads}/w2:${params.w2Threads} | ` +
                 `batches fitting in RAM: ~${params.maxBatches}`);

        // Write actual measured ramPerBatch so hwgw-manager can use the real value
        // instead of its overestimated static calculation in subsequent target selections.
        // The manager reads this in estimateRamPerBatch() — file expires after 10 minutes.
        try {
            ns.write(`/Temp/hwgw-rpb-${target}.txt`, JSON.stringify({
                ramPerBatch: params.ramPerBatch,
                maxBatches:  params.maxBatches,
                timestamp:   Date.now(),
            }), 'w');
        } catch { /* non-critical */ }

        // ── Step 3: Clear the worker completion port ──────────────────────────
        // Drain leftover messages for THIS target from a previous run.
        // Messages for other batchers are preserved — clearing them would
        // cause their batchesInFlight counters to leak.
        const workerPort = ns.getPortHandle(WORKER_PORT);
        {
            const keep = [];
            while (!workerPort.empty()) {
                const msg = workerPort.read();
                const parts = msg.split(":");
                const msgTarget = parts.length >= 4 ? parts[3] : target;
                if (msgTarget !== target) keep.push(msg);
                // else: discard — stale message for our target
            }
            for (const msg of keep) workerPort.tryWrite(msg);
        }

        batchesInFlight = 0;

        // ── Step 4: The batch scheduling loop ────────────────────────────────
        // We schedule batches as fast as we can until we've filled the
        // available RAM. Then we wait for completions and keep the pipeline
        // topped up. The inner logic is: schedule → wait → check for desync
        // → schedule more → repeat.
        //
        // loopStartTime anchors ALL batch delay calculations to a fixed point
        // in time. Without this, replacement batches (scheduled after earlier
        // ones complete) compute their delays relative to "now", which is a
        // full weakenTime into the future — stalling the pipeline for one
        // entire weaken cycle between each wave of batches.
        const loopStartTime = Date.now();
        let loopBatchIndex = 0;

        // nextBatchBaseTime tracks the intended base time for each upcoming batch.
        // It advances by `period` per batch and is snapped forward when it falls
        // behind the clock — which happens after the first weakenTime has elapsed.
        //
        // Without this, every replacement batch (wave 2+) gets baseTime =
        // loopStartTime + index*period which is well in the past. All four worker
        // delays clamp to 0, so W1/H/W2/G all fire at the same moment. With
        // hackTime (30s) << growTime (98s), H_{k+1} lands ~67s before G_k,
        // meaning two hacks drain the server before any grow restores it.
        // That produces the gradual drain you see despite correct grow ratios.
        let nextBatchBaseTime = loopStartTime;

        while (anomalyCount < DESYNC_THRESHOLD) {

            // Read all pending completion messages from the port.
            // Each message is "ROLE:batchId:result:target" from a finished worker.
            // With multiple batchers sharing port 1, we must filter by target
            // and put back messages intended for other batchers.
            const requeue = [];
            while (!workerPort.empty()) {
                const msg = workerPort.read();
                const parts = msg.split(":");
                // New format: ROLE:batchId:result:target (4 parts)
                // Legacy format: ROLE:batchId:result (3 parts, no target — treat as ours)
                const msgTarget = parts.length >= 4 ? parts[3] : target;
                if (msgTarget !== target) {
                    requeue.push(msg); // Not for us — put it back
                    continue;
                }
                processWorkerCompletion(ns, msg, params, logQuiet,
                                        (income) => { totalIncome += income; },
                                        () => { anomalyCount++; batchesInFlight--; },
                                        () => { anomalyCount = 0; batchesInFlight--; });
            }
            // Re-queue messages for other batchers
            for (const msg of requeue) workerPort.tryWrite(msg);

            if (anomalyCount >= DESYNC_THRESHOLD) break; // Exit to re-prep

            // Schedule new batches if we have room in RAM and haven't hit our
            // calculated maximum concurrent batches.
            while (batchesInFlight < params.maxBatches) {
                // Snap nextBatchBaseTime forward if the clock has overtaken it.
                // This happens every weakenTime (~122s for the-hub) when all
                // in-flight batches complete and replacement batches are scheduled.
                // Without snapping, baseTime = loopStartTime + index*period is
                // in the past, all delays clamp to 0, and H_{k+1} lands before
                // G_k — draining the server each cycle.
                const snapNow = Date.now();
                if (nextBatchBaseTime + params.baseDelays.w1 < snapNow) {
                    const lag       = snapNow - (nextBatchBaseTime + params.baseDelays.w1);
                    const stepsAhead = Math.ceil(lag / params.period);
                    nextBatchBaseTime += stepsAhead * params.period;
                    loopBatchIndex    += stepsAhead; // keep in sync for logging
                }

                const scheduled = scheduleBatch(ns, target, batchId, loopBatchIndex,
                                                nextBatchBaseTime, params, reserveRam, execHosts, loopStartTime, logQuiet);
                if (!scheduled) break; // Not enough RAM right now — stop trying

                nextBatchBaseTime += params.period;
                batchId = (batchId + 1) % 10000; // Wrap to keep IDs manageable
                loopBatchIndex++;
                batchesInFlight++;
            }

            // Status update every 30 seconds
            if (Date.now() - startTime > 30000) {
                const elapsed = (Date.now() - startTime) / 1000;

                // Refresh maxBatches from current free RAM. The initial calculation
                // at loop start may have been stale (prep workers running, other scripts
                // using RAM). Updating here lets the batcher fill RAM that freed up since.
                const workerHosts  = getWorkerHosts(ns, execHosts);
                const currentFreeRam = getTotalFreeRam(ns, reserveRam, workerHosts);
                // Add back RAM from in-flight batches (they'll free up as they complete)
                const inFlightRam = batchesInFlight * params.ramPerBatch;
                const effectiveRam = currentFreeRam + inFlightRam;
                const timingSlots  = Math.floor(params.weakenTime / period);
                const newRamSlots  = Math.floor(effectiveRam / params.ramPerBatch);
                const newMax       = Math.max(0, Math.min(timingSlots, newRamSlots, MAX_BATCHES_PER_TARGET));
                if (newMax > params.maxBatches) {
                    logQuiet(`[REFRESH] maxBatches: ${params.maxBatches} → ${newMax} ` +
                             `(free RAM: ${(currentFreeRam/1000).toFixed(1)}TB + ${(inFlightRam/1000).toFixed(1)}TB in-flight)`);
                    params.maxBatches = newMax;
                }

                logQuiet(`[STATUS] Target: ${target} | In-flight: ${batchesInFlight}/${params.maxBatches} | ` +
                         (hackIncomeViable
                           ? `Income: ${ns.format.number(totalIncome)} | Rate: ${ns.format.number(totalIncome / elapsed)}/s | `
                           : `[manipulation-only mode] | `) +
                         `Anomalies: ${anomalyCount}/${DESYNC_THRESHOLD}`);
                startTime = Date.now();
                totalIncome = 0; // Reset for next reporting window
            }

            // Sleep for a fraction of the period. This keeps the scheduling
            // loop responsive without burning CPU checking an empty port.
            // Waking up at half the period means we check roughly twice per
            // batch interval — fast enough to keep the pipeline topped up.
            await ns.sleep(Math.max(50, period / 2));
        }

        // If we broke out of the inner loop, we hit the desync threshold.
        log(`Desync detected on "${target}" (${anomalyCount} anomalies). Re-prepping...`);

        // Kill all in-flight workers so they don't land on an unprepped server
        // and compound the problem. We target scripts by their filename and
        // the target server argument.
        killInFlightWorkers(ns, target, logQuiet);
        batchesInFlight = 0;

        await ns.sleep(2000); // Brief pause before re-prep
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH PARAMETER CALCULATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate all the numbers needed to run batches against this target.
 * Called once before entering the batch loop, and again after each re-prep
 * (since hacking level may have changed, affecting weaken time and threads).
 *
 * Returns null if anything goes wrong (e.g. target has no money,
 * or hack chance is too low to be worth batching).
 *
 * @param {NS} ns
 * @param {string} target
 * @param {number} hackPercent    fraction of max money to steal per batch
 * @param {number} delta          ms between operations within a batch
 * @param {BitNodeMultipliers} bnMults
 * @param {boolean} hasFormulas
 * @param {number} actualWeakenPerThread  weaken security reduction per thread (BN-adjusted)
 */
function calculateBatchParams(ns, target, hackPercent, delta, period, reserveRam, bnMults, hasFormulas, actualWeakenPerThread, execHosts, hackPct = 0) {
    const maxMoney  = ns.getServerMaxMoney(target);
    const minSec    = ns.getServerMinSecurityLevel(target);

    if (!maxMoney || maxMoney <= 0) return null;

    // ── Operation timings ─────────────────────────────────────────────────────
    // We use getWeakenTime() directly rather than formulas because it accounts
    // for the player's current state and the server's current security.
    // We call it against the target at MIN security (since the server is prepped)
    // which is the most optimistic timing — batches will be this fast once prepped.
    const weakenTime = ns.getWeakenTime(target);
    const hackTime   = weakenTime * HACK_TIME_RATIO;
    const growTime   = weakenTime * GROW_TIME_RATIO;

    // ── Hack thread count ─────────────────────────────────────────────────────
    // ns.hackAnalyze() returns the fraction of the server's money stolen
    // per hack thread. We want to steal hackPercent of maxMoney total, so:
    // hackThreads = hackPercent / moneyPerThread
    // Use the hackPct passed in (from manager's HACK_GATHER cache or fetchHackPct fallback).
    // Avoids ns.hackAnalyze (1.0 GB) in the static RAM cost.
    const hackPctVal = (hackPct > 0) ? hackPct : _hackPctCache;
    if (!hackPctVal || hackPctVal <= 0) return null;
    const moneyPerHackThread = maxMoney * hackPctVal;
    if (moneyPerHackThread <= 0) return null;

    const hackThreads = Math.max(1, Math.floor(hackPercent / (moneyPerHackThread / maxMoney)));

    // The actual percentage we'll steal (may differ slightly from hackPercent
    // due to rounding hackThreads to an integer)
    const actualHackPercent = hackThreads * moneyPerHackThread / maxMoney;

    // ── Grow thread count ─────────────────────────────────────────────────────
    // After hacking actualHackPercent, the server has (1 - actualHackPercent)
    // of its money left. We need to multiply that back up to maxMoney.
    // The math: growFactor = 1 / (1 - actualHackPercent)
    //
    // With Formulas.exe, we simulate the exact post-hack server state and
    // ask the game for the precise thread count. Without it, we estimate
    // conservatively and add padding proportional to how uncertain we are
    // in bitnodes with low ServerGrowthRate.
    // Growth estimation (no Formulas.exe path — avoids ns.getServer 2GB + ns.getPlayer 0.5GB).
    // The estimate is accurate enough for steady-state batching; 20% padding handles BN variance.
    // Manager uses the same formula and has already validated this target is profitable.
    const growFactor    = 1 / Math.max(0.01, 1 - actualHackPercent);
    const serverGrowth  = ns.getServerGrowth(target);
    const adjRate       = Math.min(1.0035, 1 + 0.03 / Math.max(minSec, 0.01));
    const bnGrowRate    = bnMults.ServerGrowthRate ?? 1;
    const rawGrow       = Math.log(growFactor) / (Math.log(adjRate) * (serverGrowth * bnGrowRate / 100)) * 1.2;
    const growThreads   = Number.isFinite(rawGrow) ? Math.max(1, Math.ceil(rawGrow)) : 2000;

    // ── Weaken thread counts ──────────────────────────────────────────────────
    // Each batch needs TWO weaken operations:
    //
    // W1 (before hack): establishes minimum security going into the hack.
    //     In normal steady-state batching, the server should already be at
    //     min security. But W1 is there to absorb any drift that slipped
    //     through. In the first few batches, it also does real work.
    //
    // W2 (after hack): counteracts the security raised by hack AND grow.
    //     Security raised by hack = hackThreads * HACK_SECURITY_PER_THREAD
    //     Security raised by grow = growThreads * GROW_SECURITY_PER_THREAD
    //     Total security to reduce = hack_sec + grow_sec
    //     Threads needed = total_sec / actualWeakenPerThread
    //
    // Note: We split weaken threads into W1 (small, for drift correction)
    // and W2 (larger, for full hack+grow security recovery).
    const secFromHack   = hackThreads * HACK_SECURITY_PER_THREAD;
    const secFromGrow   = growThreads * GROW_SECURITY_PER_THREAD;
    const w1Threads     = Math.ceil(secFromHack / actualWeakenPerThread);           // Absorbs hack security
    const w2Threads     = Math.ceil((secFromHack + secFromGrow) / actualWeakenPerThread); // Absorbs both

    // ── RAM per batch ─────────────────────────────────────────────────────────
    // Each worker occupies RAM from launch until its operation completes.
    // Total RAM per batch = sum of all four workers' RAM costs * their thread counts.
    // Uses module-level SCRIPT_RAM cache (populated once in resolveScripts).
    const hackRam   = SCRIPT_RAM.hack;
    const growRam   = SCRIPT_RAM.grow;
    const weakenRam = SCRIPT_RAM.weaken;

    const ramPerBatch = (hackThreads   * hackRam)   +
                        (growThreads   * growRam)   +
                        (w1Threads     * weakenRam) +
                        (w2Threads     * weakenRam);

    // ── Maximum concurrent batches ────────────────────────────────────────────
    // Each batch stays in RAM from launch until its last operation (G) completes.
    // The time a batch occupies RAM ≈ weakenTime (since W1 is the first to finish
    // and G finishes weakenTime + 3*delta after W1 starts, roughly weakenTime total).
    // Number of batch-slots in the timing window = weakenTime / period.
    // But we're also limited by available RAM, so we take the minimum.
    const timingSlots  = Math.floor(weakenTime / period);
    const workerHosts  = getWorkerHosts(ns, execHosts);
    const totalFreeRam = getTotalFreeRam(ns, reserveRam, workerHosts);
    const ramSlots     = Math.floor(totalFreeRam / ramPerBatch);
    // Cap at MAX_BATCHES_PER_TARGET regardless of RAM/timing slots.
    // See constant definition for why this matters at PB-scale RAM.
    const maxBatches   = Math.max(0, Math.min(timingSlots, ramSlots, MAX_BATCHES_PER_TARGET));

    // ── Delay calculations ────────────────────────────────────────────────────
    // These are the core offsets that make the timing work. See the explanation
    // in the design walkthrough for the full derivation. The key insight is:
    // each delay is calculated so the operation FINISHES at the right moment,
    // not so it STARTS at the right moment.
    //
    // We use a scheduling buffer of 1000ms to ensure all four scripts are
    // launched and their delay timers are running before any of them fire.
    // This is the "buffer" term from the design discussion.
    const buffer = 1000; // ms

    // Base delays (for batch index 0). Each subsequent batch adds `period` to all four.
    const baseDelays = {
        // W1 just sleeps for the buffer, then fires immediately.
        // It's the reference point — everything else is timed relative to when W1 lands.
        w1: buffer,
        // H lands at W1 + delta. Since hack is 3/4 shorter than weaken, it needs
        // a large head-start delay: (weaken - hack) + delta = (1 - 0.25)*W + delta
        h:  buffer + (weakenTime - hackTime) + delta,
        // W2 lands at W1 + 2*delta. Same duration as W1, so just offset by 2*delta.
        w2: buffer + 2 * delta,
        // G lands at W1 + 3*delta. Since grow is 1/5 shorter than weaken:
        // (weaken - grow) + 3*delta = (1 - 0.80)*W + 3*delta = 0.20*W + 3*delta
        g:  buffer + (weakenTime - growTime) + 3 * delta,
    };

    return {
        weakenTime, hackTime, growTime,
        hackThreads, growThreads, w1Threads, w2Threads,
        hackRam, growRam, weakenRam,
        ramPerBatch, maxBatches,
        baseDelays, period, buffer,
        actualHackPercent,
        moneyPerBatch: hackThreads * moneyPerHackThread,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH SCHEDULING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schedule a single HWGW batch: launch all four workers with their
 * calculated delays so they land in W1 → H → W2 → G order.
 *
 * Returns true if all four workers were successfully launched,
 * false if there wasn't enough RAM (caller should stop trying for now).
 *
 * @param {NS} ns
 * @param {string} target
 * @param {number} batchId        global batch identifier
 * @param {number} loopIndex      index within this prep cycle (0, 1, 2, ...)
 * @param {Object} params         from calculateBatchParams()
 * @param {number} reserveRam
 * @param {Function} logFn
 */
function scheduleBatch(ns, target, batchId, loopIndex, batchBaseTime, params, reserveRam, execHosts, loopStartTime, logFn) {
    // batchBaseTime is the caller-maintained base time for this batch,
    // already snapped forward so all four delays are positive.
    // loopStartTime is kept in the signature for the rollback block below
    // which iterates all exec hosts to clean up partial batches.
    const baseTime = batchBaseTime;
    const now = Date.now();
    const d = {
        w1: Math.max(0, baseTime + params.baseDelays.w1 - now),
        h:  Math.max(0, baseTime + params.baseDelays.h  - now),
        w2: Math.max(0, baseTime + params.baseDelays.w2 - now),
        g:  Math.max(0, baseTime + params.baseDelays.g  - now),
    };

    // Build the host list — restricted to exec hosts if the partition is active,
    // otherwise all rooted servers. Home goes last in both cases so we don't eat
    // into the reserved RAM unnecessarily.
    const hosts = getWorkerHosts(ns, execHosts);

    // Verify there's enough RAM across eligible hosts before committing to launch.
    const totalFreeRam = getTotalFreeRam(ns, reserveRam, hosts);
    if (totalFreeRam < params.ramPerBatch) {
        logFn(`Not enough RAM for batch ${batchId}: need ${params.ramPerBatch.toFixed(1)}GB, have ${totalFreeRam.toFixed(1)}GB`);
        return false;
    }

    // Stock manipulation: read stockmaster's position data and determine whether
    // hack and grow should influence the associated stock's forecast.
    const stockFlags = getStockManipulationFlags(ns, target);

    const w1Launched = launchWorker(ns, SCRIPTS.weaken, params.w1Threads, target, d.w1, batchId, "W1", hosts, reserveRam, false);
    const hLaunched  = launchWorker(ns, SCRIPTS.hack,   params.hackThreads, target, d.h,  batchId, "H",  hosts, reserveRam, stockFlags.manipulateHack);
    const w2Launched = launchWorker(ns, SCRIPTS.weaken, params.w2Threads, target, d.w2, batchId, "W2", hosts, reserveRam, false);
    const gLaunched  = launchWorker(ns, SCRIPTS.grow,   params.growThreads, target, d.g,  batchId, "G",  hosts, reserveRam, stockFlags.manipulateGrow);

    if (!w1Launched || !hLaunched || !w2Launched || !gLaunched) {
        // Kill any orphaned workers from this batch so they don't land on an
        // unprepped server and compound the desync. Return false so the caller
        // does NOT increment batchesInFlight — a partial batch never reports
        // a G completion, so the counter would leak upward indefinitely.
        logFn(`WARNING: Partial batch ${batchId} — rolling back orphaned workers.`);
        // Fire-and-forget temp to avoid ns.ps+ns.kill static RAM cost in batcher.
        const _rbHosts = JSON.stringify(getWorkerHosts(ns, execHosts));
        const _rbScripts = JSON.stringify(Object.values(SCRIPTS));
        ns.write('/Temp/hwgw-rollback.js', [
            'export async function main(ns) {',
            `  const batchId = ${batchId};`,
            `  const hosts   = ${_rbHosts};`,
            `  const scripts = ${_rbScripts};`,
            '  for (const host of hosts)',
            '    for (const proc of ns.ps(host))',
            '      if (scripts.includes(proc.filename) && proc.args[2]===batchId) ns.kill(proc.pid);',
            '}',
        ].join('\n'), 'w');
        ns.exec('/Temp/hwgw-rollback.js', 'home');
        return false;
    }

    logFn(`Scheduled batch ${batchId}: W1+${d.w1}ms H+${d.h}ms W2+${d.w2}ms G+${d.g}ms`);
    return true;
}

/**
 * Launch one worker script with the given thread count and arguments.
 * Tries to fit all threads on a single host for simplicity. If that
 * fails, splits across multiple hosts (less ideal for timing but
 * necessary when no single host has enough free RAM).
 *
 * @param {NS} ns
 * @param {string} script
 * @param {number} threads
 * @param {string} target
 * @param {number} delay        ms before the worker fires its operation
 * @param {number} batchId
 * @param {string} role         "W1", "H", "W2", or "G"
 * @param {string[]} hosts      sorted list of available hosts
 * @param {number} reserveRam
 * @param {boolean} stockManip  if true, worker should pass {stock:true} to hack/grow
 * @returns {boolean} true if all threads were launched
 */
function launchWorker(ns, script, threads, target, delay, batchId, role, hosts, reserveRam, stockManip = false) {
    // SCRIPT_RAM is keyed by the script's role-name fragment. Derive the key by
    // matching the script path against the known names — avoids a getScriptRam()
    // call on every invocation of this hot-path function (4× per batch scheduled).
    const scriptRam = script === SCRIPTS.hack   ? SCRIPT_RAM.hack
                    : script === SCRIPTS.grow   ? SCRIPT_RAM.grow
                    : SCRIPT_RAM.weaken; // weaken covers W1, W2, and any fallback
    let remaining   = threads;

    for (const host of hosts) {
        if (remaining <= 0) break;

        // Workers should already be on exec hosts (manager's copyWorkerScripts ran at startup).
        // Removing ns.scp (0.6 GB) from batcher's static RAM cost. If script is missing
        // on a remote host, that host is simply skipped — manager will re-copy on next refresh.
        const maxRam  = ns.getServerMaxRam(host);
        const usedRam = ns.getServerUsedRam(host);
        const reserve = host === "home" ? Math.max(reserveRam, HOME_RAM_RESERVE) : 0;
        const freeRam = Math.max(0, maxRam - usedRam - reserve);
        const canFit  = Math.floor(freeRam / scriptRam);

        if (canFit <= 0) continue;

        const toRun = Math.min(remaining, canFit);

        // Args: target, delay, batchId, role, stockManip
        // These map directly to ns.args[0..4] in each worker script.
        const pid = ns.exec(script, host, toRun, target, delay, batchId, role, stockManip ? 1 : 0);
        if (pid > 0) {
            remaining -= toRun;
        }
    }

    return remaining === 0; // True if all threads were successfully launched
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPLETION PROCESSING & DESYNC DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a single completion message from port 1.
 * Message format: "ROLE:batchId:result"
 *
 * For "G" (grow) completions, we check whether the batch was healthy:
 * a grow factor close to 1.0 means the server was already near max money
 * when grow landed — which means the preceding hack stole less than expected,
 * which is a desync symptom. We call the anomaly callback in that case.
 *
 * For "H" (hack) completions, we report the income to the tracker callback.
 *
 * @param {NS} ns
 * @param {string} msg            raw message from the port
 * @param {Object} params         batch parameters (for expected values)
 * @param {Function} logFn
 * @param {Function} onIncome     called with money stolen when H completes
 * @param {Function} onAnomaly    called when a suspicious completion is detected
 * @param {Function} onHealthy    called when a batch completes normally
 */
function processWorkerCompletion(ns, msg, params, logFn, onIncome, onAnomaly, onHealthy) {
    const parts = msg.split(":");
    if (parts.length < 3) return;

    const [role, , resultStr] = parts;
    const result = parseFloat(resultStr);

    if (role === "H") {
        // Track income. Even $0 (failed hack) is fine to report — the grow
        // that follows will still restore the server, and W2 will still fix security.
        onIncome(result);

    } else if (role === "G") {
        // A grow factor of exactly 1.0 (or very close to it) means the server
        // was already at maximum money when grow landed. This SHOULD be normal
        // if hack stole very little — but in context, it signals that something
        // is off. Either hack failed (server not fully prepped), or there's
        // overlap between batches.
        //
        // We use 1.001 as the threshold: anything below that is suspicious.
        // This value may need tuning — if you get too many false desync recoveries,
        // raise it slightly; if desyncs cascade before detection, lower it.
        if (result < 1.001) {
            logFn(`Anomaly: G result ${result.toFixed(6)} suggests server was already at max money`);
            onAnomaly();
        } else {
            onHealthy();
        }
    }
    // W1 and W2 completions are not currently used for desync detection,
    // but their messages are still read from the port to keep it clear.
}

// ─────────────────────────────────────────────────────────────────────────────
// PREP MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the target server is prepped (min security, max money).
 * Launches hwgw-prep.js and waits for its completion signal on port 2.
 *
 * Returns true if prep succeeded, false if it failed (e.g. hacking
 * is disabled in this BN, or we hit the iteration limit).
 *
 * @param {NS} ns
 * @param {string} target
 * @param {number} reserveRam
 * @param {Function} logFn        progress messages — respects --quiet (terminal only when not quiet)
 * @param {Function} logErrorFn   errors/fatals   — always printed to terminal regardless of --quiet
 * @param {Function} logQuietFn   routine detail  — tail window only, never terminal
 */
async function ensurePrepped(ns, target, reserveRam, logFn, logErrorFn, logQuietFn) {
    // Quick check first -- if already prepped, skip launching the prep script.
    const currentSec = ns.getServerSecurityLevel(target);
    const minSec     = ns.getServerMinSecurityLevel(target);
    const currentMon = ns.getServerMoneyAvailable(target);
    const maxMon     = ns.getServerMaxMoney(target);

    const alreadyPrepped = (currentSec / minSec) <= 1.01 &&
                           maxMon > 0 && (currentMon / maxMon) >= 0.99;
    if (alreadyPrepped) {
        logQuietFn(`"${target}" is already prepped. Skipping prep.`);
        return true;
    }

    // Prepping and "Prep complete" are progress events — they go to terminal
    // unless --quiet is set, so the player knows what's happening without spam.
    logFn(`Prepping "${target}"... (sec: ${currentSec.toFixed(2)}/${minSec}, money: ${ns.format.percent(currentMon/maxMon)})`);

    // File-based signaling -- avoids the shared-port race condition where
    // batcher-A consumes the PREP_DONE:B signal meant for batcher-B.
    // hwgw-prep.js writes /Temp/hwgw-prep-{target}.txt = "DONE" or "FAILED:reason".
    // Clear any stale signal from a previous prep run before starting.
    const signalFile = `/Temp/hwgw-prep-${target}.txt`;
    ns.write(signalFile, "", "w"); // clear stale signal

    // Drain port 2 of any stale signals too (legacy prep instances might still write there)
    const prepPort = ns.getPortHandle(PREP_PORT);
    while (!prepPort.empty()) prepPort.read();

    // Check if manager is running (exec-hosts file present)
    let managerRunning = false;
    try {
        const raw = ns.read('/Temp/hwgw-exec-hosts.txt');
        managerRunning = raw && raw !== '';
    } catch {}

    if (!managerRunning) {
        // Standalone mode -- launch our own prep.
        const pid = ns.exec(SCRIPTS.prep, "home", 1, target, "--reserve", reserveRam);
        if (pid === 0) {
            logErrorFn(`ERROR: Failed to launch hwgw-prep.js on home. Not enough RAM?`);
            return false;
        }
        logQuietFn(`Launched prep (standalone mode, PID ${pid})`);
    } else {
        // Manager mode. The manager launches prep on target selection, but NOT on
        // internal desync (batcher still alive from manager's view). Check if a
        // prep script is actively running for this target; if not, self-launch.
        // Check via temp script instead of ns.ps (0.2 GB static cost).
        // Fire-and-forget: writes "1" or "0" to file, batcher reads it after brief wait.
        ns.write('/Temp/hwgw-prep-check.js', [
            'export async function main(ns) {',
            '  const t = ns.args[0]; const prep = "hacking/hwgw-prep.js";',
            '  const r = ns.ps("home").some(p => p.filename.endsWith(prep) && p.args.includes(t));',
            '  ns.write("/Temp/hwgw-prep-running.txt", r ? "1" : "0", "w");',
            '}',
        ].join('\n'), 'w');
        const checkPid = ns.exec('/Temp/hwgw-prep-check.js', 'home', 1, target);
        let prepRunning = false;
        if (checkPid) {
            const dlCheck = Date.now() + 3000;
            while (ns.isRunning(checkPid) && Date.now() < dlCheck) await ns.sleep(50);
            prepRunning = ns.read('/Temp/hwgw-prep-running.txt') === '1';
        }
        if (!prepRunning) {
            const pid = ns.exec(SCRIPTS.prep, "home", 1, target, "--reserve", reserveRam);
            if (pid > 0)
                logQuietFn(`Launched prep (desync recovery, PID ${pid})`);
            else
                logErrorFn(`ERROR: Failed to launch hwgw-prep.js for desync recovery. Not enough RAM?`);
        } else {
            logQuietFn(`Prep already running for "${target}" -- waiting for completion.`);
        }
    }

    // Wait for prep completion by polling the per-target signal file.
    // This avoids the shared-port race where one batcher consumes another's signal.
    const maxPrepWait = 30 * 60 * 1000;
    const startWait   = Date.now();

    while (Date.now() - startWait < maxPrepWait) {
        const signal = ns.read(signalFile);
        if (signal === "DONE") {
            logFn(`Prep complete for "${target}".`);
            ns.write(signalFile, "", "w"); // clear after reading
            return true;
        } else if (signal.startsWith("FAILED:")) {
            const reason = signal.slice(7) || "unknown";
            logErrorFn(`Prep failed for "${target}": ${reason}`);
            ns.write(signalFile, "", "w"); // clear after reading
            return false;
        }
        // If the prep script has died without writing a signal, self-launch a new one.
        // Check via a temp script to avoid ns.ps static RAM cost.
        if (signal === "") {
            ns.write('/Temp/hwgw-prep-check2.js', [
                'export async function main(ns) {',
                '  const t = ns.args[0];',
                '  const r = ns.ps("home").some(p => p.filename.endsWith("hacking/hwgw-prep.js") && p.args.includes(t));',
                '  ns.write("/Temp/hwgw-prep-running2.txt", r ? "1" : "0", "w");',
                '}',
            ].join('\n'), 'w');
            const chkPid = ns.exec('/Temp/hwgw-prep-check2.js', 'home', 1, target);
            if (chkPid) {
                const dl2 = Date.now() + 3000;
                while (ns.isRunning(chkPid) && Date.now() < dl2) await ns.sleep(50);
            }
            if (ns.read('/Temp/hwgw-prep-running2.txt') !== '1') {
                logQuietFn(`Prep for "${target}" vanished without signaling. Re-launching...`);
                const pid = ns.exec(SCRIPTS.prep, "home", 1, target, "--reserve", reserveRam);
                if (pid === 0)
                    logErrorFn(`ERROR: Re-launch of prep failed. Not enough RAM?`);
            }
        }
        await ns.sleep(5000);
    }

    logErrorFn(`ERROR: Prep for "${target}" timed out after 30 minutes.`);
    return false;
}
// ─────────────────────────────────────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kill all in-flight worker scripts targeting the given server.
 * Called when a desync is detected so stale workers don't land on
 * a server that's about to be re-prepped.
 *
 * @param {NS} ns
 * @param {string} target
 * @param {Function} logFn
 */
function killInFlightWorkers(ns, target, logFn) {
    // Fire-and-forget temp script — removes ns.ps(0.2GB)+ns.kill(0.5GB)+ns.scan(0.2GB)
    // from batcher's static RAM cost. The temp script bears those costs for its brief lifetime.
    const scripts = JSON.stringify(Object.values(SCRIPTS).filter(s => s !== SCRIPTS.prep));
    ns.write('/Temp/hwgw-kill-inflight.js', [
        'export async function main(ns) {',
        '  const target  = ns.args[0];',
        `  const scripts = ${scripts};`,
        '  const visited = new Set(), queue = ["home"], hosts = [];',
        '  while (queue.length) {',
        '    const h = queue.shift(); if (visited.has(h)) continue; visited.add(h);',
        '    if (!h.startsWith("hacknet-") && (h==="home" || ns.hasRootAccess(h))) hosts.push(h);',
        '    for (const n of ns.scan(h)) if (!visited.has(n)) queue.push(n);',
        '  }',
        '  for (const host of hosts) {',
        '    for (const proc of ns.ps(host)) {',
        '      const isPrepWorker = Array.isArray(proc.args) && proc.args.includes("PREP");',
        '      if (scripts.includes(proc.filename) && proc.args[0]===target && !isPrepWorker)',
        '        ns.kill(proc.pid);',
        '    }',
        '  }',
        '}',
    ].join('\n'), 'w');
    ns.exec('/Temp/hwgw-kill-inflight.js', 'home', 1, target);
    logFn(`Launched kill sweep for in-flight workers on "${target}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate total free RAM across all rooted hosts,
 * applying the reserve only to home.
 */
/**
 * Build the list of hosts eligible to run worker scripts.
 *
 * When hwgw-manager is running and has written an exec hosts file, we restrict
 * workers to those servers only — this is the partition that prevents workers
 * from competing with daemon.js for RAM on world servers.
 *
 * When the batcher is run standalone (no manager, no exec hosts file), execHosts
 * is null and we fall back to all rooted servers. The batcher works correctly
 * in both modes.
 *
 * Home is always sorted to the end of the list so we don't eat into the
 * reserved RAM budget unnecessarily.
 *
 * @param {NS} ns
 * @param {Set<string>|null} execHosts  — claimed servers from hwgw-manager, or null
 * @returns {string[]}
 */
function getWorkerHosts(ns, execHosts) {
    // Require execHosts from manager — removes the getAllRootedHosts fallback
    // (and thus ns.scan + ns.hasRootAccess from batcher's static RAM cost).
    // In standalone mode (no manager), pass a Set(['home']) for home-only operation.
    const hosts = execHosts && execHosts.size > 0
        ? [...execHosts].filter(h => ns.serverExists(h))
        : ['home']; // safe fallback: home-only when no partition active
    if (!hosts.includes('home') && ns.getServerMaxRam('home') > HOME_RAM_THRESHOLD)
        hosts.push('home');
    return hosts.sort((a, b) => (a === "home" ? 1 : 0) - (b === "home" ? 1 : 0));
}

/**
 * Sum free RAM across a list of hosts, applying the home reserve only to "home".
 * Accepts a pre-built host list so callers control which servers are in scope —
 * this is what enforces the exec host partition.
 */
function getTotalFreeRam(ns, reserveRam, hosts) {
    let total = 0;
    for (const host of hosts) {
        const reserve = host === "home" ? Math.max(reserveRam, HOME_RAM_RESERVE) : 0;
        total += Math.max(0, ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserve);
    }
    return total;
}

/**
 * Read BitNode multipliers from daemon.js's cache file at no RAM cost.
 * ns.read() is free; the alternative (helpers.js import chain) costs 1.1 GB
 * via ns.run + ns.isRunning even when the cache already exists and no spawning
 * actually happens at runtime. RAM is calculated statically by the game.
 *
 * Falls back to known non-default values for the bitnodes where multipliers
 * meaningfully differ from 1.0. If the fallback is wrong (e.g. we're in BN3
 * but the cache hasn't been written yet), thread counts will be slightly off
 * for one prep cycle. That's harmless — prep just runs one extra iteration.
 */
function readBnMults(ns) {
    // ns.getResetInfo() BN-specific table removed — saves 0.05 GB static RAM.
    // If the cache file is missing (very start of a new BN), safe all-1.0 defaults
    // are used. Prep will run one extra iteration; batch thread counts are slightly off
    // for one cycle. Both correct themselves automatically once daemon.js writes the file.
    try {
        const cached = ns.read('/Temp/bitNode-multipliers.txt');
        if (cached && cached !== '') return JSON.parse(cached);
    } catch {}
    return { ServerWeakenRate: 1, ServerGrowthRate: 1, ScriptHackMoney: 1, ScriptHackMoneyGain: 1 };
}

// getAllRootedHosts removed from batcher — scan(0.2GB)+hasRootAccess(0.1GB) saved.
// Kill sweeps now run in fire-and-forget temp scripts that bear those costs briefly.
// getWorkerHosts() below requires execHosts to be provided (manager always does).