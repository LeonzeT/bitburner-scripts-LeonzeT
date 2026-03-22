export async function main(ns) {
  const safe = f => { try { return f(); } catch { return undefined; } };
  const d = {};
  try {
    const names  = ns.cloud.getServerNames();
    const maxRam = ns.cloud.getRamLimit();
    const limit  = ns.cloud.getServerLimit();
    d.purchasedServers = names.map(n => {
      const cur  = safe(() => ns.getServerMaxRam(n))  ?? 0;
      const used = safe(() => ns.getServerUsedRam(n)) ?? 0;
      const next = Math.min(maxRam, cur * 2);
      const upgradeCost = next > cur
        ? safe(() => ns.cloud.getServerUpgradeCost(n, next)) ?? null : null;
      return { name: n, maxRam: cur, usedRam: used, upgradeCost, nextRam: next };
    });
    d.serverLimit  = limit;
    d.serverMaxRam = maxRam;
    d.serverCosts  = {};
    for (let i = 3; i <= 20; i++) {
      const ram = 2 ** i;
      if (ram <= maxRam) d.serverCosts[ram] = safe(() => ns.cloud.getServerCost(ram)) ?? null;
    }
  } catch {}
  d.serversLoaded    = true;
  d.serversTimestamp = Date.now();
  ns.write("/Temp/dash-servers-gathered.txt", JSON.stringify(d), "w");
}