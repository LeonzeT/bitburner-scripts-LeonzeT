/**
 * darknet-actions.js — heavy darknet operations exec'd on demand by darknet-worker.js
 *
 * Holds the expensive API calls so darknet-worker.js doesn't pay their static RAM cost:
 *   ns.dnet.openCache      2.0 GB
 *   ns.dnet.phishingAttack 2.0 GB
 *   ns.dnet.packetCapture  6.0 GB
 *   base                   1.6 GB
 *   ─────────────────────────────
 *   Total                 11.6 GB  (only while running, ~seconds per invocation)
 *
 * Called by darknet-worker.js via ns.exec(). Results reported to port 3.
 *
 * Args:
 *   ns.args[0]  action    "cache" | "phish" | "packet" | "all_caches"
 *   ns.args[1]  target    hostname (for "packet") or cache filename (for "cache")
 *   ns.args[2]  extra     passwordLength (for "packet")
 *
 * @param {NS} ns
 */
export async function main(ns) {
    ns.disableLog("ALL");
    const action = ns.args[0];
    const arg1   = ns.args[1] ?? "";
    const arg2   = ns.args[2] ?? 0;
    const PORT   = 3;
    const myHost = ns.getHostname();
    const report = (msg) => ns.tryWritePort(PORT, JSON.stringify(msg));

    if (action === "all_caches") {
        // Open every .cache file on this server
        for (const file of ns.ls(myHost, ".cache")) {
            try {
                const r = ns.dnet.openCache(file, true);
                report({ t: "cache", host: myHost, file, result: r.message, karma: r.karmaLoss });
            } catch {}
        }
        // Read .data.txt clue files too
        for (const file of ns.ls(myHost, ".data.txt")) {
            try {
                const content = ns.read(file);
                if (content) report({ t: "clue", host: myHost, file, content: content.slice(0, 200) });
            } catch {}
        }
        return;
    }

    if (action === "phish") {
        try {
            const r = await ns.dnet.phishingAttack();
            report({ t: "phish", host: myHost, success: r.success, msg: r.message ?? "" });
        } catch {}
        return;
    }

    if (action === "packet") {
        // packetCapture requires direct connection to target — must be exec'd on adjacent server
        try {
            const result = await ns.dnet.packetCapture(arg1);
            // Return raw data via port so the cracker (re-exec'd after this) can use it
            report({ t: "packet_result", host: myHost, target: arg1, success: result.success,
                     data: result.success ? (result.data ?? "") : "" });
        } catch {
            report({ t: "packet_result", host: myHost, target: arg1, success: false, data: "" });
        }
        return;
    }

    ns.print(`darknet-actions: unknown action "${action}"`);
}