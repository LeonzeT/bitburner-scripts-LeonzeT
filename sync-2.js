export async function main(ns) {
    const base = "http://YOUR_LOCAL_IP:8000/";

    // Fetch manifest
    const ok = await ns.wget(base + "manifest.json", "/Temp/sync-manifest.json", "home");
    if (!ok) { ns.tprint("ERR: Could not fetch manifest"); return; }

    const files = JSON.parse(ns.read("/Temp/sync-manifest.json"));
    ns.tprint(`Found ${files.length} files to sync...`);

    let success = 0, fail = 0;
    for (const f of files) {
        const pulled = await ns.wget(base + f, f, "home");
        ns.tprint(pulled ? `OK  ${f}` : `ERR ${f}`);
        pulled ? success++ : fail++;
    }
    ns.tprint(`Done. ${success} synced, ${fail} failed.`);
    ns.rm("/Temp/sync-manifest.json");
}