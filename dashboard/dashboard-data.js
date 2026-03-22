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
 * dashboard-data.js — always-on command router + data hub (~3 GB static)
 *
 * ALL expensive ns.* calls (getPlayer, getServer*, stock.has*, gang.inGang,
 * sleeve.getNumSleeves, getMoneySources, ps, kill, etc.) are delegated to a
 * temp gather script that runs for <1s each cycle, then exits and frees RAM.
 *
 * This script only uses: ns.exec(1.3) + ns.isRunning(0.05) + ns.read/write(0)
 * = ~3 GB sustained. The temp script peaks at ~9 GB during its 1s run.
 *
 * Old version: ~9.9 GB held the entire time
 * New version: ~3 GB sustained, ~9 GB peak for 1s/cycle
 *
 * Port architecture:
 *   Port 17 ← dashboard.js (React button presses)
 *   Port 18 → active on-demand tab script (forwarded commands)
 *
 * @param {NS} ns
 */

const CMD_PORT        = 17;
const FWD_PORT        = 18;          // forward → active on-demand tab script
const DATA_FILE       = '/Temp/dashboard-data.txt';
const ACTIVE_TAB_FILE = '/Temp/dashboard-active-tab.txt';
const GATHER_SCRIPT   = '/Temp/dash-data-gather.js';
const KILL_SCRIPT     = '/Temp/dash-data-kill.js';

// Commands that require expensive ns.* calls — forwarded to the active tab script
// which either handles them directly or delegates to temp scripts.
const FORWARD_CMDS = new Set([
    'upgradeRam','upgradeCores','installAugs','buyAug','buyProgram',
    'workForFaction','donateToFaction','purchaseTor',
    'upgradeServer','deleteServer','purchaseServer',
    'launchCrawler','launchManager','launchBackdoor',
    'buyStock','sellStock',
    'ascendMember',
    'purchaseWse','purchaseTix','purchase4SData','purchase4SApi',
    'setSleeveTask','clearSleeveOverride','clearAllSleeveOverrides',
]);

// Commands handled locally — only needs ns.write (0 GB) and ns.exec (already paid)
const LOCAL_CMDS = {
    setActiveTab:   (ns, cmd) => ns.write(ACTIVE_TAB_FILE, cmd.tab ?? '', 'w'),
    setForceTarget: (ns, cmd) => ns.write('/Temp/hwgw-force-target.txt', cmd.target ?? '', 'w'),
    // Kill by PID — delegated to temp script so dashboard-data.js avoids ns.ps (0.2 GB) + ns.kill (0.5 GB)
    killManager:    (ns) => killByName(ns, 'hacking/hwgw-manager.js'),
    killCrawler:        (ns) => killByName(ns, 'darknet/darknet-crawler.js'),
    clearWffOverride:   (ns) => ns.write('/Temp/wff-override.txt', '', 'w'),
};

function killByName(ns, suffix) {
    ns.write(KILL_SCRIPT, [
        'export async function main(ns) {',
        `  const p = ns.ps("home").find(p => p.filename.endsWith("${suffix}"));`,
        '  if (p) ns.kill(p.pid);',
        '}',
    ].join('\n'), 'w');
    ns.exec(KILL_SCRIPT, 'home');
}

function writeGatherScript(ns) {
    // This temp script contains ALL the expensive ns.* calls.
    // It runs for <1s, writes results to DATA_FILE, then exits and frees its ~9 GB.
    ns.write(GATHER_SCRIPT, `export async function main(ns) {
  const safe = f => { try { return f(); } catch { return undefined; } };
  const d = {};

  d.player = safe(() => ns.getPlayer());
  d.sleevesUnlocked = safe(() => {
    try { ns.sleeve.getNumSleeves(); return true; } catch { return false; }
  }) ?? false;
  d.corpExists = safe(() => {
    try { return ns.corporation.hasCorporation(); } catch { return false; }
  }) ?? false;
  d.gangAvailable = safe(() => {
    try { return ns.gang.inGang() || ns.heart.break() <= -54000; } catch { return false; }
  }) ?? false;

  // Write player snapshot — other scripts read this for free
  if (d.player) try { ns.write("/Temp/dashboard-player.txt", JSON.stringify(d.player), "w"); } catch {}

  d.homeMaxRam  = safe(() => ns.getServerMaxRam("home"))  ?? 0;
  d.homeUsedRam = safe(() => ns.getServerUsedRam("home")) ?? 0;

  try {
    const r = ns.read("/Temp/bitNode-multipliers.txt");
    d.bnMults = r && r !== "" ? JSON.parse(r) : null;
  } catch { d.bnMults = null; }

  // HWGW — pure file reads (free). hackChance embedded in status by hwgw-manager.
  try {
    const r = ns.read("/Temp/hwgw-status.txt");
    if (r && r !== "") {
      const parsed = JSON.parse(r);
      // Only use status if it's fresh (written within the last 10s).
      // Stale status means manager was killed/restarted — avoids showing old targets.
      if (parsed.timestamp && (Date.now() - parsed.timestamp) < 10000)
        d.hwgw = parsed;
    }
  } catch {}

  // Target stats — real-time server data for HWGW and prep targets
  const allTargets = new Set([
    ...(d.hwgw?.targets ?? []),
  ]);
  // Collect prep targets from process list
  let prepTargets = [];
  try {
    const procs = ns.ps("home");
    const prepProcs = procs.filter(p => p.filename.endsWith('hacking/hwgw-prep.js'));
    prepTargets = [...new Set(prepProcs.flatMap(p =>
      (p.args ?? []).filter(a => typeof a === "string" && !a.startsWith("-"))
    ))];
    prepTargets.forEach(t => allTargets.add(t));
    d.prepRunning = prepProcs.length > 0;
    d.prepTargets = prepTargets;

    // Script running status
    d.managerRunning       = procs.some(p => p.filename.endsWith('hacking/hwgw-manager.js'));
    d.crawlerRunning       = procs.some(p => p.filename.endsWith('darknet/darknet-crawler.js'));
    d.crawlerWorkerRunning = procs.some(p => p.filename.endsWith('darknet/darknet-worker.js'));
    d.backdoorRunning      = procs.some(p => p.filename.endsWith('Tasks/backdoor-all-servers.js'));
  } catch {}

  if (allTargets.size > 0) {
    d.targetStats = {};
    for (const t of allTargets) {
      d.targetStats[t] = {
        money:      safe(() => ns.getServerMoneyAvailable(t)),
        maxMoney:   safe(() => ns.getServerMaxMoney(t)),
        sec:        safe(() => ns.getServerSecurityLevel(t)),
        minSec:     safe(() => ns.getServerMinSecurityLevel(t)),
        chance:     d.hwgw?.targetHackChance?.[t] ?? null,
        weakenTime: safe(() => ns.getWeakenTime(t)),
        growTime:   safe(() => ns.getGrowTime(t)),
      };
    }
  }

  try {
    const hosts = JSON.parse(ns.read("/Temp/hwgw-exec-hosts.txt") || "[]");
    d.execCount   = hosts.length;
    d.execRamMax  = hosts.reduce((s,h) => s + (safe(() => ns.getServerMaxRam(h))  ?? 0), 0);
    d.execRamUsed = hosts.reduce((s,h) => s + (safe(() => ns.getServerUsedRam(h)) ?? 0), 0);
  } catch {}

  try { const r = ns.read("/Temp/hwgw-force-target.txt"); d.forceTarget = r.trim() || null; } catch {}
  try { const r = ns.read("/Temp/dnet-passwords.txt"); if (r && r !== "") d.dnet = JSON.parse(r); } catch {}

  // Lightweight stock flags (0.05 GB each)
  try {
    d.hasWse    = safe(() => ns.stock.hasWseAccount())   ?? false;
    d.hasTix    = safe(() => ns.stock.hasTixApiAccess()) ?? false;
    d.has4SData = safe(() => ns.stock.has4SData())       ?? false;
    d.has4SApi  = safe(() => ns.stock.has4SDataTixApi()) ?? false;
    const sc = ns.stock.getConstants(), bn = d.bnMults ?? {};
    d.stockCosts = {
      wse: sc.WseAccountCost, tix: sc.TixApiCost,
      s4d: sc.MarketData4SCost       * (bn.FourSigmaMarketDataCost    ?? 1),
      s4a: sc.MarketDataTixApi4SCost * (bn.FourSigmaMarketDataApiCost ?? 1),
    };
  } catch { d.stockCosts = {}; }

  try { d.hasTor = ns.serverExists("darkweb"); } catch { d.hasTor = false; }
  d.darknetAvailable = d.hasTor;
  try { d.moneySources = ns.getMoneySources(); } catch {}

  try {
    if (ns.serverExists("w0r1d_d43m0n"))
      d.wdHackReq = ns.getServerRequiredHackingLevel("w0r1d_d43m0n");
  } catch {}

  try {
    const r = ns.read("/Temp/affordable-augs.txt");
    if (r && r !== "") d.facman = JSON.parse(r);
  } catch {}

  try { const r = ns.read("/Temp/wff-override.txt"); d.wffOverride = r && r !== "" ? JSON.parse(r) : null; } catch { d.wffOverride = null; }
  d._writer = ns.getScriptName();
  d.dataTimestamp = Date.now();
  ns.write("${DATA_FILE}", JSON.stringify(d), "w");
}`, 'w');
}

async function runTemp(ns, script, timeout = 5000) {
    const pid = ns.exec(script, 'home');
    if (!pid) return false;
    const deadline = Date.now() + timeout;
    while (ns.isRunning(pid) && Date.now() < deadline) await ns.sleep(50);
    return !ns.isRunning(pid);
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const uiScript = ns.getScriptName().replace(/dashboard-data\.js$/, 'dashboard.js');
    const cmdPort  = ns.getPortHandle(CMD_PORT);
    const fwdPort  = ns.getPortHandle(FWD_PORT);
    while (!cmdPort.empty()) cmdPort.read(); // drain stale commands on startup
    writeGatherScript(ns);

    while (true) {
        if (!ns.isRunning(uiScript, 'home')) {
            ns.print('UI closed. Exiting.'); ns.write(DATA_FILE, '', 'w'); return;
        }

        // Process commands from dashboard.js
        while (!cmdPort.empty()) {
            try {
                const cmd = JSON.parse(cmdPort.read());
                if (FORWARD_CMDS.has(cmd.type)) {
                    // Side-effect: write WFF override file so work-for-factions
                    // respects the dashboard-selected faction/workType.
                    if (cmd.type === 'workForFaction') {
                        ns.write('/Temp/wff-override.txt', JSON.stringify({
                            faction: cmd.faction,
                            workType: cmd.workType,
                            until: Date.now() + 86400000, // 24-hour safety expiry
                        }), 'w');
                    }
                    if (!fwdPort.tryWrite(JSON.stringify(cmd)))
                        ns.print('WARN: fwd port full: ' + cmd.type);
                } else if (LOCAL_CMDS[cmd.type]) {
                    LOCAL_CMDS[cmd.type](ns, cmd);
                } else {
                    ns.print('Unknown cmd: ' + cmd.type);
                }
            } catch (e) { ns.print('CMD error: ' + (e?.message ?? e)); }
        }

        // Run the gather temp script — it writes directly to DATA_FILE
        await runTemp(ns, GATHER_SCRIPT);

        await ns.sleep(1000);
    }
}