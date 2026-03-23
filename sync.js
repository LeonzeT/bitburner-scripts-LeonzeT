/** @param {NS} ns */
export async function main(ns) {
    const base = "https://raw.githubusercontent.com/LeonzeT/bitburner-scripts-LeonzeT/main/";
    const SKIP = ["sync.js", "manifest.json", "push.py", "generate-manifest.py"];
    const HASH_FILE = "/Temp/sync-hashes.json";

    ns.tprint("Fetching manifest...");
    const ok = await ns.wget(base + "manifest.json", "/Temp/sync-manifest.json", "home");
    if (!ok) { ns.tprint("ERR: Could not fetch manifest.json"); return; }

    const raw = ns.read("/Temp/sync-manifest.json");
    if (!raw) { ns.tprint("ERR: manifest.json was empty"); return; }

    // Load remote manifest { filename: md5 }
    const remote = JSON.parse(raw);

    // Load previously synced hashes (what we downloaded last time)
    let local = {};
    try {
        const savedRaw = ns.read(HASH_FILE);
        if (savedRaw) local = JSON.parse(savedRaw);
    } catch {}
 
    const files = Object.keys(remote).filter(f => !SKIP.includes(f));
    const changed = files.filter(f => remote[f] !== local[f]);
    const unchanged = files.length - changed.length;

    if (changed.length === 0) {
        ns.tprint(`Already up to date. ${unchanged} files unchanged.`);
        ns.rm("/Temp/sync-manifest.json");
        return;
    }

    ns.tprint(`${changed.length} changed, ${unchanged} unchanged. Syncing...`);

    let success = 0, fail = 0;
    for (const f of changed) {
        const pulled = await ns.wget(base + f, f, "home");
        ns.tprint(pulled ? `OK  ${f}` : `ERR ${f}`);
        if (pulled) {
            local[f] = remote[f]; // Update hash only on success
            success++;
        } else {
            fail++;
        }
    }

    // Save updated hashes
    ns.write(HASH_FILE, JSON.stringify(local), "w");
    ns.rm("/Temp/sync-manifest.json");
    ns.tprint(`Done. ${success} synced, ${fail} failed, ${unchanged} unchanged.`);
}