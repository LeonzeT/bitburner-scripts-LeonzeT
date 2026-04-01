/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    const SETUP_DONE_FLAG = "/corp-setup-done.txt";

    function resolveSiblingPath(key, fallbackFile) {
        try {
            const paths = JSON.parse(ns.read("/script-paths.json") || "{}");
            if (typeof paths[key] === "string" && paths[key].length > 0) return paths[key];
        } catch { }

        const script = ns.getScriptName();
        const slash = script.lastIndexOf("/");
        return slash === -1 ? fallbackFile : `${script.slice(0, slash)}/${fallbackFile}`;
    }

    const SETUP_SCRIPT = resolveSiblingPath("corp-setup", "corp-setup.js");
    const AUTOPILOT_SCRIPT = resolveSiblingPath("corp-autopilot", "corp-autopilot.js");

    const hasCorp = ns.corporation.hasCorporation();
    const setupDone = ns.fileExists(SETUP_DONE_FLAG, "home");
    const setupPhase = Number.parseInt(ns.read('/corp-setup-phase.txt') || '0', 10) || 0;

    if (!hasCorp || !setupDone || setupPhase < 6) {
        if (!ns.isRunning(SETUP_SCRIPT, "home")) {
            ns.run(SETUP_SCRIPT);
        }
        return;
    }

    if (!ns.isRunning(AUTOPILOT_SCRIPT, "home")) {
        ns.run(AUTOPILOT_SCRIPT);
    }
}
