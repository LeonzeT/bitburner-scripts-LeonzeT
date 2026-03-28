/**
 * darknet-realloc.js — Liberate blocked RAM from a darknet server.
 *
 * Run this ON a server that is directly connected to the target.
 * Uses all available threads (exec with as many as the host can fit)
 * to maximise the amount of RAM cleared per call.
 *
 * ns.dnet.memoryReallocation() constraints (from game source):
 *   - requireDirectConnection: must run adjacent to the target
 *   - requireAdminRights:      target must already be cracked
 *   - clears: 0.02 × 2×0.92^(difficulty+1) × threads × (1 + cha/100) GB per call
 *   - delay per call: max(8000 × 500/(500+cha), 200) ms
 *
 * Loops until blockedRam == 0 or maxCycles is reached, then exits.
 * Reports completion to port 3 so the crawler can re-exec the worker.
 *
 * @param {NS} ns
 */
export async function main(ns) {
    ns.disableLog("ALL");
    const target    = ns.args[0];
    const maxCycles = Math.max(1, Number(ns.args[1] ?? 50));
    const PORT      = 3;

    if (!target) { ns.tprint("darknet-realloc: no target specified"); return; }

    let freed = 0;
    for (let i = 0; i < maxCycles; i++) {
        const blocked = ns.dnet.getBlockedRam(target);
        if (blocked <= 0) break;
        const r = await ns.dnet.memoryReallocation(target);
        if (r.success) {
            freed += Number(r.message?.match(/[\d.]+/)?.[0] ?? 0);
        } else {
            // NoBlockRAM or lost connection — stop early
            break;
        }
    }

    const remaining = ns.dnet.getBlockedRam(target);
    ns.print(`Realloc done: freed ~${freed.toFixed(2)} GB from "${target}". Remaining: ${remaining.toFixed(2)} GB`);

    if (remaining <= 0) {
        // Notify crawler that this server is now fully clear
        ns.tryWritePort(PORT, JSON.stringify({ t: "realloc_done", host: target }));
    }
}