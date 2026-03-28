export async function main(ns) {
  const hosts = JSON.parse(ns.args[0]);
  const data = {};
  for (const h of hosts) {
    const pct = ns.hackAnalyze(h);
    data[h] = { hackPct: pct, hackChance: pct > 0 ? ns.hackAnalyzeChance(h) : 0 };
  }
  ns.write("/Temp/hackdata-cache.txt", JSON.stringify(data), "w");
}