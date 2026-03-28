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

        // Purchased servers — read from manager's PSERV cache file (free) instead of
        // ns.cloud.getServerNames() (0.4 GB). Falls back to exec-hosts file.
        // If neither file exists (standalone, very start of BN), purchased servers
        // are skipped and only home + world servers are used.
        try {
            const pservRaw = ns.read('/Temp/pserv-list.txt');
            const pservHosts = pservRaw && pservRaw !== '' ? JSON.parse(pservRaw) : [];
            if (pservHosts.length > 0) {
                for (const h of pservHosts) if (!hosts.includes(h)) hosts.push(h);
            } else {
                // Fallback: exec-hosts file written by manager
                const ehRaw = ns.read('/Temp/hwgw-exec-hosts.txt');
                const ehHosts = ehRaw && ehRaw !== '' ? JSON.parse(ehRaw) : [];
                for (const h of ehHosts) if (!hosts.includes(h)) hosts.push(h);
            }
        } catch {}

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
        await(2000);
        return hosts;
    }

    // ── Clean up workers when this script exits ─────────────────────────────
    // Fire-and-forget temp script handles ps+kill to avoid ns.ps(0.2GB)+ns.kill(0.5GB)
    // in xp-grind's static RAM cost. Status file is cleared directly (ns.write = free).
    ns.atExit(() => {
        ns.write(STATUS_FILE, '', 'w');
        // Write and exec cleanup temp — it bears ps+kill RAM cost for its brief lifetime.
        ns.write('/Temp/xp-cleanup.js', [
            'export async function main(ns) {',
            `  const WORKER = ${JSON.stringify(WORKER)};`,
            '  const visited = new Set(), queue = ["home"], hosts = [];',
            '  while (queue.length) {',
            '    const h = queue.shift(); if (visited.has(h)) continue; visited.add(h);',
            '    if (!h.startsWith("hacknet-") && (h==="home"||ns.hasRootAccess(h))) hosts.push(h);',
            '    for (const n of ns.scan(h)) if (!visited.has(n)) queue.push(n);',
            '  }',
            '  for (const host of hosts)',
            '    for (const proc of ns.ps(host))',
            '      if (proc.filename === WORKER) ns.kill(proc.pid);',
            '}',
        ].join('\n'), 'w');
        ns.exec('/Temp/xp-cleanup.js', 'home');
    });

    // ── Deploy workers ───────────────────────────────────────────────────────
    let totalThreads = 0;
    const hosts = getHosts();

    for (const host of hosts) {
        await(2000);
        // Copy worker + kill stale workers via temp (removes ns.scp+ns.kill+ns.ps from static RAM).
        if (host !== 'home') {
            ns.write('/Temp/xp-init-host.js', [
                'export async function main(ns) {',
                `  const WORKER = ${JSON.stringify(WORKER)};`,
                '  const host = ns.args[0];',
                '  if (!ns.fileExists(WORKER, host)) ns.scp(WORKER, host, "home");',
                '  for (const proc of ns.ps(host))',
                '    if (proc.filename === WORKER) ns.kill(proc.pid);',
                '}',
            ].join('\n'), 'w');
            const initPid = ns.exec('/Temp/xp-init-host.js', 'home', 1, host);
            if (initPid) {
                const dl = Date.now() + 3000;
                while (ns.isRunning(initPid) && Date.now() < dl) await ns.sleep(50);
            }
        } else {
            // Home: kill stale workers directly (home ps is cheap — we already pay exec RAM)
            // Actually also do via temp to keep ns.ps+ns.kill out of static cost.
            ns.write('/Temp/xp-init-home.js', [
                'export async function main(ns) {',
                `  const WORKER = ${JSON.stringify(WORKER)};`,
                '  for (const proc of ns.ps("home"))',
                '    if (proc.filename === WORKER) ns.kill(proc.pid);',
                '}',
            ].join('\n'), 'w');
            const homePid = ns.exec('/Temp/xp-init-home.js', 'home');
            if (homePid) {
                const dl = Date.now() + 3000;
                while (ns.isRunning(homePid) && Date.now() < dl) await ns.sleep(50);
            }
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