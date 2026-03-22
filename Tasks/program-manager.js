/** @param {NS} ns
 * Buys all programs available on the darkweb that we can afford and don't yet own. **/
export async function main(ns) {
    const programNames = [
        "BruteSSH.exe",
        "FTPCrack.exe",
        "relaySMTP.exe",
        "ServerProfiler.exe",
        "DeepscanV1.exe",
        "AutoLink.exe",
        "DeepscanV2.exe",
        "HTTPWorm.exe",
        "DarkscapeNavigator.exe",
        "SQLInject.exe",
        "Formulas.exe",
    ];

    const keepRunning = ns.args.length > 0 && ns.args[0] == "-c";
    const hasTor = ns.hasTorRouter();

    ns.tprint(`program-manager: hasTor=${hasTor}, money=$${ns.getPlayer().money.toFixed(0)}`);
    if (!hasTor) { ns.tprint("program-manager: no TOR, exiting"); return; }

    do {
        let foundMissing = false;
        for (const prog of programNames) {
            if (ns.fileExists(prog, "home")) continue;
            foundMissing = true;
            const bought = ns.singularity.purchaseProgram(prog);
            ns.tprint(`program-manager: purchaseProgram("${prog}") = ${bought}`);
            if (bought) ns.toast(`Purchased ${prog}`, 'success');
        }
        if (keepRunning && foundMissing) await ns.sleep(2000);
    } while (keepRunning && foundMissing);

    ns.tprint("program-manager: done");
}