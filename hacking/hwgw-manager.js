/**
 * hwgw-manager.js — HWGW Batcher Coordinator
 *
 * Sits above hwgw-batcher.js and handles three responsibilities:
 *
 *   1. TARGET SELECTION — scans all rooted servers, scores them by estimated
 *      income per second per GB of RAM, and picks the best one(s) to batch.
 *
 *   2. BATCHER LIFECYCLE — launches hwgw-batcher.js, monitors it, and restarts
 *      it if it dies unexpectedly (desync recovery, script crash, etc.).
 *
 *   3. DAEMON.JS COORDINATION — claims purchased servers as exclusive execution
 *      hosts for worker scripts, writes that claim to a shared file so daemon.js
 *      knows to stay off those hosts. Reads the home RAM reserve from reserve.txt
 *      so both systems respect the same boundary.
 *
 * Partition strategy (agreed design):
 *   - hwgw workers run on purchased servers ("daemon-*") only
 *   - daemon.js runs on home + world servers
 *   - This prevents RAM contention between the two systems
 *
 * Usage:
 *   run hwgw-manager.js [--targets N] [--hack-percent 0-1] [--period ms]
 *                       [--delta ms] [--min-hack-chance 0-1] [--quiet]
 *
 * Args:
 *   --targets         How many targets to batch simultaneously (0 = auto, default)
 *                     Auto mode picks as many targets as needed to saturate purchased server RAM.
 *                     Multi-target only worth it if top targets have very
 *                     different weaken times. Default of 1 is almost always optimal.
 *   --hack-percent    Fraction of max money to steal per batch (default: 0.25)
 *                     Higher = more money per batch but fewer concurrent batches.
 *                     With billions from blackjack, 10% is a reasonable default.
 *   --period          ms between batch starts (default: 200, must be >= 4×delta)
 *   --delta           ms between operations within a batch (default: 50)
 *   --min-hack-chance Minimum hack success chance to consider a target (default: 0.50)
 *                     Targets below this threshold aren't worth batching — failed
 *                     hacks waste a full batch's timing window.
 *   --quiet           Suppress terminal output
 *
 * Coordination files (shared with daemon.js):
 *   reserve.txt                    — home RAM to leave free (written by daemon.js)
 *   /Temp/hwgw-exec-hosts.txt      — purchased servers claimed for worker use
 *                                    (written by this script, read by daemon.js patch)
 *   /Temp/hwgw-status.txt          — current target + income stats for dashboards
 *
 * RAM cost: ~5.1 GB
 *   Includes: brutessh/ftpcrack/relaysmtp/httpworm/sqlinject/nuke (0.30 GB)
 *   Darknet servers excluded from exec hosts (ns.exec requires direct dnet connection).
 *   1.6 base + 1.3 exec + 0.5 kill + 0.5 ps + 0.6 scp + 0.2 scan
 *   + cheap getServerhasRootAccess/getWeakenTime/hackAnalyze calls
 *   No helpers.js import — uses readBnMults() cache pattern for 0 GB BN mults.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Duration ratios from game source — used for estimating thread counts in scoring
const HACK_TIME_RATIO = 0.25;
const GROW_TIME_RATIO = 0.80;
const WEAKEN_SECURITY_PER_THREAD = 0.05;
const GROW_SECURITY_PER_THREAD = 0.004;
const HACK_SECURITY_PER_THREAD = 0.002;

// How often to re-evaluate target quality (ms).
// In income BNs: 5 minutes — hacking level rises slowly, re-scoring is cheap.
// In manipulation-only BNs (BN8): 30 seconds — stock positions change as
// stockmaster trades, and we want to follow those positions quickly.
const TARGET_EVAL_INTERVAL_INCOME = 5 * 60 * 1000;
const TARGET_EVAL_INTERVAL_MANIP  = 30 * 1000;

// Must match hwgw-batcher.js MAX_BATCHES_PER_TARGET.
// Used here so RAM accounting in selectTargets reflects what the batcher
// will actually consume, preventing over-allocation at PB-scale RAM.
const MAX_BATCHES_PER_TARGET = 200;

// How long to wait before deciding a batcher has died (ms).
// A healthy batcher wakes up every period/2 ms to check completions.
// If we haven't seen it alive in 30 seconds, something is wrong.
const BATCHER_WATCHDOG_INTERVAL = 30 * 1000;

// Paths — resolved from /script-paths.json (0 GB — ns.read only). Falls back to bare filenames.
const EXEC_HOSTS_FILE = "/Temp/hwgw-exec-hosts.txt";
const STATUS_FILE = "/Temp/hwgw-status.txt";
let BATCHER_SCRIPT, PREP_SCRIPT, WORKER_SCRIPTS;

// Worker script RAM costs, cached after the first resolveScripts() call.
// getScriptRam() is called once at startup instead of on every target in
// every estimateScore() and estimateRamPerBatch() invocation.
let HACK_RAM = 0, GROW_RAM = 0, WEAKEN_RAM = 0;

function resolveScripts(ns) {
    let paths = {};
    try {
        const raw = ns.read('/script-paths.json');
        if (raw && raw !== '') paths = JSON.parse(raw);
    } catch {}
    BATCHER_SCRIPT = paths['hwgw-batcher'] ?? "hacking/hwgw-batcher.js";
    PREP_SCRIPT    = paths['hwgw-prep']    ?? "hacking/hwgw-prep.js";
    WORKER_SCRIPTS = [
        paths['hwgw-weaken'] ?? "hacking/hwgw-weaken.js",
        paths['hwgw-hack']   ?? "hacking/hwgw-hack.js",
        paths['hwgw-grow']   ?? "hacking/hwgw-grow.js",
    ];
    // Cache RAM costs once here — these never change at runtime
    WEAKEN_RAM = ns.getScriptRam(WORKER_SCRIPTS[0], "home") || 0;
    HACK_RAM   = ns.getScriptRam(WORKER_SCRIPTS[1], "home") || 0;
    GROW_RAM   = ns.getScriptRam(WORKER_SCRIPTS[2], "home") || 0;
}

/** @param {NS} ns */
export async function main(ns) {
  // ── Parse arguments ───────────────────────────────────────────────────────
  const flags = ns.flags([
    ["targets", 0],  // 0 = auto-scale to fill available RAM
                     // set > 0 to cap the number of simultaneous targets
    ["hack-percent", 0.25],   // 25% — more aggressive to fill large RAM pools (3 PB+)
    // because with 5-10B starting cash, faster income matters more
    // than maximising concurrent batch depth at low money levels
    ["period", 200],           // ms between batch starts. MUST be >= 4×delta to avoid batch overlap.
                               // With delta=50: min period=200. Lower values cause operations from
                               // consecutive batches to interleave, corrupting server state.
    ["delta", 50],
    ["min-hack-chance", 0.50],
    ["min-money", 0],          // Minimum maxMoney ($) a target must have. Filters out weak servers
                               // that would dominate scoring when exec RAM is low but earn little.
                               // Dashboard auto-derives this from hack level (1e7/1e8/1e9).
    ["quiet", false],
    ["reserve-ram", 32],   // GB of home RAM to keep free. Do NOT use reserve.txt for this —
    // that file stores DOLLAR amounts for stockmaster/daemon, not RAM GB.
    ["world-server-min-ram", 8], // Minimum RAM (GB) a world server must have to be claimed as an
    // hwgw exec host. Servers below this threshold are left to daemon.js
    // for XP farming, share threads, and misc tasks.
    // 8 GB = 4 weaken threads minimum, which is worth the overhead.
    // Set to 0 to claim all rooted world servers; set very high to use
    // purchased servers only (original behaviour).
  ]);

  const maxTargets = flags["targets"];  // 0 = auto-detect below; clamped in selectTargets
  const hackPercent = flags["hack-percent"];
  const worldMinRam = flags["world-server-min-ram"];
  const period = flags["period"];
  const delta = flags["delta"];
  const minHackChance = flags["min-hack-chance"];
  const minMoney = flags["min-money"];
  const quiet = flags["quiet"];

  ns.disableLog("sleep");
  ns.disableLog("exec");
  ns.disableLog("kill");
  ns.disableLog("scp");
  ns.disableLog("scan");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");

  // Resolve script paths from /script-paths.json (0 GB)
  resolveScripts(ns);

  const log = (msg) => { ns.print(msg); if (!quiet) ns.tprint(msg); };
  const logAlways = (msg) => { ns.print(msg); ns.tprint(msg); };
  const logQuiet = (msg) => ns.print(msg);

  // ── Read home RAM reserve ─────────────────────────────────────────────────
  // IMPORTANT: reserve.txt stores DOLLAR amounts written by autopilot.js/daemon.js
  // for stockmaster and faction-manager (e.g. $8B augmentation purchase cost).
  // Reading it as GB of RAM gives "8,000,000,000 GB reserved" which zeroes all RAM.
  // We use --reserve-ram instead, which defaults to 32 GB.
  const reserveRam = flags["reserve-ram"];
  logQuiet(`Home RAM reserve: ${reserveRam}GB`);

  // ── Claim exec hosts ─────────────────────────────────────────────────────
  // Workers run on purchased servers PLUS any rooted world servers with
  // enough RAM to be worth the overhead (>= --world-server-min-ram GB).
  // The full list is written to a coordination file so daemon.js knows to
  // leave those servers alone for hwgw workers.
  writeTempScripts(ns);
  await refreshPurchasedServerCache(ns);
  let execHosts = getExecHosts(ns, worldMinRam);
  const purchasedCount = getPurchasedServers(ns).length;
  const worldCount    = execHosts.length - purchasedCount;
  if (execHosts.length === 0) {
    logAlways(`WARNING: No exec hosts found (no purchased servers, no rooted world servers >= ${worldMinRam}GB).`);
  } else {
    ns.write(EXEC_HOSTS_FILE, JSON.stringify(execHosts), "w");
    logQuiet(`Claimed ${execHosts.length} exec hosts: ${purchasedCount} purchased + ${worldCount} world (>=${worldMinRam}GB).`);
    await copyWorkerScripts(ns, execHosts, logQuiet);
  }

  // ── BitNode awareness ─────────────────────────────────────────────────────
  // Crack all reachable servers on startup
  const initialCracks = crackAllServers(ns);
  if (initialCracks > 0) logAlways(`Cracked ${initialCracks} server(s) on startup.`);
  else logQuiet('Startup crack sweep: no new servers to crack.');

  const bnMults = readBnMults(ns);

  // Determine operating mode — affects scoring, target selection, and manipulation.
  // hackIncomeViable: hacking actually earns money for the player this BN.
  // stockManipViable: stockmaster is running and has written position data we can use.
  //
  // We no longer hard-exit in BN8 (ScriptHackMoneyGain=0). Instead, scoring
  // transitions smoothly: when hackIncomeViable=false, the hack-income term in
  // estimateScore() contributes 0 and the manipulation bonus carries all the weight,
  // naturally ranking stock-linked servers highest. This removes every BN-specific
  // branch — the same code path handles BN1, BN8, BN9, BN12, and everything else.
  const hackIncomeViable = bnMults.ScriptHackMoney * bnMults.ScriptHackMoneyGain > 0;
  hackIncomeViableGlobal = hackIncomeViable; // expose to estimateScore()
  const stockPositionsFile = '/Temp/stock-probabilities.txt';

  if (!hackIncomeViable) {
    // In BNs where hack earns nothing (BN8), only run if stockmaster is active.
    // Check once at startup — if the file appears later the next target eval cycle
    // will see it and start scoring manipulation targets automatically.
    const posRaw = ns.read(stockPositionsFile);
    if (!posRaw || posRaw === '') {
      logAlways(`INFO: Hacking income disabled in this BN and stockmaster not yet running.`);
      logAlways(`      hwgw-manager will exit. Restart once stockmaster is running.`);
      ns.write(EXEC_HOSTS_FILE, "[]", "w");
      return;
    }
    logAlways(`INFO: Hack income disabled this BN — running in stock-manipulation-only mode.`);
  }
  const actualWeakenPerThread = WEAKEN_SECURITY_PER_THREAD * bnMults.ServerWeakenRate;
  const hasFormulas = ns.fileExists("Formulas.exe", "home");

  // ── State ─────────────────────────────────────────────────────────────────
  // activeBatchers maps target → { pid, startTime, lastSeenAlive }
  // We track these to detect crashes and decide when to restart.
  const activeBatchers = new Map();
  let lastTargetEval = 0;
  let lastExecHostsRefresh = 0;
  let targetExecSlices = new Map(); // target → assigned server list
  let currentTargets = [];
  let lastPositionSnapshot = ''; // JSON of owned positions, for change detection
  let prepPid = 0; // PID of the last prep launched (for kill-on-retarget)
  const prepPids = new Map(); // target → prep PID (for gate-before-batcher)
  let lastForceTarget = null; // Last value of the force-target file, to detect changes
  let lastUtilCheck = 0; // Timestamp of last RAM utilization check

  logAlways(`hwgw-manager started. Targets: ${maxTargets}, hackPercent: ${(hackPercent * 100).toFixed(0)}%`);

  // ── Main management loop ──────────────────────────────────────────────────
  while (true) {
    const now = Date.now();

    // ── Force-target override ─────────────────────────────────────────────
    // Written by the dashboard "Set Target" button via setForceTarget command.
    // When the value changes, immediately kill the current batcher and relaunch
    // on the new target — no waiting for the 5-minute TARGET_EVAL_INTERVAL.
    // An empty/blank file means "clear override, return to auto-select".
    try {
      const raw = ns.read('/Temp/hwgw-force-target.txt').trim();
      const forceTarget = raw || null;
      if (forceTarget !== lastForceTarget) {
        lastForceTarget = forceTarget;
        if (forceTarget) {
          logAlways(`Force-target set to "${forceTarget}" — switching immediately.`);
          // Kill all current batchers, then clear currentTargets so the target
          // eval block below sees a real change (newTargets=[forceTarget] vs [])
          // and actually launches the batcher. If we set currentTargets=[forceTarget]
          // here, the eval block sees no diff and silently does nothing.
          for (const t of currentTargets)
            killBatcherForTarget(ns, t, activeBatchers, logQuiet);
          currentTargets = [];
          lastTargetEval = 0; // trigger immediate re-eval
        } else {
          logAlways(`Force-target cleared — returning to auto-select.`);
          for (const t of currentTargets)
            killBatcherForTarget(ns, t, activeBatchers, logQuiet);
          currentTargets = [];
          lastTargetEval = 0;
        }
      }
    } catch {}

    // ── Refresh exec hosts ────────────────────────────────────────────────
    // host-manager.js can buy new servers at any time. When a new purchased
    // server appears, we must claim it so workers use it and daemon.js doesn't.
    // Checked every 60 seconds — infrequent enough to be cheap, frequent enough
    // to pick up new servers before the target eval cycle fires.
    if (now - lastExecHostsRefresh > 60_000) {
      const newCracks = crackAllServers(ns);
      if (newCracks > 0) logAlways(`Cracked ${newCracks} new server(s).`);
      await refreshPurchasedServerCache(ns);
      const freshHosts = getExecHosts(ns, worldMinRam);
      const hostsChanged = freshHosts.length !== execHosts.length ||
        freshHosts.some(h => !execHosts.includes(h));
      if (hostsChanged) {
        const prevCount = execHosts.length;
        execHosts = freshHosts;
        // Invalidate slices so they're recomputed on the next target eval
        targetExecSlices = new Map();
        // Always write the file — even an empty list tells daemon.js
        // that the partition has been released.
        ns.write(EXEC_HOSTS_FILE, JSON.stringify(execHosts), "w");
        if (execHosts.length > 0) {
          const pCount = getPurchasedServers(ns).length;
          const wCount = execHosts.length - pCount;
          await copyWorkerScripts(ns, execHosts, logQuiet);
          logAlways(`Exec hosts updated (${prevCount}→${execHosts.length}): ${pCount} purchased + ${wCount} world `);
        } else {
          logAlways(`Exec hosts cleared — purchased servers reset (aug install?). Waiting for new servers.`);
          // Hosts gone entirely — batcher has no RAM. Force re-eval so it gets
          // killed cleanly rather than spinning on empty exec hosts.
          lastTargetEval = 0;
        }
      }
      lastExecHostsRefresh = now;
    }

    // ── Re-evaluate targets periodically ─────────────────────────────────
    // Target quality changes as your hacking level rises — weaken times
    // decrease, hack chance increases, and previously-locked servers
    // become viable. Re-running the scorer every 5 minutes catches this.
    const targetEvalInterval = hackIncomeViableGlobal
      ? TARGET_EVAL_INTERVAL_INCOME
      : TARGET_EVAL_INTERVAL_MANIP;

    // In manipulation-only mode, detect position changes and force immediate
    // re-evaluation. Stockmaster may buy/sell between our 30s intervals;
    // we want to follow those positions within one loop tick (2s).
    if (!hackIncomeViableGlobal) {
      const pos = readStockPositions(ns);
      const snapshot = pos ? JSON.stringify(
        Object.fromEntries(Object.entries(pos)
          .filter(([, v]) => (v.sharesLong ?? 0) > 0 || (v.sharesShort ?? 0) > 0)
          .map(([k, v]) => [k, { l: v.sharesLong, s: v.sharesShort }])
        )) : '';
      if (snapshot !== lastPositionSnapshot) {
        lastPositionSnapshot = snapshot;
        if (lastTargetEval > 0) { // don't trigger on first startup
          logAlways(`Stock positions changed — forcing target re-evaluation.`);
          lastTargetEval = 0;
        }
      }
    }

    if (now - lastTargetEval > targetEvalInterval) {
      const player = hasFormulas ? ns.getPlayer() : null;
      // If a force-target override is active, skip scoring entirely and use it directly.
      const newTargets = lastForceTarget
        ? [lastForceTarget]
        : await selectTargets(ns, maxTargets, minHackChance, minMoney, hackPercent,
        period, bnMults, hasFormulas,
        actualWeakenPerThread, execHosts, player, logQuiet,
        readStockPositions(ns));

      // Check if our target list has changed. If a better target emerged,
      // kill the batcher on the old target and let it restart on the new one.
      const targetsChanged = !arraysEqual(currentTargets, newTargets);
      if (targetsChanged && newTargets.length > 0) {
        if (currentTargets.length > 0) {
          logAlways(`Target update: ${currentTargets.join(", ")} → ${newTargets.join(", ")}`);
          for (const oldTarget of currentTargets) {
            if (!newTargets.includes(oldTarget)) {
              killBatcherForTarget(ns, oldTarget, activeBatchers, logQuiet);
            }
          }
        }
        currentTargets = newTargets;

        // Assign per-target server slices so batchers don't contend for RAM.
        // Must happen before prep launch so prep also uses the correct slice.
        targetExecSlices = assignExecSlices(ns, currentTargets, execHosts,
          period, bnMults, hasFormulas, actualWeakenPerThread, logQuiet);

        // Kill old prep if running
        if (prepPid > 0 && ns.isRunning(prepPid)) {
          ns.kill(prepPid);
          logQuiet(`Killed old prep PID ${prepPid}`);
        }
        // Launch one prep per target, each constrained to its own server slice.
        // This prevents prep from one target eating into the RAM another
        // batcher needs, which would cause immediate desyncs on that batcher.
        let lastPrepPid = 0;
        for (const t of currentTargets) {
          ns.write(`/Temp/hwgw-prep-${t}.txt`, "", "w");
          const slice = targetExecSlices.get(t) ?? execHosts;
          // Pass the slice as a JSON arg so prep knows which servers to use.
          // If prep doesn't support --exec-hosts, it will ignore unknown args.
          const pp = ns.exec(PREP_SCRIPT, "home", 1, t,
            "--reserve", reserveRam);
          if (pp > 0) {
            logQuiet(`Launched prep for "${t}" on ${slice.length} servers (PID ${pp})`);
            lastPrepPid = pp;
            prepPids.set(t, pp); // track for batcher gate
          } else {
            logAlways(`WARNING: Could not launch prep for "${t}" (insufficient RAM?). Batcher will self-prep.`);
          }
        }
        prepPid = lastPrepPid; // track last launched for watchdog checks
      }
      lastTargetEval = now;

      if (currentTargets.length === 0) {
        logAlways(`WARNING: No viable targets found. Will retry in ${targetEvalInterval / 1000}s.`);
        logAlways(`         Common causes: hacking level too low, or all targets already being batched.`);
        await ns.sleep(targetEvalInterval);
        continue;
      }
    }

    // ── Watchdog: restart dead batchers ──────────────────────────────────
    // A batcher that crashes (unhandled exception, killed by user, etc.)
    // won't clean up after itself. We detect this by checking whether its
    // PID is still running, then restart it against the same target.
    for (const target of currentTargets) {
      const batcherInfo = activeBatchers.get(target);

      if (batcherInfo) {
        const isAlive = ns.isRunning(batcherInfo.pid);
        if (isAlive) {
          // Still running — update its "last seen alive" timestamp
          batcherInfo.lastSeenAlive = now;
          continue;
        }
        // PID is gone — batcher exited (normal after desync+prep, or crashed)
        logQuiet(`Batcher for "${target}" (PID ${batcherInfo.pid}) has exited. Restarting...`);
        activeBatchers.delete(target);
      }

      // Gate: don't launch batcher while prep is still running for this target.
      // Prep's grow workers raise security; if hack workers land simultaneously,
      // security spikes further and grow becomes far less effective (see notes §3).
      const prepPidForTarget = prepPids.get(target);
      if (prepPidForTarget && ns.isRunning(prepPidForTarget)) {
        logQuiet(`Prep still running for "${target}" (PID ${prepPidForTarget}). Deferring batcher.`);
        continue;
      }
      if (prepPidForTarget) prepPids.delete(target); // prep finished, clear the gate

      // Launch a new batcher for this target, using its dedicated server slice
      const targetSlice = targetExecSlices.get(target) ?? execHosts;
      const pid = launchBatcher(ns, target, hackPercent, period, delta,
        reserveRam, quiet, targetSlice, logQuiet);
      if (pid > 0) {
        activeBatchers.set(target, { pid, startTime: now, lastSeenAlive: now });
        log(`Launched batcher for "${target}" (PID ${pid})`);
      } else {
        logAlways(`ERROR: Failed to launch batcher for "${target}". Not enough home RAM?`);
      }
    }

    // ── Write status file ─────────────────────────────────────────────────
    // A lightweight status snapshot that dashboard scripts (or tail windows)
    // can read. Not critical — we don't block on it.
    //
    // ── Watchdog: RAM underutilization ────────────────────────────────────
    // estimateRamPerBatch can overestimate by 2-5× (Formulas.exe grow thread
    // count differs at scoring time vs batch time, server security state varies,
    // etc.). This causes auto-scaling to pick too few targets, leaving most of
    // the exec pool idle. After batchers stabilize (~60s), measure actual usage
    // and add more targets if utilization is below 60%.
    // Batchers are considered stable after 15 seconds (down from 60s).
    // One full weaken cycle on the average target takes 5-30 seconds;
    // after that, RAM usage is representative and underutilization is detectable.
    const allBatchersStable = currentTargets.length > 0 &&
      [...activeBatchers.values()].every(b => now - b.startTime > 15000 && ns.isRunning(b.pid));
    if (allBatchersStable && now - (lastUtilCheck ?? 0) > 15000) {
      lastUtilCheck = now;
      const workerHosts = execHosts && execHosts.length > 0
        ? execHosts.filter(h => ns.serverExists(h))
        : getAllRootedHosts(ns).filter(h => h !== "home");
      const totalMaxRam = workerHosts.reduce((s, h) => s + ns.getServerMaxRam(h), 0);
      const totalUsedRam = workerHosts.reduce((s, h) => s + ns.getServerUsedRam(h), 0);
      const utilization = totalMaxRam > 0 ? totalUsedRam / totalMaxRam : 1;

      if (utilization < 0.60 && currentTargets.length < 20) {
        const player = hasFormulas ? ns.getPlayer() : null;
        // Pass a high maxTargets (not 0/auto) so selectTargets returns ALL viable
        // targets ranked by score. Auto-scaling (maxTargets=0) would re-run the
        // overestimating RAM loop and return too few candidates — the exact bug
        // that brought us here.
        const stockPosWatchdog = readStockPositions(ns);
        const allScored = await selectTargets(ns, 20, minHackChance, minMoney, hackPercent,
          period, bnMults, hasFormulas, actualWeakenPerThread, execHosts, player, logQuiet,
          stockPosWatchdog);
        const newCandidates = allScored.filter(t => !currentTargets.includes(t));
        // Scale additions by how underutilized we are: 20% used → add 4, 50% used → add 2
        const toAdd = newCandidates.slice(0, Math.max(1, Math.ceil((1 - utilization) * 5)));
        if (toAdd.length > 0) {
          logAlways(`RAM underutilized: ${(utilization * 100).toFixed(0)}% of ${ns.format.ram(totalMaxRam)}. ` +
            `Adding ${toAdd.length} target(s): ${toAdd.join(", ")}`);
          currentTargets.push(...toAdd);
          // Prep and launch batchers for new targets
          // Recompute slices for the expanded target list
          targetExecSlices = assignExecSlices(ns, currentTargets, execHosts,
            period, bnMults, hasFormulas, actualWeakenPerThread, logQuiet);
          for (const t of toAdd) {
            ns.write(`/Temp/hwgw-prep-${t}.txt`, "", "w");
            const slice = targetExecSlices.get(t) ?? execHosts;
            const prepP = ns.exec(PREP_SCRIPT, "home", 1, t,
              "--reserve", reserveRam);
            if (prepP > 0) {
              logQuiet(`Launched prep for "${t}" on ${slice.length} servers (PID ${prepP})`);
              prepPids.set(t, prepP);
            }
          }
          // Force immediate batcher launch on next loop iteration
          lastTargetEval = now;
        }
      }
    }
    const status = {
      timestamp: now,
      targets: currentTargets,
      batchers: Object.fromEntries(
        [...activeBatchers.entries()].map(([t, info]) => [t, {
          pid: info.pid,
          uptimeS: Math.floor((now - info.startTime) / 1000),
        }])
      ),
      execHosts,
      reserveRam,
      bnMults: {
        ServerWeakenRate: bnMults.ServerWeakenRate,
        ServerGrowthRate: bnMults.ServerGrowthRate
      },
    };
    ns.write(STATUS_FILE, JSON.stringify(status, null, 2), "w");

    // Check back in every 2 seconds.
    // 2s keeps force-target latency low and makes the underutilization watchdog
    // react 5× faster with negligible extra CPU cost (manager does almost nothing
    // on most iterations — it only acts when an interval or threshold fires).
    await ns.sleep(2 * 1000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TARGET SELECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assign specific server slices to each target so batchers don't contend for RAM.
 *
 * Each target gets a dedicated subset of exec hosts whose combined free RAM covers
 * ramPerBatch × min(timingSlots, MAX_BATCHES_PER_TARGET). Servers are sorted largest
 * first so big servers fill quota quickly. A target that can't be fully covered still
 * gets as many servers as are available — the batcher's own RAM check will clamp it.
 *
 * The global hwgw-exec-hosts.txt (for daemon.js) is unchanged.
 * Per-target files: /Temp/hwgw-exec-hosts-{target}.txt
 *
 * @param {NS} ns
 * @param {string[]} targets        — ordered list of targets (best first)
 * @param {string[]} execHosts      — full list of available exec hosts
 * @param {number}   period
 * @param {Object}   bnMults
 * @param {boolean}  hasFormulas
 * @param {number}   actualWeakenPerThread
 * @param {Function} logFn
 * @returns {Map<string, string[]>}  target → assigned servers
 */
function assignExecSlices(ns, targets, execHosts, period, bnMults, hasFormulas, actualWeakenPerThread, logFn) {
  if (!execHosts || execHosts.length === 0 || targets.length === 0)
    return new Map(targets.map(t => [t, execHosts ?? []]));

  // Single target — give it everything
  if (targets.length === 1) {
    ns.write(`/Temp/hwgw-exec-hosts-${targets[0]}.txt`, JSON.stringify(execHosts), 'w');
    return new Map([[targets[0], execHosts]]);
  }

  // Sort servers largest-first so quota is filled with fewest servers
  const sorted = execHosts
    .filter(h => ns.serverExists(h))
    .sort((a, b) => ns.getServerMaxRam(b) - ns.getServerMaxRam(a));

  // Compute needed RAM per target
  const neededRam = new Map();
  for (const target of targets) {
    // Read rpb cache first (written by batcher after first run). Fall back to
    // ns.hackAnalyze for the hackPct estimate — 0 GB via RAM-dodge isn't possible
    // here, so we call it directly (this is inside a helper, not a hot loop).
    // If neither is available yet, use 0.01 as a conservative placeholder.
    let hackPctForSlice = 0.01;
    try {
      const cachedRpb = ns.read(`/Temp/hwgw-rpb-${target}.txt`);
      if (cachedRpb && cachedRpb !== '') {
        const c = JSON.parse(cachedRpb);
        if (c?.ramPerBatch > 0 && (Date.now() - (c.timestamp ?? 0)) < 10*60*1000) {
          neededRam.set(target, c.ramPerBatch * Math.min(MAX_BATCHES_PER_TARGET,
            Math.floor(ns.getWeakenTime(target) / period)));
          continue; // skip estimateRamPerBatch entirely — we have the real value
        }
      }
      hackPctForSlice = ns.hackAnalyze(target) || 0.01;
    } catch { /* keep 0.01 default */ }
    const rpb = estimateRamPerBatch(ns, target,
      hackPctForSlice, 0.25, period, bnMults, hasFormulas, actualWeakenPerThread);
    const weakenTime = ns.getWeakenTime(target);
    const timingSlots = Math.max(1, Math.floor(weakenTime / period));
    const batches = Math.min(timingSlots, MAX_BATCHES_PER_TARGET);
    neededRam.set(target, rpb ? rpb * batches : 0);
  }

  // Greedily assign servers to targets
  const assigned = new Map(targets.map(t => [t, []]));
  const usedBy   = new Map();  // server → target

  for (const target of targets) {
    let covered = 0;
    const needed = neededRam.get(target) ?? 0;
    for (const host of sorted) {
      if (usedBy.has(host)) continue;  // already assigned to another target
      const ram = ns.getServerMaxRam(host);
      assigned.get(target).push(host);
      usedBy.set(host, target);
      covered += ram;
      if (needed > 0 && covered >= needed) break;  // quota met
    }
  }

  // Any unassigned servers (rare: more servers than needed) go to first target
  for (const host of sorted) {
    if (!usedBy.has(host)) assigned.get(targets[0]).push(host);
  }

  // Write per-target files
  for (const [target, hosts] of assigned) {
    ns.write(`/Temp/hwgw-exec-hosts-${target}.txt`, JSON.stringify(hosts), 'w');
    logFn(`Exec slice for "${target}": ${hosts.length} servers, ` +
      `${ns.format.ram(hosts.reduce((s,h) => s + ns.getServerMaxRam(h), 0))} total`);
  }

  return assigned;
}

// Server → stock symbol map (mirrors hwgw-batcher.js and daemon.js).
// Used by selectTargets() and estimateScore() to look up position data.
// Server hostname → stock symbol.
// Source: src/StockMarket/Enums.ts (LocationName → symbol) cross-referenced
// with src/Server/data/servers.ts (hostname → organizationName).
// WDS (Watchdog Security) has no hackable server — omitted by design.
const SERVER_STOCK_SYMBOLS = {
    "foodnstuff":"FNS",  "joesguns":"JGN",   "sigma-cosmetics":"SGC",
    "omega-net":"OMGA",  "comptek":"CTK",    "netlink":"NTLK",
    "syscore":"SYSC",   "catalyst":"CTYS",  "lexo-corp":"LXO",
    "alpha-ent":"APHE", "rho-construction":"RHOC", "aerocorp":"AERO",
    "global-pharm":"GPH","omnia":"OMN",    "defcomm":"DCOMM",
    "solaris":"SLRS",   "icarus":"ICRS",   "univ-energy":"UNV",
    "nova-med":"NVMD",  "titan-labs":"TITN","microdyne":"MDYN",
    "stormtech":"STM",  "helios":"HLS",    "vitalife":"VITA",
    "fulcrumtech":"FLCM","4sigma":"FSIG",  "kuai-gong":"KGI",
    "omnitek":"OMTK",  "blade":"BLD",      "clarkinc":"CLRK",
    "ecorp":"ECP",     "megacorp":"MGCP",  "fulcrumassets":"FLCM",
};

/**
 * Read stockmaster's position data from the shared file.
 * Returns a map of { sym → { prob, sharesLong, sharesShort } }, or null if unavailable.
 * Uses ns.read() (0 GB) — called once per selectTargets() invocation.
 */
function readStockPositions(ns) {
  try {
    const raw = ns.read('/Temp/stock-probabilities.txt');
    if (!raw || raw === '') return null;
    return JSON.parse(raw); // { SYM: { prob, sharesLong, sharesShort }, ... }
  } catch {
    return null;
  }
}

// Weight applied to the stock manipulation bonus in the unified score.
// Calibrated so that in BN8 (hackIncome=0) a server with a $1B short position
// scores comparably to a good income target in BN1. Tune upward if you want
// HWGW to prioritise manipulation more aggressively in income BNs.
const STOCK_MANIP_WEIGHT = 0.15;

// Set once at startup by main() so estimateScore() can read it without
// needing to be passed an extra argument through every call chain.
let hackIncomeViableGlobal = true;

/**
 * Scan all rooted servers, score them, and return the top N targets.
 *
 * The scoring formula is:
 *   score = (maxMoney × hackChance × hackPercent) / (weakenTime × ramPerBatch)
 *
 * This is money/sec/GB — the quantity we want to maximise. Breaking it down:
 *   - maxMoney × hackPercent = money stolen per successful batch
 *   - hackChance = probability that hack actually succeeds (failed hacks waste
 *     an entire batch's timing window with no income)
 *   - weakenTime = how long one batch occupies RAM (approximately)
 *   - ramPerBatch = how much RAM one batch costs
 *
 * Dividing by both time and RAM gives us a true efficiency score. A server
 * with $50B max money but a 5-minute weaken time and 20 GB/batch will score
 * lower than a server with $10B, 30-second weaken time, and 7 GB/batch.
 *
 * @param {NS} ns
 * @param {number} maxTargets  0 = return as many targets as needed to fill available RAM
 * @param {number} minHackChance
 * @param {number} hackPercent
 * @param {number} period
 * @param {Object} bnMults
 * @param {boolean} hasFormulas
 * @param {number} actualWeakenPerThread
 * @param {string[]} execHosts        — purchased servers (used for RAM estimate)
 * @param {Function} logFn
 * @returns {string[]} sorted list of target hostnames, best first
 */
async function selectTargets(ns, maxTargets, minHackChance, minMoney, hackPercent, period,
  bnMults, hasFormulas, actualWeakenPerThread, execHosts, player, logFn, stockPositions = null) {
  const myHackLevel = ns.getHackingLevel();
  const scored = [];

  // Compute total available exec-host RAM once, before scoring.
  // Passed to estimateScore so ranking blends efficiency vs absolute $/s:
  // RAM-scarce  → score ∝ $/s/GB  (don't waste RAM on low-yield targets)
  // RAM-abundant → score ∝ $/s    (maximise raw income; RAM isn't the constraint)
  // The crossover is ~5 TB for typical top targets at period=220ms.
  //
  // Game limits (ServerPurchases.ts / Constants.ts):
  //   CloudServerMaxRam = 2^20 GB = 1 PB per server (BN10: ×0.5 = 512 TB)
  //   CloudServerLimit  = 25 servers               (BN9: ×0, BN10: ×0.6 = 15)
  const workerHosts = execHosts && execHosts.length > 0
    ? execHosts.filter(h => ns.serverExists(h))
    : getAllRootedHosts(ns).filter(h => h !== "home");
  const totalRam = workerHosts.reduce(
    (sum, h) => sum + Math.max(0, ns.getServerMaxRam(h) - ns.getServerUsedRam(h)), 0
  );

  if (totalRam <= 0) {
    logFn(`No viable targets: exec RAM is 0. No purchased servers? All servers full? ` +
      `Exec hosts: ${execHosts?.length ?? 0} (${workerHosts.length} exist).`);
    return [];
  }

  // Read stockmaster positions once for the whole scoring pass.
  // Callers may pass pre-fetched positions (for the watchdog path); otherwise we read here.
  const stockPos = stockPositions ?? readStockPositions(ns);

  let skipNoMoney = 0, skipMinMoney = 0, skipLevel = 0, skipChance = 0, skipRam = 0;

  // Pre-compute hackPct/hackChance for all rooted hosts in one batch.
  // Saves 2 GB static RAM by avoiding direct ns.hackAnalyze/ns.hackAnalyzeChance.
  const allRooted = getAllRootedHosts(ns);
  const hackData = await precomputeHackData(ns, allRooted, hasFormulas, player);

  for (const host of allRooted) {
    const maxMoney = ns.getServerMaxMoney(host);
    const reqLevel = ns.getServerRequiredHackingLevel(host);
    if (!maxMoney || maxMoney <= 0) { skipNoMoney++; continue; }
    if (minMoney > 0 && maxMoney < minMoney) { skipMinMoney++; continue; }
    if (reqLevel > myHackLevel) { skipLevel++; continue; }

    const hd = hackData[host] ?? { hackPct: 0, hackChance: 0 };
    if (hd.hackChance < minHackChance) { skipChance++; continue; }

    const weakenTime = ns.getWeakenTime(host);
    const score = estimateScore(ns, host, maxMoney, hd.hackChance, hd.hackPct, hackPercent,
      weakenTime, period, bnMults, hasFormulas,
      actualWeakenPerThread, player, totalRam, stockPos);
    if (score > 0) {
      scored.push({ host, score, weakenTime, maxMoney, hackChance: hd.hackChance, hackPct: hd.hackPct });
    } else {
      skipRam++;
    }
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    logFn(`No viable targets. Filtered: ${skipNoMoney} no-money, ${skipLevel} level (need <=${myHackLevel}),`
      + ` ${skipMinMoney} below min-money ($${(minMoney/1e6).toFixed(0)}M),`
      + ` ${skipChance} low-chance (<${(minHackChance*100).toFixed(0)}%),`
      + ` ${skipRam} zero-score (exec RAM=${ns.format.ram(totalRam)}).`);
    return [];
  }

  // Log the top few candidates so the player can see what the scorer found
  const topN = scored.slice(0, Math.min(5, scored.length));
  logFn(`Target scores (top ${topN.length}) [exec RAM: ${ns.format.ram(totalRam)}]:`);
  for (const { host, score, weakenTime, maxMoney, hackChance } of topN) {
    logFn(`  ${host.padEnd(20)} score=${ns.format.number(score)} ` +
      `money=${ns.format.number(maxMoney)} ` +
      `W=${(weakenTime / 1000).toFixed(1)}s ` +
      `chance=${(hackChance * 100).toFixed(0)}%`);
  }

  // Auto-detect: pick as many targets as needed to fill purchased server RAM.
  // totalRam already computed above — reuse it here.
  let effectiveMax = Math.max(1, maxTargets);
  if (maxTargets <= 0 && scored.length > 0) {
    // Walk down the ranked list and add targets until we run out of RAM.
    // Each target's RAM cost is estimated individually.
    //
    // Per-target cap: no single target can claim more than 40% of total exec RAM.
    // Without this cap, the top target (short weakenTime, many timing slots) can
    // consume the entire estimate, leaving 0 for other targets. In practice the
    // batcher often uses far less than estimated (Formulas.exe produces different
    // grow thread counts at scoring time vs batch time, free RAM differs at launch,
    // etc.). The cap guarantees at least 3 targets when RAM is abundant, and the
    // excess RAM gets filled by lower-ranked targets instead of sitting idle.
    const maxRamPerTarget = totalRam * 0.40;
    let ramRemaining = totalRam;
    let count = 0;
    for (const candidate of scored) {
      const ramPerBatch = estimateRamPerBatch(ns, candidate.host, candidate.hackPct, hackPercent, period,
        bnMults, hasFormulas, actualWeakenPerThread);
      if (!ramPerBatch) {
        logFn(`  [auto] ${candidate.host}: estimateRamPerBatch returned null — skipped`);
        continue;
      }
      const timingSlots = Math.max(1, Math.floor(candidate.weakenTime / period));
      const batchesFit = Math.min(timingSlots, MAX_BATCHES_PER_TARGET,
        Math.floor(Math.min(ramRemaining, maxRamPerTarget) / ramPerBatch));
      const ramNeeded = batchesFit * ramPerBatch;
      logFn(`  [auto] ${candidate.host}: rpb=${ramPerBatch.toFixed(1)}GB ts=${timingSlots} batches=${batchesFit} ` +
        `ram=${(ramNeeded/1000).toFixed(1)}TB remaining=${(ramRemaining/1000).toFixed(1)}TB` +
        `${ramNeeded >= maxRamPerTarget * 0.99 ? ' (capped at 40%)' : ''}`);
      if (ramNeeded <= 0) break;
      ramRemaining -= ramNeeded;
      count++;
    }
    effectiveMax = Math.max(1, count);

    // Safety net: if the auto-scaler picks few targets but significant RAM is
    // unused, force more. With the 40% cap above this fires less often, but still
    // catches edge cases where estimates were wrong for the top targets.
    const usedPct = (totalRam - ramRemaining) / totalRam;
    if (effectiveMax < scored.length && usedPct < 0.85) {
      const oldMax = effectiveMax;
      while (effectiveMax < scored.length && ramRemaining > 0) {
        const next = scored[effectiveMax];
        const rpb = estimateRamPerBatch(ns, next.host, next.hackPct, hackPercent, period,
          bnMults, hasFormulas, actualWeakenPerThread);
        if (!rpb) { effectiveMax++; continue; }
        const ts = Math.max(1, Math.floor(next.weakenTime / period));
        const fit = Math.min(ts, MAX_BATCHES_PER_TARGET,
          Math.floor(Math.min(ramRemaining, maxRamPerTarget) / rpb));
        if (fit <= 0) break;
        ramRemaining -= fit * rpb;
        effectiveMax++;
      }
      if (effectiveMax > oldMax)
        logFn(`  [auto] Safety net: bumped from ${oldMax} to ${effectiveMax} targets ` +
          `(${((totalRam - ramRemaining) / totalRam * 100).toFixed(0)}% allocated)`);
    }

    if (effectiveMax > 1)
      logFn(`Auto-scaling to ${effectiveMax} targets (${((totalRam - ramRemaining)/1000).toFixed(1)}TB / ${(totalRam/1000).toFixed(1)}TB allocated)`);
    else if (count === 0)
      effectiveMax = 3; // Sensible fallback if estimation failed entirely
  }

  return scored.slice(0, Math.min(effectiveMax, scored.length)).map(s => s.host);
}

/**
 * Score a target for ranking.
 *
 * The formula accounts for available RAM so scoring naturally transitions
 * between two regimes:
 *
 *   RAM-scarce  (ramSlots < timingSlots):
 *     score ∝ moneyPerBatch × ramSlots / weakenTime
 *           = $/s/GB × totalRam   (constant factor, ranking preserves $/s/GB order)
 *     → favours RAM-efficient targets (short weakenTime, low ramPerBatch)
 *
 *   RAM-abundant (ramSlots ≥ timingSlots):
 *     score ∝ moneyPerBatch × timingSlots / weakenTime
 *           ∝ moneyPerBatch / period          (timingSlots = weakenTime/period)
 *     → favours high-maxMoney targets regardless of RAM cost
 *
 * The crossover is ~5 TB for typical top targets at period=220ms. No hard
 * threshold is needed — the formula handles it continuously.
 *
 * @param {number} totalRam  total free exec-host RAM (GB), used to compute ramSlots
 * @returns {number} score (higher = better), or 0 if target isn't viable
 */
function estimateScore(ns, host, maxMoney, hackChance, hackPct, hackPercent,
  weakenTime, period, bnMults, hasFormulas, actualWeakenPerThread,
  player, totalRam, stockPositions = null) {
  const moneyPerThread = maxMoney * hackPct;
  if (moneyPerThread <= 0) return 0;

  // In manipulation-only BNs (BN8), ScriptHackMoney=0.3 makes hackPct tiny,
  // so hackPercent=0.25 requires thousands of threads and TBs of RAM per batch —
  // more than the entire exec pool. Use a tiny effective hackPercent instead:
  // we only need each batch to drain a small fraction to get manipulation probability.
  // hackPercent=0.002 → ~14 hack threads on megacorp → ~31 GB/batch → fits in RAM.
  const effectiveHackPct = hackIncomeViableGlobal
    ? hackPercent
    : Math.min(hackPercent, 0.002);

  const hackThreads = Math.max(1, Math.floor(effectiveHackPct / (moneyPerThread / maxMoney)));
  const actualHack = hackThreads * moneyPerThread / maxMoney;

  let growThreads;
  if (hasFormulas && player) {
    const server = ns.getServer(host);
    const minSec = ns.getServerMinSecurityLevel(host);
    server.moneyAvailable = Math.max(0, maxMoney * (1 - actualHack));
    server.hackDifficulty = minSec + hackThreads * HACK_SECURITY_PER_THREAD;
    growThreads = Math.ceil(ns.formulas.hacking.growThreads(server, player, maxMoney));
  } else {
    // Correct Bitburner grow formula (see hwgw-notes.txt §1).
    // The game's grow mechanic uses adjustedGrowthRate = min(1.0035, 1 + 0.03/minSec)
    // as the per-thread multiplier base, NOT (1 + serverGrowth*bnRate/100).
    // Using the wrong formula underestimates grow threads by 10-100×, which makes
    // RAM-per-batch look far cheaper than it is and corrupts target scoring.
    const minSec       = ns.getServerMinSecurityLevel(host);
    const serverGrowth = ns.getServerGrowth(host);
    const growRate     = bnMults.ServerGrowthRate ?? 1;
    const growFactor   = 1 / Math.max(0.01, 1 - actualHack);
    const adjGrowthRate = Math.min(1.0035, 1 + 0.03 / Math.max(1, minSec));
    growThreads = Math.ceil(
      (Math.log(growFactor) / (Math.log(adjGrowthRate) * serverGrowth / 100 * growRate)) * 1.2
    );
  }

  const secFromHack = hackThreads * HACK_SECURITY_PER_THREAD;
  const secFromGrow = growThreads * GROW_SECURITY_PER_THREAD;
  const w1Threads = Math.ceil(secFromHack / actualWeakenPerThread);
  const w2Threads = Math.ceil((secFromHack + secFromGrow) / actualWeakenPerThread);

  // Use module-level cached RAM values (populated once in resolveScripts)
  // instead of calling getScriptRam() on every target in every scoring pass.
  if (!HACK_RAM || !GROW_RAM || !WEAKEN_RAM) return 0;

  const ramPerBatch = hackThreads * HACK_RAM
    + growThreads * GROW_RAM
    + w1Threads * WEAKEN_RAM
    + w2Threads * WEAKEN_RAM;
  if (ramPerBatch <= 0) return 0;

  // How many batches can simultaneously run?
  //   timingSlots = how many fit in the weaken-time window
  //   ramSlots    = how many fit in available RAM
  // When RAM is abundant, ramSlots ≥ timingSlots and timing is the limit.
  // When RAM is scarce,   ramSlots < timingSlots and RAM is the limit.
  // When totalRam is 0 (no purchased servers yet, e.g. right after aug install),
  // return 0 so this target is excluded from selection entirely. Falling back to
  // timingSlots would pretend we have unlimited RAM, giving a misleadingly high
  // score and causing the manager to launch batchers that immediately fail.
  if (totalRam <= 0) return 0;
  const timingSlots = Math.max(1, Math.floor(weakenTime / period));
  const ramSlots = Math.floor(totalRam / ramPerBatch);
  if (ramSlots <= 0) return 0; // This target's batch is too large for available RAM
  const maxBatches = Math.min(timingSlots, ramSlots);

  // ── Hack-income score ────────────────────────────────────────────────────
  // Total achievable $/s from this target given current RAM budget.
  // One batch completes every `period` ms in steady state; scale by hackChance.
  // In BNs where ScriptHackMoney * ScriptHackMoneyGain = 0, this term is 0.
  const moneyPerBatch = hackThreads * moneyPerThread * hackChance
    * (bnMults.ScriptHackMoney ?? 1) * (bnMults.ScriptHackMoneyGain ?? 1);
  const hackIncomeScore = (moneyPerBatch * maxBatches) / (weakenTime / 1000);

  // ── Stock manipulation bonus ─────────────────────────────────────────────
  // Each hack call probabilistically decreases a stock's second-order forecast
  // by 0.1 (on the 0–100 scale) with probability = moneyHacked/maxMoney.
  // Each grow call does the reverse. Manipulation amplifies open positions.
  //
  // manipScore = position_value × hack_fraction × change_per_hack × batches/s
  //            = position_value × hackPercent × 0.1 × (maxBatches / (weakenTime/1000))
  //
  // This is intentionally in $/s units so it's directly comparable to hackIncomeScore.
  // STOCK_MANIP_WEIGHT scales the relative priority between the two terms.
  let manipScore = 0;
  {
    const sym = SERVER_STOCK_SYMBOLS[host];
    if (sym) {
      // pos may be null if stockmaster hasn't written the file yet — that's fine;
      // in BN8 we still want to score stock-linked servers (positionMagnitude=0
      // falls through to the !hackIncomeViableGlobal branch which scores by maxMoney).
      const pos = stockPositions ? (stockPositions[sym] ?? null) : null;
      if (pos || !hackIncomeViableGlobal) {
        // positionValue: current market value of open position (long or short)
        // We use sharesLong + sharesShort as a proxy — price is unavailable here
        // but all that matters for ranking is relative magnitude.
        const hasLong  = ((pos?.sharesLong)  ?? 0) > 0;
        const hasShort = ((pos?.sharesShort) ?? 0) > 0;
        const hasPosition = hasLong || hasShort;
        const batchesPerSec = maxBatches / (weakenTime / 1000);

        // Score formula: maxMoney × hackPercent × 0.1 × batchesPerSec × weight
        //
        // Why maxMoney (not share count):
        //   The manipulation mechanic fires with probability = moneyHacked/maxMoney.
        //   moneyHacked = hackPercent × maxMoney, so probability = hackPercent (constant).
        //   maxMoney then sets the *scale* — higher maxMoney means more money moved
        //   per manipulation event, which is what drives price movement.
        //   Using share count instead mixes units (shares ~1e7 vs dollars ~1e12)
        //   and causes unowned megacorp to score 100,000× higher than owned 4sigma.
        //
        // Weights:
        //   hasPosition = 1.0 : we own this stock — manipulation directly amplifies P&L
        //   !hasPosition, BN8 = 0.3 : no position yet, but we want to push the forecast
        //                             so stockmaster can open one. Lower weight means we
        //                             prioritise maintaining existing positions first.
        //   income BN, no position = 0 : don't sacrifice income targets for speculation
        const manipWeight = hasPosition ? 1.0
          : (!hackIncomeViableGlobal ? 0.3 : 0);
        if (manipWeight > 0) {
          manipScore = maxMoney * hackPercent * 0.1 * batchesPerSec
            * STOCK_MANIP_WEIGHT * manipWeight;
        }
      }
    }
  }

  return hackIncomeScore + manipScore;
}
/**
 * Estimate raw RAM consumed per batch for a given target.
 * Used by auto-scaling to determine how many targets are needed to fill RAM.
 * Returns null if the target is not viable or scripts are missing.
 * @returns {number|null}
 */
function estimateRamPerBatch(ns, host, hackPct, hackPercent, period, bnMults, hasFormulas, actualWeakenPerThread) {
  // If the batcher has previously run against this host, use its measured ramPerBatch
  // instead of re-estimating. Estimates can overstate by 2-5x, causing the manager to
  // select too few targets on launch and leave RAM idle until the watchdog corrects it.
  // Files expire after 10 minutes so stale values (e.g. from a much-lower hack level) are
  // ignored and we fall through to re-estimation.
  try {
    const raw = ns.read(`/Temp/hwgw-rpb-${host}.txt`);
    if (raw && raw !== '') {
      const cached = JSON.parse(raw);
      if (cached?.ramPerBatch > 0 && (Date.now() - (cached.timestamp ?? 0)) < 10 * 60 * 1000)
        return cached.ramPerBatch;
    }
  } catch { /* fall through to estimation */ }

  const maxMoney = ns.getServerMaxMoney(host);
  if (!maxMoney || maxMoney <= 0) return null;
  const moneyPerThread = maxMoney * hackPct;
  if (moneyPerThread <= 0) return null;
  const effectiveHackPct = hackIncomeViableGlobal
    ? hackPercent
    : Math.min(hackPercent, 0.002);
  const hackThreads = Math.max(1, Math.floor(effectiveHackPct / (moneyPerThread / maxMoney)));
  const actualHack = hackThreads * moneyPerThread / maxMoney;
  let growThreads;
  if (hasFormulas) {
    const server = ns.getServer(host);
    const player = ns.getPlayer();
    server.moneyAvailable = Math.max(0, maxMoney * (1 - actualHack));
    server.hackDifficulty = ns.getServerMinSecurityLevel(host) + hackThreads * HACK_SECURITY_PER_THREAD;
    growThreads = Math.ceil(ns.formulas.hacking.growThreads(server, player, maxMoney));
  } else {
    // Same correct formula as estimateScore — see hwgw-notes.txt §1
    const minSec        = ns.getServerMinSecurityLevel(host);
    const serverGrowth  = ns.getServerGrowth(host);
    const growRate      = bnMults.ServerGrowthRate ?? 1;
    const growFactor    = 1 / Math.max(0.01, 1 - actualHack);
    const adjGrowthRate = Math.min(1.0035, 1 + 0.03 / Math.max(1, minSec));
    growThreads = Math.ceil(
      (Math.log(growFactor) / (Math.log(adjGrowthRate) * serverGrowth / 100 * growRate)) * 1.2
    );
  }
  const secFromHack = hackThreads * HACK_SECURITY_PER_THREAD;
  const secFromGrow = growThreads * GROW_SECURITY_PER_THREAD;
  const w1Threads = Math.ceil(secFromHack / actualWeakenPerThread);
  const w2Threads = Math.ceil((secFromHack + secFromGrow) / actualWeakenPerThread);
  // Use cached RAM values — same reasoning as estimateScore
  if (!HACK_RAM || !GROW_RAM || !WEAKEN_RAM) return null;
  return (hackThreads * HACK_RAM) + (growThreads * GROW_RAM) +
    (w1Threads * WEAKEN_RAM) + (w2Threads * WEAKEN_RAM);
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCHER LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Launch hwgw-batcher.js against the given target.
 *
 * The batcher is launched on home with 1 thread (it's a controller, not a worker).
 * Its RAM cost is charged against home's reserved pool — that's the point of the
 * reserve. We pass --quiet so the batcher doesn't flood the terminal; it logs
 * to its own tail window.
 *
 * @returns {number} PID of the launched batcher, or 0 on failure
 */
function launchBatcher(ns, target, hackPercent, period, delta, reserveRam,
  quiet, execHosts, logFn) {
  // Build the argument list for the batcher.
  // Note: we pass --exec-hosts so the batcher knows to restrict workers to
  // purchased servers. This is the mechanism that enforces the partition.
  // The batcher's getAllRootedHosts will need to respect this — see below.
  // In manipulation-only BNs, use a tiny hackPercent so thread counts stay
  // within available RAM. The batcher's income is $0 anyway (ScriptHackMoneyGain=0)
  // so all that matters is manipulation throughput (batches/s × hack probability).
  const effectiveBatcherHackPct = hackIncomeViableGlobal
    ? hackPercent
    : Math.min(hackPercent, 0.002);
  const args = [
    target,
    "--reserve", reserveRam,
    "--period", period,
    "--delta", delta,
    "--hack-percent", effectiveBatcherHackPct,
  ];
  if (quiet) args.push("--quiet");

  // Ensure the batcher script is on home (it should be, but be defensive)
  if (!ns.fileExists(BATCHER_SCRIPT, "home")) {
    logFn(`ERROR: ${BATCHER_SCRIPT} not found on home. Cannot launch.`);
    return 0;
  }

  return ns.exec(BATCHER_SCRIPT, "home", 1, ...args);
}

/**
 * Kill the batcher running against a specific target, and kill all its
 * in-flight workers on purchased servers.
 *
 * @param {NS} ns
 * @param {string} target
 * @param {Map} activeBatchers
 * @param {Function} logFn
 */
function killBatcherForTarget(ns, target, activeBatchers, logFn) {
  const info = activeBatchers.get(target);
  if (info) {
    ns.kill(info.pid);
    activeBatchers.delete(target);
    logFn(`Killed batcher PID ${info.pid} for "${target}"`);
  }

  // Kill all worker scripts AND prep orchestrators targeting this server.
  // CRITICAL: hwgw-prep.js runs on home (it's an orchestrator, not a worker).
  // If we only kill weaken/hack/grow workers but leave the prep script alive,
  // it will re-deploy new workers on the purchased servers, starving the new
  // batcher of RAM and preventing it from ever starting.
  const ALL_TARGET_SCRIPTS = [...WORKER_SCRIPTS, PREP_SCRIPT];
  let killed = 0;
  for (const host of getAllRootedHosts(ns)) {
    for (const proc of ns.ps(host)) {
      const isTargetScript = ALL_TARGET_SCRIPTS.includes(proc.filename);
      // Workers store target as args[0]; multi-target prep has target anywhere in args
      const targetsThisServer = proc.args[0] === target ||
        (Array.isArray(proc.args) && proc.args.includes(target));
      if (isTargetScript && targetsThisServer) {
        ns.kill(proc.pid);
        killed++;
      }
    }
  }
  if (killed > 0) logFn(`Killed ${killed} orphaned worker/prep processes for "${target}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

// ── RAM-saving temp script helpers ─────────────────────────────────────────
// These delegate expensive ns.* calls to short-lived temp scripts so the
// parent (hwgw-manager.js) doesn't pay their static RAM cost.
// ns.exec (1.3 GB) and ns.isRunning (0.05 GB) are already in our RAM budget.

const PSERV_GATHER   = '/Temp/pserv-gather.js';
const PSERV_FILE     = '/Temp/pserv-list.txt';
const HACK_GATHER    = '/Temp/hackdata-gather.js';
const HACK_DATA_FILE = '/Temp/hackdata-cache.txt';

/** Write the temp scripts to disk once at startup */
function writeTempScripts(ns) {
  ns.write(PSERV_GATHER,
    'export async function main(ns) { ns.write("/Temp/pserv-list.txt", JSON.stringify(ns.cloud.getServerNames()), "w"); }', 'w');
  ns.write(HACK_GATHER, [
    'export async function main(ns) {',
    '  const hosts = JSON.parse(ns.args[0]);',
    '  const data = {};',
    '  for (const h of hosts) {',
    '    const pct = ns.hackAnalyze(h);',
    '    data[h] = { hackPct: pct, hackChance: pct > 0 ? ns.hackAnalyzeChance(h) : 0 };',
    '  }',
    '  ns.write("/Temp/hackdata-cache.txt", JSON.stringify(data), "w");',
    '}',
  ].join('\n'), 'w');
}

async function runTempAndWait(ns, script, args = [], timeout = 10000) {
  const pid = ns.exec(script, 'home', 1, ...args);
  if (!pid) return false;
  const dl = Date.now() + timeout;
  while (ns.isRunning(pid) && Date.now() < dl) await ns.sleep(50);
  return !ns.isRunning(pid);
}

/** Fetch purchased server names via temp script (saves 1.05 GB vs ns.cloud.getServerNames) */
async function refreshPurchasedServerCache(ns) {
  await runTempAndWait(ns, PSERV_GATHER, [], 3000);
}

/** Read cached purchased server list (synchronous, 0 GB) */
function getPurchasedServers(ns) {
  try { return JSON.parse(ns.read(PSERV_FILE) || '[]'); } catch { return []; }
}

/**
 * Pre-compute hackAnalyze + hackAnalyzeChance for a list of hosts.
 * With Formulas.exe: uses ns.formulas.hacking.* (0 GB, already paid for getServer/getPlayer)
 * Without: delegates to temp script (saves 2 GB vs direct ns.hackAnalyze/hackAnalyzeChance)
 * Returns: { hostname: { hackPct, hackChance }, ... }
 */
async function precomputeHackData(ns, hosts, hasFormulas, player) {
  if (hasFormulas && player) {
    const data = {};
    for (const h of hosts) {
      const srv = ns.getServer(h);
      data[h] = {
        hackPct:    ns.formulas.hacking.hackPercent(srv, player),
        hackChance: ns.formulas.hacking.hackChance(srv, player),
      };
    }
    return data;
  }
  // No Formulas.exe: temp script computes hackAnalyze + hackAnalyzeChance
  await runTempAndWait(ns, HACK_GATHER, [JSON.stringify(hosts)], 10000);
  try { return JSON.parse(ns.read(HACK_DATA_FILE) || '{}'); } catch { return {}; }
}

/**
 * Get all servers to claim as hwgw exec hosts: purchased servers PLUS rooted
 * world servers with at least worldMinRam GB of RAM.
 *
 * Why include world servers?
 *   Purchased servers hold most of the RAM budget, but world servers (32–512 GB
 *   at the high end) add meaningful capacity — especially early in a BN before
 *   large purchased servers are online. hwgw workers are single-shot scripts at
 *   1.70–1.75 GB each, so even a 16 GB world server contributes ~9 useful threads.
 *   Claiming them here tells daemon.js to stop running /Remote/ hack scripts on
 *   them, eliminating the last source of daemon/batcher RAM contention.
 *
 * Why worldMinRam >= 8 GB default?
 *   Servers below 8 GB contribute < 4 threads — barely worth the overhead of
 *   iterating them in every launchWorker call. They're left to daemon for share
 *   threads, XP farming, and other misc tasks that need a home base.
 *
 * Home is always excluded — the batcher respects --reserve-ram for home,
 * and daemon needs home for its own orchestration scripts.
 *
 * @param {NS} ns
 * @param {number} worldMinRam — minimum server RAM (GB) to include world servers
 * @returns {string[]} combined list of exec host hostnames
 */
function getExecHosts(ns, worldMinRam) {
  const purchased = getPurchasedServers(ns);
  const purchasedSet = new Set(purchased);

  // Include rooted world servers (not home, not purchased) that meet the RAM threshold.
  // getAllRootedHosts already excludes hacknet nodes.
  const worldHosts = worldMinRam < Infinity
    ? getAllRootedHosts(ns).filter(h =>
      h !== "home" &&
      !purchasedSet.has(h) &&
      ns.getServerMaxRam(h) >= worldMinRam
    )
    : [];

  return [...purchased, ...worldHosts];
}

/**
 * Copy all worker scripts to the given execution hosts.
 * Done once at startup so workers can be exec'd there without per-launch scp calls.
 *
 * @param {NS} ns
 * @param {string[]} hosts
 * @param {Function} logFn
 */
async function copyWorkerScripts(ns, hosts, logFn) {
  const scripts = [...WORKER_SCRIPTS, BATCHER_SCRIPT, PREP_SCRIPT];
  for (const host of hosts) {
    for (const script of scripts) {
      if (ns.fileExists(script, "home") && !ns.fileExists(script, host)) {
        ns.scp(script, host, "home");
      }
    }
  }
  logFn(`Worker scripts copied to ${hosts.length} exec hosts.`);
}

/**
 * Read BitNode multipliers from daemon.js's cache file at no RAM cost.
 * See hwgw-prep.js and hwgw-batcher.js for the full explanation of why
 * this pattern is used instead of importing from helpers.js.
 */
function readBnMults(ns) {
  try {
    const cached = ns.read('/Temp/bitNode-multipliers.txt');
    if (cached && cached !== '') return JSON.parse(cached);
  } catch { /* fall through */ }

  // Comprehensive fallback from game source (BitNode.tsx). Only HWGW-relevant fields.
  // BN12 uses level 1 estimate (inc=1.02, dec=0.98) — real values come from cache file.
  const currentBN = ns.getResetInfo().currentNode;
  const table = {
    1:  {},
    2:  { HackingLevelMultiplier: 0.8, ServerGrowthRate: 0.8, ServerMaxMoney: 0.08 },
    3:  { HackingLevelMultiplier: 0.8, ServerGrowthRate: 0.2, ServerMaxMoney: 0.04, ScriptHackMoney: 0.2 },
    4:  { ServerMaxMoney: 0.1125, ScriptHackMoney: 0.2, HackExpGain: 0.4 },
    5:  { ScriptHackMoney: 0.15, HackExpGain: 0.5 },
    6:  { HackingLevelMultiplier: 0.35, ServerMaxMoney: 0.2, ScriptHackMoney: 0.75, HackExpGain: 0.25 },
    7:  { HackingLevelMultiplier: 0.35, ServerMaxMoney: 0.2, ScriptHackMoney: 0.5, HackExpGain: 0.25 },
    8:  { ScriptHackMoney: 0.3, ScriptHackMoneyGain: 0 },
    9:  { HackingLevelMultiplier: 0.5, ServerMaxMoney: 0.01, ScriptHackMoney: 0.1, HackExpGain: 0.05 },
    10: { HackingLevelMultiplier: 0.35, ScriptHackMoney: 0.5 },
    11: { HackingLevelMultiplier: 0.6, ServerGrowthRate: 0.2, ServerMaxMoney: 0.01, ServerWeakenRate: 2, HackExpGain: 0.5 },
    12: { HackingLevelMultiplier: 0.98, ServerGrowthRate: 0.98, ServerMaxMoney: 0.96, ServerWeakenRate: 0.98, ScriptHackMoney: 0.98, HackExpGain: 0.98 },
    13: { HackingLevelMultiplier: 0.25, ServerMaxMoney: 0.3375, ScriptHackMoney: 0.2, HackExpGain: 0.1 },
    14: { HackingLevelMultiplier: 0.4, ServerMaxMoney: 0.7, ScriptHackMoney: 0.3 },
    15: { HackingLevelMultiplier: 0.6, ServerMaxMoney: 0.8 },
  };
  const overrides = table[currentBN] ?? {};
  return { ServerWeakenRate: 1, ServerGrowthRate: 1, ServerMaxMoney: 1, ScriptHackMoney: 1,
           ScriptHackMoneyGain: 1, HackingLevelMultiplier: 1, HackExpGain: 1, ...overrides };
}

/**
 * Try to crack (root) every reachable server we don't already own.
 * Port openers cost 0.05 GB each (6 total = 0.30 GB added to manager static RAM).
 * Servers missing the required .exe files fail silently -- nuke just throws.
 * Returns number of newly rooted servers.
 */
function crackAllServers(ns) {
  let cracked = 0;
  for (const host of getAllRootedHosts(ns, true)) { // true = include unrooted
    if (host === 'home' || ns.hasRootAccess(host)) continue;
    try { ns.brutessh(host); }  catch {}
    try { ns.ftpcrack(host); }  catch {}
    try { ns.relaysmtp(host); } catch {}
    try { ns.httpworm(host); }  catch {}
    try { ns.sqlinject(host); } catch {}
    try { ns.nuke(host); if (ns.hasRootAccess(host)) cracked++; } catch {}
  }
  return cracked;
}

/**
 * BFS from home to find all servers we have root access on.
 * Excludes hacknet servers.
 */
function getAllRootedHosts(ns, includeUnrooted = false) {
  const visited = new Set();
  const queue = ["home"];
  const rooted = [];

  while (queue.length > 0) {
    const host = queue.shift();
    if (visited.has(host)) continue;
    visited.add(host);

    if (!host.startsWith("hacknet-")) {
      if (host === "home" || ns.hasRootAccess(host) || includeUnrooted) rooted.push(host);
    }

    for (const neighbor of ns.scan(host)) {
      if (!visited.has(neighbor)) queue.push(neighbor);
    }
  }
  return rooted;
}

/** Compare two string arrays for equality (order-sensitive) */
function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}