/**
 * xp-grind.js — Standalone hack XP grinder
 *
 * Fills ALL available RAM on home + purchased + world servers with weaken()
 * threads. Automatically selects the rooted server with the highest
 * minSecurityLevel the player can currently hack — that maximises XP per
 * thread (XP/call = 3 + baseDifficulty×0.3, from game source Hacking.ts).
 *
 * Why weaken over hack?
 *   - weaken() always gives 100% XP; hack() gives only 25% on failure
 *   - No server-state dependency — weaken works correctly regardless of money
 *
 * Writes a live status snapshot to /Temp/xp-grind-status.txt every 10 seconds
 * so autopilot.js can read actual XP/s and make smarter cycle decisions.
 *
 * Usage:
 *   run xp-grind.js [target] [--reserve 128] [--include-world true]
 *
 * Args:
 *   target           (optional) explicit target; auto-selects if omitted
 *   --reserve        GB to keep free on home (default: 128)
 *   --include-world  also use rooted world servers (default: true)
 *
 * @param {NS} ns
 */
export async function main(ns) {
    const flags = ns.flags([
        ['reserve',       128 ],
        ['include-world', true],
    ]);

    const explicitTarget = (typeof ns.args[0] === 'string' && ns.args[0].length > 0
        && !ns.args[0].startsWith('--'))
        ? ns.args[0]
        : null;

    const reserveRam   = flags['reserve'];
    const includeWorld = flags['include-world'];
    const STATUS_FILE  = '/Temp/xp-grind-status.txt';
    const WORKER       = '/Temp/xp-weaken-loop.js';

    ns.disableLog('ALL');

    // ── Auto-select best target ──────────────────────────────────────────────
    // XP formula: expGain = 3 + baseDifficulty×0.3  (game source Hacking.ts)
    // weakenTime ∝ requiredHackingSkill × baseDifficulty / playerHack
    //
    // XP/s per thread = expGain / weakenTime
    //                 ∝ (3 + diff×0.3) / (req × diff)
    //
    // The constant 3 in the numerator means LOW difficulty + LOW req always wins.
    // n00dles (diff=1, req=1) beats joesguns (diff=15, req=10) by ~66× per thread.
    // We maximise this ratio — not raw security level.
    function pickBestTarget() {
        const myHackLevel = ns.getHackingLevel();
        let bestHost  = 'n00dles'; // safe fallback — always rooted, always optimal
        let bestScore = -1;

        const visited = new Set();
        const queue   = ['home'];
        while (queue.length > 0) {
            const h = queue.shift();
            if (visited.has(h)) continue;
            visited.add(h);

            if (h !== 'home' && !h.startsWith('hacknet') && ns.hasRootAccess(h)) {
                const reqLevel = ns.getServerRequiredHackingLevel(h);
                if (reqLevel > myHackLevel) {
                    for (const n of ns.scan(h)) if (!visited.has(n)) queue.push(n);
                    continue;
                }
                const minSec = ns.getServerMinSecurityLevel(h);
                // XP/s score ∝ (3 + minSec×0.3) / (reqLevel × minSec)
                // Avoid div-by-zero: both are always ≥ 1 for valid servers
                const score = (3 + minSec * 0.3) / (Math.max(1, reqLevel) * Math.max(1, minSec));
                if (score > bestScore) {
                    bestScore = score;
                    bestHost  = h;
                }
            }

            for (const n of ns.scan(h)) {
                if (!visited.has(n)) queue.push(n);
            }
        }
        return { host: bestHost, minSec: ns.getServerMinSecurityLevel(bestHost) };
    }

    const { host: autoTarget, minSec: autoMinSec } = pickBestTarget();
    const target = explicitTarget ?? autoTarget;

    if (!ns.serverExists(target)) {
        ns.tprint(`ERROR: xp-grind: server "${target}" not found.`);
        return;
    }
    if (!ns.hasRootAccess(target)) {
        ns.tprint(`ERROR: xp-grind: no root access on "${target}".`);
        return;
    }

    if (!explicitTarget) {
        ns.tprint(`XP Grind: auto-selected "${target}" ` +
            `(minSec=${ns.getServerMinSecurityLevel(target)}, ` +
            `hackLevel=${ns.getHackingLevel()})`);
    }

    // ── Write worker script ──────────────────────────────────────────────────
    // Kept minimal (single-call loop) so it costs exactly 1.75 GB RAM.
    ns.write(WORKER, [
        'export async function main(ns) {',
        '  while (true) await ns.weaken(ns.args[0]);',
        '}',
    ].join('\n'), 'w');

    const workerRam = ns.getScriptRam(WORKER, 'home');
    if (workerRam <= 0) {
        ns.tprint('ERROR: xp-grind: could not determine worker RAM cost.');
        return;
    }

    // ── Build host list ──────────────────────────────────────────────────────
    function getHosts() {
        const hosts = ['home'];

        // Purchased servers
        try {
            for (const h of ns.cloud.getServerNames()) {
                if (!hosts.includes(h)) hosts.push(h);
            }
        } catch { /* API might not be available */ }

        // World servers (optional)
        if (includeWorld) {
            const visited = new Set();
            const queue   = ['home'];
            while (queue.length > 0) {
                const h = queue.shift();
                if (visited.has(h)) continue;
                visited.add(h);
                if (h !== 'home'
                        && !h.startsWith('hacknet')
                        && ns.hasRootAccess(h)
                        && ns.getServerMaxRam(h) >= workerRam
                        && !hosts.includes(h)) {
                    hosts.push(h);
                }
                for (const n of ns.scan(h)) {
                    if (!visited.has(n)) queue.push(n);
                }
            }
        }

        return hosts;
    }

    // ── Clean up workers and status file when this script exits ─────────────
    ns.atExit(() => {
        for (const host of getHosts()) {
            for (const proc of ns.ps(host)) {
                if (proc.filename === WORKER) ns.kill(proc.pid);
            }
        }
        try { ns.write(STATUS_FILE, '', 'w'); } catch { /* non-critical */ }
    });

    // ── Deploy workers ───────────────────────────────────────────────────────
    let totalThreads = 0;
    const hosts = getHosts();

    for (const host of hosts) {
        // Copy worker to remote hosts
        if (host !== 'home') ns.scp(WORKER, host, 'home');

        // Kill any leftover workers from a previous run on this host
        for (const proc of ns.ps(host)) {
            if (proc.filename === WORKER) ns.kill(proc.pid);
        }

        const maxRam   = ns.getServerMaxRam(host);
        const usedRam  = ns.getServerUsedRam(host);
        const reserve  = (host === 'home') ? reserveRam : 0;
        const freeRam  = Math.max(0, maxRam - usedRam - reserve);
        const threads  = Math.floor(freeRam / workerRam);
        if (threads <= 0) continue;

        const pid = ns.exec(WORKER, host, threads, target);
        if (pid > 0) {
            totalThreads += threads;
            ns.tprint(`  ${host}: ${threads} threads (${ns.format.ram(threads * workerRam)})`);
        }
    }

    if (totalThreads === 0) {
        ns.tprint('ERROR: xp-grind: no threads launched — not enough free RAM.');
        return;
    }

    const baseSec    = ns.getServerMinSecurityLevel(target);
    // Correct XP formula from game source (Hacking.ts calculateHackingExpGain):
    //   expGain = 3 + baseDifficulty × 0.3   (before player/BN multipliers)
    // The old formula (minSec × 0.004) was the weaken security reduction, not XP.
    const xpPerCycle = totalThreads * (3 + baseSec * 0.3);
    const weakenTime = ns.getWeakenTime(target);

    ns.tprint(`\nTotal: ${totalThreads.toLocaleString()} threads across ${hosts.length} host(s)`);
    ns.tprint(`Est XP/cycle: ${xpPerCycle.toLocaleString()} (×HackExpGain mult)`);
    ns.tprint(`Weaken time:  ${(weakenTime / 1000).toFixed(1)}s`);
    ns.tprint(`Est XP/sec:   ~${(xpPerCycle / (weakenTime / 1000)).toFixed(0)}`);
    ns.tprint(`\nWorkers are looping. Kill this script to stop.`);

    // ── Status loop ──────────────────────────────────────────────────────────
    while (true) {
        const sec      = ns.getServerSecurityLevel(target);
        const minSec   = ns.getServerMinSecurityLevel(target);
        const wt       = ns.getWeakenTime(target);
        const xpPerSec = (totalThreads * (3 + minSec * 0.3)) / (wt / 1000);
        const hackLvl  = ns.getHackingLevel();

        ns.print(
            `[${new Date().toLocaleTimeString()}] ${target}: ` +
            `sec=${sec.toFixed(2)}/${minSec} | ` +
            `${totalThreads.toLocaleString()} threads | ` +
            `~${xpPerSec.toFixed(0)} XP/s | ` +
            `hack=${hackLvl}`
        );

        // Write status for autopilot.js to read (non-critical, wrapped in try)
        try {
            ns.write(STATUS_FILE, JSON.stringify({
                target,
                hackLevel:    hackLvl,
                xpPerSec:     Math.round(xpPerSec),
                totalThreads,
                weakenTimeS:  Math.round(wt / 1000),
                timestamp:    Date.now(),
            }), 'w');
        } catch { /* non-critical */ }

        await ns.sleep(10000);
    }
}