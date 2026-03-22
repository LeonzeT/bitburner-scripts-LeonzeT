/** @param {NS} ns */
export async function main(ns) {
  let l;
  l = ns.serverExists("darkweb");
  ns.tprint(l);
}