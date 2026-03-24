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
} from '/helpers.js'

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
    ['reserve',                      null  ],
    ['augmentations-budget',         null  ], // Override default aug budget fraction
    ['equipment-budget',             null  ], // Override default equip budget fraction
    ['no-4s-budget-multiplier',      NO4S_BUDGET_MULTIPLIER], // Budget scale without 4S
    ['territory-engage-threshold',   0.52  ], // Engage warfare when MINIMUM win chance (vs any territory-holding gang) >= this
    ['money-focus',                  false ],
    ['reputation-focus',             false ],
];

export function autocomplete(data, _) { data.flags(argsSchema); return []; }

let myGangFaction = '', isHackGang = false, strWantedReduction = '', importantStats = [];
let requiredRep = 2.5e6, myGangMembers = [], equipments = [], ownedSourceFiles;
let allTaskNames, allTaskStats, assignedTasks = {}, lastMemberReset = {};
let chaTrainTicksCount = {};  // consecutive ticks each member has been in chaTrainSet
const MAX_CONSEC_CHA_TRAIN_TICKS = 40; // force one crime tick if stuck training this long
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
let bothIsMoneyTick    = false;
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
    log(ns, 'Gang manager starting main loop... [v7: threshold decay at high pts]');
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

    // Detect territory tick by watching other gangs' power/territory change.
    // We poll other gang info in two situations:
    //   1. Initial/re-sync detection (!territoryTickDetected)
    //   2. While waiting for the tick after switching to TW (isReadyForNextTerritoryTick)
    //      — own power may not change if timing was off, but other gangs always update.
    const needOtherInfo = !territoryTickDetected || isReadyForNextTerritoryTick;
    const otherInfo = needOtherInfo
        ? await getNsDataThroughFile(ns, 'ns.gang.getOtherGangInformation()')
        : null;

    if (!territoryTickDetected) {
        if (lastOtherGangInfo != null &&
            JSON.stringify(otherInfo) !== JSON.stringify(lastOtherGangInfo)) {
            // If we're already waiting for the tick (isReadyForNextTerritoryTick),
            // the prediction is already good — don't overwrite it with a stale lastLoopTime.
            if (!isReadyForNextTerritoryTick)
                territoryNextTick = lastLoopTime + territoryTickTime;
            territoryTickDetected = true;
            log(ns, `Territory tick detected. Next tick ETA: ${formatDuration(territoryNextTick - now - territoryTickWaitPadding)}`);
        } else if (!lastOtherGangInfo)
            log(ns, territoryNextTick != null
                ? `Re-syncing tick detection (predicted tick in ${formatDuration(territoryNextTick - now)}).`
                : `Waiting for territory tick detection...`);
        lastOtherGangInfo = otherInfo;
    }

    // Switch to Territory Warfare just before tick
    if (!warfareFinished && !isReadyForNextTerritoryTick &&
        now + UPDATE_MS + territoryTickWaitPadding >= territoryNextTick) {
        isReadyForNextTerritoryTick = true;
        await updateMemberActivities(ns, null, 'Territory Warfare', myGangInfo);
    }

    // While waiting for tick: detect via other gangs (reliable even when own power
    // doesn't change due to timing miss). This replaces the 5000ms hard timeout
    // as the primary signal, limiting TW exposure to ~1 loop past the actual tick.
    const otherGangTickFired = isReadyForNextTerritoryTick && otherInfo != null
        && lastOtherGangInfo != null
        && JSON.stringify(otherInfo) !== JSON.stringify(lastOtherGangInfo);
    if (otherGangTickFired) lastOtherGangInfo = otherInfo;

    // Handle territory tick: own-power change (accurate), other-gang change (drift fallback),
    // or hard timeout as last resort (2× tick time instead of flat 5s — scales with bonus time).
    const tickTimeout = territoryTickTime * 2;
    if ((isReadyForNextTerritoryTick && myGangInfo.power !== lastTerritoryPower) ||
        otherGangTickFired ||
        now > (territoryNextTick ?? 0) + tickTimeout) {
        if (now > (territoryNextTick ?? 0) + tickTimeout)
            log(ns, `WARNING: Territory tick timeout after ${Math.round((now - territoryNextTick)/1000)}s. Re-syncing.`, false, 'warning');
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
        }
        // Warfare off: timing miss is expected. Silently adjust, keep detection state.
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

/**
 * How many members should be dedicated to cha/hack training right now.
 * Scales: all 12 members train when far below threshold, fewer as they approach it.
 */
function chaTrainersNeeded(dictMembers) {
    if (options['no-training']) return 0;
    const statKey   = isHackGang ? 'hack' : 'cha';
    const threshold = isHackGang ? options['hack-threshold'] : options['cha-threshold'];
    const members   = Object.values(dictMembers);
    const below     = members.filter(m => (m[statKey] ?? 0) < threshold);
    if (below.length === 0) return 0;
    // Dedicate up to cha-training-percentage of members, minimum 1
    return Math.max(1, Math.round(members.length * options['cha-training-percentage']));
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

        // Protect fragile members from warfare deaths.
        // Always revert to a safe task, never back to Territory Warfare —
        // assignedTasks[m.name] could itself be 'Territory Warfare' if the
        // optimizer assigned it or it was read from the game on startup.
        if (forceTask === 'Territory Warfare' && myGangInfo?.territoryClashChance > 0) {
            if (m.def < 100 || m.def < Math.min(10000, maxDef * 0.1)) {
                const safeTask = assignedTasks[m.name] === 'Territory Warfare'
                    ? trainTask()
                    : assignedTasks[m.name];
                task = safeTask;
            }
        }
        // TW tick window is ~200ms -- all members switch to TW during that window,
        // including cha/hack trainers. The training loss is negligible (~1% of a tick)
        // and every member on TW means more power gained. After the tick they all
        // return to their assigned tasks automatically.
        // Train Combat members also switch (same logic applies).
        // Exception: members who JUST ascended/recruited (min-training-ticks guard below)
        // are already handled and won't be pulled to TW.

        // Force-train members who recently ascended/recruited
        const trainTicks = options['min-training-ticks'] * territoryTickTime;
        if ((Date.now() - (lastMemberReset[m.name] ?? 0)) < trainTicks)
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

// ── Crime optimization ─────────────────────────────────────────────────────────
async function optimizeGangCrime(ns, myGangInfo) {
    const dictMembers = await getGangDict(ns, myGangMembers, 'getMemberInformation');

    const currentPenalty = getWantedPenalty(myGangInfo) - 1;

    const penaltyBad = currentPenalty < -1.1 * WANTED_PENALTY_THRESH;
    const wantedAboveMin = myGangInfo.wantedLevel > 1.05;
    if (penaltyBad && wantedAboveMin && !inWantedRecovery) {
        inWantedRecovery = true;
        log(ns, `Wanted recovery ON: penalty=${(currentPenalty*100).toFixed(2)}%, wanted=${myGangInfo.wantedLevel.toFixed(2)}`);
    }
    if (inWantedRecovery && !wantedAboveMin) {
        inWantedRecovery = false;
        log(ns, `Wanted recovery OFF: wanted=${myGangInfo.wantedLevel.toFixed(2)}`);
    }

    let wantedGainTolerance;
    if (inWantedRecovery) {
        wantedGainTolerance = -0.01 * myGangInfo.wantedLevel;
    } else if (!wantedAboveMin && myGangInfo.respect < 200) {
        wantedGainTolerance = 0.1;
    } else if (currentPenalty < -0.9 * WANTED_PENALTY_THRESH &&
               myGangInfo.wantedLevel >= (1.1 + myGangInfo.respect / 10000) &&
               myGangInfo.respect >= 200) {
        wantedGainTolerance = myGangInfo.wantedLevel / 50;
    } else {
        wantedGainTolerance = Math.max(myGangInfo.respectGainRate / 1000, myGangInfo.wantedLevel / 10);
    }

    let factionRep = -1;
    if (ownedSourceFiles[4] > 0) {
        try {
            factionRep = await getNsDataThroughFile(ns,
                `ns.singularity.getFactionRep(ns.args[0])`, null, [myGangFaction]);
        } catch {}
    }
    if (factionRep < 0) factionRep = myGangInfo.respect / 75;

    const optStat = options['reputation-focus'] ? 'respect'
        : options['money-focus']       ? 'money'
        : factionRep > requiredRep     ? 'money'
        : (myGangInfo.respect < 9000)  ? 'respect'
        : 'both';



    // Determine which members should train cha/hack this tick (per-member, not global)
    const statKey     = isHackGang ? 'hack' : 'cha';
    const trainCount  = chaTrainersNeeded(dictMembers);
    const trainTaskName = isHackGang ? 'Train Hacking' : 'Train Charisma';
    // chaTrainSet: members whose cha/hack is below the training threshold.
    // Three caps on how many can train simultaneously:
    //
    //   VIGILANTE_FLOOR (2): when wanted is bad, always keep 2 free for Vigilante Justice.
    //   Without this cap, all members lock to Train Charisma and wanted can never recover.
    //
    //   CRIME_FLOOR: when below max members, always keep at least this many on crimes to
    //   earn respect for the next recruit. Training all members stalls recruitment entirely.
    //   Floor scales with roster size — smaller gangs need proportionally more earners.
    //   Once at max (12) members recruitment is no longer needed, so floor drops to 0.
    const VIGILANTE_FLOOR = 2;
    const wantedBad = (myGangInfo.wantedPenalty ?? 1) < (1 - WANTED_PENALTY_THRESH);
    const allMembers = Object.values(dictMembers);
    const needsRecruits = allMembers.length < (myGangInfo.maxMembers ?? 12);
    // Keep at least 1 earner per 4 members (min 1) when still recruiting.
    // This means: 4 members → 1 earner, 8 members → 2 earners, 12 → 0 (done).
    const CRIME_FLOOR = needsRecruits
        ? Math.max(1, Math.floor(allMembers.length / 4))
        : 0;
    const floor = Math.max(VIGILANTE_FLOOR * (wantedBad ? 1 : 0), CRIME_FLOOR);
    // trainCount is the configured training rate (default 15% = ~2 for 11 members).
    // It was previously computed but never enforced — all below-threshold members
    // could lock to training. Now use it as the primary cap so the rest do crimes.
    // If trainCount is 0 (no-training flag or everyone above flat threshold), the
    // dynamic-threshold filter in chaTrainSet will handle it — we just don't add a
    // second cap that could conflict, so use allMembers.length as the fallback.
    const trainCap = trainCount > 0 ? trainCount : allMembers.length;
    const maxChaTrainers = Math.min(trainCap, Math.max(0, allMembers.length - floor));
    // Dynamic cha threshold: the higher of the flat unlock threshold OR 80% of
    // the member's own dex (same weight in HT/TIA formula). Keeps cha proportional
    // as stats grow through ascensions instead of stopping at the flat 350 unlock value.
    const flatChaThreshold = isHackGang ? options['hack-threshold'] : options['cha-threshold'];
    const memberChaThreshold = (m) => isHackGang
        ? flatChaThreshold
        : Math.max(flatChaThreshold, 0.8 * (m.dex ?? 0)); // Math.max: at least flat floor, then scales with dex

    // Update consecutive-training counters before building the set.
    // Members who have been locked in cha training for too long get one
    // forced crime tick to guarantee they're never permanently stuck.
    const chaTrainExhausted = new Set();
    for (const m of allMembers) {
        const belowThreshold = (m[statKey] ?? 0) < memberChaThreshold(m);
        if (belowThreshold) {
            chaTrainTicksCount[m.name] = (chaTrainTicksCount[m.name] ?? 0) + 1;
            if (chaTrainTicksCount[m.name] > MAX_CONSEC_CHA_TRAIN_TICKS) {
                chaTrainExhausted.add(m.name);
                chaTrainTicksCount[m.name] = 0; // reset so they get one crime tick, then can re-enter
                log(ns, `[cha-dbg] ${m.name}: ${MAX_CONSEC_CHA_TRAIN_TICKS} ticks in cha training, forcing crime tick.`);
            }
        } else {
            chaTrainTicksCount[m.name] = 0; // threshold met, reset
        }
    }

    const chaTrainSet = new Set(
        allMembers
            .filter(m => (m[statKey] ?? 0) < memberChaThreshold(m)
                      && !chaTrainExhausted.has(m.name)) // skip exhausted members
            .sort((a, b) => {
                // Sort by ratio (how far below threshold), most deficient first
                const ratioA = (a[statKey] ?? 0) / memberChaThreshold(a);
                const ratioB = (b[statKey] ?? 0) / memberChaThreshold(b);
                return ratioA - ratioB;
            })
            .slice(0, maxChaTrainers)
            .map(m => m.name)
    );



    // Build a combat training set for members who haven't reached ascension threshold yet.
    // These members need Train Combat to push their stats high enough to ascend.
    // Exclusions to prevent blocking cha training:
    //   - Already in chaTrainSet (cha training takes priority)
    //   - Within min-training-ticks window (already training combat via inTraining path)
    //   - cha_exp is 0 < exp < 3000 (cha training in progress; combat training here
    //     would let them ascend and reset that cha progress to 0 with 0 asc points gained)
    //   - cha/hack stat below training threshold (needs cha/hack training first, not more combat)
    const ascResults = await getGangDict(ns, myGangMembers, 'getAscensionResult');
    const memberInfosForCombat = await getGangDict(ns, myGangMembers, 'getMemberInformation');
    const trainTicks = options['min-training-ticks'] * territoryTickTime;
    // Use same dynamic threshold for combatTrainSet exclusion
    const chaHackThreshold = (m) => isHackGang ? options['hack-threshold'] : memberChaThreshold(m);
    const combatTrainSet = new Set(
        Object.values(dictMembers)
            .filter(m => {
                if (chaTrainSet.has(m.name)) return false; // Already in cha training
                if ((Date.now() - (lastMemberReset[m.name] ?? 0)) < trainTicks) return false; // Already in training window
                if ((m[statKey] ?? 0) < chaHackThreshold(m)) return false; // Needs cha/hack training first
                const chaExp = memberInfosForCombat[m.name]?.cha_exp ?? 0;
                if (chaExp > 0 && chaExp < 3000) return false; // Cha training in progress — don't interrupt
                const result = ascResults[m.name];
                if (!result) return false;
                const info = memberInfosForCombat[m.name];
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
                    const info = memberInfosForCombat[m.name];
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

    // Commit chaTrainSet and combatTrainSet assignments to assignedTasks NOW,
    // before startingGain is computed. Without this, the optimizer sees the
    // current gain (members on crimes) as the baseline, and rates "all training"
    // as gain=0 < baseline -> never updates -> training never starts.
    let trainingChanged = false;
    for (const m of allMembers) {
        if (chaTrainSet.has(m.name) && assignedTasks[m.name] !== trainTaskName) {
            assignedTasks[m.name] = trainTaskName;
            trainingChanged = true;
        } else if (combatTrainSet.has(m.name) && assignedTasks[m.name] !== trainTask()) {
            assignedTasks[m.name] = trainTask();
            trainingChanged = true;
        }
    }
    if (trainingChanged) {
        await updateMemberActivities(ns, dictMembers);
        log(ns, `[gang-dbg] Committed ${[...chaTrainSet].length} cha + ${combatTrainSet.size} combat trainers before optimizing.`);
    }

    // Pre-compute every member × every task rate
    // Members in chaTrainSet are locked to Train Charisma/Hacking
    // Members in combatTrainSet are locked to Train Combat
    const memberTaskRates = Object.fromEntries(
        Object.values(dictMembers).map(m => [m.name,
            chaTrainSet.has(m.name)
                ? [{ name: trainTaskName, respect: 0, money: 0, wanted: 0, both: 0 }]
                : combatTrainSet.has(m.name)
                    ? [{ name: trainTask(), respect: 0, money: 0, wanted: 0, both: 0 }]
                    : allTaskNames.map(t => ({
                    name:    t,
                    respect: computeRespectGain(myGangInfo, t, m),
                    money:   computeMoneyGain(myGangInfo, t, m),
                    wanted:  computeWantedGain(myGangInfo, t, m),
                })).filter(t => t.wanted <= 0 || t.money > 0 || t.respect > 0)
        ])
    );

    // 'both' mode: alternate between pure 'money' and pure 'respect' each territory tick.
    // The old approach computed a combined 'both' score (money/_bothDivisor + respect)
    // and evaluated the shuffle by that score. This was circular: when moneyRate is low,
    // _bothDivisor clamps to 100, Terrorism's respect score dominates every money task's
    // combined score, the optimizer picks all-Terrorism, moneyRate stays low next tick.
    // Tick-alternating runs a clean single-objective optimizer each time — no divisor,
    // no circular dependency, no unit mismatch between sort order and gain evaluation.
    const effectiveStat = optStat === 'both'
        ? (bothIsMoneyTick = !bothIsMoneyTick, bothIsMoneyTick ? 'money' : 'respect')
        : optStat;

    const sortKey = effectiveStat;
    Object.values(memberTaskRates).forEach(tasks =>
        tasks.sort((a, b) => b[sortKey] - a[sortKey]));

    const start = Date.now();
    let bestAssignments = null, bestGain = 0, bestWanted = 0;
    const startingGain = myGangInfo.wantedLevelGainRate > wantedGainTolerance ? 0
        : effectiveStat === 'respect' ? myGangInfo.respectGainRate : myGangInfo.moneyGainRate;
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
                    combatTrainSet.has(c)) return t;
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


    if (bestAssignments && myGangMembers.some(m => assignedTasks[m] !== bestAssignments[m]?.name)) {
        myGangMembers.forEach(m => { if (bestAssignments[m]) assignedTasks[m] = bestAssignments[m].name; });
        const old = myGangInfo;
        await updateMemberActivities(ns, dictMembers);
        myGangInfo = await waitForGameUpdate(ns, old);
        log(ns, `Optimized for ${optStat === 'both' ? 'both/' + effectiveStat : optStat} (${Date.now()-start}ms). ` +
            `Wanted: ${old.wantedLevelGainRate.toPrecision(3)}→${myGangInfo.wantedLevelGainRate.toPrecision(3)}, ` +
            `Rep: ${formatNumberShort(old.respectGainRate)}→${formatNumberShort(myGangInfo.respectGainRate)}, ` +
            `Money: ${formatMoney(old.moneyGainRate)}→${formatMoney(myGangInfo.moneyGainRate)}`);
    } else {
        log(ns, `All ${myGangMembers.length} assignments already optimal for ${optStat === 'both' ? 'both/' + effectiveStat : optStat} (${Date.now()-start}ms).`);
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
 *   result(s)   = sqrt(1 + gain/pts)    — ratio of new mult to old
 *
 * The cost of each 1% gain scales linearly with asc_points:
 *   gain_needed = (threshold² - 1) × pts
 * At 10k pts, 1.07 needs 1,449 exp. At 3M pts, 1.07 needs 434,700 exp.
 * At 3M pts, 1.10 needs 630,000 exp — over an hour of training.
 *
 * Curve:
 *   <1k pts:     1.05   (first ascension — any gain counts)
 *   1k → 100k:   ramps up to 1.08 (building phase, equipment-strip cost matters)
 *   100k → 1M:   1.08 plateau (mature members, healthy balance)
 *   >1M:         decays toward 1.04 (diminishing sqrt returns make each %
 *                exponentially more expensive; frequent small ascensions beat
 *                rare large ones at this scale)
 */
function optimalAscendThreshold(maxAscPoints) {
    if (maxAscPoints < 1000) return 1.05;
    const floor = 1.05, peak = 1.10;
    // Ramp up: 1k → 100k
    if (maxAscPoints <= 100000) {
        const t = (Math.log10(maxAscPoints) - 3) / 2; // 0 at 1k, 1 at 100k
        return floor + (peak - floor) * t;
    }
    // Ramp down: 100k → 2M
    const t = Math.min(1, (Math.log10(maxAscPoints) - 5) / 1.3); // 0 at 100k, 1 at 2M
    return peak - (peak - floor) * t;
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

    const nextRecruitResp = respectForMember(myGangMembers.length);
    let currentRespect = myGangInfo?.respect ?? Infinity;
    const startRespect = currentRespect;
    const MAX_RESPECT_LOSS_FRAC = 0.30;

    const membersByImpact = [...myGangMembers].sort((a, b) =>
        (memberInfos[a]?.earnedRespect ?? 0) - (memberInfos[b]?.earnedRespect ?? 0));

    for (let i = 0; i < membersByImpact.length; i++) {
        const m      = membersByImpact[i];
        const result = ascResults[m];
        const info   = memberInfos[m];
        if (!result) continue;

        const statsList = [...importantStats, 'cha'];
        const maxAscPts = Math.max(
            ...statsList.map(s => info?.[s + '_asc_points'] ?? 0)
        );
        const threshold = optimalAscendThreshold(maxAscPts);

        // ── Gate 1: Does any stat meet the ascension threshold? ──────────
        if (!statsList.some(s => (result[s] ?? 0) >= threshold)) {
            const bestStat = statsList.reduce((best, s) =>
                (result[s] ?? 0) > (result[best] ?? 0) ? s : best, statsList[0]);
            const bestRatio = result[bestStat] ?? 0;
            if (bestRatio > 1.01)
                log(ns, `[asc-dbg] ${m}: best=${bestStat}→×${bestRatio.toFixed(3)}, need=${threshold.toFixed(3)} (pts=${formatNumberShort(maxAscPts)}). Not ready.`);
            continue;
        }

        // ── Gate 2: Cha co-ascension guard (sliding scale) ─────────────
        // At low combat asc_points (<10k), cha and combat train at similar
        // rates. Requiring cha to gain meaningfully each cycle (>1.005)
        // ensures cha mults get built up properly — only costs a few extra
        // ticks per cycle.
        //
        // At high combat asc_points (>20k), combat reaches threshold in 5-7
        // ticks. Cha training at low/mid cha mults still needs 4-7 ticks,
        // meaning the cha requirement pins ascension rate to cha's training
        // speed and wastes the compound growth advantage of high combat mults.
        //
        // Sliding scale:
        //   <10k pts: chaResult >= 1.005  (strict — build cha mults)
        //   10k-20k:  chaResult > 1.001   (any measurable gain, minimal drag)
        //   >20k:     no requirement      (combat compounding is the priority;
        //             cha was built during the <10k phase and gets incidental
        //             gains from chaTrainSet between cycles)
        const chaResult = result?.cha ?? 0;
        let chaFloor;
        if (maxAscPts < 10000)       chaFloor = 1.005;
        else if (maxAscPts < 20000)  chaFloor = 1.001;
        else                         chaFloor = 0; // no requirement
        if (chaFloor > 0 && chaResult < chaFloor) {
            log(ns, `Holding ${m}: cha→×${chaResult.toFixed(3)} < ${chaFloor} (pts=${formatNumberShort(maxAscPts)}). Train cha.`);
            continue;
        }

        const earnedResp = info?.earnedRespect ?? 0;

        // ── Gate 3: Hard respect floor ───────────────────────────────────
        if (earnedResp > 0 && currentRespect - earnedResp < 50) {
            log(ns, `Holding ${m}: would drop respect to ${formatNumberShort(currentRespect - earnedResp)} (below floor 50).`);
            continue;
        }

        // ── Gate 4: Wanted safety ────────────────────────────────────────
        // Don't ascend if the respect drop would push the wanted penalty
        // past the threshold. Prevents the spiral: ascend → penalty bad →
        // everyone to VJ → zero progress.
        if (earnedResp > 0 && myGangInfo.wantedLevel > 1.05) {
            const postRespect = currentRespect - earnedResp;
            const postPenalty = postRespect / (postRespect + myGangInfo.wantedLevel);
            if (postPenalty < 1 - WANTED_PENALTY_THRESH) {
                log(ns, `Holding ${m}: post-ascension penalty would be ${(postPenalty*100).toFixed(1)}% ` +
                    `(respect ${formatNumberShort(currentRespect)}→${formatNumberShort(postRespect)}, ` +
                    `wanted=${myGangInfo.wantedLevel.toFixed(1)}). Wait for wanted to drop.`);
                continue;
            }
        }

        // ── Gate 5: Recruit threshold protection ─────────────────────────
        const alreadyAboveThreshold = currentRespect >= nextRecruitResp;
        if (myGangMembers.length < 12 && alreadyAboveThreshold &&
                currentRespect - earnedResp < nextRecruitResp) {
            log(ns, `Holding ${m}: would drop respect below recruit floor ${formatNumberShort(nextRecruitResp)}.`);
            continue;
        }

        // ── Gate 6: Per-tick cascade limit ───────────────────────────────
        const alreadyLost = startRespect - currentRespect;
        if (startRespect > 1 && alreadyLost / startRespect >= MAX_RESPECT_LOSS_FRAC) {
            log(ns, `[asc-dbg] Deferring ${m}: already lost ${(alreadyLost/startRespect*100).toFixed(1)}% respect this tick.`);
            break;
        }

        // ── All gates passed — ascend ────────────────────────────────────
        const ok = await getNsDataThroughFile(ns,
            `ns.gang.ascendMember(ns.args[0])`, null, [m]);
        if (ok !== undefined) {
            log(ns, `Ascended ${m}: ${statsList.map(s => `${s}→×${(result[s]??1).toFixed(2)}`).join(' ')} ` +
                `(threshold=${threshold.toFixed(3)}, pts=${formatNumberShort(maxAscPts)})`, false, 'success');
            lastMemberReset[m] = Date.now();
            currentRespect -= earnedResp;
        } else {
            log(ns, `ERROR: Ascend failed for ${m}`, false, 'error');
        }
    }
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
    // Use MINIMUM win chance rather than average. Average is misleading when a few
    // weak gangs (power 1-6) inflate the mean while you lose 90% of clashes against
    // the dominant gangs. Since clashes fire proportional to territory held, the big
    // gangs hit you far more often than the small ones — minimum is the right metric.
    const engage = !warfareFinished && lowest >= options['territory-engage-threshold'];
    if (engage !== myGangInfo.territoryWarfareEngaged) {
        log(ns, `${warfareFinished ? 'SUCCESS' : 'INFO'}: Territory warfare → ${engage}. ` +
            `Power: ${formatNumberShort(myGangInfo.power)}. Avg win: ${(avg*100).toFixed(1)}%. ` +
            `Lowest: ${(lowest*100).toFixed(1)}% vs ${lowestName} (threshold: ${(options['territory-engage-threshold']*100).toFixed(0)}%).`,
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
        if (JSON.stringify(latest) !== JSON.stringify(old)) return latest;
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