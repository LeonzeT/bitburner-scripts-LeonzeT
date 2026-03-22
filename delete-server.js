/** @param {NS} ns */
export async function main(ns) {
  for (let i = 1; i <= ns.cloud.getServerNames().length; i++) {
      ns.cloud.deleteServer(ns.cloud.getServerNames()[i-1]);
      ns.tprint("Deleted " + ns.cloud.getServerNames()[i-1]);
  }
  ns.tprint("Done");
}