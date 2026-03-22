// Resolve registered script paths via script-paths.json (0 GB — ns.read only)
let _scriptPaths = null;
function resolveScript(ns, key) {
    if (!_scriptPaths) {
        _scriptPaths = {};
        try { const r = ns.read('/script-paths.json'); if (r && r !== '') { _scriptPaths = JSON.parse(r); delete _scriptPaths._comment; } } catch {}
    }
    return _scriptPaths[key] ?? (key.endsWith('.js') ? key : key + '.js');
}
/**
 * darknet-crawler.js — Darknet coordinator
 *
 * Runs persistently on home. Execs darknet-worker.js onto darkweb and then
 * recursively onto each cracked server. Reads results from port 3 and
 * displays status. Re-execs workers after each mutation cycle.
 *
 * USAGE:
 *   run darknet/darknet-crawler.js
 *   run darknet/darknet-crawler.js --max-depth 12
 *   run darknet/darknet-crawler.js --phish
 *   run darknet/darknet-crawler.js --packet-capture   (adds 6 GB to worker RAM)
 *   run darknet/darknet-crawler.js --once             (single pass, then exit)
 *
 * Both files must be in darknet/ directory.
 * @param {NS} ns
 */
export async function main(ns) {
    const flags = ns.flags([
        ["max-depth",      8],
        ["phish",          false],
        ["packet-capture", false],
        ["once",           false],
        ["quiet",          false],
    ]);

    ns.disableLog("ALL");

    const maxDepth = flags["max-depth"];
    const doPhish  = flags["phish"];
    const doPacket = flags["packet-capture"];
    const once     = flags["once"];
    const quiet    = flags["quiet"];

    const log  = (msg) => ns.print(msg);
    const logT = (msg) => ns.print(msg);

    const PORT      = 3;
    const WORKER    = 'darknet/darknet-worker.js';
    const REALLOC   = 'darknet/darknet-realloc.js';
    const PASS_FILE = "/Temp/dnet-passwords.txt";

    if (!ns.fileExists("DarkscapeNavigator.exe", "home")) {
        logT("FATAL: DarkscapeNavigator.exe not found on home.");
        return;
    }

    const passwords   = new Map([["darkweb", ""]]);
    let   totalCracks = 0;
    let   totalCaches = 0;

    const savePasswords = () =>
        ns.write(PASS_FILE, JSON.stringify(Object.fromEntries(passwords)), "w");

    const workerArgs = () => [
        "--max-depth",      maxDepth,
        "--phish",          doPhish,
        "--packet-capture", doPacket,
        "--quiet",          quiet,
    ];

    const execWorker = (host, depth) => {
        if (ns.isRunning(WORKER, host)) return false;
        const need = ns.getScriptRam(WORKER, "home");
        const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        if (free < need) { log(`  [${host}] ${free.toFixed(1)}/${need.toFixed(1)} GB — skip`); return false; }
        if (!ns.fileExists(WORKER, host))  ns.scp(WORKER,  host, "home");
        if (ns.fileExists(REALLOC, "home") && !ns.fileExists(REALLOC, host)) ns.scp(REALLOC, host, "home");
        const pid = ns.exec(WORKER, host, 1, "--depth", depth, ...workerArgs());
        if (pid > 0) { log(`  → exec'd worker on "${host}" (depth ${depth}, pid ${pid})`); return true; }
        log(`  → exec failed on "${host}"`);
        return false;
    };

    // Drain stale port data
    while (ns.peek(PORT) !== "NULL PORT DATA") ns.readPort(PORT);

    logT(`Darknet crawler started (max-depth=${maxDepth})`);
    savePasswords();
    execWorker("darkweb", 0);

    do {
        // Read all port messages
        while (ns.peek(PORT) !== "NULL PORT DATA") {
            const raw = ns.readPort(PORT);
            let msg;
            try { msg = JSON.parse(raw); } catch { continue; }

            switch (msg.t) {
                case "cracked":
                    if (!passwords.has(msg.host)) {
                        totalCracks++;
                        logT(`✓ Cracked "${msg.host}" depth=${msg.depth} pw="${msg.password}"`);
                    }
                    passwords.set(msg.host, msg.password);
                    savePasswords();
                    execWorker(msg.host, msg.depth);
                    break;
                case "cache":
                    totalCaches++;
                    logT(`💾 [${msg.host}] ${msg.file}: ${msg.result} (karma ${msg.karma})`);
                    break;
                case "clue":
                    logT(`📄 [${msg.host}] ${msg.file}: ${msg.content}`);
                    break;
                case "phish":
                    if (msg.success) logT(`🎣 [${msg.host}] ${msg.msg}`);
                    break;
                case "probe":
                    log(`🔍 [${msg.host}] depth=${msg.depth} sees: [${msg.neighbours.join(", ")}]`);
                    break;
                case "failed":
                    log(`✗ [${msg.host}] model=${msg.model}`);
                    break;
                case "realloc_start":
                    log(`[realloc] ${msg.host} → ${msg.target}: liberating ${msg.blocked} GB blocked RAM (${msg.threads} threads)`);
                    break;
                case "realloc_done":
                    logT(`[realloc] RAM fully liberated on "${msg.host}". Re-exec'ing worker.`);
                    execWorker(msg.host, msg.host === "darkweb" ? 0 : 1);
                    break;
            }
        }

        // Re-exec workers that died after mutations
        for (const [host] of passwords) {
            execWorker(host, host === "darkweb" ? 0 : 1);
        }

        log(`Status: ${passwords.size} known, ${totalCracks} cracked, ${totalCaches} caches`);
        if (once) break;

        try { await ns.dnet.nextMutation(); }
        catch { await ns.sleep(30_000); }

    } while (true);

    logT(`Done. Cracked: ${totalCracks}, caches: ${totalCaches}`);
}