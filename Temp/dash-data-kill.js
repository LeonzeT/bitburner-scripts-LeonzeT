export async function main(ns) {
  const p = ns.ps("home").find(p => p.filename.endsWith("hacking/hwgw-manager.js"));
  if (p) ns.kill(p.pid);
}