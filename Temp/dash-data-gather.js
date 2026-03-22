export async function main(ns) {
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
    if (r && r !== "") d.hwgw = JSON.parse(r);
  } catch {}

  // Target stats — real-time server data for HWGW and prep targets
  const allTargets = new Set([
    ...(d.hwgw?.targets ?? []),
  ]);
  // Collect prep targets from process list
  let prepTargets = [];
  try {
    const procs = ns.ps("home");
    const prepProcs = procs.filter(p => p.filename.endsWith("hwgw-prep.js"));
    prepTargets = [...new Set(prepProcs.flatMap(p =>
      (p.args ?? []).filter(a => typeof a === "string" && !a.startsWith("-"))
    ))];
    prepTargets.forEach(t => allTargets.add(t));
    d.prepRunning = prepProcs.length > 0;
    d.prepTargets = prepTargets;

    // Script running status
    d.managerRunning       = procs.some(p => p.filename.endsWith("hwgw-manager.js"));
    d.crawlerRunning       = procs.some(p => p.filename.endsWith("darknet-crawler.js"));
    d.crawlerWorkerRunning = procs.some(p => p.filename.endsWith("darknet-worker.js"));
    d.backdoorRunning      = procs.some(p => p.filename.endsWith("backdoor-all-servers.js"));
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

  d._writer = "dashboard-data.js";
  d.dataTimestamp = Date.now();
  ns.write("/Temp/dashboard-data.txt", JSON.stringify(d), "w");
}