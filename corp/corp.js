/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    const SETUP_DONE_FLAG = "/corp-setup-done.txt";
    const SETUP_PHASE_FILE = "/corp-setup-phase.txt";
    const SETUP_COMPLETE_PHASE = 6;
    const CHILD_LAUNCH_BUFFER = 32;

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
    const setupPhase = Number.parseInt(ns.read(SETUP_PHASE_FILE) || '0', 10) || 0;

    function freeHomeRam() {
        return Math.max(0, ns.getServerMaxRam("home") - ns.getServerUsedRam("home"));
    }

    function tryLaunch(script, extraRam = 0) {
        if (ns.isRunning(script, "home")) return true;
        const requiredFreeRam = ns.getScriptRam(script, "home") + extraRam;
        if (freeHomeRam() + 1e-9 < requiredFreeRam) {
            ns.print(`INFO: Waiting for ${requiredFreeRam.toFixed(1)} GB free home RAM before launching ${script}.`);
            return false;
        }
        return !!ns.run(script);
    }

    if (!hasCorp || !setupDone || setupPhase < SETUP_COMPLETE_PHASE) {
        tryLaunch(SETUP_SCRIPT, CHILD_LAUNCH_BUFFER);
        return;
    }

    tryLaunch(AUTOPILOT_SCRIPT, CHILD_LAUNCH_BUFFER);
}
