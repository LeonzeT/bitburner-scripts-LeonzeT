// Resolve registered script paths via script-paths.json (0 GB — ns.read only)
let _scriptPaths = null;
function resolveScript(ns, key) {
    if (!_scriptPaths) {
        _scriptPaths = {};
        try { const r = ns.read('/script-paths.json'); if (r && r !== '') { _scriptPaths = JSON.parse(r); delete _scriptPaths._comment; } } catch {}
    }
    return _scriptPaths[key] ?? (key.endsWith('.js') ? key : key + '.js');
}
/**
 * hwgw-prep.js — Server prep orchestrator for HWGW batching.
 *
 * Brings a server to the "prepped" state required by hwgw-batcher.js:
 *   - Security at minimum (minSecurityLevel)
 *   - Money at maximum (maxMoney)
 *
 * Runs in two alternating phases until both conditions are met:
 *   Phase 1 — Weaken:  deploy weaken threads until security reaches minimum.
 *   Phase 2 — Grow:    deploy grow threads until money reaches maximum,
 *                       then one more weaken pass to clean the security raise.
 *
 * Signals completion by writing to /Temp/hwgw-prep-{target}.txt:
 *   "DONE"           — server is prepped, batcher may launch
 *   "FAILED:reason"  — could not prep (e.g. too many iterations, script missing)
 *
 * Worker scripts are launched with args[3]='PREP' so hwgw-grow.js and
 * hwgw-weaken.js skip writing to port 1 (the batcher's desync channel).
 * See hwgw-notes.txt §2 for why this matters.
 *
 * @param {NS} ns
 * Args:
 *   ns.args[0]  {string}  target    — server to prep
 *   ns.args[1]  {string}  "--reserve"
 *   ns.args[2]  {number}  reserveRam — GB to leave free on home (default 32)
 *   --exec-hosts {string} JSON array of exec host names (optional, ignored if
 *                         not present — prep uses all exec hosts from the global
 *                         file, or all rooted servers in standalone mode)
 */

// No helpers.js import — self-contained by design (same as batcher).
// RAM cost: ~2 GB (ns.exec, ns.scp, ns.getServer*, ns.ps, ns.write, ns.sleep)

const WEAKEN_SECURITY_PER_THREAD = 0.05;
const GROW_SECURITY_PER_THREAD   = 0.004;
const HACK_SECURITY_PER_THREAD   = 0.002; // unused here but kept for reference
const WORKER_PORT = 1; // batcher's desync channel — prep must NOT write here

const MAX_ITERATIONS = 50; // give up after this many weaken+grow cycles

// Fraction of total free exec RAM prep is allowed to consume per wave.
// When no batchers are running (fresh start / only target) we can safely
// hammer the full RAM pool and finish prep as fast as possible.
// When batchers ARE running on other targets we leave 50% free so their
// workers don't get starved between waves.
// This is computed dynamically in getPrepRamFraction() below.

/** Safe number helper — guards against NaN/Infinity cascades (see hwgw-notes.txt §5) */
const fin  = (v, fallback) => Number.isFinite(v) ? v : fallback;
/** Thread count helper — returns 0 instead of a garbage value */
const threads = n => (Number.isFinite(n) && n >= 1) ? Math.floor(n) : 0;

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');

    const target = ns.args[0];
    if (!target || typeof target !== 'string') {
        ns.tprint('ERROR hwgw-prep: no target specified.');
        return;
    }

    // Parse --reserve from args. Manager calls us as:
    //   ns.exec(PREP_SCRIPT, 'home', 1, target, '--reserve', reserveRam, '--exec-hosts', json)
    // We read positionally: args[1]='--reserve', args[2]=value
    const reserveRam = fin(
        ns.args[1] === '--reserve' ? Number(ns.args[2]) : 32,
        32
    );

    const signalFile = `/Temp/hwgw-prep-${target}.txt`;

    // ── Script path resolution ─────────────────────────────────────────────
    let paths = {};
    try {
        const raw = ns.read('/script-paths.json');
        if (raw && raw !== '') paths = JSON.parse(raw);
    } catch {}
    const WEAKEN = paths['hwgw-weaken'] ?? 'hacking/hwgw-weaken.js';
    const GROW   = paths['hwgw-grow']   ?? 'hacking/hwgw-grow.js';

    if (!ns.fileExists(WEAKEN, 'home') || !ns.fileExists(GROW, 'home')) {
        ns.tprint(`ERROR hwgw-prep: worker scripts missing (${WEAKEN}, ${GROW})`);
        ns.write(signalFile, `FAILED:worker scripts missing`, 'w');
        return;
    }

    // ── BN multipliers ─────────────────────────────────────────────────────
    let bnMults = { ServerWeakenRate: 1, ServerGrowthRate: 1 };
    try {
        const cached = ns.read('/Temp/bitNode-multipliers.txt');
        if (cached && cached !== '') bnMults = { ...bnMults, ...JSON.parse(cached) };
    } catch {}
    const actualWeakenPerThread = WEAKEN_SECURITY_PER_THREAD * fin(bnMults.ServerWeakenRate, 1);

    // ── Exec host pool ─────────────────────────────────────────────────────
    // Use the global exec-hosts file if present; fall back to all rooted servers.
    // We intentionally do NOT use the per-target slice file here — prep benefits
    // from using all available RAM to complete as fast as possible.
    function getWorkerHosts() {
        // BFS fallback removed — saves ns.scan(0.2GB) + ns.hasRootAccess(0.1GB).
        // Manager writes /Temp/hwgw-exec-hosts.txt before launching prep.
        // Standalone fallback: home-only (safe, just slower prep).
        try {
            const raw = ns.read('/Temp/hwgw-exec-hosts.txt');
            if (raw && raw !== '') {
                const hosts = JSON.parse(raw).filter(h => ns.serverExists(h));
                if (hosts.length > 0) {
                    if (!hosts.includes('home')) hosts.push('home');
                    return hosts.sort((a, b) => (a === 'home' ? 1 : 0) - (b === 'home' ? 1 : 0));
                }
            }
        } catch {}
        return ['home']; // standalone fallback
    }

    function getTotalFreeRam(hosts) {
        return hosts.reduce((sum, h) => {
            const reserve = h === 'home' ? reserveRam : 0;
            return sum + Math.max(0, ns.getServerMaxRam(h) - ns.getServerUsedRam(h) - reserve);
        }, 0);
    }

    // getPrepRamFraction replaced with fixed constant — removes the last ns.ps call.
    // 0.5 (50% of free RAM) is conservative and safe in all situations.
    // The adaptive 90% path (fresh BN, no batchers) means slightly more prep iterations
    // but is not correctness-critical. RAM saved: 0.2 GB (ps).
    const PREP_RAM_FRACTION = 0.50;

    // ── Copy workers to all exec hosts via fire-and-forget temp ─────────────
    // Removes ns.scp (0.6 GB) from prep's static RAM cost.
    function ensureScriptsCopied(hosts) {
        const nonHome = hosts.filter(h => h !== 'home');
        if (!nonHome.length) return;
        const scripts = JSON.stringify([WEAKEN, GROW]);
        const hostsJson = JSON.stringify(nonHome);
        ns.write('/Temp/prep-scp.js', [
            'export async function main(ns) {',
            `  const scripts = ${scripts};`,
            `  const hosts   = ${hostsJson};`,
            '  for (const host of hosts)',
            '    for (const script of scripts)',
            '      if (ns.fileExists(script,"home") && !ns.fileExists(script,host))',
            '        ns.scp(script, host, "home");',
            '}',
        ].join('\n'), 'w');
        ns.exec('/Temp/prep-scp.js', 'home');
    }

    // ── PID tracking for waitForPids (replaces ns.ps) ──────────────────────
    // ns.ps (0.2 GB) removed; instead track launched PIDs and poll ns.isRunning.
    const activePids = [];

    // ── Thread dispatch: spread threads across available hosts ─────────────
    // Workers are tagged args[3]='PREP' so they don't signal port 1.
    function dispatchThreads(script, totalThreads, hosts) {
        let remaining = totalThreads;
        for (const host of hosts) {
            if (remaining <= 0) break;
            const scriptRam = ns.getScriptRam(script, 'home');
            if (!scriptRam || scriptRam <= 0) continue;
            const reserve = host === 'home' ? reserveRam : 0;
            const free = Math.max(0, ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserve);
            const canRun = Math.floor(free / scriptRam);
            if (canRun <= 0) continue;
            const toRun = Math.min(canRun, remaining);
            // args: [target, delay=0, batchId=-1, role='PREP']
            const pid = ns.exec(script, host, toRun, target, 0, -1, 'PREP');
            if (pid > 0) { remaining -= toRun; activePids.push(pid); }
        }
        return totalThreads - remaining; // threads actually launched
    }

    // ── Wait for all dispatched PREP workers to finish ─────────────────────
    // Uses PID tracking + ns.isRunning instead of ns.ps (saves 0.2 GB static RAM).
    // PIDs are pushed into activePids[] by dispatchThreads(); cleared here after wait.
    async function waitForPids() {
        while (activePids.some(pid => ns.isRunning(pid))) {
            // Prune finished PIDs to keep the array small
            for (let i = activePids.length - 1; i >= 0; i--)
                if (!ns.isRunning(activePids[i])) activePids.splice(i, 1);
            await ns.sleep(500);
        }
        activePids.length = 0; // clear for next wave
    }

    // ── Grow thread estimate (correct Bitburner formula, see hwgw-notes.txt §1) ──
    function estimateGrowThreads(currentMoney, maxMoney, minSec) {
        if (currentMoney >= maxMoney) return 0;
        const serverGrowth = fin(ns.getServerGrowth(target), 1);
        const growRate     = fin(bnMults.ServerGrowthRate, 1);
        const ratio        = maxMoney / Math.max(1, currentMoney);
        // Correct formula: adjustedGrowthRate = min(1.0035, 1 + 0.03/minSecurity)
        const adjGrowthRate = Math.min(1.0035, 1 + 0.03 / Math.max(1, minSec));
        const need = Math.log(ratio) / (Math.log(adjGrowthRate) * serverGrowth / 100 * growRate);
        return threads(need * 1.2); // 20% padding for safety
    }

    // ── Main prep loop ─────────────────────────────────────────────────────
    ns.print(`Prepping "${target}"...`);

    let iters = 0;
    while (iters < MAX_ITERATIONS) {
        iters++;

        const minSec     = fin(ns.getServerMinSecurityLevel(target), 1);
        const currentSec = fin(ns.getServerSecurityLevel(target),    200);
        const maxMon     = fin(ns.getServerMaxMoney(target),         1);
        const currentMon = fin(ns.getServerMoneyAvailable(target),   0);

        const secOk = currentSec <= minSec * 1.01;
        const monOk = maxMon > 0 && currentMon / maxMon >= 0.99;

        if (secOk && monOk) {
            ns.print(`"${target}" is prepped. Writing DONE signal.`);
            ns.write(signalFile, 'DONE', 'w');
            return;
        }

        const hosts = getWorkerHosts();
        ensureScriptsCopied(hosts);

        const weakenRam = fin(ns.getScriptRam(WEAKEN, 'home'), 0);
        const growRam   = fin(ns.getScriptRam(GROW, 'home'),   0);

        if (weakenRam <= 0 || growRam <= 0) {
            ns.tprint(`ERROR hwgw-prep: worker scripts have 0 RAM. Missing from home?`);
            ns.write(signalFile, 'FAILED:worker script RAM is 0', 'w');
            return;
        }

        const prepRamFraction = PREP_RAM_FRACTION;

        // ── Phase 1: Weaken if security above minimum ──────────────────────
        if (!secOk) {
            const secDelta  = fin(currentSec - minSec, 0);
            const needed    = threads(Math.ceil(secDelta / actualWeakenPerThread) * 1.1);
            const freeRam   = getTotalFreeRam(hosts) * prepRamFraction;
            const canLaunch = threads(freeRam / weakenRam);
            const toLaunch  = Math.min(needed, canLaunch);

            if (toLaunch > 0) {
                ns.print(`[Iter ${iters}] Weaken: sec=${currentSec.toFixed(2)}/${minSec} — launching ${toLaunch} threads (${(prepRamFraction*100).toFixed(0)}% RAM)`);
                dispatchThreads(WEAKEN, toLaunch, hosts);
            } else {
                ns.print(`[Iter ${iters}] Weaken needed but no RAM (free=${freeRam.toFixed(0)}GB, need ${weakenRam}GB/thread). Waiting...`);
            }
            await waitForPids();
            continue; // re-evaluate before growing
        }

        // ── Phase 2: Grow if money below maximum ───────────────────────────
        if (!monOk) {
            const growNeeded = estimateGrowThreads(currentMon, maxMon, minSec);
            const freeRam    = getTotalFreeRam(hosts) * prepRamFraction;
            const canLaunch  = threads(freeRam / growRam);
            const toLaunch   = Math.min(growNeeded, canLaunch);

            if (toLaunch > 0) {
                ns.print(`[Iter ${iters}] Grow: money=${(currentMon/maxMon*100).toFixed(1)}% — launching ${toLaunch}/${growNeeded} threads (${(prepRamFraction*100).toFixed(0)}% RAM)`);
                dispatchThreads(GROW, toLaunch, hosts);
            } else {
                ns.print(`[Iter ${iters}] Grow needed but no RAM (free=${freeRam.toFixed(0)}GB). Waiting...`);
            }
            await waitForPids();

            // After growing, security will have risen — loop back to weaken
            continue;
        }
    }

    ns.tprint(`ERROR hwgw-prep: "${target}" not prepped after ${MAX_ITERATIONS} iterations.`);
    ns.write(signalFile, `FAILED:exceeded ${MAX_ITERATIONS} iterations`, 'w');
}