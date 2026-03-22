/** force-scp.js — Sync HWGW workers to all purchased servers.
 *  Reads paths from /script-paths.json. Run once after updating workers.
 *  @param {NS} ns */
export async function main(ns) {
    // Resolve paths from JSON registry
    let paths = {};
    try {
        const raw = ns.read('/script-paths.json');
        if (raw && raw !== '') paths = JSON.parse(raw);
    } catch {}

    const workerKeys = ['hwgw-hack', 'hwgw-weaken', 'hwgw-grow'];
    const resolved = workerKeys.map(k => paths[k] ?? `${k}.js`);

    // Verify scripts exist on home
    for (const p of resolved) {
        if (!ns.fileExists(p, 'home')) {
            ns.tprint(`  WARNING: ${p} not found on home!`);
        }
    }

    // Verify new port format (target-tagged messages)
    for (const p of resolved) {
        const content = ns.read(p);
        if (content.includes(':${target}')) {
            ns.tprint(`  ✓ ${p} has target-tagged port messages`);
        } else {
            ns.tprint(`  ✗ ${p} is MISSING target tag — multi-target desync will persist!`);
        }
    }

    // Copy to all purchased servers
    const servers = ns.cloud.getServerNames();
    if (servers.length === 0) {
        ns.tprint('No purchased servers found.');
        return;
    }

    let copied = 0;
    for (const s of servers) {
        for (const src of resolved) {
            // Delete stale copy first to force overwrite
            if (ns.fileExists(src, s)) ns.rm(src, s);
            if (ns.scp(src, s, 'home')) copied++;
        }
    }

    ns.tprint(`\nCopied ${copied} files to ${servers.length} servers.`);
    ns.tprint(`Scripts: ${resolved.join(', ')}`);
    ns.tprint(`Now kill all batchers and let hwgw-manager restart them.`);
}