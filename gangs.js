/**
 * gangs.js — Gang management script.
 *
 * Improvements over the original alain version:
 *  1. Charisma training is explicitly tracked and rotated. Without cha, tasks like
 *     Traffick Illegal Arms (best money), Run a Con, and Armed Robbery are permanently
 *     inactive because their statWeight goes negative. We dedicate a configurable
 *     fraction of members to Train Charisma until it reaches a useful threshold.
 *  2. The 4S TIX gate (budget ÷100 without 4S) is replaced with a configurable
 *     multiplier. Default is 0.05 without 4S (was 0.00002) so members actually get gear.
 *  3. Territory engagement threshold defaults to 0.52 instead of 0.60 so warfare starts
 *     while gangs are still equal power rather than waiting to be clearly dominant.
 *  4. Task selection explicitly computes all 6 stats per member against every task formula
 *     (same formulas as game source). Tasks with negative statWeight are excluded.
 *  5. Training rotation: newly recruited/ascended members train for min-training-ticks
 *     before being assigned crime. Charisma training stops once cha threshold is met.
 *  6. Ascension uses per-member staggered thresholds same as original, but applied
 *     to the most-needed stat (primary for gang type, cha for cha-deficient members).
 *
 * Preserved from original:
 *  - Territory warfare timing (tick detection, padding adjustment)
 *  - Greedy-shuffle optimizer (100 shuffles, sustainable task filtering)
 *  - Wanted penalty tolerance formula
 *  - Equipment purchase logic and priority
 *  - Gang creation priority order
 */

import {
    log, getConfiguration, instanceCount, getNsDataThroughFile, getActiveSourceFiles,
    runCommand, tryGetBitNodeMultipliers, formatMoney, formatNumberShort, formatDuration
} from './helpers.js'

// ── Constants ──────────────────────────────────────────────────────────────────
const UPDATE_MS               = 200;
const WANTED_PENALTY_THRESH   = 0.01;   // 1% actual penalty threshold. Old value (0.0001) triggered recovery
                                        // at 0.011% penalty -- negligible for high-respect gangs.
                                        // normal: >0.991, sustain: <0.991, recovery: <0.989
const OFF_STAT_COST_PENALTY   = 50;
const DEFAULT_EQUIP_BUDGET    = 0.002;   // fraction of cash per tick, equipment
const DEFAULT_AUG_BUDGET      = 0.20;    // fraction of cash per tick, augmentations
const NO4S_BUDGET_MULTIPLIER  = 0.05;    // Without 4S, scale down budgets (was /100)
const CHA_TRAINING_THRESHOLD  = 350;     // Stop training cha once all members exceed this (341 needed to unlock Traffick Illegal Arms with str/def/dex=70)
const HACK_TRAINING_THRESHOLD = 80;      // Same for hack (hacking gangs)
const MIN_TRAINING_TICKS      = 10;      // Territory ticks of training after ascend/recruit
const GANGS_FILE              = '/Temp/dashboard-gangs.txt'; // Dashboard reads this for Gang tab (ns.write = 0 GB)

// Gang creation preference order (most desirable first)
// Combat gangs listed before hacking gangs since they're available earlier
const GANG_PREFERENCE = [
    "Speakers for the Dead", "The Dark Army", "The Syndicate", "Tetrads",
    "Slum Snakes", "The Black Hand", /* "NiteSec" */ // NiteSec needs backdoor, listed last
];

// ── Global state ───────────────────────────────────────────────────────────────
let options;
const argsSchema = [
    ['training-percentage',          0.05  ], // Fraction of ticks randomly training (backup)
    ['cha-training-percentage',      0.15  ], // Fraction of members dedicated to cha training when cha < threshold
    ['no-training',                  false ], // Never train
    ['no-auto-ascending',            false ],
    ['ascend-multi-threshold',       1.05  ], // DEPRECATED: now uses dynamic threshold from asc_points (kept for CLI compat)
    ['ascend-multi-threshold-spacing', 0.05], // DEPRECATED: no longer used, threshold is per-member based on asc_points
    ['min-training-ticks',           MIN_TRAINING_TICKS],
    ['cha-threshold',                CHA_TRAINING_THRESHOLD], // 341 needed for Traffick Illegal Arms; 382 for Human Trafficking
    ['hack-threshold',               HACK_TRAINING_THRESHOLD],
    ['combat-bootcamp-threshold',    50  ], // Min avg combat stat before members do crime. New recruits/post-ascend train combat until this.
    ['reserve',                      null  ],
    ['augmentations-budget',         null  ], // Override default aug budget fraction
    ['equipment-budget',             null  ], // Override default equip budget fraction
    ['no-4s-budget-multiplier',      NO4S_BUDGET_MULTIPLIER], // Budget scale without 4S
    ['territory-engage-threshold',   0.52  ], // Engage warfare when avg win chance >= this
    ['money-focus',                  false ],
    ['reputation-focus',             false ],
];

export function autocomplete(data, _) { data.flags(argsSchema); return []; }

let myGangFaction = '', isHackGang = false, strWantedReduction = '', importantStats = [];
let requiredRep = 2.5e6, myGangMembers = [], equipments = [], ownedSourceFiles;
let allTaskNames, allTaskStats, assignedTasks = {}, lastMemberReset = {};
let multGangSoftcap = 1.0, resetInfo, is4sBought = false;

// Territory tracking
let territoryTickDetected = false, territoryTickTime = 20000;
let territoryTickWaitPadding = UPDATE_MS, consecutiveTerritoryDetections = 0;
let territoryNextTick = null, isReadyForNextTerritoryTick = false;
let warfareFinished = false, lastTerritoryPower = 0, lastOtherGangInfo = null;
let lastLoopTime = null;

// Dashboard live-update state
let lastDashboardData  = null;   // full snapshot cached by writeDashboardDataFull
let lastDashLiveWrite  = 0;      // timestamp of last live patch write

/** @param {NS} ns */
export async function main(ns) {
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return;
    options = runOptions;
    ownedSourceFiles = await getActiveSourceFiles(ns);
    if (!(ownedSourceFiles[2] > 0))
        return log(ns, 'ERROR: SF2 required for gang access.');

    await initialize(ns);
    log(ns, 'Gang manager starting main loop...');
    while (true) {
        try { await mainLoop(ns); }
        catch (err) {
            log(ns, `WARNING: Suppressed error in main loop:\n${err?.message ?? err}`, false, 'warning');
        }
        await ns.sleep(UPDATE_MS);
    }
}

// ── Initialization ─────────────────────────────────────────────────────────────
async function initialize(ns) {
    ns.disableLog('ALL');
    resetInfo = await getNsDataThroughFile(ns, 'ns.getResetInfo()');

    // Wait until in a gang, creating one if possible
    let loggedWaiting = false;
    while (!(await getNsDataThroughFile(ns, 'ns.gang.inGang()'))) {
        if (!loggedWaiting) {
            log(ns, 'Waiting to join/create a gang...');
            loggedWaiting = true;
        }
        if (resetInfo.currentNode === 2 || ns.heart.break() <= -54000)
            await runCommand(ns, `ns.args.forEach(g => ns.gang.createGang(g))`,
                '/Temp/gang-createGang.js', GANG_PREFERENCE);
        await ns.sleep(1000);
    }

    const myGangInfo = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
    myGangFaction    = myGangInfo.faction;
    isHackGang       = myGangInfo.isHacking;
    strWantedReduction = isHackGang ? 'Ethical Hacking' : 'Vigilante Justice';
    importantStats     = isHackGang ? ['hack'] : ['str', 'def', 'dex', 'agi'];

    if (loggedWaiting)
        log(ns, `Created gang: ${myGangFaction}`, true, 'success');

    // Required rep for gang augs
    if (ownedSourceFiles[4] > 0) {
        try {
            const augNames  = await getNsDataThroughFile(ns,
                `ns.singularity.getAugmentationsFromFaction(ns.args[0])`, null, [myGangFaction]);
            const owned     = await getNsDataThroughFile(ns,
                `ns.singularity.getOwnedAugmentations(true)`, '/Temp/player-augs-purchased.txt');
            const repReqs   = await getDict(ns, augNames, 'singularity.getAugmentationRepReq', '/Temp/aug-repreqs.txt');
            requiredRep = augNames
                .filter(a => !owned.includes(a) && a !== 'The Red Pill')
                .reduce((mx, a) => Math.max(mx, repReqs[a] ?? 0), -1);
            log(ns, `Highest unowned aug rep: ${formatNumberShort(requiredRep)}`);
        } catch {
            log(ns, 'WARNING: Could not fetch aug rep requirements. Using default 2.5m.', false, 'warning');
        }
    }

    // Equipment catalogue
    const equipNames  = await getNsDataThroughFile(ns, 'ns.gang.getEquipmentNames()');
    const equipTypes  = await getGangDict(ns, equipNames, 'getEquipmentType');
    const equipCosts  = await getGangDict(ns, equipNames, 'getEquipmentCost');
    const equipStats  = await getGangDict(ns, equipNames, 'getEquipmentStats');
    equipments = equipNames.map(n => ({
        name: n, type: equipTypes[n], cost: equipCosts[n], stats: equipStats[n]
    })).sort((a, b) => a.cost - b.cost);

    allTaskNames  = await getNsDataThroughFile(ns, 'ns.gang.getTaskNames()');
    allTaskStats  = await getGangDict(ns, allTaskNames, 'getTaskStats');
    multGangSoftcap = (await tryGetBitNodeMultipliers(ns)).GangSoftcap;

    myGangMembers = await getNsDataThroughFile(ns, 'ns.gang.getMemberNames()');
    const dictMembers = await getGangDict(ns, myGangMembers, 'getMemberInformation');
    for (const m of Object.values(dictMembers))
        assignedTasks[m.name] = (m.task && m.task !== 'Unassigned')
            ? m.task : trainTask();
    while (myGangMembers.length < 3) await doRecruitMember(ns);

    lastLoopTime = Date.now();
    await onTerritoryTick(ns, myGangInfo);
    lastTerritoryPower = myGangInfo.power;
}

// ── Main loop ──────────────────────────────────────────────────────────────────
async function mainLoop(ns) {
    const myGangInfo = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
    const now = Date.now();

    // Detect territory tick by watching other gangs' power change
    if (!territoryTickDetected) {
        const otherInfo = await getNsDataThroughFile(ns, 'ns.gang.getOtherGangInformation()');
        if (lastOtherGangInfo != null &&
            JSON.stringify(otherInfo) !== JSON.stringify(lastOtherGangInfo)) {
            territoryNextTick = lastLoopTime + territoryTickTime;
            territoryTickDetected = true;
            log(ns, `Territory tick detected. Next tick ETA: ${formatDuration(territoryNextTick - now - territoryTickWaitPadding)}`);
        } else if (!lastOtherGangInfo)
            log(ns, `Waiting for territory tick detection...`);
        lastOtherGangInfo = otherInfo;
    }

    // Switch to Territory Warfare just before tick
    if (!warfareFinished && !isReadyForNextTerritoryTick &&
        now + UPDATE_MS + territoryTickWaitPadding >= territoryNextTick) {
        isReadyForNextTerritoryTick = true;
        await updateMemberActivities(ns, null, 'Territory Warfare', myGangInfo);
    }

    // Handle territory tick
    if ((isReadyForNextTerritoryTick && myGangInfo.power !== lastTerritoryPower) ||
        now > (territoryNextTick ?? 0) + 5000) {
        await onTerritoryTick(ns, myGangInfo);
        isReadyForNextTerritoryTick = false;
        lastTerritoryPower = myGangInfo.power;
    } else if (isReadyForNextTerritoryTick) {
        log(ns, `Waiting for territory tick. Power=${formatNumberShort(myGangInfo.power)}. ETA: ${formatDuration(territoryNextTick - now)}`);
    }
    lastLoopTime = now;

    // Live dashboard patch (~1s cadence). Uses the already-fetched myGangInfo so
    // there's zero extra ns.gang.* cost. Keeps wantedLevel/respect/income live
    // between the ~20s territory-tick full writes.
    if (now - lastDashLiveWrite > 1000) {
        writeDashboardDataLive(ns, myGangInfo);
        lastDashLiveWrite = now;
    }
}

// ── Territory tick actions ─────────────────────────────────────────────────────
async function onTerritoryTick(ns, myGangInfo) {
    territoryNextTick = lastLoopTime + territoryTickTime /
        (ns.gang.getBonusTime() > 0 ? 5 : 1);

    if (myGangInfo.power !== lastTerritoryPower || lastTerritoryPower == null) {
        consecutiveTerritoryDetections++;
        if (consecutiveTerritoryDetections > 5 && territoryTickWaitPadding > UPDATE_MS)
            territoryTickWaitPadding = Math.max(UPDATE_MS, territoryTickWaitPadding - UPDATE_MS);
        log(ns, `Power: ${formatNumberShort(lastTerritoryPower)} → ${formatNumberShort(myGangInfo.power)}`);
    } else if (!warfareFinished) {
        consecutiveTerritoryDetections = 0;
        territoryTickWaitPadding = Math.min(2000, territoryTickWaitPadding + UPDATE_MS);
        territoryNextTick -= UPDATE_MS;
        // Only reset detection state if warfare is engaged — when warfare is off,
        // power never changes by design (gain = 0.015 × territory × Σ members_on_TW,
        // and pre-tick TW switch contributes 0 if timing is off by even one loop).
        // Resetting detection every miss creates an infinite re-sync loop.
        if (myGangInfo.territoryWarfareEngaged) {
            territoryTickDetected = false;
            lastOtherGangInfo = null;
            log(ns, 'WARNING: Power not updated while in warfare, re-syncing tick detection.', false, 'warning');
        } else {
            // warfare off: re-arm tick detection so lastOtherGangInfo keeps refreshing
            territoryTickDetected = false;
        }
    }

    myGangMembers = await getNsDataThroughFile(ns, 'ns.gang.getMemberNames()');
    if (await getNsDataThroughFile(ns, 'ns.gang.canRecruitMember()'))
        await doRecruitMember(ns);

    const dictMembers = await getGangDict(ns, myGangMembers, 'getMemberInformation');

    if (!options['no-auto-ascending']) await tryAscendMembers(ns, myGangInfo);
    await tryUpgradeMembers(ns, dictMembers);
    await enableOrDisableWarfare(ns, myGangInfo);

    // Determine training task for this tick
    // Priority: cha training if members are cha-deficient, else primary stat, else random
    const forcedTask = pickTrainingTask(dictMembers);
    await updateMemberActivities(ns, dictMembers, forcedTask);
    if (!forcedTask)
        await optimizeGangCrime(ns, await waitForGameUpdate(ns, myGangInfo));

    // Write fresh data for the dashboard Gang tab.
    // gangs.js already paid for all the ns.gang.* calls above, so this is essentially
    // free (ns.write = 0 GB). Saves ~12 GB by letting dashboard-gangs.js skip gatherData.
    try { await writeDashboardDataFull(ns); }
    catch (e) { log(ns, `Dashboard write error: ${e?.message ?? e}`, false, 'warning'); }
}

// ── Training task selection ────────────────────────────────────────────────────
/**
 * Returns a global forced training task for ALL members this tick, or null.
 * Only used for the rare generic-training ticks (training-percentage).
 * Charisma training is handled PER-MEMBER inside the optimizer, so it doesn't
 * kill all crime output while cha-deficient members train.
 */
function pickTrainingTask(dictMembers) {
    // Per-member training is now handled entirely within optimizeGangCrime via
    // chaTrainSet (cha/hack below threshold) and combatTrainSet (below asc threshold).
    // The old random global override is redundant and actively harmful — it fires with
    // 5% probability, forces Train Combat on everyone including cha trainers, and skips
    // optimizeGangCrime entirely for that tick. Always return null.
    return null;
}

/** Primary training task for this gang type */
function trainTask() {
    return isHackGang ? 'Train Hacking' : 'Train Combat';
}

// ── Member activities ──────────────────────────────────────────────────────────
async function updateMemberActivities(ns, dictMemberInfo = null, forceTask = null, myGangInfo = null) {
    const dictMembers = dictMemberInfo ??
        (await getGangDict(ns, myGangMembers, 'getMemberInformation'));
    const maxDef = Math.max(...Object.values(dictMembers).map(m => m.def));
    const workOrders = [];

    for (const m of Object.values(dictMembers)) {
        // Override task if this member just ascended/recruited (still in training window)
        let task = forceTask ?? assignedTasks[m.name];

        // Force-train members who recently ascended/recruited — checked BEFORE TW so
        // freshly ascended members with 0 stats don't get sent to Territory Warfare
        const trainTicks = options['min-training-ticks'] * territoryTickTime;
        if ((Date.now() - (lastMemberReset[m.name] ?? 0)) < trainTicks) {
            task = trainTask();
            if (m.task !== task) workOrders.push({ name: m.name, task });
            continue; // Skip TW/fragile checks entirely for training members
        }

        // Protect fragile members from warfare deaths
        if (forceTask === 'Territory Warfare' && myGangInfo?.territoryClashChance > 0) {
            if (m.def < 100 || m.def < Math.min(10000, maxDef * 0.1))
                task = assignedTasks[m.name];
        }

        if (m.task !== task) workOrders.push({ name: m.name, task });
    }

    if (!workOrders.length) return;
    const ok = await getNsDataThroughFile(ns,
        `JSON.parse(ns.args[0]).reduce((s,m) => s && ns.gang.setMemberTask(m.name, m.task), true)`,
        '/Temp/gang-set-tasks.txt', [JSON.stringify(workOrders)]);
    if (ok)
        log(ns, `Assigned ${workOrders.length} member tasks (${[...new Set(workOrders.map(o => o.task))].join(', ')})`);
    else
        log(ns, `ERROR: Failed to assign member tasks: ${JSON.stringify(workOrders)}`, false, 'error');
}

// ── Crime optimization ─────────────────────────────────────────────────────────
async function optimizeGangCrime(ns, myGangInfo) {
    const dictMembers = await getGangDict(ns, myGangMembers, 'getMemberInformation');

    // Compute actual VJ wanted reduction rate from member stats and territory.
    // Used in both recovery tolerance and vjNeeded allocation below.
    // Formula (from game source): 0.4 * baseWanted * statWeight * territoryMult
    // VJ: baseWanted = -0.001, all stat weights = 20%, difficulty = 1
    const allMembers = Object.values(dictMembers);
    const avgVjRate = (() => {
        const tm = Math.max(0.005, Math.pow(myGangInfo.territory * 100, 0.9) / 100);
        let total = 0;
        for (const m of allMembers) {
            const sw = 0.2 * ((m.hack ?? 0) + m.str + m.def + m.dex + m.agi) - 3.5;
            if (sw > 0) total += 0.4 * 0.001 * sw * tm;
        }
        return allMembers.length > 0 ? total / allMembers.length : 0.002;
    })();
    const vjPerMemberRate = Math.max(0.001, avgVjRate);

    const currentPenalty = getWantedPenalty(myGangInfo) - 1;
    // wantedGainTolerance: how much wanted gain per cycle is acceptable.
    //
    // DESIGN: The penalty formula is respect/(respect+wanted). At low respect,
    // even moderate wanted is "high percentage" but negligible in absolute terms.
    // A 5% penalty at 390 respect means wanted=20.5 — cosmetically ugly but the
    // gang needs to do crimes to build respect, not sit on Vigilante Justice.
    //
    // Three modes:
    //   Normal:   allow wanted to grow as long as penalty stays below threshold
    //   Sustain:  wanted is high enough to matter; allow some crime but cap growth
    //   Recovery: penalty is painful; demand wanted decrease (capped to achievable rate)
    //
    // Early-game guard: with < 8 members, respect is the bottleneck for recruiting.
    // Crippling crime output to control wanted is counterproductive.
    const penaltyPct = -currentPenalty; // positive number, e.g. 0.015 = 1.5%
    // Estimate how many members are free for crime (before chaTrainSet is computed).
    // If most members need cha/hack training, the gang is effectively early-game
    // regardless of headcount. Entering sustain at 5% penalty when only 1-2 members
    // can do crime starves respect growth and delays recruiting.
    const flatChaEst = isHackGang ? HACK_TRAINING_THRESHOLD : CHA_TRAINING_THRESHOLD;
    const freeForCrimeEst = allMembers.filter(m => {
        // Same logic as memberChaGate: crime viable AND proportional
        const tiaSW = isHackGang
            ? 0.90 * (m.hack ?? 0) + 0.10 * (m.cha ?? 0) - 3.2
            : 0.15 * (m.hack ?? 0) + 0.15 * m.str + 0.15 * m.def + 0.20 * m.dex + 0.35 * (m.cha ?? 0) - 57.6;
        const avgCombat = (m.str + m.def + m.dex + m.agi) / 4;
        const crimeOk = tiaSW >= 50 || (isHackGang ? (m.hack ?? 0) >= flatChaEst : (m.cha ?? 0) >= flatChaEst);
        const proportionalOk = isHackGang || avgCombat <= 200 || (m.cha ?? 0) >= Math.min(2000, avgCombat * 0.05);
        const combatOk = isHackGang || (avgCombat >= 50);
        return crimeOk && proportionalOk && combatOk;
    }).length;
    const earlyGame = freeForCrimeEst <= 2 || myGangInfo.respect < 5000;

    // Recovery: penalty > 10% (or > 20% early game) AND wanted is meaningfully above minimum
    const recoveryThresh = earlyGame ? 0.20 : 0.10;
    // Sustain: penalty > 5% (or > 10% early game)
    const sustainThresh = earlyGame ? 0.10 : 0.05;

    let wantedGainTolerance;
    if (penaltyPct > recoveryThresh && myGangInfo.wantedLevel > 2) {
        // Recovery: demand wanted decrease, but cap to half what all-vigilante could produce.
        // This ensures the optimizer can still assign SOME members to crime for respect/money
        // instead of deadlocking everyone on Vigilante Justice.
        const estimatedVjRate = -vjPerMemberRate * myGangMembers.length;
        wantedGainTolerance = Math.max(estimatedVjRate * 0.5, -0.01 * myGangInfo.wantedLevel);
        log(ns, `[gang-dbg] RECOVERY mode: penalty=${(penaltyPct*100).toFixed(1)}% tolerance=${wantedGainTolerance.toFixed(4)}`);
    } else if (penaltyPct > sustainThresh && myGangInfo.wantedLevel > 1.5) {
        // Sustain: allow a small wanted trickle so at least 1 member can do crime.
        // Pure tolerance=0 deadlocks every free member to VJ — zero respect, zero money.
        // Instead: allow growth at the rate 1 VJ member can offset, so net wanted stays flat.
        // Floor of 0.05 ensures low-wanted crimes (Mug, Strongarm) are always permitted.
        wantedGainTolerance = Math.max(0.05, myGangInfo.wantedLevel / 200);
        log(ns, `[gang-dbg] SUSTAIN mode: penalty=${(penaltyPct*100).toFixed(1)}% tolerance=${wantedGainTolerance.toFixed(4)}`);
    } else {
        // Normal: be generous, let the gang do crimes
        wantedGainTolerance = Math.max(myGangInfo.respectGainRate / 500, myGangInfo.wantedLevel / 10);
    }

    let factionRep = -1;
    if (ownedSourceFiles[4] > 0) {
        try {
            factionRep = await getNsDataThroughFile(ns,
                `ns.singularity.getFactionRep(ns.args[0])`, null, [myGangFaction]);
        } catch {}
    }
    if (factionRep < 0) factionRep = myGangInfo.respect / 75;

    // optStat decision tree:
    //   1. Explicit flags override everything
    //   2. Already have enough faction rep for all augs → pure money
    //   3. All 12 members recruited → money. Respect is only needed for faction rep at this
    //      point, and it builds passively from any crime (HT still produces baseRespect=0.004).
    //      Optimizing for respect sacrifices 10-50x money income for marginally faster faction
    //      rep gain. Not worth it — especially when saving for Covenant sleeves.
    //   4. Early game (respect < 9000) → pure respect to recruit members fast
    //   5. Mid game → both (blend respect + money)
    const maxMembers = 12;
    const optStat = options['reputation-focus'] ? 'respect'
        : options['money-focus']       ? 'money'
        : factionRep > requiredRep     ? 'money'
        : myGangMembers.length >= maxMembers ? 'money'
        : (myGangInfo.respect < 9000)  ? 'respect'
        : 'both';

    // ── Debug: log key state every optimization pass ────────────────────────
    const memberStats = Object.values(dictMembers).map(m =>
        `${m.name}: str=${m.str} dex=${m.dex} agi=${m.agi} cha=${m.cha}`).join(', ');
    log(ns, `[gang-dbg] Tolerance=${wantedGainTolerance.toFixed(4)} respect=${myGangInfo.respect.toFixed(0)} wanted=${myGangInfo.wantedLevel.toFixed(2)} optStat=${optStat}`);
    log(ns, `[gang-dbg] Stats: ${memberStats}`);

    // Determine which members should train cha/hack this tick (per-member, not global)
    const statKey     = isHackGang ? 'hack' : 'cha';
    const trainTaskName = isHackGang ? 'Train Hacking' : 'Train Charisma';
    // chaTrainSet: members whose cha/hack is below the training threshold.
    // Cap size when wanted is bad to always leave at least VIGILANTE_FLOOR members free
    // for Vigilante Justice. Without the cap, all members lock to Train Charisma, the
    // downgrade loop skips them (locked tasks), and wanted can never recover.
    const inSustainOrRecovery = penaltyPct > sustainThresh && myGangInfo.wantedLevel > 1.5;
    const vjNeededRaw = wantedGainTolerance < 0
        ? Math.min(allMembers.length - 1, Math.max(2, Math.ceil(Math.abs(wantedGainTolerance) / vjPerMemberRate)))
        : inSustainOrRecovery ? 1  // Sustain: at least 1 VJ to actively reduce existing wanted
        : 0;
    // Always reserve at least some members for crime. Without this, proportional gate can
    // lock all 12 to Train Charisma when combat stats are high but cha is below the cap.
    // The opportunity cost of 0 crime output massively outweighs a few % cha improvement.
    const minFreeForCrime = Math.max(1, Math.floor(allMembers.length / 6)); // 1 for ≤6, 2 for 12
    const maxChaTrainers = Math.max(0, allMembers.length - vjNeededRaw - minFreeForCrime);
    // Dynamic cha threshold: flat unlock threshold (350) is the GATE for crime eligibility
    // UNLESS the member's combat stats are high enough that TIA/Ethical Hacking produces
    // positive statWeight even with low cha. High-combat post-ascension members with cha=130
    // and str=3000 produce statWeight=1600 on TIA — locking them to Train Charisma is absurd.
    //
    // Gate logic: member needs cha training if BOTH:
    //   (a) cha < flat threshold (350), AND
    //   (b) key crime statWeight is too low (< 50) to be productive
    // If (b) fails (statWeight is high), combat stats carry the member through TIA just fine.
    const flatChaThreshold = isHackGang ? options['hack-threshold'] : options['cha-threshold'];
    // TIA: hack15 str15 def15 dex20 agi0 cha35 diff18 | Ethical Hacking: hack90 cha10 diff1
    const keyCrimeStatWeight = (m) => isHackGang
        ? 0.90 * (m.hack ?? 0) + 0.10 * (m.cha ?? 0) - 3.2 * 1  // Ethical Hacking
        : 0.15 * (m.hack ?? 0) + 0.15 * m.str + 0.15 * m.def + 0.20 * m.dex + 0.35 * (m.cha ?? 0) - 3.2 * 18; // TIA
    const memberChaGate = (m) => {
        if (isHackGang) {
            if (keyCrimeStatWeight(m) >= 50) return 0;
            return flatChaThreshold;
        }
        // Two independent gates — take the HIGHER:
        //
        // 1. Crime viability: can the member do TIA at all?
        //    Low combat + low cha → negative statWeight → need flat 350 threshold
        const crimeGate = keyCrimeStatWeight(m) >= 50 ? 0 : flatChaThreshold;
        //
        // 2. Proportionality: is cha keeping up with combat stats?
        //    After ascension, Train Combat rockets str/def/dex/agi via high asc mults
        //    but cha stays near 0 (Train Combat gives 0 cha exp). TIA weights cha at 35%
        //    — the largest single stat. Training cha to 5% of avg combat recovers most
        //    of the lost output. Cap at 2000 so members with 100k+ combat stats don't
        //    get locked to Train Charisma for hours chasing a 2% improvement.
        const avgCombat = (m.str + m.def + m.dex + m.agi) / 4;
        const proportionalGate = avgCombat > 200 ? Math.min(2000, Math.ceil(avgCombat * 0.05)) : 0;

        return Math.max(crimeGate, proportionalGate);
    };
    // Long-term training target: keep cha proportional to dex (used for priority, not gating)
    const memberChaTrainTarget = (m) => isHackGang
        ? flatChaThreshold
        : Math.max(flatChaThreshold, 0.8 * (m.dex ?? 0));

    // chaTrainSet: members below the GATE threshold. These can't do crime effectively.
    const chaTrainSet = new Set(
        allMembers
            .filter(m => (m[statKey] ?? 0) < memberChaGate(m))
            .sort((a, b) => {
                // Sort descending (closest to threshold first) so the cap displaces the
                // most deficient members to VJ, not ones nearly at the unlock point.
                const ratioA = (a[statKey] ?? 0) / memberChaGate(a);
                const ratioB = (b[statKey] ?? 0) / memberChaGate(b);
                return ratioB - ratioA;
            })
            .slice(0, maxChaTrainers)
            .map(m => m.name)
    );

    log(ns, `[gang-dbg] chaTrainSet (${chaTrainSet.size} below threshold, max ${maxChaTrainers}): [${[...chaTrainSet].join(', ')}]`);

    // ── Combat bootcamp: bring low-stat members up to viable crime levels ──
    // New recruits and freshly ascended members often have combat stats too low
    // for any crime to produce meaningful output. Training combat from 20→50 is
    // much faster than the marginal respect they'd earn struggling through Mug.
    // Applies AFTER cha training (cha is the gating unlock for TIA/HT).
    const bootcampThreshold = options['combat-bootcamp-threshold'];
    const combatBootcampSet = new Set(
        allMembers
            .filter(m => {
                if (chaTrainSet.has(m.name)) return false; // Cha training takes priority
                if (options['no-training']) return false;
                if (isHackGang) return false; // Hack gangs use hack threshold in chaTrainSet
                const avgCombat = (m.str + m.def + m.dex + m.agi) / 4;
                return avgCombat < bootcampThreshold;
            })
            .map(m => m.name)
    );
    if (combatBootcampSet.size > 0)
        log(ns, `[gang-dbg] combatBootcampSet (avg combat < ${bootcampThreshold}): [${[...combatBootcampSet].join(', ')}]`);

    // Build a combat training set for members who haven't reached ascension threshold yet.
    // These members need Train Combat to push their stats high enough to ascend.
    // Exclusions to prevent blocking cha training:
    //   - Already in chaTrainSet (cha training takes priority)
    //   - Within min-training-ticks window (already training combat via inTraining path)
    //   - cha_exp is 0 < exp < 3000 (cha training in progress; combat training here
    //     would let them ascend and reset that cha progress to 0 with 0 asc points gained)
    //   - cha/hack stat below training threshold (needs cha/hack training first, not more combat)
    const ascResults = await getGangDict(ns, myGangMembers, 'getAscensionResult');
    const trainTicks = options['min-training-ticks'] * territoryTickTime;
    // Use same dynamic threshold for combatTrainSet exclusion
    const chaHackThreshold = (m) => isHackGang ? options['hack-threshold'] : memberChaGate(m);
    const combatTrainSet = new Set(
        Object.values(dictMembers)
            .filter(m => {
                if (chaTrainSet.has(m.name)) return false; // Already in cha training
                if (combatBootcampSet.has(m.name)) return false; // Already in combat bootcamp
                if ((Date.now() - (lastMemberReset[m.name] ?? 0)) < trainTicks) return false; // Already in training window
                if ((m[statKey] ?? 0) < chaHackThreshold(m)) return false; // Needs cha/hack training first
                const chaExp = dictMembers[m.name]?.cha_exp ?? 0;
                if (chaExp > 0 && chaExp < 3000) return false; // Cha training in progress — don't interrupt
                const result = ascResults[m.name];
                if (!result) return false;
                const info = dictMembers[m.name];
                const statsList = [...importantStats, 'cha'];
                const maxAscPts = Math.max(...statsList.map(s => info?.[s + '_asc_points'] ?? 0));
                const threshold = optimalAscendThreshold(maxAscPts);
                // Member needs combat training if NO stat meets the ascension threshold
                return !statsList.some(s => (result[s] ?? 0) >= threshold);
            })
            .sort((a, b) => {
                // Prioritize members closest to their threshold (highest result/threshold ratio)
                const getMaxRatio = m => {
                    const result = ascResults[m.name];
                    const info = dictMembers[m.name];
                    const statsList = [...importantStats, 'cha'];
                    const maxAscPts = Math.max(...statsList.map(s => info?.[s + '_asc_points'] ?? 0));
                    const threshold = optimalAscendThreshold(maxAscPts);
                    return Math.max(...statsList.map(s => (result?.[s] ?? 0) / threshold));
                };
                return getMaxRatio(b) - getMaxRatio(a);
            })
            .slice(0, 1) // At most 1 member in combat training at a time
            .map(m => m.name)
    );
    if (combatTrainSet.size > 0)
        log(ns, `[gang-dbg] combatTrainSet (training to reach asc threshold): [${[...combatTrainSet].join(', ')}]`);

    // Commit training assignments to assignedTasks NOW before startingGain is computed.
    // Build vjSet from non-training members sorted by crime output ascending (weakest first).
    // Cap vjNeeded to nonTrainingCount-1 so at least 1 non-training member is always free
    // for crime — otherwise when all remaining members are taken for VJ, nobody does crimes.
    const lockedToTraining = new Set([...chaTrainSet, ...combatBootcampSet, ...combatTrainSet]);
    const nonTrainingMembers = allMembers.filter(m => !lockedToTraining.has(m.name));
    const vjNeeded = Math.min(vjNeededRaw, Math.max(0, nonTrainingMembers.length - 1));
    const crimeProxy = m => isHackGang
        ? (m.hack ?? 0) + (m.cha ?? 0)
        : importantStats.reduce((s, k) => s + (m[k] ?? 0), 0) + (m.cha ?? 0);
    const vjSet = new Set(
        vjNeeded > 0
            ? nonTrainingMembers
                .sort((a, b) => crimeProxy(a) - crimeProxy(b))
                .slice(0, vjNeeded)
                .map(m => m.name)
            : []
    );
    if (vjSet.size > 0)
        log(ns, `[gang-dbg] vjSet (vjNeeded=${vjNeeded}/${vjNeededRaw} capped, vjRate=${vjPerMemberRate.toFixed(4)}/member): [${[...vjSet].join(', ')}]`);

    let trainingChanged = false;
    for (const m of allMembers) {
        if (chaTrainSet.has(m.name) && assignedTasks[m.name] !== trainTaskName) {
            assignedTasks[m.name] = trainTaskName;
            trainingChanged = true;
        } else if (combatBootcampSet.has(m.name) && assignedTasks[m.name] !== trainTask()) {
            assignedTasks[m.name] = trainTask();
            trainingChanged = true;
        } else if (combatTrainSet.has(m.name) && assignedTasks[m.name] !== trainTask()) {
            assignedTasks[m.name] = trainTask();
            trainingChanged = true;
        } else if (vjSet.has(m.name) && assignedTasks[m.name] !== strWantedReduction) {
            assignedTasks[m.name] = strWantedReduction;
            trainingChanged = true;
        }
    }
    if (trainingChanged) {
        await updateMemberActivities(ns, dictMembers);
        log(ns, `[gang-dbg] Committed ${[...chaTrainSet].length} cha + ${combatBootcampSet.size} bootcamp + ${combatTrainSet.size} combat + ${vjSet.size} VJ before optimizing.`);
    }

    // Pre-compute every member × every task rate
    // Members in chaTrainSet are locked to Train Charisma/Hacking
    // Members in combatBootcampSet or combatTrainSet are locked to Train Combat
    const memberTaskRates = Object.fromEntries(
        Object.values(dictMembers).map(m => [m.name,
            chaTrainSet.has(m.name)
                ? [{ name: trainTaskName, respect: 0, money: 0, wanted: 0, both: 0 }]
                : (combatBootcampSet.has(m.name) || combatTrainSet.has(m.name))
                    ? [{ name: trainTask(), respect: 0, money: 0, wanted: 0, both: 0 }]
                    : vjSet.has(m.name)
                    ? [{ name: strWantedReduction, respect: 0, money: 0, wanted: -vjPerMemberRate, both: 0 }]
                    : allTaskNames.map(t => ({
                    name:    t,
                    respect: computeRespectGain(myGangInfo, t, m),
                    money:   computeMoneyGain(myGangInfo, t, m),
                    wanted:  computeWantedGain(myGangInfo, t, m),
                })).filter(t => t.wanted <= 0 || t.money > 0 || t.respect > 0)
        ])
    );

    if (optStat === 'both')
        Object.values(memberTaskRates).flat().forEach(v => v.both = v.money / 1000 + v.respect);

    const sortKey = optStat === 'both' ? 'both' : optStat;
    if (optStat === 'both') {
        // Stagger: even-indexed members prioritise respect, odd prioritise money
        Object.values(memberTaskRates).forEach((tasks, i) =>
            tasks.sort((a, b) => i % 2 === 0 ? b.respect - a.respect : b.money - a.money));
    } else {
        Object.values(memberTaskRates).forEach(tasks =>
            tasks.sort((a, b) => b[sortKey] - a[sortKey]));
    }

    const start = Date.now();
    let bestAssignments = null, bestGain = 0, bestWanted = 0;
    const startingGain = myGangInfo.wantedLevelGainRate > wantedGainTolerance ? 0
        : optStat === 'respect' ? myGangInfo.respectGainRate : myGangInfo.moneyGainRate;
    bestGain = startingGain;

    for (let shuffle = 0; shuffle < 100; shuffle++) {
        let proposed = {}, totalWanted = 0, totalGain = 0;
        shuffleArray(myGangMembers.slice()).forEach((member, idx) => {
            const rates = memberTaskRates[member];
            const sustainable = idx < myGangMembers.length - 2
                ? rates
                : rates.filter(t => totalWanted + t.wanted <= wantedGainTolerance);
            const trainTicks = options['min-training-ticks'] * territoryTickTime;
            const inTraining = (Date.now() - (lastMemberReset[member] ?? 0)) < trainTicks;
            // For chaTrainSet members, rates = [{name:'Train Charisma',...}], rates[0] IS the task.
            // For inTraining members, use trainTask() (Train Combat/Hacking).
            // For zero-gain members (no viable crime), also train.
            const bestTask = inTraining
                ? rates.find(t => t.name === trainTask()) ?? rates[0]
                : rates[0]?.[sortKey] === 0
                    ? rates[0]   // locked to training task (Train Charisma etc.)
                    : (totalWanted > wantedGainTolerance || !sustainable.length)
                        ? rates.find(t => t.name === strWantedReduction) ?? rates[0]
                        : sustainable[0];
            if (!bestTask) return;
            proposed[member] = bestTask;
            totalWanted += bestTask.wanted;
            totalGain   += bestTask[sortKey] ?? 0;
        });

        // Downgrade worst offenders until within tolerance.
        // Skip chaTrainSet members (locked tasks, can't downgrade) and guard against
        // null worst (all on vigilante) or undefined next (no lower-wanted task found).
        let guard = 9999;
        while (totalWanted > wantedGainTolerance &&
               Object.values(proposed).some(t => t.name !== strWantedReduction && t.name !== trainTask() && t.name !== 'Train Charisma' && t.name !== 'Train Hacking')) {
            const worst = Object.keys(proposed).reduce((t, c) => {
                const task = proposed[c];
                // Skip members locked to training tasks — can't downgrade them
                if (task.name === strWantedReduction || task.name === trainTask() ||
                    task.name === 'Train Charisma' || task.name === 'Train Hacking' ||
                    combatBootcampSet.has(c) || combatTrainSet.has(c)) return t;
                return t == null || proposed[t].wanted < task.wanted ? c : t;
            }, null);
            if (worst == null) break; // All downgradeable members already on vigilante
            const next = memberTaskRates[worst].find(t => t.wanted < proposed[worst].wanted)
                ?? memberTaskRates[worst].find(t => t.name === strWantedReduction);
            if (!next) break; // No lower-wanted task available (e.g. chaTrainSet member)
            totalWanted += next.wanted - proposed[worst].wanted;
            totalGain   += (next[sortKey] ?? 0) - (proposed[worst][sortKey] ?? 0);
            proposed[worst] = next;
            if (--guard <= 0) throw 'Infinite loop in crime optimizer';
        }

        if (totalWanted <= wantedGainTolerance && totalGain > bestGain ||
            totalWanted > wantedGainTolerance && totalWanted < bestWanted)
            [bestAssignments, bestGain, bestWanted] = [proposed, totalGain, totalWanted];
    }

    log(ns, `[gang-dbg] Best: ${bestAssignments ? Object.entries(bestAssignments).map(([m,t])=>m.split(' ')[1]+':'+t.name).join(' | ') : 'null (no improvement)'}`);
    if (bestAssignments && myGangMembers.some(m => assignedTasks[m] !== bestAssignments[m]?.name)) {
        myGangMembers.forEach(m => { if (bestAssignments[m]) assignedTasks[m] = bestAssignments[m].name; });
        const old = myGangInfo;
        await updateMemberActivities(ns, dictMembers);
        myGangInfo = await waitForGameUpdate(ns, old);
        log(ns, `Optimized for ${optStat} (${Date.now()-start}ms). ` +
            `Wanted: ${old.wantedLevelGainRate.toPrecision(3)}→${myGangInfo.wantedLevelGainRate.toPrecision(3)}, ` +
            `Rep: ${formatNumberShort(old.respectGainRate)}→${formatNumberShort(myGangInfo.respectGainRate)}, ` +
            `Money: ${formatMoney(old.moneyGainRate)}→${formatMoney(myGangInfo.moneyGainRate)}`);
    } else {
        log(ns, `All ${myGangMembers.length} assignments already optimal for ${optStat} (${Date.now()-start}ms).`);
    }

    if (myGangInfo.wantedLevelGainRate > wantedGainTolerance)
        await fixWantedGainRate(ns, myGangInfo, wantedGainTolerance);
}

async function fixWantedGainRate(ns, myGangInfo, tolerance = 0) {
    let lastRate = myGangInfo.wantedLevelGainRate;
    log(ns, `WARNING: Wanted gaining too fast (${lastRate.toPrecision(3)} > ${tolerance.toPrecision(3)}), assigning vigilante...`, false, 'warning');
    for (const m of shuffleArray(myGangMembers.slice())) {
        if (!['Mug People','Deal Drugs','Strongarm Civilians','Run a Con','Armed Robbery',
            'Traffick Illegal Arms','Human Trafficking','Terrorism',
            'Ransomware','Phishing','Identity Theft','DDoS Attacks',
            'Plant Virus','Fraud & Counterfeiting','Money Laundering','Cyberterrorism'
        ].includes(assignedTasks[m])) continue;
        assignedTasks[m] = strWantedReduction;
        await updateMemberActivities(ns);
        myGangInfo = await waitForGameUpdate(ns, myGangInfo);
        if (myGangInfo.wantedLevelGainRate < tolerance) return;
        if (myGangInfo.wantedLevelGainRate === lastRate)
            log(ns, `WARNING: Rolling back ${m} to ${strWantedReduction} had no effect.`, false, 'warning');
        lastRate = myGangInfo.wantedLevelGainRate;
    }
}

// ── Recruitment ────────────────────────────────────────────────────────────────
async function doRecruitMember(ns) {
    let i = 0, name;
    do { name = `Thug ${++i}`; } while (
        myGangMembers.includes(name) || myGangMembers.includes(name + ' Understudy'));
    if (i < myGangMembers.length) name += ' Understudy';
    const ok = await getNsDataThroughFile(ns,
        `ns.gang.canRecruitMember() && ns.gang.recruitMember(ns.args[0])`,
        '/Temp/gang-recruit.txt', [name]);
    if (ok) {
        myGangMembers.push(name);
        assignedTasks[name]  = trainTask();
        lastMemberReset[name] = Date.now();
        log(ns, `Recruited "${name}"`, false, 'success');
    } else {
        log(ns, `ERROR: Could not recruit "${name}"`, false, 'error');
    }
}

// ── Ascension ──────────────────────────────────────────────────────────────────

/**
 * Dynamic ascension threshold based on accumulated asc_points.
 *
 * From the game source (formulas.ts + GangMember.ts):
 *   ascMult(p)  = sqrt(p / 2000)        — square-root scaling
 *   ascGain(e)  = max(e - 1000, 0)      — 1000 exp dead zone per cycle
 *   expRate     ∝ ascMult                — higher mult = faster exp gain
 *   On ascend: all exp → 0, non-aug equipment stripped, earnedRespect deducted
 *
 * The theoretical optimal mult-ratio for sqrt is √3.513 ≈ 1.874 — but that's
 * ONLY optimal for maximizing mult growth rate during pure training.
 *
 * Gang members spend most of their time doing crime, not training. For crime:
 *   - Even a 5% permanent mult boost is worth taking (compounds forever)
 *   - High asc_mult means fast retraining → short downtime
 *   - Members produce money/respect during the accumulation phase anyway
 *   - At 200k+ asc_points, reaching ratio 1.85 would take hours of real time
 *     because sqrt scaling gives heavily diminishing returns
 *
 * Practical thresholds:
 *   points < 1k   → 1.05  (first ascension — any meaningful gain is worth it)
 *   points ~ 50k  → 1.07  (moderate, accounts for equipment-strip cost)
 *   points ~ 500k → 1.08  (peak — sweet spot between gain size and wait time)
 *   points > 5M   → 1.06  (very high — sqrt makes ×1.10 unreachable in any
 *                           reasonable time. Members are better off doing crime
 *                           than grinding Train Combat for hours. Even ×1.05 on
 *                           an ascMult of 86.6 is +4.3 permanent mult.)
 */
function optimalAscendThreshold(maxAscPoints) {
    if (maxAscPoints < 1000) return 1.05;
    const logPts = Math.log10(Math.max(1, maxAscPoints));
    // Ramp up: 1.05 at 1K (log=3) → 1.08 at 500K (log=5.7)
    const rampUp = Math.min(1, Math.max(0, (logPts - 3) / 2.7));
    // Ramp down: 1.08 at 1M (log=6) → 1.06 at 10M (log=7)
    const rampDown = Math.min(1, Math.max(0, (logPts - 6) / 1));
    const peak = 1.08;
    const threshold = 1.05 + (peak - 1.05) * rampUp - (peak - 1.06) * rampDown;
    return Math.max(1.05, threshold);
}

/**
 * Respect needed to recruit the Nth member (0-indexed count).
 * First 3 are free; after that it's 5^(n - 2) from Gang.ts source.
 */
function respectForMember(n) {
    if (n < 3) return 0;
    return Math.pow(5, n - 2);
}

async function tryAscendMembers(ns, myGangInfo) {
    const ascResults  = await getGangDict(ns, myGangMembers, 'getAscensionResult');
    const memberInfos = await getGangDict(ns, myGangMembers, 'getMemberInformation');

    // Respect guard: don't ascend if it would drop us below next recruit threshold.
    // Game formula: threshold = 5^(currentCount - numFreeMembers + 1) = 5^(currentCount - 2)
    // respectForMember(n) = 5^(n-2), so pass currentCount directly (not +1).
    const nextRecruitResp = respectForMember(myGangMembers.length);
    let currentRespect = myGangInfo?.respect ?? Infinity;

    // Cap ascensions per territory tick. After ascending, a member's stats reset to ~0
    // and they enter min-training-ticks. If too many ascend at once, nobody can do crime
    // or VJ → respect stalls, wanted stays high, remaining members can't ascend (wanted floor).
    // Limit to 2 per tick so the gang retains enough earning/VJ power to recover between ticks.
    const MAX_ASCENSIONS_PER_TICK = Math.max(1, Math.floor(myGangMembers.length / 4));
    let ascensionCount = 0;

    for (let i = 0; i < myGangMembers.length; i++) {
        if (ascensionCount >= MAX_ASCENSIONS_PER_TICK) break;
        const m      = myGangMembers[i];
        const result = ascResults[m];
        const info   = memberInfos[m];
        if (!result) continue;

        const statsList = [...importantStats, 'cha'];

        // Dynamic threshold from this member's actual asc_points (highest among relevant stats)
        const maxAscPts = Math.max(
            ...statsList.map(s => info?.[s + '_asc_points'] ?? 0)
        );
        const threshold = optimalAscendThreshold(maxAscPts);

        // Check if any relevant stat's mult-ratio meets the dynamic threshold
        if (!statsList.some(s => (result[s] ?? 0) >= threshold)) {
            // Log progress for the stat closest to threshold
            const bestStat = statsList.reduce((best, s) =>
                (result[s] ?? 0) > (result[best] ?? 0) ? s : best, statsList[0]);
            const bestRatio = result[bestStat] ?? 0;
            if (bestRatio > 1.01)
                log(ns, `[asc-dbg] ${m}: best=${bestStat}→×${bestRatio.toFixed(3)}, need=${threshold.toFixed(3)} (pts=${formatNumberShort(maxAscPts)}). Not ready.`);
            continue;
        }

        // Respect protection: skip if ascending would CROSS below the next recruit threshold.
        // If we're already below it, ascending doesn't change anything — we can't recruit either way.
        // Also irrelevant once at 12 members (max).
        // ALSO: maintain a cumulative floor of wanted×2 to prevent mass ascension from bricking
        // the gang. If respect drops below wanted×2, the wanted penalty exceeds 33% and crime
        // output collapses. With stats reset to ~0 after ascension, members can't even do VJ
        // to reduce wanted (statWeight goes negative). Stagger ascensions across ticks instead.
        const earnedResp = info?.earnedRespect ?? 0;
        const wantedFloor = myGangInfo.wantedLevel * 2;
        if (earnedResp > 0 && myGangMembers.length < 12 &&
            currentRespect >= nextRecruitResp && currentRespect - earnedResp < nextRecruitResp) {
            log(ns, `Holding ascension for ${m}: would lose ${formatNumberShort(earnedResp)} respect ` +
                `(${formatNumberShort(currentRespect)}→${formatNumberShort(currentRespect - earnedResp)}), ` +
                `need ${formatNumberShort(nextRecruitResp)} for next recruit.`);
            continue;
        }
        if (earnedResp > 0 && currentRespect - earnedResp < wantedFloor) {
            log(ns, `Holding ascension for ${m}: would drop respect to ${formatNumberShort(currentRespect - earnedResp)} ` +
                `below wanted floor ${formatNumberShort(wantedFloor)} (wanted=${formatNumberShort(myGangInfo.wantedLevel)}). Staggering.`);
            continue;
        }

        // Only block ascension if cha training is actively IN PROGRESS but < 3000:
        //   cha_exp == 0 → never trained → nothing to lose, allow ascension
        //   cha_exp  > 0 and < 3000 → training in progress, ascending resets to 0
        //                             and gains 0 asc_points → hold until 3000
        //   cha_exp >= 3000 → will gain cha asc_points on ascension → allow
        // If info is null (RAM failure), hold as safety.
        const chaExp = info?.cha_exp ?? null;
        if (chaExp === null) {
            log(ns, `Holding ascension for ${m}: could not verify cha_exp (RAM issue).`);
            continue;
        }
        if (chaExp > 0 && chaExp < 3000) {
            log(ns, `Holding ascension for ${m}: cha_exp=${Math.floor(chaExp)} (0 < exp < 3000 = training in progress, would gain 0 asc pts). Keep training.`);
            continue;
        }

        const ok = await getNsDataThroughFile(ns,
            `ns.gang.ascendMember(ns.args[0])`, null, [m]);
        if (ok !== undefined) {
            log(ns, `Ascended ${m}: ${statsList.map(s => `${s}→×${(result[s]??1).toFixed(2)}`).join(' ')} ` +
                `(threshold=${threshold.toFixed(3)}, pts=${formatNumberShort(maxAscPts)})`, false, 'success');
            lastMemberReset[m] = Date.now();
            currentRespect -= earnedResp; // Track cumulative respect loss within this tick
            ascensionCount++;
        } else {
            log(ns, `ERROR: Ascend failed for ${m}`, false, 'error');
        }
    }
    if (ascensionCount >= MAX_ASCENSIONS_PER_TICK)
        log(ns, `[asc-dbg] Capped at ${MAX_ASCENSIONS_PER_TICK} ascensions this tick. Remaining candidates deferred.`);
}

// ── Equipment upgrades ─────────────────────────────────────────────────────────
async function tryUpgradeMembers(ns, dictMembers) {
    const costs = await getGangDict(ns, equipments.map(e => e.name), 'getEquipmentCost');
    equipments.forEach(e => e.cost = costs[e.name]);

    if (!is4sBought)
        is4sBought = await getNsDataThroughFile(ns, 'ns.stock.has4SDataTixApi()');

    const player   = await getNsDataThroughFile(ns, 'ns.getPlayer()');
    const reserve  = options['reserve'] ?? Number(ns.read('reserve.txt') || 0);
    const cash     = Math.max(0, player.money - reserve);
    const budgetMult = (!is4sBought || resetInfo.currentNode === 8)
        ? options['no-4s-budget-multiplier'] : 1;

    let budget    = Math.min(0.99, (options['equipment-budget']     ?? DEFAULT_EQUIP_BUDGET))   * cash * budgetMult;
    let augBudget = Math.min(0.99, (options['augmentations-budget'] ?? DEFAULT_AUG_BUDGET))     * cash * budgetMult;

    const order = [];
    for (const equip of equipments) {
        if (augBudget <= 0) break;
        for (const m of Object.values(dictMembers)) {
            if (augBudget <= 0) break;
            const isRelevant = Object.keys(equip.stats ?? {}).some(s =>
                importantStats.some(i => s.includes(i)) || s.includes('cha'));
            const perceivedCost = equip.cost * (isRelevant ? 1 : OFF_STAT_COST_PENALTY);
            if (perceivedCost > augBudget) continue;
            if (equip.type !== 'Augmentation' && perceivedCost > budget) continue;
            if (m.upgrades.includes(equip.name) || m.augmentations.includes(equip.name)) continue;
            order.push({ member: m.name, type: equip.type, equipmentName: equip.name, cost: equip.cost });
            budget    -= equip.cost;
            augBudget -= equip.cost;
        }
    }

    if (!order.length) return;
    const total = order.reduce((s, e) => s + e.cost, 0);
    const results = await getNsDataThroughFile(ns,
        `JSON.parse(ns.args[0]).map(o => ns.gang.purchaseEquipment(o.member, o.equipmentName))`,
        '/Temp/gang-upgrades.txt', [JSON.stringify(order)]);
    const success = order.filter((_, i) => results[i]);
    const fail    = order.filter((_, i) => !results[i]);
    if (!fail.length)
        log(ns, `Purchased ${order.length} upgrades for ${formatMoney(total)}: ${success.map(o=>`${o.member} ${o.equipmentName}`).join(', ')}`, false, 'success');
    else
        log(ns, `WARNING: ${fail.length} upgrade(s) failed. Succeeded: ${success.length}/${order.length}`, false, 'warning');
}

// ── Territory warfare ──────────────────────────────────────────────────────────
async function enableOrDisableWarfare(ns, myGangInfo) {
    warfareFinished = Math.round(myGangInfo.territory * 2**20) / 2**20 >= 1;
    if (warfareFinished && !myGangInfo.territoryWarfareEngaged) return;

    const others = await getNsDataThroughFile(ns, 'ns.gang.getOtherGangInformation()');
    let totalWin = 0, count = 0, lowest = 1, lowestName = '';
    for (const [name, g] of Object.entries(others)) {
        if (g.territory === 0 || name === myGangFaction) continue;
        const win = myGangInfo.power / (myGangInfo.power + g.power);
        if (win <= lowest) { lowest = win; lowestName = name; }
        totalWin += win; count++;
    }
    const avg = count ? totalWin / count : 1;
    const engage = !warfareFinished && avg >= options['territory-engage-threshold'];
    if (engage !== myGangInfo.territoryWarfareEngaged) {
        log(ns, `${warfareFinished ? 'SUCCESS' : 'INFO'}: Territory warfare → ${engage}. ` +
            `Power: ${formatNumberShort(myGangInfo.power)}. Avg win: ${(avg*100).toFixed(1)}%. ` +
            `Lowest: ${(lowest*100).toFixed(1)}% vs ${lowestName}.`,
            false, warfareFinished ? 'info' : 'success');
        await runCommand(ns, `ns.gang.setTerritoryWarfare(ns.args[0])`, null, [engage]);
    }
}

// ── Dashboard data writer ─────────────────────────────────────────────────────
// writeDashboardDataFull: called every territory tick (~20s). Fetches all member
// data and writes the complete snapshot. Also caches to lastDashboardData so the
// live patcher can patch fast-changing fields on top of it between ticks.
async function writeDashboardDataFull(ns) {
    const info = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
    if (!info) { ns.write(GANGS_FILE, JSON.stringify({ inGang: true, gangsLoaded: true }), 'w'); return; }

    const canRecruit = await getNsDataThroughFile(ns, 'ns.gang.canRecruitMember()');
    const dictMembers = await getGangDict(ns, myGangMembers, 'getMemberInformation');
    const ascResults  = await getGangDict(ns, myGangMembers, 'getAscensionResult');
    const others = lastOtherGangInfo ?? {};

    const d = {
        _writer: 'gangs.js', _ts: Date.now(),
        inGang: true, gangsLoaded: true, gangsTimestamp: Date.now(),
        gangName: myGangFaction, isHacking: isHackGang,
        territory: info.territory, power: info.power,
        respect: info.respect, canRecruit,
        nextRecruitAt: info.respectForNextRecruit > 0 ? info.respectForNextRecruit : null,
        maxMembers: 12,
        wantedLevel: info.wantedLevel,
        wantedPenalty: info.wantedPenalty,
        territoryWarfareEngaged: info.territoryWarfareEngaged,
        moneyPerSec:   info.moneyGainRate       * 5,
        respectPerSec: info.respectGainRate     * 5,
        wantedPerSec:  info.wantedLevelGainRate * 5,
        otherGangs: Object.entries(others)
            .filter(([name]) => name !== myGangFaction)
            .map(([name, g]) => ({ name, power: g.power, territory: g.territory }))
            .sort((a, b) => b.territory - a.territory),
        members: Object.values(dictMembers).map(m => ({
            name: m.name, task: m.task,
            hackAscMult: m.hack_asc_mult, strAscMult: m.str_asc_mult,
            hackTotalMult: m.hack_asc_mult * m.hack_mult,
            strTotalMult:  m.str_asc_mult  * m.str_mult,
            agiTotalMult:  m.agi_asc_mult  * m.agi_mult,
            defTotalMult:  m.def_asc_mult  * m.def_mult,
            dexTotalMult:  m.dex_asc_mult  * m.dex_mult,
            chaTotalMult:  m.cha_asc_mult  * m.cha_mult,
            chaAscMult: m.cha_asc_mult,
            strAscPts: m.str_asc_points, chaAscPts: m.cha_asc_points,
            hack: m.hack, str: m.str, agi: m.agi, def: m.def, dex: m.dex, cha: m.cha,
            earnedRespect: m.earnedRespect, moneyGain: m.moneyGain,
        })),
        ascensionResults: Object.fromEntries(
            myGangMembers.map(n => [n, ascResults[n]])
                .filter(([, r]) => r !== undefined)),
    };
    lastDashboardData = d;  // cache for live patching
    ns.write(GANGS_FILE, JSON.stringify(d), 'w');
}

// writeDashboardDataLive: called every ~1s from mainLoop. Patches only the
// fast-changing fields (rates, levels, territory) onto the cached full snapshot.
// Uses the already-fetched myGangInfo — zero extra ns.gang.* calls.
// Member stats and ascension results stay at their last full-write values
// (they only meaningfully change on territory ticks anyway).
function writeDashboardDataLive(ns, myGangInfo) {
    if (!lastDashboardData) return; // no full write yet, wait for first territory tick
    lastDashboardData.wantedLevel              = myGangInfo.wantedLevel;
    lastDashboardData.wantedPenalty            = myGangInfo.wantedPenalty;
    lastDashboardData.wantedPerSec             = myGangInfo.wantedLevelGainRate * 5;
    lastDashboardData.respect                  = myGangInfo.respect;
    lastDashboardData.respectPerSec            = myGangInfo.respectGainRate     * 5;
    lastDashboardData.moneyPerSec              = myGangInfo.moneyGainRate       * 5;
    lastDashboardData.territory                = myGangInfo.territory;
    lastDashboardData.power                    = myGangInfo.power;
    lastDashboardData.territoryWarfareEngaged  = myGangInfo.territoryWarfareEngaged;
    lastDashboardData.nextRecruitAt            = myGangInfo.respectForNextRecruit > 0
                                                 ? myGangInfo.respectForNextRecruit : null;
    // Compute canRecruit locally — avoids an extra ns.gang.* call
    lastDashboardData.canRecruit               = myGangMembers.length < 12
                                                 && myGangInfo.respect >= (myGangInfo.respectForNextRecruit ?? Infinity);
    ns.write(GANGS_FILE, JSON.stringify(lastDashboardData), 'w');
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function waitForGameUpdate(ns, old) {
    if (myGangMembers.every(m => assignedTasks[m]?.includes('Train'))) return old;
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
        const latest = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
        if (latest.respectGainRate !== old.respectGainRate ||
            latest.moneyGainRate !== old.moneyGainRate ||
            latest.wantedLevelGainRate !== old.wantedLevelGainRate) return latest;
        await ns.sleep(100);
    }
    return await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
}

const getWantedPenalty   = g => g.respect / (g.respect + g.wantedLevel);
const getTerritoryPenalty = g => (0.2 * g.territory + 0.8) * multGangSoftcap;

function getStatWeight(task, m) {
    return (task.hackWeight / 100) * m['hack'] +
        (task.strWeight / 100) * m.str +
        (task.defWeight / 100) * m.def +
        (task.dexWeight / 100) * m.dex +
        (task.agiWeight / 100) * m.agi +
        (task.chaWeight / 100) * m.cha;
}

function computeRespectGain(g, taskName, m) {
    const task = allTaskStats[taskName];
    if (!task?.baseRespect) return 0;
    const sw = getStatWeight(task, m) - 4 * task.difficulty;
    if (sw <= 0) return 0;
    const tm = Math.max(0.005, Math.pow(g.territory * 100, task.territory?.respect ?? 0) / 100);
    const tp = getTerritoryPenalty(g);
    return Math.pow(11 * task.baseRespect * sw * tm * getWantedPenalty(g), tp);
}

function computeMoneyGain(g, taskName, m) {
    const task = allTaskStats[taskName];
    if (!task?.baseMoney) return 0;
    const sw = getStatWeight(task, m) - 3.2 * task.difficulty;
    if (sw <= 0) return 0;
    const tm = Math.max(0.005, Math.pow(g.territory * 100, task.territory?.money ?? 0) / 100);
    const tp = getTerritoryPenalty(g);
    return Math.pow(5 * task.baseMoney * sw * tm * getWantedPenalty(g), tp);
}

function computeWantedGain(g, taskName, m) {
    const task = allTaskStats[taskName];
    if (!task?.baseWanted) return 0;
    const sw = getStatWeight(task, m) - 3.5 * task.difficulty;
    if (sw <= 0) return 0;
    const tm = Math.max(0.005, Math.pow(g.territory * 100, task.territory?.wanted ?? 0) / 100);
    if (task.baseWanted < 0) return 0.4 * task.baseWanted * sw * tm;
    return Math.min(100, (7 * task.baseWanted) / Math.pow(3 * sw * tm, 0.8));
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

const getGangDict = (ns, items, fn) =>
    getDict(ns, items, `gang.${fn}`, `/Temp/gang-${fn}.txt`);
const getDict = (ns, items, fn, file) =>
    getNsDataThroughFile(ns, `Object.fromEntries(ns.args.map(o => [o, ns.${fn}(o)]))`, file, items);