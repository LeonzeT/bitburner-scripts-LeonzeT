/** @param {NS} ns */
export async function main(ns) {
    const base = "https://raw.githubusercontent.com/LeonzeT/bitburner-scripts-LeonzeT/main/";
    const SKIP = ["sync.js", "manifest.json", "push.py", "generate-manifest.py"];

    ns.tprint("Fetching manifest...");
    const ok = await ns.wget(base + "manifest.json", "/Temp/sync-manifest.json", "home");
    if (!ok) { ns.tprint("ERR: Could not fetch manifest.json"); return; }

    const raw = ns.read("/Temp/sync-manifest.json");
    if (!raw) { ns.tprint("ERR: manifest.json was empty"); return; }

    const files = JSON.parse(raw).filter(f => !SKIP.includes(f));
    ns.tprint(`Syncing ${files.length} files...`);

    let success = 0, fail = 0;
    for (const f of files) {
        const pulled = await ns.wget(base + f, f, "home");
        ns.tprint(pulled ? `OK  ${f}` : `ERR ${f}`);
        pulled ? success++ : fail++;
    }

    ns.tprint(`Done. ${success} synced, ${fail} failed.`);
    ns.rm("/Temp/sync-manifest.json");
}
