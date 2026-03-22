
export async function main(ns) {
    const safe = f => { try { return f(); } catch { return undefined; } };
    const d = {};

    // Read player from file (written every 1s by dashboard-data.js — free, 0 GB here)
    let player = null;
    try { const r = ns.read('/Temp/dashboard-player.txt'); player = r ? JSON.parse(r) : null; } catch {}
    if (!player) player = safe(() => ns.getPlayer());

    const bnMults = (() => {
        try { const r = ns.read('/Temp/bitNode-multipliers.txt'); return r ? JSON.parse(r) : null; }
        catch { return null; }
    })();

    // Favor threshold and rep mult
    const donateMinFavor = Math.floor(150 * ((bnMults?.FavorToDonateToFaction) ?? 1));
    const fRepMult = (player?.mults?.faction_rep ?? 1) * ((bnMults?.FactionWorkRepGain) ?? 1);
    d.donateMinFavor = donateMinFavor;
    d.fRepMult       = fRepMult;

    // Current work and pending augs
    d.currentWork = safe(() => ns.singularity.getCurrentWork());
    try {
        const installed = safe(() => ns.singularity.getOwnedAugmentations(false)) ?? [];
        const withPend  = safe(() => ns.singularity.getOwnedAugmentations(true))  ?? [];
        d.pendingAugs   = withPend.length - installed.length;
    } catch {}

    // Per-faction data with unowned augs
    try {
        const factions = player?.factions ?? [];
        const owned    = new Set(safe(() => ns.singularity.getOwnedAugmentations(true)) ?? []);
        const money    = player?.money ?? 0;

        d.factionData = factions.slice(0, 20).map(f => {
            const rep       = safe(() => ns.singularity.getFactionRep(f))       ?? 0;
            const favor     = safe(() => ns.singularity.getFactionFavor(f))     ?? 0;
            const workTypes = safe(() => ns.singularity.getFactionWorkTypes(f)) ?? [];
            const augNames  = safe(() => ns.singularity.getAugmentationsFromFaction(f)) ?? [];
            const augs = augNames.filter(a => !owned.has(a)).map(a => {
                const repReq = safe(() => ns.singularity.getAugmentationRepReq(a))   ?? 0;
                const price  = safe(() => ns.singularity.getAugmentationPrice(a))    ?? 0;
                const prereq = safe(() => ns.singularity.getAugmentationPrereq(a))   ?? [];
                const stats  = safe(() => ns.singularity.getAugmentationStats(a))    ?? {};
                const prereqMet = prereq.every(p => owned.has(p));
                const canBuy = rep >= repReq && money >= price && prereqMet;
                return { name: a, repReq, price, canBuy, prereq, stats };
            }).sort((a, b) => a.repReq - b.repReq);
            return {
                name: f, rep, favor, workTypes, augs,
                canDonate: favor >= donateMinFavor,
                buyable: augs.filter(a => a.canBuy).length,
            };
        }).sort((a, b) => b.buyable - a.buyable || b.rep - a.rep);
    } catch {}

    d.factionsLoaded    = true;
    d.factionsTimestamp = Date.now();
    ns.write('/Temp/dash-factions-gathered.txt', JSON.stringify(d), 'w');
}
