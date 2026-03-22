export async function main(ns) {
  const safe = f => { try { return f(); } catch { return undefined; } };
  const d = {};
  // Home upgrades
  d.homeRamCost   = safe(() => ns.singularity.getUpgradeHomeRamCost());
  d.homeCoresCost = safe(() => ns.singularity.getUpgradeHomeCoresCost());
  d.homeMaxRam    = safe(() => ns.getServerMaxRam("home")) ?? 0;
  d.homeCores     = safe(() => ns.getServer("home").cpuCores) ?? null;
  // Current work + darkweb
  d.currentWork = safe(() => ns.singularity.getCurrentWork());
  d.hasTor      = safe(() => ns.hasTorRouter()) ?? false;
  try {
    const progs = safe(() => ns.singularity.getDarkwebPrograms()) ?? [];
    d.darkwebPrograms = progs.map(p => ({
      name:  p,
      owned: safe(() => ns.fileExists(p, "home")) ?? false,
      cost:  safe(() => ns.singularity.getDarkwebProgramCost(p)) ?? null,
    }));
  } catch { d.darkwebPrograms = []; }
  // Pending augs
  try {
    const installed = safe(() => ns.singularity.getOwnedAugmentations(false)) ?? [];
    const withInst  = safe(() => ns.singularity.getOwnedAugmentations(true))  ?? [];
    d.pendingAugs   = withInst.length - installed.length;
  } catch {}
  // Stock market access flags
  d.hasWse    = safe(() => ns.stock.hasWseAccount())    ?? null;
  d.hasTix    = safe(() => ns.stock.hasTixApiAccess())  ?? null;
  d.has4SData = safe(() => ns.stock.has4SData())        ?? null;
  d.has4SApi  = safe(() => ns.stock.has4SDataTixApi())  ?? null;
  try {
    const sc = ns.stock.getConstants();
    // Key names from StockMarket/data/Constants.ts:
    //   WseAccountCost, TixApiCost, MarketData4SCost, MarketDataTixApi4SCost
    d.stockCosts = {
      wse: sc.WseAccountCost,
      tix: sc.TixApiCost,
      s4d: sc.MarketData4SCost,
      s4a: sc.MarketDataTixApi4SCost,
    };
  } catch { d.stockCosts = {}; }
  // Script running status — use ps()+suffix matching, not exact-path isRunning()
  try {
    const procs = ns.ps("home");
    d.managerRunning       = procs.some(p => p.filename.endsWith("hwgw-manager.js"));
    d.crawlerRunning       = procs.some(p => p.filename.endsWith("darknet-crawler.js"));
    d.crawlerWorkerRunning = procs.some(p => p.filename.endsWith("darknet-worker.js"));
    d.backdoorRunning      = procs.some(p => p.filename.endsWith("backdoor-all-servers.js"));
  } catch {}
  d.shortcutsLoaded    = true;
  d.shortcutsTimestamp = Date.now();
  ns.write("/Temp/dash-shortcuts-gathered.txt", JSON.stringify(d), "w");
}