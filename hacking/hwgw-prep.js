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
 *
 * @param {NS} ns
 * Args:
 *   ns.args[0]  {string}  target    — server to prep
 *   ns.args[1]  {string}  "--reserve"
 *   ns.args[2]  {number}  reserveRam — GB to leave free on home (default 32)
 */

// RAM BUDGET (static cost charged regardless of call count):
//   Base:                      1.60 GB
//   ns.exec:                   1.30 GB
//   ns.getServerMaxRam:        0.05 GB  ← cheaper than the 0.1 GB GetServer calls
//   ns.getServerUsedRam:       0.05 GB
//   ns.getServerMinSecurityLevel: 0.10 GB
//   ns.getServerSecurityLevel:    0.10 GB
//   ns.getServerMaxMoney:         0.10 GB
//   ns.getServerMoneyAvailable:   0.10 GB
//   ns.getServerGrowth:           0.10 GB
//   ns.isRunning:                 0.10 GB
//   ── Removed vs previous version ──────────────────────────────────────────
//   ns.fileExists (×2):  -0.10 GB  (scripts verified by manager before launch)
//   ns.serverExists:     -0.10 GB  (exec-hosts file is trusted, no live check)
//   ns.getScriptRam:     -0.10 GB  (worker RAM hardcoded from game source)
//   ─────────────────────────────────────────────────────────────────────────
//   Total: ~2.70 GB  (was ~3.00 GB — saves 0.30 GB)

const WEAKEN_SECURITY_PER_THREAD = 0.05;
const GROW_SECURITY_PER_THREAD   = 0.004;
const MAX_ITERATIONS = 50;
const PREP_RAM_FRACTION = 0.50;

// Worker script RAM costs — derived directly from the game source (RamCostGenerator.ts):
//   Base RAM per script:  1.60 GB
//   ns.weaken cost:       0.15 GB  → WEAKEN_SCRIPT_RAM = 1.75 GB
//   ns.grow cost:         0.15 GB  → GROW_SCRIPT_RAM   = 1.75 GB
//
// !! These constants must be updated if the worker scripts ever call additional
// !! NS functions beyond weaken/grow. The batcher's own SCRIPT_RAM cache uses
// !! ns.getScriptRam() at startup for this reason; prep avoids that 0.10 GB cost
// !! by hardcoding values known at design time.
const WEAKEN_SCRIPT_RAM = 1.75;
const GROW_SCRIPT_RAM   = 1.75;

/** Safe number helper — guards against NaN/Infinity cascades */
const fin  = (v, fallback) => Number.isFinite(v) ? v : fallback;
/** Thread count helper — returns 0 instead of a garbage value */
const threads = n => (Number.isFinite(n) && n >= 1) ? Math.floor(n) : 0;

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');

    const target = ns.args[0];
    if (!target || typeof target !== 'string') {
        ns.print('ERROR hwgw-prep: no target specified.');
        return;
    }

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

    // Scripts are guaranteed to be present by the manager's copyWorkerScripts()
    // which runs before prep is ever launched. Removing the ns.fileExists() check
    // here saves 0.10 GB of static RAM — the most expensive per-call cost we can cut.
    // If a script IS missing, ns.exec() will simply return 0 and the loop will
    // report "no RAM" instead of "missing script" — acceptable tradeoff.

    // ── BN multipliers ─────────────────────────────────────────────────────
    let bnMults = { ServerWeakenRate: 1, ServerGrowthRate: 1 };
    try {
        const cached = ns.read('/Temp/bitNode-multipliers.txt');
        if (cached && cached !== '') bnMults = { ...bnMults, ...JSON.parse(cached) };
    } catch {}
    const actualWeakenPerThread = WEAKEN_SECURITY_PER_THREAD * fin(bnMults.ServerWeakenRate, 1);

    // ── Exec host pool ─────────────────────────────────────────────────────
    // Reads /Temp/hwgw-exec-hosts.txt written by hwgw-manager.js.
    // ns.serverExists() removed: we trust the manager's host list. If a host
    // becomes invalid, ns.exec() returns 0 and dispatchThreads skips it gracefully.
    // Savings: 0.10 GB static RAM.
    function getWorkerHosts() {
        try {
            const raw = ns.read('/Temp/hwgw-exec-hosts.txt');
            if (raw && raw !== '') {
                const hosts = JSON.parse(raw);
                if (hosts.length > 0) {
                    if (!hosts.includes('home')) hosts.push('home');
                    // Home last so we don't eat reserved RAM unnecessarily
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

    // ── Copy workers to exec hosts via fire-and-forget temp ─────────────────
    // Keeps ns.scp (0.60 GB) out of prep's static RAM cost.
    // The copied set avoids re-launching the SCP temp script on every loop
    // iteration — it only runs once per unique host set per prep session.
    const _copiedToHosts = new Set();
    function ensureScriptsCopied(hosts) {
        const nonHome = hosts.filter(h => h !== 'home');
        if (!nonHome.length) return;
        // Build a stable cache key from sorted host names
        const cacheKey = nonHome.slice().sort().join(',');
        if (_copiedToHosts.has(cacheKey)) return; // Already queued this run
        _copiedToHosts.add(cacheKey);
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

    // ── PID tracking (replaces ns.ps to save 0.20 GB) ──────────────────────
    const activePids = [];

    // ── Thread dispatch across hosts ────────────────────────────────────────
    // Workers tagged args[3]='PREP' so they don't signal port 1.
    function dispatchThreads(script, totalThreads, hosts) {
        // Use the hardcoded script RAM constant (0.10 GB saved vs ns.getScriptRam).
        // weaken → WEAKEN_SCRIPT_RAM, grow → GROW_SCRIPT_RAM.
        const scriptRam = (script === WEAKEN) ? WEAKEN_SCRIPT_RAM : GROW_SCRIPT_RAM;
        let remaining = totalThreads;

        for (const host of hosts) {
            if (remaining <= 0) break;
            const reserve = host === 'home' ? reserveRam : 0;
            const free = Math.max(0, ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserve);
            const canRun = Math.floor(free / scriptRam);
            if (canRun <= 0) continue;
            const toRun = Math.min(canRun, remaining);
            // args: [target, delay=0, batchId=-1, role='PREP']
            const pid = ns.exec(script, host, toRun, target, 0, -1, 'PREP');
            if (pid > 0) { remaining -= toRun; activePids.push(pid); }
        }
        return totalThreads - remaining;
    }

    // ── Wait for all dispatched PREP workers ────────────────────────────────
    async function waitForPids() {
        while (activePids.some(pid => ns.isRunning(pid))) {
            for (let i = activePids.length - 1; i >= 0; i--)
                if (!ns.isRunning(activePids[i])) activePids.splice(i, 1);
            await ns.sleep(500);
        }
        activePids.length = 0;
    }

    // ── Grow thread estimate ────────────────────────────────────────────────
    // Uses the same log formula as the game's numCycleForGrowth() (ServerHelpers.ts).
    // Full Newton-Raphson (numCycleForGrowthCorrected) is ~identical for the ratios
    // we care about because the additive +threads term is negligible vs server money.
    //
    // Formula derivation (from game source):
    //   k = log1p(min(0.03/minSec, 0.0035)) × (serverGrowth/100) × bnGrowRate
    //   threads = log(targetMoney/currentMoney) / k
    //
    // Note: the player's hacking_grow multiplier is omitted here (requires ns.getPlayer,
    // 0.50 GB). The 20% padding accounts for this and rounding. Since hacking_grow ≥ 1,
    // omitting it means we slightly overestimate threads — safe but not wasteful at ×1.2.
    function estimateGrowThreads(currentMoney, maxMoney, minSec) {
        if (currentMoney >= maxMoney) return 0;
        const serverGrowth = fin(ns.getServerGrowth(target), 1);
        const growRate     = fin(bnMults.ServerGrowthRate, 1);
        const ratio        = maxMoney / Math.max(1, currentMoney);
        // Math.log1p(x) = log(1+x), preferred for small x (matches game source exactly)
        const adjGrowthLog = Math.min(
            Math.log1p(0.0035),                           // ServerMaxGrowthLog from Constants.ts
            Math.log1p(0.03 / Math.max(1, minSec))       // ServerBaseGrowthIncr / hackDifficulty
        );
        const k    = adjGrowthLog * (serverGrowth / 100) * growRate;
        const need = k > 0 ? Math.log(ratio) / k : Infinity;
        return threads(need * 1.2); // 20% padding covers hackGrowMult and rounding
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

        // ── Phase 1: Weaken if security above minimum ──────────────────────
        if (!secOk) {
            const secDelta  = fin(currentSec - minSec, 0);
            const needed    = threads(Math.ceil(secDelta / actualWeakenPerThread) * 1.1);
            const freeRam   = getTotalFreeRam(hosts) * PREP_RAM_FRACTION;
            const canLaunch = threads(freeRam / WEAKEN_SCRIPT_RAM);
            const toLaunch  = Math.min(needed, canLaunch);

            if (toLaunch > 0) {
                ns.print(`[Iter ${iters}] Weaken: sec=${currentSec.toFixed(2)}/${minSec} → launching ${toLaunch} threads`);
                dispatchThreads(WEAKEN, toLaunch, hosts);
            } else {
                ns.print(`[Iter ${iters}] Weaken needed but no RAM (free=${(freeRam).toFixed(0)}GB). Waiting...`);
            }
            await waitForPids();
            continue;
        }

        // ── Phase 2: Grow if money below maximum ───────────────────────────
        if (!monOk) {
            const growNeeded = estimateGrowThreads(currentMon, maxMon, minSec);
            const freeRam    = getTotalFreeRam(hosts) * PREP_RAM_FRACTION;
            const canLaunch  = threads(freeRam / GROW_SCRIPT_RAM);
            const toLaunch   = Math.min(growNeeded, canLaunch);

            if (toLaunch > 0) {
                ns.print(`[Iter ${iters}] Grow: money=${(currentMon/maxMon*100).toFixed(1)}% → launching ${toLaunch}/${growNeeded} threads`);
                dispatchThreads(GROW, toLaunch, hosts);
            } else {
                ns.print(`[Iter ${iters}] Grow needed but no RAM (free=${(freeRam).toFixed(0)}GB). Waiting...`);
            }
            await waitForPids();
            continue;
        }
    }

    ns.print(`ERROR hwgw-prep: "${target}" not prepped after ${MAX_ITERATIONS} iterations.`);
    ns.write(signalFile, `FAILED:exceeded ${MAX_ITERATIONS} iterations`, 'w');
}