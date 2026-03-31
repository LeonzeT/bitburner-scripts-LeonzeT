/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    const SETUP_DONE_FLAG = "/corp-setup-done.txt";
    const SETUP_SCRIPT = "corp-setup.js";
    const AUTOPILOT_SCRIPT = "corp-autopilot.js";

    const hasCorp = ns.corporation.hasCorporation();
    const setupDone = ns.fileExists(SETUP_DONE_FLAG, "home");

    if (!hasCorp || !setupDone) {
        if (!ns.isRunning(SETUP_SCRIPT, "home")) {
            ns.run(SETUP_SCRIPT);
        }
        return;
    }

    if (!ns.isRunning(AUTOPILOT_SCRIPT, "home")) {
        ns.run(AUTOPILOT_SCRIPT);
    }
}