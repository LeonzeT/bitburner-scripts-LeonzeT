export async function main(ns) {
  const safe = f => { try { return f(); } catch { return undefined; } };
  const d = {};

  d.player = safe(() => ns.getPlayer());

  // Derive sleeves-unlocked from the sleeves data file (0 GB — just ns.read).
  // dashboard-sleeves.js writes this file when the Sleeves tab is active;
  // if it's empty, sleeves haven't been confirmed unlocked yet this session.
  d.sleevesUnlocked = (() => {
    try {
      const r = ns.read("/Temp/dashboard-sleeves.txt");
      if (!r || r === "") return false;
      const sd = JSON.parse(r);
      return (sd.sleeves?.length ?? 0) > 0;
    } catch { return false; }
  })();

  d.corpExists = safe(() => {
    try { return ns.corporation.hasCorporation(); } catch { return false; }
  }) ?? false;

  // Derive gang-available from the gangs data file (0 GB — just ns.read).
  // gangs.js writes inGang to this file when it's running. If the file is
  // empty (gang tab not open), we default to false — the Gang tab itself
  // will show the correct state once its companion script starts.
  d.gangAvailable = (() => {
    try {
      const r = ns.read("/Temp/dashboard-gangs.txt");
      if (!r || r === "") return false;
      return JSON.parse(r).inGang ?? false;
    } catch { return false; }
  })();

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

  // Stock flags (hasWse, hasTix, has4SData, has4SApi, stockCosts) are no longer
  // fetched here. They cost ~12.5 GB (5 ns.stock.* calls × 2.5 GB each) in this
  // temp script and were only used by the Shortcuts and Stocks tabs.
  // dashboard-shortcuts.js gather provides them when on Shortcuts tab.
  // dashboard-stocks.js gather provides them when on Stocks tab.
  // The merged data object in dashboard.js combines all three files, so the
  // flags will be present whenever the relevant tab is active.

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
  ns.write("/Temp/dashboard-data.txt", JSON.stringify(d), "w");
}