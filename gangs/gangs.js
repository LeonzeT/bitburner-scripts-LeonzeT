/**
 * gangs.js — Gang management script.
 *
 * v10 Optimizations (combat gang — respect + power + stats + money + territory):
 *  A. ns.gang.nextUpdate() main loop: Replaces 200ms polling + all heuristic tick-detection
 *     state (territoryTickDetected, territoryTickWaitPadding, consecutiveTerritoryDetections,
 *     isReadyForNextTerritoryTick, lastOtherGangInfo, tickTimeout, re-sync logic).
 *     The game's own gang-cycle callback fires after each 2-second batch. Territory processes
 *     4 times per batch (every 100 cycles in a 400-cycle batch at 5ms/cycle). With 9 crime
 *     batches + 1 TW batch per cycle, members contribute to 4 territory events per TW window
 *     vs the previous approach of catching ~1 event via heuristic timing — 4× better TW
 *     power efficiency with zero re-sync failures. Eliminates ~100 lines of tick-detection
 *     state machine.
 *  B. Cha/dex training threshold ratio 0.8→1.1: Source task data shows optimal cha/dex ratio
 *     is 1.25 for Traffick Illegal Arms (best money: 25%cha/20%dex) and 1.0 for Human
 *     Trafficking (30%cha/30%dex). Previous 0.8× consistently undershot both tasks.
 *     1.1× is a calibrated average that keeps charisma high enough for both top money crimes.
 *  C. combatTrainSet cap 2→3 when roster < 8 members: During the critical early phase
 *     (before roster fills out), three simultaneous combat trainers triple the rate of
 *     stat-mult accumulation. Reverts to 2 once roster reaches 8+ to preserve crime output.
 *  D. Smart fixWantedGainRate: Sort candidates by lowest objective crime score (least valuable
 *     earner first) instead of random shuffle. Keeps the best earners on crimes longest during
 *     wanted recovery, minimising total respect/money loss per recovery event.
 *  E. NPC power threat awareness (source: Gang/data/power.ts): Speakers for the Dead and
 *     The Black Hand have powerMult=5 — 2.5× faster additive growth than typical NPCs.
 *     When either holds >20% territory their compounding power becomes an existential threat.
 *     Lower the TW engage threshold by 0.03 when either high-threat NPC holds >20%, so we
 *     fight them sooner before their power becomes insurmountable.
 *  F. Corrected death chance formula (source: Gang.ts clash()): Actual formula is
 *     `baseDeathChance / Math.pow(member.def, 0.6)`, not linear. At def=100:
 *     0.01/100^0.6 = 6.3e-4 (loss), 3.15e-4 (win). Floor of 100 is conservative but safe.
 *  G. Bulk recruit loop: Use ns.gang.getRecruitsAvailable() to recruit all unlocked members
 *     per cycle, not just the first. Prevents multi-recruit opportunities being missed.
 *
 * v9 Optimizations (all preserved):
 *  A. DEFAULT_EQUIP_BUDGET 0.008 (more aggressive early gear, compounding power ROI)
 *  B. TERRITORY_TASK_WEIGHT 0.30 + sublinear gap^0.7 decay (elevates high-exp task weight)
 *  C. GEAR_POWER_WEIGHT_MAX 0.65 (aggressive power-gear ROI at low territory)
 *  D. MAX_CONSEC_CHA_TRAIN_TICKS 30 (faster crime rotation)
 *  E. MAX_RESPECT_LOSS_FRAC 0.18 (more aggressive ascension cascades)
 *  F. Early wantedGainTolerance 0.15 (more aggressive crime at respect < 200)
 *  G. combatTrainSet cap 2 (now 3 when < 8 members)
 *  H. augTerritoryBonus coefficient 0.25 (correctly prices long-term aug compounding)
 *  I. Dynamic TW threshold: 0.52 at territory=0 → configuredThreshold at 20%
 *
 * Source citations:
 *  - Gang.ts: clash(), calculatePower(), processTerritoryAndPowerGains(), getDiscount()
 *  - GangMember.ts: calculateExpGain(), ascend(), getAscensionResults()
 *  - Gang/data/power.ts: PowerMultiplier (SpeakersForDead=5, TheBlackHand=5, others=2)
 *  - Gang/data/Constants.ts: CyclesPerTerritoryAndPowerUpdate=100, recruitThresholdBase=5
 *  - Gang/formulas/formulas.ts: calculateRespectGain, calculateMoneyGain, calculateWantedLevelGain
 */

import {
    log, getConfiguration, instanceCount, getNsDataThroughFile, getActiveSourceFiles,
    runCommand, tryGetBitNodeMultipliers, formatMoney, formatNumberShort, formatDuration
} from '/helpers.js'

// ── Constants ──────────────────────────────────────────────────────────────────
const OFF_STAT_COST_PENALTY   = 50;
const DEFAULT_EQUIP_BUDGET    = 0.008;   // v9: 0.005→0.008. Early combat gear ROI is enormous.
const DEFAULT_AUG_BUDGET      = 0.25;    // fraction of cash per tick, augmentations
const NO4S_BUDGET_MULTIPLIER  = 0.05;    // Without 4S, scale down budgets
const CHA_TRAINING_THRESHOLD  = 400;     // flat floor; dynamic threshold scales with dex
const HACK_TRAINING_THRESHOLD = 80;
const MIN_TRAINING_TICKS      = 10;      // gang-cycle batches of training after ascend/recruit
const GANGS_FILE              = '/Temp/dashboard-gangs.txt';
const TASK_OPTIMIZER_BUCKETS  = 240;
const GEAR_POWER_WEIGHT_MAX   = 0.65;    // v9: 0.55→0.65. Power weight in equipment ROI at territory=0
const GEAR_POWER_WEIGHT_MIN   = 0.10;
const GEAR_RECOVERY_WEIGHT    = 0.35;
const TEMP_GEAR_ASC_PENALTY   = 0.40;
// Source (Gang.ts clash()): modifiedDeathChance = baseDeathChance / Math.pow(member.def, 0.6)
// at def=100: 0.01/100^0.6 = 6.3e-4. At def=50: 0.01/50^0.6 = 9.5e-4. Both very safe.
// 100 kept as conservative floor; real formula is NOT linear (previous comment was wrong).
const DEF_WARFARE_FLOOR       = 100;
const TERRITORY_TASK_WEIGHT   = 0.30;    // v9: max task score weight for stat-exp dimension
// v10: High-powerMult NPC gangs (source: Gang/data/power.ts PowerMultiplier).
// Additive gain = 0.75 * rand * territory * powerMult. At 30% territory, these two
// average +0.56 power/tick vs +0.225 for typical gangs. Must be neutralised first.
const HIGH_POWERMULT_GANGS    = new Set(['Speakers for the Dead', 'The Black Hand']);
// v10: Crime batches between TW batches. 9 crime + 1 TW = ~20s cycle at 2s/batch.
// During the TW batch, territory fires 4× (100-cycle events in a 400-cycle batch),
// delivering 4× more power gain per TW window than the previous 1-event timing approach.
const CRIME_BATCHES_PER_TW    = 9;

const GANG_PREFERENCE = [
    "Speakers for the Dead", "The Dark Army", "The Syndicate", "Tetrads",
    "Slum Snakes", "The Black Hand",
];

// ── Global state ───────────────────────────────────────────────────────────────
let options;
const argsSchema = [
    ['training-percentage',          0.05  ],
    ['cha-training-percentage',      0.15  ],
    ['no-training',                  false ],
    ['no-auto-ascending',            false ],
    ['ascend-multi-threshold',       1.05  ],
    ['ascend-multi-threshold-spacing', 0.05],
    ['min-training-ticks',           MIN_TRAINING_TICKS],
    ['cha-threshold',                CHA_TRAINING_THRESHOLD],
    ['hack-threshold',               HACK_TRAINING_THRESHOLD],
    ['reserve',                      null  ],
    ['augmentations-budget',         null  ],
    ['equipment-budget',             null  ],
    ['no-4s-budget-multiplier',      NO4S_BUDGET_MULTIPLIER],
    ['territory-engage-threshold',   0.55  ],
    ['money-focus',                  false ],
    ['reputation-focus',             false ],
];

export function autocomplete(data, _) { data.flags(argsSchema); return []; }

let myGangFaction = '', isHackGang = false, strWantedReduction = '', importantStats = [];
let requiredRep = 2.5e6, myGangMembers = [], equipments = [], ownedSourceFiles;
let allTaskNames, allTaskStats, assignedTasks = {}, lastMemberReset = {};
let chaTrainTicksCount = {};
const MAX_CONSEC_CHA_TRAIN_TICKS = 30; // v9: 40→30
let multGangSoftcap = 1.0, resetInfo, is4sBought = false;
let warfareFinished = false;
let lastDashboardData = null;
let inWantedRecovery   = false;

/** @param {NS} ns */
export async function main(ns) {
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return;
    options = runOptions;
    ownedSourceFiles = await getActiveSourceFiles(ns);
    if (!(ownedSourceFiles[2] > 0))
        return log(ns, 'ERROR: SF2 required for gang access.');

    await initialize(ns);
    log(ns, 'Gang manager starting... [v10: nextUpdate-driven, 4× TW efficiency, cha-ratio 1.1×dex, smart recovery]');

    // ── v10 Main Loop: nextUpdate()-driven, no polling ────────────────────────
    // Structure per cycle (~20s): 9 crime batches + 1 TW batch.
    // Each nextUpdate() resolves after the game processes one ~2s gang batch.
    // Territory fires 4× per batch; all eligible members on TW during the TW batch
    // contribute to all 4 events, vs the old approach catching ~1 event heuristically.
    while (true) {
        try {
            // ── Crime phase (9 batches ≈ 18s) ────────────────────────────────
            for (let i = 0; i < CRIME_BATCHES_PER_TW; i++) {
                await ns.gang.nextUpdate();
                await crimePhaseMaintenance(ns);
            }

            // ── TW phase (1 batch ≈ 2s, 4 territory events) ──────────────────
            let gangInfoPreTW = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
            await enableOrDisableWarfare(ns, gangInfoPreTW);
            if (!warfareFinished) {
                await updateMemberActivities(ns, null, 'Territory Warfare', gangInfoPreTW);
            }
            await ns.gang.nextUpdate(); // territory fires 4× during this window

            // ── Post-TW tick work ─────────────────────────────────────────────
            await onGangCycle(ns);
        } catch (err) {
            log(ns, `WARNING: Suppressed error in main loop:\n${err?.message ?? err}`, false, 'warning');
        }
    }
}

// ── Initialization ─────────────────────────────────────────────────────────────
async function initialize(ns) {
    ns.disableLog('ALL');
    resetInfo = await getNsDataThroughFile(ns, 'ns.getResetInfo()');

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
}

// ── Crime-phase maintenance (called every crime batch) ─────────────────────────
async function crimePhaseMaintenance(ns) {
    const gangInfo = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
    const penalty = getWantedPenalty(gangInfo) - 1;
    const wantedAboveMin = gangInfo.wantedLevel > 1.05;

    if ((penalty < -1.1 * WANTED_PENALTY_THRESH) && wantedAboveMin && !inWantedRecovery) {
        inWantedRecovery = true;
        log(ns, `Wanted recovery ON: penalty=${(penalty*100).toFixed(2)}%, wanted=${gangInfo.wantedLevel.toFixed(2)}`);
    }
    if (inWantedRecovery && !wantedAboveMin) {
        inWantedRecovery = false;
        log(ns, `Wanted recovery OFF: wanted=${gangInfo.wantedLevel.toFixed(2)}`);
    }
    if (inWantedRecovery) {
        const tolerance = -0.01 * gangInfo.wantedLevel;
        if (gangInfo.wantedLevelGainRate > tolerance)
            await fixWantedGainRate(ns, gangInfo, tolerance);
    }
    writeDashboardDataLive(ns, gangInfo);
}

// ── Post-TW tick work ──────────────────────────────────────────────────────────
async function onGangCycle(ns) {
    myGangMembers = await getNsDataThroughFile(ns, 'ns.gang.getMemberNames()');

    // v10: Bulk recruit — getRecruitsAvailable() tells us exactly how many are unlocked
    const recruitsAvailable = await getNsDataThroughFile(ns, 'ns.gang.getRecruitsAvailable()');
    for (let i = 0; i < (recruitsAvailable ?? 0); i++)
        await doRecruitMember(ns);

    let myGangInfo = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
    let dictMembers = await getGangDict(ns, myGangMembers, 'getMemberInformation');

    if (!options['no-auto-ascending']) await tryAscendMembers(ns, myGangInfo);
    myGangInfo = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
    dictMembers = await getGangDict(ns, myGangMembers, 'getMemberInformation');

    await tryUpgradeMembers(ns, myGangInfo, dictMembers);
    await enableOrDisableWarfare(ns, myGangInfo);
    await optimizeGangCrime(ns, myGangInfo);

    try { await writeDashboardDataFull(ns); }
    catch (e) { log(ns, `Dashboard write error: ${e?.message ?? e}`, false, 'warning'); }
}

// ── Training task selection ────────────────────────────────────────────────────
function pickTrainingTask(dictMembers) {
    // Per-member training handled inside optimizeGangCrime via chaTrainSet/combatTrainSet.
    // Global override is never needed; always return null.
    return null;
}

function chaTrainersNeeded(dictMembers) {
    if (options['no-training']) return 0;
    const statKey   = isHackGang ? 'hack' : 'cha';
    const threshold = isHackGang ? options['hack-threshold'] : options['cha-threshold'];
    const members   = Object.values(dictMembers);
    const below     = members.filter(m => (m[statKey] ?? 0) < threshold);
    if (below.length === 0) return 0;
    return Math.max(1, Math.round(members.length * options['cha-training-percentage']));
}

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
        let task = forceTask ?? assignedTasks[m.name];

        if (forceTask === 'Territory Warfare' && myGangInfo?.territoryClashChance > 0) {
            if (m.def < DEF_WARFARE_FLOOR || m.def < Math.min(10000, maxDef * 0.1)) {
                const safeTask = assignedTasks[m.name] === 'Territory Warfare'
                    ? trainTask()
                    : assignedTasks[m.name];
                task = safeTask;
            }
        }

        // Use MIN_TRAINING_TICKS as gang-cycle count (v10: each cycle = one nextUpdate batch)
        const trainCycles = options['min-training-ticks'];
        if (((lastMemberReset[m.name] ?? -Infinity) + trainCycles) > getCurrentCycle())
            task = trainTask();

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

// ── Cycle counter (replaces Date.now()-based training timer) ───────────────────
// v10: training window is now tracked in gang-cycle counts rather than wall-clock ms,
// since nextUpdate() handles all timing and the period isn't constant (bonus time compresses).
let _currentCycle = 0;
function getCurrentCycle() { return _currentCycle; }
function advanceCycle()     { return ++_currentCycle; }

// ── Crime optimization ─────────────────────────────────────────────────────────
async function optimizeGangCrime(ns, myGangInfo) {
    advanceCycle(); // advance cycle counter each optimization pass
    const dictMembers = await getGangDict(ns, myGangMembers, 'getMemberInformation');

    const currentPenalty = getWantedPenalty(myGangInfo) - 1;
    const wantedAboveMin = myGangInfo.wantedLevel > 1.05;

    let wantedGainTolerance;
    if (inWantedRecovery) {
        wantedGainTolerance = -0.01 * myGangInfo.wantedLevel;
    } else if (!wantedAboveMin && myGangInfo.respect < 200) {
        wantedGainTolerance = 0.15; // v9: more aggressive early crime
    } else if (currentPenalty < -0.9 * WANTED_PENALTY_THRESH &&
               myGangInfo.wantedLevel >= (1.1 + myGangInfo.respect / 10000) &&
               myGangInfo.respect >= 200) {
        wantedGainTolerance = myGangInfo.wantedLevel / 50;
    } else {
        wantedGainTolerance = Math.max(myGangInfo.respectGainRate / 1000, myGangInfo.wantedLevel / 10);
    }
    // Account for justice multiplicative decay: wanted *= (1 - justice * 0.001) per cycle
    // (source: Gang.ts processGains). Add expected decay to tolerance.
    if (!inWantedRecovery && myGangInfo.wantedLevel > 1) {
        const justiceCount = myGangMembers.filter(m => assignedTasks[m] === strWantedReduction).length;
        if (justiceCount > 0)
            wantedGainTolerance += myGangInfo.wantedLevel * justiceCount * 0.001;
    }

    let factionRep = -1;
    if (ownedSourceFiles[4] > 0) {
        try {
            factionRep = await getNsDataThroughFile(ns,
                `ns.singularity.getFactionRep(ns.args[0])`, null, [myGangFaction]);
        } catch {}
    }
    if (factionRep < 0) factionRep = myGangInfo.respect / 75;

    const objectiveWeights = getOptimizationWeights(myGangInfo, factionRep);
    const goalLabel = formatOptimizationGoal(objectiveWeights);

    const statKey      = isHackGang ? 'hack' : 'cha';
    const trainCount   = chaTrainersNeeded(dictMembers);
    const trainTaskName = isHackGang ? 'Train Hacking' : 'Train Charisma';
    const VIGILANTE_FLOOR = 2;
    const wantedBad = (myGangInfo.wantedPenalty ?? 1) < (1 - WANTED_PENALTY_THRESH);
    const allMembers = Object.values(dictMembers);
    const needsRecruits = allMembers.length < (myGangInfo.maxMembers ?? 12);
    const CRIME_FLOOR = needsRecruits ? Math.max(1, Math.floor(allMembers.length / 4)) : 0;
    const floor = Math.max(VIGILANTE_FLOOR * (wantedBad ? 1 : 0), CRIME_FLOOR);
    const trainCap = trainCount > 0 ? trainCount : allMembers.length;
    const maxChaTrainers = Math.min(trainCap, Math.max(0, allMembers.length - floor));

    const flatChaThreshold = isHackGang ? options['hack-threshold'] : options['cha-threshold'];
    // v10: ratio 0.8→1.1. Source task data: TIA cha/dex = 25%/20% = 1.25, HT = 30%/30% = 1.0.
    // 1.1× is a calibrated midpoint that keeps cha competitive in both top money tasks.
    const memberChaThreshold = (m) => isHackGang
        ? flatChaThreshold
        : Math.max(flatChaThreshold, 1.1 * (m.dex ?? 0));

    // Update consecutive-training counters
    const chaTrainExhausted = new Set();
    for (const m of allMembers) {
        const belowThreshold = (m[statKey] ?? 0) < memberChaThreshold(m);
        if (belowThreshold) {
            chaTrainTicksCount[m.name] = (chaTrainTicksCount[m.name] ?? 0) + 1;
            if (chaTrainTicksCount[m.name] > MAX_CONSEC_CHA_TRAIN_TICKS) {
                chaTrainExhausted.add(m.name);
                chaTrainTicksCount[m.name] = 0;
                log(ns, `[cha-dbg] ${m.name}: ${MAX_CONSEC_CHA_TRAIN_TICKS} ticks in cha training, forcing crime tick.`);
            }
        } else {
            chaTrainTicksCount[m.name] = 0;
        }
    }

    const chaTrainSet = new Set(
        allMembers
            .filter(m => (m[statKey] ?? 0) < memberChaThreshold(m) && !chaTrainExhausted.has(m.name))
            .sort((a, b) => {
                const ratioA = (a[statKey] ?? 0) / memberChaThreshold(a);
                const ratioB = (b[statKey] ?? 0) / memberChaThreshold(b);
                return ratioA - ratioB;
            })
            .slice(0, maxChaTrainers)
            .map(m => m.name)
    );

    const ascResults = await getGangDict(ns, myGangMembers, 'getAscensionResult');
    const memberInfosForCombat = await getGangDict(ns, myGangMembers, 'getMemberInformation');
    const trainCycles = options['min-training-ticks'];
    const chaHackThreshold = (m) => isHackGang ? options['hack-threshold'] : memberChaThreshold(m);

    // v10: cap 2→3 when roster < 8 members. Triple training throughput during early game
    // when stat-mult compounding matters most. Reverts to 2 once roster is larger.
    const combatTrainCap = myGangMembers.length < 8 ? 3 : 2;

    const combatTrainSet = new Set(
        Object.values(dictMembers)
            .filter(m => {
                if (chaTrainSet.has(m.name)) return false;
                if (((lastMemberReset[m.name] ?? -Infinity) + trainCycles) > getCurrentCycle()) return false;
                if ((m[statKey] ?? 0) < chaHackThreshold(m)) return false;
                const chaExp = memberInfosForCombat[m.name]?.cha_exp ?? 0;
                if (chaExp > 0 && chaExp < 3000) return false;
                if (!isHackGang && (m.def ?? 0) < DEF_WARFARE_FLOOR &&
                    myGangInfo.territory < 1 && !warfareFinished) return true;
                const result = ascResults[m.name];
                if (!result) return false;
                const info = memberInfosForCombat[m.name];
                const statsList = [...importantStats, 'cha'];
                const maxAscPts = Math.max(...statsList.map(s => info?.[s + '_asc_points'] ?? 0));
                const threshold = optimalAscendThreshold(maxAscPts);
                if (!statsList.some(s => (result[s] ?? 0) >= threshold)) return true;
                if (!isHackGang) {
                    const chaTriggered    = (result['cha'] ?? 0) >= threshold;
                    const combatTriggered = importantStats.some(s => (result[s] ?? 0) >= threshold);
                    const maxCombatAscPts = Math.max(...importantStats.map(s => info?.[s + '_asc_points'] ?? 0));
                    if (chaTriggered && !combatTriggered && maxCombatAscPts < 2000) return true;
                }
                return false;
            })
            .sort((a, b) => {
                const getMaxRatio = m => {
                    const result = ascResults[m.name];
                    const info = memberInfosForCombat[m.name];
                    const statsList = [...importantStats, 'cha'];
                    const maxAscPts = Math.max(...statsList.map(s => info?.[s + '_asc_points'] ?? 0));
                    const threshold = optimalAscendThreshold(maxAscPts);
                    return Math.max(...statsList.map(s => (result?.[s] ?? 0) / threshold));
                };
                return getMaxRatio(b) - getMaxRatio(a);
            })
            .slice(0, combatTrainCap)
            .map(m => m.name)
    );
    if (combatTrainSet.size > 0)
        log(ns, `[gang-dbg] combatTrainSet (cap=${combatTrainCap}): [${[...combatTrainSet].join(', ')}]`);

    const utilityTasks = new Set([strWantedReduction, trainTask(), trainTaskName, 'Territory Warfare']);
    const regularCrimeTasks = allTaskNames.filter(t => !utilityTasks.has(t));
    const rateScales = getTaskRateScales(myGangInfo, allMembers, regularCrimeTasks);
    const fixedAssignments = {};
    const memberOptions = [];
    const fallbackTrainers = [];
    let baselineWanted = 0, baselineMoney = 0, baselineRespect = 0, baselineExpGain = 0;

    for (const m of allMembers) {
        if (chaTrainSet.has(m.name)) {
            fixedAssignments[m.name] = { name: trainTaskName, wanted: 0, money: 0, respect: 0, expGain: 0 };
            continue;
        }
        if (combatTrainSet.has(m.name)) {
            fixedAssignments[m.name] = { name: trainTask(), wanted: 0, money: 0, respect: 0, expGain: 0 };
            continue;
        }

        const crimeRates = regularCrimeTasks.map(t => {
            const rate = {
                name: t,
                respect: computeRespectGain(myGangInfo, t, m),
                money: computeMoneyGain(myGangInfo, t, m),
                wanted: computeWantedGain(myGangInfo, t, m),
                expGain: !isHackGang ? computeCombatExpGain(t, m) : 0,
            };
            rate.score = computeTaskObjectiveScore(rate, objectiveWeights, rateScales);
            return rate;
        }).filter(t => t.score > 0);

        if (!crimeRates.length) {
            fallbackTrainers.push(m.name);
            fixedAssignments[m.name] = { name: trainTask(), wanted: 0, money: 0, respect: 0, expGain: 0 };
            continue;
        }

        const baseline = {
            name: strWantedReduction,
            respect: computeRespectGain(myGangInfo, strWantedReduction, m),
            money: computeMoneyGain(myGangInfo, strWantedReduction, m),
            wanted: computeWantedGain(myGangInfo, strWantedReduction, m),
            expGain: !isHackGang ? computeCombatExpGain(strWantedReduction, m) : 0,
        };
        baseline.score = computeTaskObjectiveScore(baseline, objectiveWeights, rateScales);
        baselineWanted += baseline.wanted;
        baselineMoney += baseline.money;
        baselineRespect += baseline.respect;
        baselineExpGain += baseline.expGain ?? 0;
        memberOptions.push({
            member: m.name,
            baseline,
            options: [baseline, ...crimeRates].sort((a, b) =>
                Math.abs(a.wanted - b.wanted) > 1e-9 ? a.wanted - b.wanted : b.score - a.score),
        });
    }

    if (fallbackTrainers.length > 0)
        log(ns, `[gang-dbg] fallbackTrainSet (no productive crimes): [${fallbackTrainers.join(', ')}]`);

    const wantedBudget = Math.max(0, wantedGainTolerance - baselineWanted);
    const optimized = optimizeWantedBudget(memberOptions, wantedBudget);
    const predictedWanted = baselineWanted + optimized.wanted;
    const predictedRespect = baselineRespect + optimized.respect;
    const predictedMoney = baselineMoney + optimized.money;
    const plannedAssignments = Object.fromEntries(
        allMembers.map(m => {
            const fixed = fixedAssignments[m.name];
            return [m.name, fixed?.name ?? optimized.assignments[m.name] ?? strWantedReduction];
        })
    );

    if (myGangMembers.some(m => assignedTasks[m] !== plannedAssignments[m])) {
        myGangMembers.forEach(m => { assignedTasks[m] = plannedAssignments[m]; });
        const old = myGangInfo;
        await updateMemberActivities(ns, dictMembers);
        myGangInfo = await waitForGameUpdate(ns, old);
        log(ns, `Optimized ${goalLabel}. Predicted wanted=${predictedWanted.toPrecision(3)} ` +
            `(tol=${wantedGainTolerance.toPrecision(3)}), predicted rep=${formatNumberShort(predictedRespect)}, ` +
            `predicted money=${formatMoney(predictedMoney)}` +
            (objectiveWeights.power > 0 ? `, predicted expGain=${(baselineExpGain + optimized.expGain).toPrecision(3)}` : '') +
            `. Actual wanted: ${old.wantedLevelGainRate.toPrecision(3)} ` +
            `to ${myGangInfo.wantedLevelGainRate.toPrecision(3)}, rep: ${formatNumberShort(old.respectGainRate)} ` +
            `to ${formatNumberShort(myGangInfo.respectGainRate)}, money: ${formatMoney(old.moneyGainRate)} ` +
            `to ${formatMoney(myGangInfo.moneyGainRate)}.`);
    } else {
        log(ns, `All ${myGangMembers.length} assignments already optimal for ${goalLabel}.`);
    }

    if (myGangInfo.wantedLevelGainRate > wantedGainTolerance)
        await fixWantedGainRate(ns, myGangInfo, wantedGainTolerance);
}

// ── fixWantedGainRate (v10: sort by lowest earner first) ──────────────────────
async function fixWantedGainRate(ns, myGangInfo, tolerance = 0) {
    // v10: Sort candidates by lowest objective score (least valuable earner first).
    // This keeps the best crime contributors on their tasks longest, minimising total
    // respect/money loss per recovery event vs the previous random shuffle.
    const objectiveWeights = getOptimizationWeights(myGangInfo, myGangInfo.respect / 75);
    const utilityTasks = new Set([strWantedReduction, trainTask(),
        isHackGang ? 'Train Hacking' : 'Train Charisma', 'Territory Warfare', 'Train Combat']);
    const regularCrimeTasks = allTaskNames.filter(t => !utilityTasks.has(t));
    const dictMembers = await getGangDict(ns, myGangMembers, 'getMemberInformation');
    const rateScales = getTaskRateScales(myGangInfo, Object.values(dictMembers), regularCrimeTasks);

    const crimeTasks = new Set([
        'Mug People','Deal Drugs','Strongarm Civilians','Run a Con','Armed Robbery',
        'Traffick Illegal Arms','Human Trafficking','Terrorism',
        'Ransomware','Phishing','Identity Theft','DDoS Attacks',
        'Plant Virus','Fraud & Counterfeiting','Money Laundering','Cyberterrorism'
    ]);

    const candidates = myGangMembers
        .filter(m => crimeTasks.has(assignedTasks[m]))
        .map(m => {
            const member = dictMembers[m];
            const score = member ? regularCrimeTasks.reduce((best, t) =>
                Math.max(best, computeTaskObjectiveScore({
                    respect: computeRespectGain(myGangInfo, t, member),
                    money: computeMoneyGain(myGangInfo, t, member),
                    expGain: !isHackGang ? computeCombatExpGain(t, member) : 0,
                }, objectiveWeights, rateScales)), 0) : 0;
            return { name: m, score };
        })
        .sort((a, b) => a.score - b.score); // lowest earner first

    let lastRate = myGangInfo.wantedLevelGainRate;
    log(ns, `WARNING: Wanted gaining too fast (${lastRate.toPrecision(3)} > ${tolerance.toPrecision(3)}), assigning vigilante (lowest earners first)...`, false, 'warning');

    for (const { name: m } of candidates) {
        assignedTasks[m] = strWantedReduction;
        await updateMemberActivities(ns);
        myGangInfo = await waitForGameUpdate(ns, myGangInfo);
        if (myGangInfo.wantedLevelGainRate < tolerance) return;
        if (myGangInfo.wantedLevelGainRate === lastRate)
            log(ns, `WARNING: Switching ${m} to ${strWantedReduction} had no effect.`, false, 'warning');
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
        assignedTasks[name]   = trainTask();
        lastMemberReset[name] = getCurrentCycle();
        log(ns, `Recruited "${name}"`, false, 'success');
    } else {
        log(ns, `ERROR: Could not recruit "${name}"`, false, 'error');
    }
}

// ── Ascension ──────────────────────────────────────────────────────────────────
function optimalAscendThreshold(maxAscPoints) {
    if (maxAscPoints < 1000) return 1.05;
    const floor = 1.04, peak = 1.10;
    if (maxAscPoints <= 100000) {
        const t = (Math.log10(maxAscPoints) - 3) / 2;
        return floor + (peak - floor) * t;
    }
    const t = Math.min(1, (Math.log10(maxAscPoints) - 5) / 1.3);
    return peak - (peak - floor) * t;
}

function respectForMember(n) {
    if (n < 3) return 0;
    return Math.pow(5, n - 2);
}

async function tryAscendMembers(ns, myGangInfo) {
    const ascResults  = await getGangDict(ns, myGangMembers, 'getAscensionResult');
    const memberInfos = await getGangDict(ns, myGangMembers, 'getMemberInformation');

    const nextRecruitResp = respectForMember(myGangMembers.length);
    let currentRespect = myGangInfo?.respect ?? Infinity;
    const startRespect = currentRespect;
    const MAX_RESPECT_LOSS_FRAC = 0.18; // v9: 0.15→0.18
    let ascensionCount = 0;

    const membersByImpact = [...myGangMembers].sort((a, b) =>
        (memberInfos[a]?.earnedRespect ?? 0) - (memberInfos[b]?.earnedRespect ?? 0));

    for (let i = 0; i < membersByImpact.length; i++) {
        const m      = membersByImpact[i];
        const result = ascResults[m];
        const info   = memberInfos[m];
        if (!result) continue;

        const statsList = [...importantStats, 'cha'];
        const maxAscPts = Math.max(...statsList.map(s => info?.[s + '_asc_points'] ?? 0));
        const threshold = optimalAscendThreshold(maxAscPts);

        if (!statsList.some(s => (result[s] ?? 0) >= threshold)) {
            const bestStat = statsList.reduce((best, s) =>
                (result[s] ?? 0) > (result[best] ?? 0) ? s : best, statsList[0]);
            const bestRatio = result[bestStat] ?? 0;
            if (bestRatio > 1.01)
                log(ns, `[asc-dbg] ${m}: best=${bestStat}→×${bestRatio.toFixed(3)}, need=${threshold.toFixed(3)} (pts=${formatNumberShort(maxAscPts)}). Not ready.`);
            continue;
        }

        const chaResult = result?.cha ?? 0;
        let chaFloor;
        if (maxAscPts < 10000)       chaFloor = 1.005;
        else if (maxAscPts < 20000)  chaFloor = 1.001;
        else                         chaFloor = 0;
        if (chaFloor > 0 && chaResult < chaFloor) {
            log(ns, `Holding ${m}: cha→×${chaResult.toFixed(3)} < ${chaFloor} (pts=${formatNumberShort(maxAscPts)}). Train cha.`);
            continue;
        }

        if (!isHackGang) {
            const chaTriggered    = chaResult >= threshold;
            const combatTriggered = importantStats.some(s => (result[s] ?? 0) >= threshold);
            if (chaTriggered && !combatTriggered) {
                const maxCombatAscPts = Math.max(...importantStats.map(s => info?.[s + '_asc_points'] ?? 0));
                if (maxCombatAscPts < 2000) {
                    log(ns, `[asc-dbg] ${m}: cha ready (×${chaResult.toFixed(3)}) but combat asc_pts=${formatNumberShort(maxCombatAscPts)} < 2000. Holding.`);
                    continue;
                }
            }
        }

        const earnedResp = info?.earnedRespect ?? 0;

        if (earnedResp > 0 && currentRespect - earnedResp < 50) {
            log(ns, `Holding ${m}: would drop respect to ${formatNumberShort(currentRespect - earnedResp)} (below floor 50).`);
            continue;
        }

        if (earnedResp > 0 && myGangInfo.wantedLevel > 1.05) {
            const postRespect = currentRespect - earnedResp;
            const postPenalty = postRespect / (postRespect + myGangInfo.wantedLevel);
            if (postPenalty < 1 - WANTED_PENALTY_THRESH) {
                log(ns, `Holding ${m}: post-ascension penalty would be ${(postPenalty*100).toFixed(1)}%.`);
                continue;
            }
        }

        const alreadyAboveThreshold = currentRespect >= nextRecruitResp;
        if (myGangMembers.length < 12 && alreadyAboveThreshold &&
                currentRespect - earnedResp < nextRecruitResp) {
            log(ns, `Holding ${m}: would drop respect below recruit floor ${formatNumberShort(nextRecruitResp)}.`);
            continue;
        }
        if (myGangMembers.length < 12 && !alreadyAboveThreshold && earnedResp > 0) {
            if (ascensionCount > 0) {
                log(ns, `[asc-dbg] Deferring ${m}: already ascended 1 this cycle while below recruit threshold.`);
                continue;
            }
        }

        const alreadyLost = startRespect - currentRespect;
        if (startRespect > 1 && alreadyLost / startRespect >= MAX_RESPECT_LOSS_FRAC) {
            log(ns, `[asc-dbg] Deferring ${m}: already lost ${(alreadyLost/startRespect*100).toFixed(1)}% respect this cycle.`);
            break;
        }

        const ok = await getNsDataThroughFile(ns,
            `ns.gang.ascendMember(ns.args[0])`, null, [m]);
        if (ok !== undefined) {
            log(ns, `Ascended ${m}: ${statsList.map(s => `${s}→×${(result[s]??1).toFixed(2)}`).join(' ')} ` +
                `(threshold=${threshold.toFixed(3)}, pts=${formatNumberShort(maxAscPts)})`, false, 'success');
            lastMemberReset[m] = getCurrentCycle();
            currentRespect -= earnedResp;
            ascensionCount++;
        } else {
            log(ns, `ERROR: Ascend failed for ${m}`, false, 'error');
        }
    }
}

// ── Equipment upgrades ─────────────────────────────────────────────────────────
async function tryUpgradeMembers(ns, myGangInfo, dictMembers) {
    const costs = await getGangDict(ns, equipments.map(e => e.name), 'getEquipmentCost');
    equipments.forEach(e => e.cost = costs[e.name]);

    if (!is4sBought)
        is4sBought = await getNsDataThroughFile(ns, 'ns.stock.has4SDataTixApi()');

    const player   = await getNsDataThroughFile(ns, 'ns.getPlayer()');
    const reserve  = options['reserve'] ?? Number(ns.read('reserve.txt') || 0);
    const cash     = Math.max(0, player.money - reserve);
    const budgetMult = (!is4sBought || resetInfo.currentNode === 8)
        ? options['no-4s-budget-multiplier'] : 1;

    let budget    = Math.min(0.99, (options['equipment-budget']     ?? DEFAULT_EQUIP_BUDGET)) * cash * budgetMult;
    let augBudget = Math.min(0.99, (options['augmentations-budget'] ?? DEFAULT_AUG_BUDGET))   * cash * budgetMult;

    const ascResults = await getGangDict(ns, myGangMembers, 'getAscensionResult');
    const objectiveWeights = getOptimizationWeights(myGangInfo, myGangInfo.respect / 75);
    const utilityTasks = new Set([strWantedReduction, trainTask(), isHackGang ? 'Train Hacking' : 'Train Charisma', 'Territory Warfare']);
    const regularCrimeTasks = allTaskNames.filter(t => !utilityTasks.has(t));
    const rateScales = getTaskRateScales(myGangInfo, Object.values(dictMembers), regularCrimeTasks);
    const liveMembers = Object.fromEntries(Object.values(dictMembers).map(m => [m.name, cloneMemberState(m)]));
    const order = [];

    const combatTwStats = new Set(['str', 'def', 'dex', 'agi', 'hack', 'cha']);

    while (augBudget > 0) {
        let best = null;
        for (const equip of equipments) {
            const isRelevant = isHackGang
                ? Object.keys(equip.stats ?? {}).some(s => s.includes('hack') || s.includes('cha'))
                : Object.keys(equip.stats ?? {}).some(s => [...combatTwStats].some(i => s.includes(i)));
            const perceivedCost = equip.cost * (isRelevant ? 1 : OFF_STAT_COST_PENALTY);
            if (perceivedCost > augBudget) continue;
            if (equip.type !== 'Augmentation' && perceivedCost > budget) continue;

            for (const source of Object.values(dictMembers)) {
                const m = liveMembers[source.name];
                if ((source.upgrades ?? []).includes(equip.name) || (source.augmentations ?? []).includes(equip.name)) continue;
                if ((order.some(o => o.member === source.name && o.equipmentName === equip.name))) continue;

                const roi = estimateEquipmentRoi(m, equip, myGangInfo, objectiveWeights, rateScales, ascResults[source.name]);
                if (!roi || roi.value <= 0) continue;
                if (!best || roi.score > best.score) {
                    best = { member: source.name, equipmentName: equip.name, type: equip.type, cost: equip.cost, score: roi.score };
                }
            }
        }

        if (!best) break;
        order.push(best);
        if (best.type !== 'Augmentation') budget -= best.cost;
        augBudget -= best.cost;
        liveMembers[best.member] = applyEquipmentToMember(cloneMemberState(liveMembers[best.member]), equipments.find(e => e.name === best.equipmentName));
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

    const configuredThreshold = options['territory-engage-threshold'];
    const dynamicThreshold = myGangInfo.territory < 0.20
        ? 0.52 + (configuredThreshold - 0.52) * (myGangInfo.territory / 0.20)
        : configuredThreshold;

    // v10: NPC power threat adjustment (source: Gang/data/power.ts PowerMultiplier).
    // Speakers for the Dead and The Black Hand have powerMult=5 — their additive power gain
    // (0.75 * rand * territory * 5) compounds 2.5× faster than typical NPCs. When either
    // holds >20% territory, lower threshold by 0.03 to prioritise fighting them before
    // their power advantage becomes insurmountable.
    let highThreatActive = false;
    for (const [name, g] of Object.entries(others)) {
        if (HIGH_POWERMULT_GANGS.has(name) && g.territory > 0.20 && name !== myGangFaction) {
            highThreatActive = true;
            break;
        }
    }
    const threatAdjustment = highThreatActive ? -0.03 : 0;
    const effectiveThreshold = Math.max(0.50, dynamicThreshold + threatAdjustment);

    const engage = !warfareFinished && lowest >= effectiveThreshold;
    if (engage !== myGangInfo.territoryWarfareEngaged) {
        log(ns, `${warfareFinished ? 'SUCCESS' : 'INFO'}: Territory warfare → ${engage}. ` +
            `Power: ${formatNumberShort(myGangInfo.power)}. Avg win: ${(avg*100).toFixed(1)}%. ` +
            `Lowest: ${(lowest*100).toFixed(1)}% vs ${lowestName} (effective threshold: ${(effectiveThreshold*100).toFixed(1)}%, ` +
            `territory: ${(myGangInfo.territory*100).toFixed(1)}%${highThreatActive ? ', HIGH-THREAT NPC active' : ''}).`,
            false, warfareFinished ? 'info' : 'success');
        await runCommand(ns, `ns.gang.setTerritoryWarfare(ns.args[0])`, null, [engage]);
    }
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
async function writeDashboardDataFull(ns) {
    const info = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
    if (!info) { ns.write(GANGS_FILE, JSON.stringify({ inGang: true, gangsLoaded: true }), 'w'); return; }

    const canRecruit = await getNsDataThroughFile(ns, 'ns.gang.canRecruitMember()');
    const dictMembers = await getGangDict(ns, myGangMembers, 'getMemberInformation');
    const ascResults  = await getGangDict(ns, myGangMembers, 'getAscensionResult');
    const others = {};

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
    lastDashboardData = d;
    ns.write(GANGS_FILE, JSON.stringify(d), 'w');
}

function writeDashboardDataLive(ns, myGangInfo) {
    if (!lastDashboardData) return;
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
        if (JSON.stringify(latest) !== JSON.stringify(old)) return latest;
        await ns.sleep(100);
    }
    return await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
}

const WANTED_PENALTY_THRESH   = 0.01;
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

function computeCombatExpGain(taskName, member) {
    const task = allTaskStats[taskName];
    if (!task || !task.difficulty) return 0;
    const diffMult = Math.pow(task.difficulty, 0.9) / 1500;
    const stats = ['str', 'def', 'dex', 'agi'];
    return stats.reduce((sum, s) => {
        const w = task[s + 'Weight'] ?? 0;
        if (!w) return sum;
        const equipMult = ((member[s + '_mult'] ?? 1) - 1) / 4 + 1;
        const ascMult   = getMemberAscensionMult(member[s + '_asc_points'] ?? 0);
        return sum + w * diffMult * equipMult * ascMult;
    }, 0);
}

function getOptimizationWeights(myGangInfo, factionRep = 0) {
    if (options['reputation-focus']) return { respect: 1, money: 0, power: 0 };
    if (options['money-focus'])      return { respect: 0.2, money: 0.8, power: 0 };
    const repGap = requiredRep > 0
        ? Math.max(0, Math.min(1, (requiredRep - factionRep) / requiredRep))
        : 0;
    const recruitGap = myGangMembers.length < 12 && myGangInfo.respectForNextRecruit > 0
        ? Math.max(0, Math.min(1, (myGangInfo.respectForNextRecruit - myGangInfo.respect) / myGangInfo.respectForNextRecruit))
        : 0;
    const territoryGap = Math.max(0, 1 - (myGangInfo.territory ?? 1));
    let respect = 0.35 + (myGangMembers.length < 12 ? 0.20 : 0) + 0.20 * recruitGap + 0.15 * repGap + 0.10 * territoryGap;
    respect = Math.max(0.2, Math.min(0.9, respect));
    let money = 1 - respect;
    // v9: sublinear gap^0.7 keeps stat-exp weight elevated through mid-territory
    const powerDim = !isHackGang ? TERRITORY_TASK_WEIGHT * Math.pow(territoryGap, 0.7) : 0;
    if (powerDim > 0) {
        const total = respect + money + powerDim;
        return { respect: respect / total, money: money / total, power: powerDim / total };
    }
    return { respect, money: 1 - respect, power: 0 };
}

function formatOptimizationGoal(weights) {
    const powerPct = ((weights.power ?? 0) * 100).toFixed(0);
    return `for respect ${(weights.respect * 100).toFixed(0)}% / money ${(weights.money * 100).toFixed(0)}%` +
        (parseFloat(powerPct) > 0 ? ` / statGain ${powerPct}%` : '');
}

function getTaskRateScales(g, members, taskNames) {
    let respect = 0, money = 0, wantedRecovery = 0, power = 0, expGain = 0;
    for (const m of members) {
        power = Math.max(power, computeMemberPower(m));
        wantedRecovery = Math.max(wantedRecovery, -Math.min(0, computeWantedGain(g, strWantedReduction, m)));
        for (const task of taskNames) {
            respect = Math.max(respect, computeRespectGain(g, task, m));
            money = Math.max(money, computeMoneyGain(g, task, m));
            if (!isHackGang) expGain = Math.max(expGain, computeCombatExpGain(task, m));
        }
    }
    return {
        respect: Math.max(respect, 1e-9),
        money: Math.max(money, 1e-9),
        wantedRecovery: Math.max(wantedRecovery, 1e-9),
        power: Math.max(power, 1e-9),
        expGain: Math.max(expGain, 1e-9),
    };
}

function computeTaskObjectiveScore(rate, weights, scales) {
    return (weights.respect * (rate.respect / scales.respect)) +
        (weights.money * (rate.money / scales.money)) +
        ((weights.power ?? 0) * ((rate.expGain ?? 0) / scales.expGain));
}

function optimizeWantedBudget(memberOptions, wantedBudget) {
    if (!memberOptions.length) return { score: 0, wanted: 0, respect: 0, money: 0, expGain: 0, assignments: {} };
    const bucketSize = wantedBudget > 0 ? Math.max(wantedBudget / TASK_OPTIMIZER_BUCKETS, 1e-5) : 1;
    const budgetBuckets = wantedBudget > 0 ? Math.max(0, Math.floor(wantedBudget / bucketSize)) : 0;
    let states = Array.from({ length: budgetBuckets + 1 }, () => null);
    states[0] = { score: 0, wanted: 0, respect: 0, money: 0, expGain: 0, assignments: {} };

    for (const entry of memberOptions) {
        const next = Array.from({ length: budgetBuckets + 1 }, () => null);
        for (let bucket = 0; bucket <= budgetBuckets; bucket++) {
            const state = states[bucket];
            if (!state) continue;
            for (const option of entry.options) {
                const extraWanted = Math.max(0, option.wanted - entry.baseline.wanted);
                const costBuckets = wantedBudget > 0
                    ? Math.ceil(extraWanted / bucketSize - 1e-12)
                    : (extraWanted > 0 ? budgetBuckets + 1 : 0);
                const nextBucket = bucket + costBuckets;
                if (nextBucket > budgetBuckets) continue;
                const candidate = {
                    score: state.score + (option.score - entry.baseline.score),
                    wanted: state.wanted + (option.wanted - entry.baseline.wanted),
                    respect: state.respect + (option.respect - entry.baseline.respect),
                    money: state.money + (option.money - entry.baseline.money),
                    expGain: state.expGain + ((option.expGain ?? 0) - (entry.baseline.expGain ?? 0)),
                    assignments: { ...state.assignments, [entry.member]: option.name },
                };
                if (candidate.wanted > wantedBudget + 1e-9) continue;
                const current = next[nextBucket];
                if (!current ||
                    candidate.score > current.score + 1e-9 ||
                    (Math.abs(candidate.score - current.score) <= 1e-9 &&
                     candidate.wanted < current.wanted - 1e-9)) {
                    next[nextBucket] = candidate;
                }
            }
        }
        states = next;
    }

    return states.filter(Boolean).reduce((best, state) =>
        !best ||
        state.score > best.score + 1e-9 ||
        (Math.abs(state.score - best.score) <= 1e-9 && state.wanted < best.wanted - 1e-9)
            ? state : best,
        null) ?? { score: 0, wanted: 0, respect: 0, money: 0, expGain: 0, assignments: {} };
}

function cloneMemberState(m) { return { ...m }; }

function getMemberAscensionMult(points) {
    return Math.max(Math.pow(points / 2000, 0.5), 1);
}

function calculateMemberSkill(exp, mult = 1) {
    return Math.max(Math.floor(mult * (32 * Math.log(exp + 534.5) - 200)), 1);
}

function applyEquipmentToMember(member, equip) {
    if (!member || !equip) return member;
    for (const stat of ['hack', 'str', 'def', 'dex', 'agi', 'cha']) {
        if (equip.stats?.[stat] != null)
            member[stat + '_mult'] = (member[stat + '_mult'] ?? 1) * equip.stats[stat];
    }
    for (const stat of ['hack', 'str', 'def', 'dex', 'agi', 'cha']) {
        const totalMult = (member[stat + '_mult'] ?? 1) * getMemberAscensionMult(member[stat + '_asc_points'] ?? 0);
        member[stat] = calculateMemberSkill(member[stat + '_exp'] ?? 0, totalMult);
    }
    return member;
}

function computeMemberPower(member) {
    return ((member.hack ?? 0) + (member.str ?? 0) + (member.def ?? 0) +
        (member.dex ?? 0) + (member.agi ?? 0) + (member.cha ?? 0)) / 95;
}

function estimateEquipmentRoi(member, equip, g, weights, scales, ascResult) {
    const taskNames = allTaskNames.filter(t => ![strWantedReduction, trainTask(), isHackGang ? 'Train Hacking' : 'Train Charisma', 'Territory Warfare'].includes(t));
    const beforeScore = taskNames.reduce((best, task) => Math.max(best, computeTaskObjectiveScore({
        respect: computeRespectGain(g, task, member),
        money: computeMoneyGain(g, task, member),
        expGain: !isHackGang ? computeCombatExpGain(task, member) : 0,
    }, weights, scales)), 0);
    const beforeVigilante = -Math.min(0, computeWantedGain(g, strWantedReduction, member));
    const beforePower = computeMemberPower(member);

    const upgraded = applyEquipmentToMember(cloneMemberState(member), equip);
    const afterScore = taskNames.reduce((best, task) => Math.max(best, computeTaskObjectiveScore({
        respect: computeRespectGain(g, task, upgraded),
        money: computeMoneyGain(g, task, upgraded),
        expGain: !isHackGang ? computeCombatExpGain(task, upgraded) : 0,
    }, weights, scales)), 0);
    const afterVigilante = -Math.min(0, computeWantedGain(g, strWantedReduction, upgraded));
    const afterPower = computeMemberPower(upgraded);

    let value = afterScore - beforeScore;
    if ((g.wantedPenalty ?? 1) < (1 - WANTED_PENALTY_THRESH))
        value += GEAR_RECOVERY_WEIGHT * ((afterVigilante - beforeVigilante) / scales.wantedRecovery);
    if ((g.territory ?? 1) < 1) {
        const gearPowerWeight = GEAR_POWER_WEIGHT_MIN +
            (GEAR_POWER_WEIGHT_MAX - GEAR_POWER_WEIGHT_MIN) * (1 - (g.territory ?? 0));
        value += gearPowerWeight * ((afterPower - beforePower) / scales.power);
    }

    if (equip.type !== 'Augmentation') {
        const statsList = [...importantStats, 'cha'];
        const maxAscPts = Math.max(...statsList.map(s => member?.[s + '_asc_points'] ?? 0));
        const threshold = optimalAscendThreshold(maxAscPts);
        const maxAscResult = Math.max(...statsList.map(s => ascResult?.[s] ?? 1));
        if (maxAscResult >= threshold * 0.98) value *= TEMP_GEAR_ASC_PENALTY;
    } else {
        // v9: augTerritoryBonus 0.15→0.25. Augs survive ascension and compound across all
        // future cycles; higher weight correctly prices their long-term territory ROI.
        const augTerritoryBonus = !isHackGang ? 0.25 * Math.max(0, 1 - (g.territory ?? 1)) : 0;
        value *= (1.35 + augTerritoryBonus);
    }

    return { value, score: value / Math.max(equip.cost, 1) };
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