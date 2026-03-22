/**
 * sleeve-audit.js — Sleeve Augmentation Audit
 *
 * Reports installed and missing augmentations for each sleeve by cross-referencing
 * purchasable augs (not installed) against all faction-available augs.
 * Also shows each sleeve's current stats, multipliers, shock, sync, and memory.
 *
 * Requires: SF10 (sleeves), SF4 recommended (for full aug cross-reference)
 *
 * Usage:
 *   run sleeve-audit.js              full report for all sleeves
 *   run sleeve-audit.js --sleeve 0   report for sleeve 0 only
 *
 * RAM: ~20 GB (sleeve API + singularity for aug lookups)
 * @param {NS} ns
 */
export async function main(ns) {
    ns.disableLog('ALL');
    const flags = ns.flags([['sleeve', -1]]);
    const targetSleeve = flags.sleeve;

    const numSleeves = ns.sleeve.getNumSleeves();
    if (numSleeves === 0) {
        ns.tprint('ERROR: No sleeves available. Need SF10.');
        return;
    }

    // Check if we have SF4 for full aug cross-reference
    let hasSF4 = false;
    try {
        const sfs = ns.singularity.getOwnedSourceFiles();
        hasSF4 = sfs.some(sf => sf.n === 4);
    } catch {
        // No singularity access (no SF4) — we can still show purchasable augs
        hasSF4 = false;
    }

    // Build a reference list of all possible sleeve augs from joined factions
    let allSleeveAugNames = new Set();
    let augFactionMap = {}; // aug name → [factions that offer it]
    let augRepReqs = {};    // aug name → rep required

    if (hasSF4) {
        const player = ns.getPlayer();
        for (const faction of player.factions) {
            let factionAugs;
            try { factionAugs = ns.singularity.getAugmentationsFromFaction(faction); } catch { continue; }
            for (const aug of factionAugs) {
                // Check if this aug has sleeve-valid multipliers
                let augStats;
                try { augStats = ns.singularity.getAugmentationStats(aug); } catch { continue; }
                const validKeys = [
                    'hacking', 'strength', 'defense', 'dexterity', 'agility', 'charisma',
                    'hacking_exp', 'strength_exp', 'defense_exp', 'dexterity_exp', 'agility_exp', 'charisma_exp',
                    'company_rep', 'faction_rep', 'crime_money', 'crime_success',
                    'work_money', 'hacking_money', 'hacking_speed', 'hacking_chance', 'hacking_grow',
                ];
                const hasValidMult = validKeys.some(k => (augStats[k] ?? 1) !== 1);
                if (!hasValidMult) continue; // Not a sleeve-valid aug

                allSleeveAugNames.add(aug);
                if (!augFactionMap[aug]) augFactionMap[aug] = [];
                augFactionMap[aug].push(faction);
                try { augRepReqs[aug] = ns.singularity.getAugmentationRepReq(aug); } catch {}
            }
        }
    }

    const startIdx = targetSleeve >= 0 ? targetSleeve : 0;
    const endIdx = targetSleeve >= 0 ? targetSleeve + 1 : numSleeves;

    for (let i = startIdx; i < endIdx; i++) {
        const sleeve = ns.sleeve.getSleeve(i);
        const purchasable = ns.sleeve.getSleevePurchasableAugs(i);
        const purchasableNames = new Set(purchasable.map(a => a.name));

        ns.tprint(`\n${'═'.repeat(60)}`);
        ns.tprint(`  SLEEVE ${i}`);
        ns.tprint(`${'═'.repeat(60)}`);

        // Basic info
        ns.tprint(`  City: ${sleeve.city} | Shock: ${sleeve.shock.toFixed(1)} | Sync: ${sleeve.sync.toFixed(1)}% | Memory: ${sleeve.memory}`);

        // Stats
        const sk = sleeve.skills;
        ns.tprint(`  Stats: hack=${sk.hacking} str=${sk.strength} def=${sk.defense} dex=${sk.dexterity} agi=${sk.agility} cha=${sk.charisma} int=${sk.intelligence}`);

        // Key multipliers
        const m = sleeve.mults;
        ns.tprint(`  Key Mults:`);
        ns.tprint(`    str=${m.strength.toFixed(2)}x  def=${m.defense.toFixed(2)}x  dex=${m.dexterity.toFixed(2)}x  agi=${m.agility.toFixed(2)}x`);
        ns.tprint(`    hack=${m.hacking.toFixed(2)}x  cha=${m.charisma.toFixed(2)}x  crime$=${m.crime_money.toFixed(2)}x  crime%=${m.crime_success.toFixed(2)}x`);
        ns.tprint(`    fac_rep=${m.faction_rep.toFixed(2)}x  co_rep=${m.company_rep.toFixed(2)}x  hack_spd=${m.hacking_speed.toFixed(2)}x`);

        // Derive installed augs (if SF4 available)
        if (hasSF4 && allSleeveAugNames.size > 0) {
            const installed = [...allSleeveAugNames].filter(a => !purchasableNames.has(a));
            ns.tprint(`\n  INSTALLED AUGMENTATIONS (${installed.length}):`);
            if (installed.length === 0) {
                ns.tprint(`    (none)`);
            } else {
                for (const aug of installed.sort()) {
                    ns.tprint(`    ✓ ${aug}`);
                }
            }
        }

        // Purchasable augs (sorted by cost)
        ns.tprint(`\n  AVAILABLE TO PURCHASE (${purchasable.length}):`);
        if (purchasable.length === 0) {
            ns.tprint(`    (all available augs installed!)`);
        } else {
            // Sort by cost ascending
            purchasable.sort((a, b) => a.cost - b.cost);
            let totalCost = 0;
            for (const aug of purchasable) {
                totalCost += aug.cost;
                const repReq = augRepReqs[aug.name];
                const factions = augFactionMap[aug.name];
                const extra = hasSF4 && factions
                    ? ` [from: ${factions.join(', ')}${repReq ? ` | rep: ${ns.format.number(repReq)}` : ''}]`
                    : '';
                ns.tprint(`    ✗ ${aug.name.padEnd(42)} ${('$' + ns.format.number(aug.cost)).padStart(10)}${extra}`);
            }
            ns.tprint(`    ${'─'.repeat(52)}`);
            ns.tprint(`    Total cost: $${ns.format.number(totalCost)}`);
        }

        // Augs that exist but aren't purchasable or installed (missing faction/rep)
        if (hasSF4 && allSleeveAugNames.size > 0) {
            const installed = new Set([...allSleeveAugNames].filter(a => !purchasableNames.has(a)));
            const unreachable = [...allSleeveAugNames].filter(a => !installed.has(a) && !purchasableNames.has(a));
            if (unreachable.length > 0) {
                ns.tprint(`\n  NOT AVAILABLE (need faction/rep) (${unreachable.length}):`);
                for (const aug of unreachable.sort()) {
                    const factions = augFactionMap[aug] ?? ['?'];
                    const repReq = augRepReqs[aug];
                    ns.tprint(`    ? ${aug.padEnd(42)} [from: ${factions.join(', ')}${repReq ? ` | need: ${ns.format.number(repReq)}` : ''}]`);
                }
            }
        }
    }

    // Summary
    if (targetSleeve < 0) {
        ns.tprint(`\n${'═'.repeat(60)}`);
        ns.tprint(`  SUMMARY`);
        ns.tprint(`${'═'.repeat(60)}`);
        let grandTotal = 0;
        for (let i = 0; i < numSleeves; i++) {
            const p = ns.sleeve.getSleevePurchasableAugs(i);
            const cost = p.reduce((s, a) => s + a.cost, 0);
            grandTotal += cost;
            ns.tprint(`  Sleeve ${i}: ${p.length} augs remaining, total cost $${ns.format.number(cost)}`);
        }
        ns.tprint(`  Grand total: $${ns.format.number(grandTotal)}`);
    }

    ns.tprint(`\n${'═'.repeat(60)}`);
    ns.tprint(`  BN10 PERSISTENCE REMINDER`);
    ns.tprint(`${'═'.repeat(60)}`);
    ns.tprint(`  Persists across BNs: number of sleeves, memory level`);
    ns.tprint(`  RESETS every BN: augmentations, stats, exp, shock (→100), sync (→memory)`);
    ns.tprint(`  Tip: Buy aug with highest mult impact NOW — they reset on BN switch.`);
    ns.tprint(`  Tip: Buy memory upgrades from Covenant — those are permanent.`);
}