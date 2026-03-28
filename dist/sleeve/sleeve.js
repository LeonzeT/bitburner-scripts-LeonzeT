import { log, getConfiguration, instanceCount, disableLogs, getActiveSourceFiles, getNsDataThroughFile, runCommand, formatMoney, formatDuration } from '../helpers.js'

const argsSchema = [
    ['min-shock-recovery', 97], // Minimum shock recovery before attempting to train or do crime (Set to 100 to disable, 0 to recover fully)
    ['shock-recovery', 0.05], // Set to a number between 0 and 1 to devote that ratio of time to periodic shock recovery (until shock is at 0)
    ['crime', null], // If specified, sleeves will perform only this crime regardless of stats
    ['homicide-chance-threshold', 0.5], // Sleeves on crime will automatically start homicide once their chance of success exceeds this ratio
    ['disable-gang-homicide-priority', false], // By default, sleeves will do homicide to farm Karma until we're in a gang. Set this flag to disable this priority.
    ['aug-budget', 0.1], // Spend up to this much of current cash on augs per tick (Default is high, because these are permanent for the rest of the BN)
    ['buy-cooldown', 60 * 1000], // Must wait this may milliseconds before buying more augs for a sleeve
    ['min-aug-batch', 20], // Must be able to afford at least this many augs before we pull the trigger (or fewer if buying all remaining augs)
    ['reserve', null], // Reserve this much cash before determining spending budgets (defaults to contents of reserve.txt if not specified)
    ['disable-follow-player', false], // Set to true to disable having Sleeve 0 work for the same faction/company as the player to boost reputation gain rates
    ['disable-training', false], // Set to true to disable having sleeves workout at the gym (costs money)
    ['train-to-strength', 210], // 210 str/def + 140 dex/agi = ~100% Homicide success rate
    ['train-to-defense', 210], // training beyond this gives no karma/s improvement
    ['train-to-dexterity', 140],
    ['train-to-agility', 140],
    ['study-to-hacking', 25], // Sleeves will go to university until they reach this much Hak
    ['study-to-charisma', 25], // Sleeves will go to university until they reach this much Cha
    ['training-reserve', null], // Defaults to global reserve.txt. Can be set to a negative number to allow debt. Sleeves will not train if money is below this amount.
    ['training-cap-seconds', 2 * 60 * 60 /* 2 hours */], // Time since the start of the bitnode after which we will no longer attempt to train sleeves to their target "train-to" settings
    ['disable-spending-hashes-for-gym-upgrades', false], // Set to true to disable spending hashes on gym upgrades when training up sleeves.
    ['disable-spending-hashes-for-study-upgrades', false], // Set to true to disable spending hashes on study upgrades when smarting up sleeves.
    ['enable-bladeburner-team-building', false], // Set to true to have one sleeve support the main sleeve, and another do recruitment. Otherwise, they will just do more "Infiltrate Synthoids"
    ['disable-bladeburner', false], // Set to true to disable having sleeves workout at the gym (costs money)
    ['failed-bladeburner-contract-cooldown', 30 * 60 * 1000], // Default 30 minutes: time to wait after failing a bladeburner contract before we try again
];

const interval = 1000; // Update (tick) this often to check on sleeves and recompute their ideal task
const rerollTime = 61000; // How often we re-roll for each sleeve's chance to be randomly placed on shock recovery
const statusUpdateInterval = 10 * 60 * 1000; // Log sleeve status this often, even if their task hasn't changed
const trainingReserveFile = '/Temp/sleeves-training-reserve.txt';
const works = ['security', 'field', 'hacking']; // When doing faction work, we prioritize physical work since sleeves tend towards having those stats be highest
const trainStats = ['strength', 'defense', 'dexterity', 'agility'];
const trainSmarts = ['hacking', 'charisma'];
const sleeveBbContractNames = ["Tracking", "Bounty Hunter", "Retirement"];
// All crime types in ascending stat/payout order. Used by pickBestCrime to find optimal money/sec.
const allCrimeNames = ["Shoplift", "Rob Store", "Mug", "Larceny", "Deal Drugs", "Bond Forgery",
    "Traffick Arms", "Homicide", "Grand Theft Auto", "Kidnap", "Assassination", "Heist"];

// Hardcoded crime data from game source (Crime.ts / Crimes.ts).
// Used when SF4 (singularity) isn't available. Fields: time (ms), money ($), difficulty.
const CRIME_DATA = {
    Shoplift:           { time: 2e3,   money: 15e3,    difficulty: 1/20,
                          dexterity_success_weight: 1, agility_success_weight: 1 },
    'Rob Store':        { time: 60e3,  money: 400e3,   difficulty: 1/5,
                          hacking_success_weight: 0.5, dexterity_success_weight: 2, agility_success_weight: 1 },
    Mug:                { time: 4e3,   money: 36e3,    difficulty: 1/5,
                          strength_success_weight: 1.5, defense_success_weight: 0.5, dexterity_success_weight: 1.5, agility_success_weight: 0.5 },
    Larceny:            { time: 90e3,  money: 800e3,   difficulty: 1/3,
                          hacking_success_weight: 0.5, dexterity_success_weight: 1, agility_success_weight: 1 },
    'Deal Drugs':       { time: 10e3,  money: 120e3,   difficulty: 1,
                          charisma_success_weight: 3, dexterity_success_weight: 2, agility_success_weight: 1 },
    'Bond Forgery':     { time: 300e3, money: 4.5e6,   difficulty: 1/2,
                          hacking_success_weight: 0.05, dexterity_success_weight: 1.25 },
    'Traffick Arms':    { time: 40e3,  money: 600e3,   difficulty: 2,
                          charisma_success_weight: 1, strength_success_weight: 1, defense_success_weight: 1, dexterity_success_weight: 1, agility_success_weight: 1 },
    Homicide:           { time: 3e3,   money: 45e3,    difficulty: 1,
                          strength_success_weight: 2, defense_success_weight: 2, dexterity_success_weight: 0.5, agility_success_weight: 0.5 },
    'Grand Theft Auto': { time: 80e3,  money: 1.6e6,   difficulty: 8,
                          hacking_success_weight: 1, strength_success_weight: 1, dexterity_success_weight: 4, agility_success_weight: 2, charisma_success_weight: 2 },
    Kidnap:             { time: 120e3, money: 3.6e6,   difficulty: 5,
                          charisma_success_weight: 1, strength_success_weight: 1, dexterity_success_weight: 1, agility_success_weight: 1 },
    Assassination:      { time: 300e3, money: 12e6,    difficulty: 8,
                          strength_success_weight: 1, dexterity_success_weight: 2, agility_success_weight: 1 },
    Heist:              { time: 600e3, money: 120e6,   difficulty: 18,
                          hacking_success_weight: 1, strength_success_weight: 1, defense_success_weight: 1, dexterity_success_weight: 1, agility_success_weight: 1, charisma_success_weight: 1 },
};
const minBbContracts = 2; // There should be this many contracts remaining before sleeves attempt them
const minBbProbability = 0.99; // Player chance should be this high before sleeves attempt contracts
const waitForContractCooldown = 60 * 1000; // 1 minute - Cooldown when contract count or probability gets too low

let cachedCrimeStats, workByFaction; // Cache of crime statistics and which factions support which work
let cachedFactionRep = {}, factionRepCacheExpiry = 0; // Cache of faction rep for sleeve assignment prioritization
let assignedFactions; // Track which factions are already assigned to a sleeve this loop (prevents duplicates)
let noWorkFactions; // Factions that support none of the 3 work types (e.g. Bladeburners, Church of the Machine God, Shadows of Anarchy). Populated at runtime when all work types fail; persists across loops so we never retry them.
let assignedContracts; // Track which bladeburner contract types are assigned this loop
let assignedBbSupport, assignedBbRecruit; // Track bladeburner support/recruit assignment
let task, lastStatusUpdateTime, lastPurchaseTime, lastPurchaseStatusUpdate, availableAugs, cacheExpiry,
    shockChance, lastRerollTime, bladeburnerCooldown, lastSleeveHp, lastSleeveShock; // State by sleeve
let numSleeves, ownedSourceFiles, playerInGang, playerInBladeburner, bladeburnerCityChaos, bladeburnerContractChances, bladeburnerContractCounts, followPlayerSleeve;
let gangFaction = ''; // Cached gang faction name — rep for this faction is earned passively by the gang
let daedalusJoined = false; // Whether player has joined Daedalus faction
let trpInstalled = false; // Whether The Red Pill augmentation is installed
let isBN8 = false; // CrimeMoney=0 in this BN — crime earns nothing
let xpCycleActive = false; // autopilot XP cycle is grinding/money phase

// Factions with the best hacking_exp augs that are accessible early.
// When the XP cycle is active, sleeves prioritise these over the lowest-rep faction.
// Chongqing: Neuregen 1.4× (exclusive) + Neuralstimulator 1.12×
// NiteSec:   NeuralRetentionEnhancement 1.25× + CRTX42AA 1.15× + Neurotrainer2 1.15×
// BitRunners: Neurolink 1.20× + NeuralAccelerator 1.15× + ENMCore 1.15×
// The Black Hand: ENMCore 1.15× + EnhancedMyelinSheathing 1.10×
const XP_FACTIONS = new Set(['Chongqing', 'NiteSec', 'BitRunners', 'The Black Hand']);
let options;

export function autocomplete(data, _) {
    data.flags(argsSchema);
    return [];
}

/** @param {NS} ns **/
export async function main(ns) {
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    options = runOptions; // We don't set the global "options" until we're sure this is the only running instance
    disableLogs(ns, ['getServerMoneyAvailable']);
    // Ensure the global state is reset (e.g. after entering a new bitnode)
    task = [], lastStatusUpdateTime = [], lastPurchaseTime = [], lastPurchaseStatusUpdate = [], availableAugs = [],
        cacheExpiry = [], shockChance = [], lastRerollTime = [], bladeburnerCooldown = [], lastSleeveHp = [], lastSleeveShock = [];
    workByFaction = {}, cachedCrimeStats = {}, cachedFactionRep = {}, factionRepCacheExpiry = 0;
    assignedFactions = new Set();
    noWorkFactions = new Set(); // persists across loops — never cleared until script restarts
    assignedContracts = new Set();
    assignedBbSupport = false; assignedBbRecruit = false;
    playerInGang = playerInBladeburner = false;
    gangFaction = '';
    // Ensure we have access to sleeves
    ownedSourceFiles = await getActiveSourceFiles(ns);
    if (!(10 in ownedSourceFiles))
        return ns.tprint("WARNING: You cannot run sleeve.js until you do BN10.");
    // Start the main loop
    while (true) {
        try { await mainLoop(ns); }
        catch (err) {
            log(ns, `WARNING: sleeve.js Caught (and suppressed) an unexpected error in the main loop:\n` +
                (err?.stack || '') + (typeof err === 'string' ? err : err.message || JSON.stringify(err)), false, 'warning');
        }
        await ns.sleep(interval);
    }
}

/** @param {NS} ns
 * Purchases augmentations for sleeves */
async function manageSleeveAugs(ns, i, budget) {
    // Retrieve and cache the set of available sleeve augs (cached temporarily, but not forever, in case rules around this change)
    if (availableAugs[i] == null || Date.now() > cacheExpiry[i]) {
        cacheExpiry[i] = Date.now() + 60000;
        availableAugs[i] = (await getNsDataThroughFile(ns, `ns.sleeve.getSleevePurchasableAugs(ns.args[0])`,  // list of { name, cost }
            null, [i])).sort((a, b) => a.cost - b.cost);
    }
    if (availableAugs[i].length == 0) return 0;

    const cooldownLeft = Math.max(0, options['buy-cooldown'] - (Date.now() - (lastPurchaseTime[i] || 0)));
    const [batchCount, batchCost] = availableAugs[i].reduce(([n, c], aug) => c + aug.cost <= budget ? [n + 1, c + aug.cost] : [n, c], [0, 0]);
    // Dynamic batch threshold: buy when we can afford a meaningful fraction of remaining augs.
    // Original min-aug-batch=20 is designed for late-game bulk buying with huge cash reserves.
    // In BN10 or early game, income is low and augs are cheap — waiting for 20 wastes time.
    // Use: max(3, min(minAugBatch, 50% of remaining)) — so with 8 remaining, threshold is 4.
    const effectiveBatchMin = Math.max(3, Math.min(options['min-aug-batch'],
        Math.ceil(availableAugs[i].length * 0.5)));
    const purchaseUpdate = `sleeve ${i} can afford ${batchCount.toFixed(0).padStart(2)}/${availableAugs[i].length.toFixed(0).padEnd(2)} remaining augs ` +
        `(cost ${formatMoney(batchCost)} of ${formatMoney(availableAugs[i].reduce((t, aug) => t + aug.cost, 0))}).`;
    if (lastPurchaseStatusUpdate[i] != purchaseUpdate)
        log(ns, `INFO: With budget ${formatMoney(budget)}, ${(lastPurchaseStatusUpdate[i] = purchaseUpdate)} ` +
            `(Min batch size: ${effectiveBatchMin}, Cooldown: ${formatDuration(cooldownLeft)})`);
    if (cooldownLeft == 0 && batchCount > 0 && ((batchCount >= availableAugs[i].length - 1) || batchCount >= effectiveBatchMin)) {
        let strAction = `Purchase ${batchCount}/${availableAugs[i].length} augmentations for sleeve ${i} at total cost of ${formatMoney(batchCost)}`;
        let toPurchase = availableAugs[i].splice(0, batchCount);
        if (await getNsDataThroughFile(ns, `ns.args.slice(1).reduce((s, aug) => s && ns.sleeve.purchaseSleeveAug(ns.args[0], aug), true)`,
            '/Temp/sleeve-purchase.txt', [i, ...toPurchase.map(a => a.name)])) {
            log(ns, `SUCCESS: ${strAction}`, true, 'success');
            [lastSleeveHp[i], lastSleeveShock[i]] = [undefined, undefined]; // Sleeve stats are reset on installation of augs, so forget saved health info
        } else log(ns, `ERROR: Failed to ${strAction}`, true, 'error');
        lastPurchaseTime[i] = Date.now();
        return batchCost; // Even if we think we failed, return the predicted cost so if the purchase did go through, we don't end up over-budget
    }
    return 0;
}

/** @param {NS} ns
 * @returns {Promise<Player>} the result of ns.getPlayer() */
async function getPlayerInfo(ns) {
    return await getNsDataThroughFile(ns, `ns.getPlayer()`);
}

/** @param {NS} ns
 * @returns {Promise<Task>} */
async function getCurrentWorkInfo(ns) {
    return (await getNsDataThroughFile(ns, 'ns.singularity.getCurrentWork()')) ?? {};
}

/** @param {NS} ns
 * @param {number} numSleeves
 * @returns {Promise<SleevePerson[]>} */
async function getAllSleeves(ns, numSleeves) {
    return await getNsDataThroughFile(ns, `ns.args.map(i => ns.sleeve.getSleeve(i))`,
        `/Temp/sleeve-getSleeve-all.txt`, [...Array(numSleeves).keys()]);
}

/** @param {NS} ns
 * Main loop that gathers data, checks on all sleeves, and manages them. */
async function mainLoop(ns) {
    // Update info
    numSleeves = await getNsDataThroughFile(ns, `ns.sleeve.getNumSleeves()`);
    const playerInfo = await getPlayerInfo(ns);
    // If we have not yet detected that we are in bladeburner, do that now (unless disabled)
    if (!options['disable-bladeburner'] && !playerInBladeburner)
        playerInBladeburner = await getNsDataThroughFile(ns, 'ns.bladeburner.inBladeburner()');
    const playerWorkInfo = await getCurrentWorkInfo(ns);
    if (!playerInGang) playerInGang = !(2 in ownedSourceFiles) ? false : await getNsDataThroughFile(ns, 'ns.gang.inGang()');
    // Cache the gang faction name once — sleeves should skip working for this faction
    // since the gang already generates rep for it passively.
    if (playerInGang && !gangFaction) {
        try {
            const gangInfo = await getNsDataThroughFile(ns, 'ns.gang.getGangInformation()');
            gangFaction = gangInfo?.faction ?? '';
        } catch { gangFaction = ''; }
    }
    let globalReserve = Number(ns.read("reserve.txt") || 0);
    let budget = (playerInfo.money - (options['reserve'] || globalReserve)) * options['aug-budget'];
    // Estimate the cost of sleeves training over the next time interval to see if (ignoring income) we would drop below our reserve.
    const costByNextLoop = interval / 1000 * task.filter(t => t.startsWith("train")).length * 12000; // TODO: Training cost/sec seems to be a bug. Should be 1/5 this ($2400/sec)
    // Get time in current bitnode (to cap how long we'll train sleeves)
    const resetInfo = await getNsDataThroughFile(ns, 'ns.getResetInfo()');
    const timeInBitnode = Date.now() - resetInfo.lastNodeReset;
    const isBN10 = resetInfo.currentNode === 10;
    // Use multiplier check so this works in any future BN where crime earns nothing,
    // not just BN8. Read from the shared BN multipliers cache (free ns.read).
    try {
        const bnRaw = ns.read('/Temp/bitNode-multipliers.txt');
        const bnMults = bnRaw && bnRaw !== '' ? JSON.parse(bnRaw) : {};
        isBN8 = (bnMults.CrimeMoney ?? 1) === 0;
    } catch { isBN8 = resetInfo.currentNode === 8; } // fallback to BN check
    // Read autopilot's XP cycle flag — 'grinding' or 'money' means active, '' means idle.
    try { xpCycleActive = (ns.read('/Temp/xp-grind-active.txt') || '').trim() !== ''; }
    catch { xpCycleActive = false; }
    // Detect Daedalus membership and TRP installation for sleeve priority overrides.
    // In BN8, FavorToDonateToFaction=0 so donation is always available — Daedalus rep
    // grinding via sleeves is extremely valuable once joined.
    daedalusJoined = playerInfo.factions?.includes('Daedalus') ?? false;
    // TRP installed = we only need hack level for w0r1d_d43m0n → sleeves should study hacking
    trpInstalled = false;
    try {
        const wdHackRaw = ns.read('/Temp/wd-hackingLevel.txt');
        if (wdHackRaw && wdHackRaw !== '' && wdHackRaw !== 'null') {
            const wdHack = JSON.parse(wdHackRaw);
            trpInstalled = wdHack > 0 && Number.isFinite(wdHack);
        }
    } catch {}
    // Fallback: check installed augs list if available
    if (!trpInstalled) {
        try {
            const raw = ns.read('/Temp/player-augs-installed.txt');
            if (raw && raw !== '') trpInstalled = JSON.parse(raw).includes('The Red Pill');
        } catch {}
    }
    // BN10 is the sleeve BitNode — training is the primary progression path, so extend the cap.
    const effectiveTrainingCap = isBN10
        ? Math.max(options['training-cap-seconds'], 24 * 60 * 60) * 1000  // min 24h in BN10
        : options['training-cap-seconds'] * 1000;
    let canTrain = !options['disable-training'] &&
        // To avoid training forever when mults are crippling, stop training if we've been in the bitnode a certain amount of time
        (effectiveTrainingCap > timeInBitnode) &&
        // Don't train if we have no money (unless player has given permission to train into debt)
        (playerInfo.money - costByNextLoop) > (options['training-reserve'] ||
            (promptedForTrainingBudget ? ns.read(trainingReserveFile) : undefined) || globalReserve);
    // If any sleeve is training at the gym, see if we can purchase a gym upgrade to help them
    if (canTrain && task.some(t => t?.startsWith("train")) && !options['disable-spending-hashes-for-gym-upgrades'])
        if (await getNsDataThroughFile(ns, 'ns.hacknet.spendHashes("Improve Gym Training")', '/Temp/spend-hashes-on-gym.txt'))
            log(ns, `SUCCESS: Bought "Improve Gym Training" to speed up Sleeve training.`, false, 'success');
    if (canTrain && task.some(t => t?.startsWith("study")) && !options['disable-spending-hashes-for-study-upgrades'])
        if (await getNsDataThroughFile(ns, 'ns.hacknet.spendHashes("Improve Studying")', '/Temp/spend-hashes-on-study.txt'))
            log(ns, `SUCCESS: Bought "Improve Studying" to speed up Sleeve studying.`, false, 'success');
    if (playerInBladeburner && (7 in ownedSourceFiles)) {
        const bladeburnerCity = await getNsDataThroughFile(ns, `ns.bladeburner.getCity()`);
        bladeburnerCityChaos = await getNsDataThroughFile(ns, `ns.bladeburner.getCityChaos(ns.args[0])`, null, [bladeburnerCity]);
        bladeburnerContractChances = await getNsDataThroughFile(ns,
            // There is currently no way to get sleeve chance, so assume it is the same as player chance for now. (EDIT: This is a terrible assumption)
            'Object.fromEntries(ns.args.map(c => [c, ns.bladeburner.getActionEstimatedSuccessChance("Contracts", c)[0]]))',
            '/Temp/sleeve-bladeburner-success-chances.txt', sleeveBbContractNames);
        bladeburnerContractCounts = await getNsDataThroughFile(ns,
            'Object.fromEntries(ns.args.map(c => [c, ns.bladeburner.getActionCountRemaining("Contracts", c)]))',
            '/Temp/sleeve-bladeburner-contract-counts.txt', sleeveBbContractNames);
    } else
        bladeburnerCityChaos = 0, bladeburnerContractChances = {}, bladeburnerContractCounts = {};

    // Update all sleeve information and loop over all sleeves to do some individual checks and task assignments
    let sleeveInfo = await getAllSleeves(ns, numSleeves);

    // If not disabled, set the "follow player" sleeve to be the first sleeve with 0 shock
    followPlayerSleeve = options['disable-follow-player'] ? -1 : undefined;
    for (let i = 0; i < numSleeves; i++) // Hack below: Prioritize sleeves doing bladeburner contracts, don't have them follow player
        if (sleeveInfo[i].shock == 0 && (i === 0 || i > 3 || !playerInBladeburner))
            followPlayerSleeve ??= i; // Skips assignment if previously assigned
    followPlayerSleeve ??= 0; // If all have shock, use the first sleeve

    // Reset per-loop faction and bladeburner tracking
    assignedFactions = new Set();
    assignedContracts = new Set();
    assignedBbSupport = false; assignedBbRecruit = false;
    // Pre-mark the follow-player faction so other sleeves don't duplicate it
    if (followPlayerSleeve >= 0 && playerWorkInfo.type === 'FACTION')
        assignedFactions.add(playerWorkInfo.factionName);

    for (let i = 0; i < numSleeves; i++) {
        let sleeve = sleeveInfo[i]; // For convenience, merge all sleeve stats/info into one object
        // Manage sleeve augmentations (if available)
        if (sleeve.shock == 0) // No augs are available augs until shock is 0
            budget -= await manageSleeveAugs(ns, i, budget);

        // Decide what we think the sleeve should be doing for the next little while
        let [designatedTask, command, args, statusUpdate] =
            await pickSleeveTask(ns, playerInfo, playerWorkInfo, i, sleeve, canTrain, isBN10);

        // After picking sleeve tasks, take a note of the sleeve's health at the end of the prior loop so we can detect failures
        [lastSleeveHp[i], lastSleeveShock[i]] = [sleeve.hp.current, sleeve.shock];

        // Set the sleeve's new task if it's not the same as what they're already doing.
        let assignSuccess = undefined;
        if (task[i] != designatedTask)
            assignSuccess = await setSleeveTask(ns, i, designatedTask, command, args);

        // For certain tasks, log a periodic status update.
        if (statusUpdate && (assignSuccess === true || (
            assignSuccess === undefined && (Date.now() - (lastStatusUpdateTime[i] ?? 0)) > statusUpdateInterval))) {
            log(ns, `INFO: Sleeve ${i} is ${assignSuccess === undefined ? '(still) ' : ''}${statusUpdate} `);
            lastStatusUpdateTime[i] = Date.now();
        }
    }
}

/** Picks the best task for a sleeve, and returns the information to assign and give status updates for that task.
 * @param {NS} ns
 * @param {Player} playerInfo
 * @param {{ type: "COMPANY"|"FACTION"|"CLASS"|"CRIME", cyclesWorked: number, crimeType: string, classType: string, location: string, companyName: string, factionName: string, factionWorkType: string }} playerWorkInfo
 * @param {SleevePerson} sleeve
 * @returns {Promise<[string, string, any[], string]>} a 4-tuple of task name, command, args, and status message */
/**
 * When the XP cycle is active, return a sorted version of availFactions that puts
 * XP_FACTIONS first. Within each group (XP / non-XP), order is preserved.
 * Returns the original array unchanged when the XP cycle is not active.
 */
function sortFactionsForXpCycle(availFactions) {
    if (!xpCycleActive) return availFactions;
    const xpFirst = availFactions.filter(f => XP_FACTIONS.has(f));
    const rest    = availFactions.filter(f => !XP_FACTIONS.has(f));
    return xpFirst.concat(rest);
}

/** Extract the faction name from a task string like "work for faction 'BitRunners' (security)".
 * Returns null if the task is not a faction-work task. */
function currentFactionFromTask(taskStr) {
    if (!taskStr) return null;
    const m = taskStr.match(/^work for faction '(.+?)'/);
    return m ? m[1] : null;
}

async function pickSleeveTask(ns, playerInfo, playerWorkInfo, i, sleeve, canTrain, isBN10 = false) {
    // Initialize sleeve dicts on first loop
    if (lastSleeveHp[i] === undefined) lastSleeveHp[i] = sleeve.hp.current;
    if (lastSleeveShock[i] === undefined) lastSleeveShock[i] = sleeve.shock;
    // Must synchronize first iif you haven't maxed memory on every sleeve
    if (sleeve.sync < 100)
        return ["synchronize", `ns.sleeve.setToSynchronize(ns.args[0])`, [i], `syncing... ${sleeve.sync.toFixed(2)}%`];
    // Opt to do shock recovery if above the --min-shock-recovery threshold
    if (sleeve.shock > 0 && sleeve.shock <= options['min-shock-recovery'])
        return shockRecoveryTask(sleeve, i, `shock is above ${options['min-shock-recovery'].toFixed(0)}% (--min-shock-recovery)`);
    // To time-balance between being useful and recovering from shock more quickly - sleeves have a random chance to be put
    // on shock recovery. To avoid frequently interrupting tasks that take a while to complete, only re-roll every so often.
    if (sleeve.shock > 0 && options['shock-recovery'] > 0) {
        if (Date.now() - (lastRerollTime[i] || 0) >= rerollTime) {
            shockChance[i] = Math.random();
            lastRerollTime[i] = Date.now();
        }
        if (shockChance[i] < options['shock-recovery'])
            return shockRecoveryTask(sleeve, i, `there is a ${(options['shock-recovery'] * 100).toFixed(1)}% chance (--shock-recovery) of picking this task every minute until fully recovered.`);
    }
    // BN10 is the sleeve BN — training targets scale up so sleeves become more capable.
    // BUT: sleeves with high stat multipliers (from augmentations) reach effective combat
    // levels much faster and don't need the full 3x overtraining. A sleeve with 5.87x str
    // mult reaches str=210 in the same time a bare sleeve reaches str=36.
    // Scale: target = base × max(1, 3 / statMult). With 5.87x: max(1, 3/5.87) = 1 → base target.
    // With 1x mults: max(1, 3/1) = 3 → full BN10 target. Smooth scaling in between.
    const getTrainTarget = (stat) => {
        const base = options[`train-to-${stat}`];
        if (!isBN10) return base;
        const statMult = sleeve.mults?.[stat] ?? 1;
        return Math.ceil(base * Math.max(1, 3 / statMult));
    };
    const getStudyTarget = (smart) => {
        const base = options[`study-to-${smart}`];
        if (!isBN10) return base;
        const smartMult = sleeve.mults?.[smart] ?? 1;
        return Math.ceil(base * Math.max(1, 3 / smartMult));
    };
    // Train if our sleeve's physical stats aren't where we want them
    if (canTrain) {
        const univClasses = {
            "hacking": ns.enums.UniversityClassType.algorithms,
            "charisma": ns.enums.UniversityClassType.leadership
        };
        let untrainedStats = trainStats.filter(stat => sleeve.skills[stat] < getTrainTarget(stat));
        let untrainedSmarts = trainSmarts.filter(smart => sleeve.skills[smart] < getStudyTarget(smart));

        // prioritize physical training
        if (untrainedStats.length > 0) {
            if (playerInfo.money < 5E6 && !promptedForTrainingBudget)
                await promptForTrainingBudget(ns); // If we've never checked, see if we can train into debt.
            if (sleeve.city != ns.enums.CityName.Sector12) {
                log(ns, `Moving Sleeve ${i} from ${sleeve.city} to Sector-12 to train at Powerhouse Gym.`);
                const gymTravelled = await getNsDataThroughFile(ns, 'ns.sleeve.travel(ns.args[0], ns.args[1])', null, [i, ns.enums.CityName.Sector12]);
                if (!gymTravelled) {
                    log(ns, `INFO: Sleeve ${i} could not travel to Sector-12 for gym (need $200K). Will crime instead.`);
                    const crime = await pickBestCrime(ns, sleeve);
                    return await crimeTask(ns, crime, i, sleeve, `cannot afford $200K travel to Sector-12 for gym`);
                }
            }
            var trainStat = untrainedStats.reduce((min, s) => sleeve.skills[s] < sleeve.skills[min] ? s : min, untrainedStats[0]);
            var gym = ns.enums.LocationName.Sector12PowerhouseGym;
            return [
                `train ${trainStat} (${gym})`,
                `ns.sleeve.setToGymWorkout(ns.args[0], ns.args[1], ns.args[2])`,
                [i, gym, trainStat.slice(0, 3)], // Gym expects the short form stat names ('str', 'def', 'dex', 'agi')
                `training ${trainStat}... ${sleeve.skills[trainStat]}/${getTrainTarget(trainStat)}`
            ];
            // if we're tough enough, flip over to studying to improve the mental stats
        } else if (untrainedSmarts.length > 0) {
            if (playerInfo.money < 5E6 && !promptedForTrainingBudget)
                await promptForTrainingBudget(ns); // check we can go into training debt
            if (sleeve.city != ns.enums.CityName.Volhaven) {
                log(ns, `Moving Sleeve ${i} from ${sleeve.city} to Volhaven to study at ZB Institute of Technology.`);
                const studyTravelled = await getNsDataThroughFile(ns, 'ns.sleeve.travel(ns.args[0], ns.args[1])', null, [i, ns.enums.CityName.Volhaven]);
                if (!studyTravelled) {
                    log(ns, `INFO: Sleeve ${i} could not travel to Volhaven for study (need $200K). Will crime instead.`);
                    const crime = await pickBestCrime(ns, sleeve);
                    return await crimeTask(ns, crime, i, sleeve, `cannot afford $200K travel to Volhaven for study`);
                }
            }
            var trainSmart = untrainedSmarts.reduce((min, s) => sleeve.skills[s] < sleeve.skills[min] ? s : min, untrainedSmarts[0]);
            var univ = ns.enums.LocationName.VolhavenZBInstituteOfTechnology;
            var course = univClasses[trainSmart];
            return [
                `study ${trainSmart} (${univ})`,
                `ns.sleeve.setToUniversityCourse(ns.args[0], ns.args[1], ns.args[2])`,
                [i, univ, course],
                `studying ${trainSmart}... ${sleeve.skills[trainSmart]}/${getStudyTarget(trainSmart)}`
            ];
        }
    }
    // ── Daedalus / TRP priority overrides ────────────────────────────────────
    // When TRP is installed, the ONLY remaining goal is hack level for w0r1d_d43m0n.
    // All sleeves should study hacking at a university to contribute hack XP.
    // BUT: studying costs money — respect canTrain so we don't drain funds needed
    // for crack programs or other purchases.
    if (trpInstalled && canTrain) {
        if (sleeve.city != ns.enums.CityName.Volhaven) {
            const trpTravelled = await getNsDataThroughFile(ns, 'ns.sleeve.travel(ns.args[0], ns.args[1])', null, [i, ns.enums.CityName.Volhaven]);
            if (!trpTravelled) {
                log(ns, `INFO: Sleeve ${i} could not travel to Volhaven for TRP hacking study (need $200K). Will crime instead.`);
                const crime = await pickBestCrime(ns, sleeve);
                return await crimeTask(ns, crime, i, sleeve, `cannot afford $200K travel to Volhaven for TRP study`);
            }
        }
        return [
            `study hacking (TRP push)`,
            `ns.sleeve.setToUniversityCourse(ns.args[0], ns.args[1], ns.args[2])`,
            [i, ns.enums.LocationName.VolhavenZBInstituteOfTechnology, ns.enums.UniversityClassType.algorithms],
            `studying hacking to reach w0r1d_d43m0n requirement`
        ];
    }
    // If TRP is installed but we can't afford study, fall through to
    // faction work / crime / BN8 fallback blocks below.
    // When Daedalus is joined but TRP isn't installed yet, grind Daedalus rep.
    // In BN8 this is especially valuable: FavorToDonateToFaction=0 means donation
    // is always available, so every point of rep = immediate aug purchasing power.
    // Only assign sleeves not already on Daedalus (one per faction limit).
    if (daedalusJoined && !assignedFactions.has('Daedalus')) {
        assignedFactions.add('Daedalus');
        return [
            `work for faction 'Daedalus' (hacking)`,
            `ns.sleeve.setToFactionWork(ns.args[0], ns.args[1], ns.args[2])`,
            [i, 'Daedalus', 'hacking'],
            `grinding Daedalus rep to afford The Red Pill`
        ];
    }
    // If player is currently working for faction or company rep, a sleeve can help him out (Note: Only one sleeve can work for a faction)
    // Skip if the faction is the gang's own faction — gang already earns rep for it passively.
    if (i == followPlayerSleeve && playerWorkInfo.type == "FACTION" && playerWorkInfo.factionName !== gangFaction) {
        // TODO: We should be able to borrow logic from work-for-factions.js to have more sleeves work for useful factions / companies
        // We'll cycle through work types until we find one that is supported. TODO: Auto-determine the most productive faction work to do.
        const faction = playerWorkInfo.factionName;
        const work = works[workByFaction[faction] || 0];
        assignedFactions.add(faction); // Mark so other sleeves pick different factions
        return [
            `work for faction '${faction}' (${work})`,
            `ns.sleeve.setToFactionWork(ns.args[0], ns.args[1], ns.args[2])`,
            [i, faction, work],
            `helping earn rep with faction ${faction} by doing ${work} work.`
        ];
    } // Same as above if player is currently working for a megacorp
    if (i == followPlayerSleeve && playerWorkInfo.type == "COMPANY" && !playerInGang) {
        const companyName = playerWorkInfo.companyName;
        return [
            `work for company '${companyName}'`,
            `ns.sleeve.setToCompanyWork(ns.args[0], ns.args[1])`,
            [i, companyName],
            `helping earn rep with company ${companyName}.`
        ];
    }
    // Multi-faction sleeve assignment: when player is NOT in a gang, assign spare sleeves
    // to different joined factions to build rep. When gang IS active, skip this — the gang
    // produces passive faction rep for its own faction (which has most augs), and sleeves
    // earn more value doing crime for money than grinding minor faction rep.
    // The follow-player sleeve still helps with the player's explicit faction work above.
    if (i != followPlayerSleeve && !playerInGang && playerInfo.factions && playerInfo.factions.length > 0) {
        const availFactions = playerInfo.factions.filter(f => !assignedFactions.has(f) && f !== gangFaction && !noWorkFactions.has(f));
        if (availFactions.length > 0) {
            // Prefer the faction this sleeve is already working for if it's still valid.
            // This prevents swap-deadlocks: if sleeve 1 is on BitRunners and sleeve 2 is on
            // Tetrads, the rep-sort might try to swap them. The game blocks each move because
            // the other sleeve is already there, causing both to fail every tick. Staying put
            // is always safe — the rep gap between factions is rarely large enough to matter.
            const currentFaction = currentFactionFromTask(task[i]);
            let faction;
            // When XP cycle is active, prefer XP factions over the stability heuristic
            // UNLESS the sleeve is already on an XP faction (keep it there — no swap).
            const currentIsXp = currentFaction && XP_FACTIONS.has(currentFaction);
            const xpAvail = availFactions.filter(f => XP_FACTIONS.has(f));
            if (xpCycleActive && xpAvail.length > 0 && !currentIsXp) {
                // Assign to an XP faction, preferring one with the lowest rep (most to gain).
                const factionReps = await getFactionReps(ns, playerInfo.factions);
                xpAvail.sort((a, b) => (factionReps[a] ?? 0) - (factionReps[b] ?? 0));
                faction = xpAvail[0];
            } else if (currentFaction && availFactions.includes(currentFaction)) {
                faction = currentFaction; // already there — stable, no API call needed
            } else {
                // No current valid faction — pick lowest rep (general case).
                const factionReps = await getFactionReps(ns, playerInfo.factions);
                const sorted = sortFactionsForXpCycle(availFactions);
                sorted.sort((a, b) => {
                    // Within XP group and within non-XP group, sort by rep ascending.
                    // sortFactionsForXpCycle already put XP factions first, so
                    // a stable sort here preserves that group ordering.
                    const aXp = XP_FACTIONS.has(a), bXp = XP_FACTIONS.has(b);
                    if (aXp !== bXp) return aXp ? -1 : 1; // XP first
                    return (factionReps[a] ?? 0) - (factionReps[b] ?? 0);
                });
                faction = sorted[0];
            }
            const work = works[workByFaction[faction] || 0];
            assignedFactions.add(faction);
            return [
                `work for faction '${faction}' (${work})`,
                `ns.sleeve.setToFactionWork(ns.args[0], ns.args[1], ns.args[2])`,
                [i, faction, work],
                `helping earn rep with faction ${faction} by doing ${work} work.`
            ];
        }
    }

    // If gangs are available, prioritize homicide until we've got the requisite -54K karma to unlock them
    if (!playerInGang && !options['disable-gang-homicide-priority'] && (2 in ownedSourceFiles) && ns.heart.break() > -54000)
        return await crimeTask(ns, 'Homicide', i, sleeve, 'we want gang karma'); // Ignore chance - even a failed homicide generates more Karma than every other crime
    // If the player is in bladeburner, and has already unlocked gangs with Karma, generate contracts and operations
    if (playerInBladeburner) {
        // Stat-aware bladeburner task assignment: pick based on sleeve combat power, not index.
        // Contracts require high stats (can fail → HP/shock loss). Infiltrate/Diplomacy are safe.
        // Each contract type can only be performed by one sleeve at a time.
        const combatPower = sleeve.skills.strength + sleeve.skills.defense +
            sleeve.skills.dexterity + sleeve.skills.agility;

        let action, contractName;
        if (combatPower >= 800 && !assignedContracts.has('Retirement')) {
            [action, contractName] = ["Take on contracts", "Retirement"];
            assignedContracts.add('Retirement');
        } else if (combatPower >= 600 && !assignedContracts.has('Bounty Hunter')) {
            [action, contractName] = ["Take on contracts", "Bounty Hunter"];
            assignedContracts.add('Bounty Hunter');
        } else if (combatPower >= 400 && !assignedContracts.has('Tracking')) {
            [action, contractName] = ["Take on contracts", "Tracking"];
            assignedContracts.add('Tracking');
        } else if (options['enable-bladeburner-team-building'] && !assignedBbSupport) {
            [action, contractName] = ["Support main sleeve"];
            assignedBbSupport = true;
        } else if (options['enable-bladeburner-team-building'] && !assignedBbRecruit) {
            [action, contractName] = ["Recruitment"];
            assignedBbRecruit = true;
        } else {
            // Low-stat sleeves or all contracts taken: safe fallback
            [action, contractName] = ["Infiltrate Synthoids"];
        }

        const contractChance = bladeburnerContractChances[contractName] ?? 1;
        const contractCount = bladeburnerContractCounts[contractName] ?? Infinity;
        const onCooldown = () => Date.now() <= bladeburnerCooldown[i]; // Function to check if we're on cooldown
        // Detect if the sleeve recently failed the task. If so, put them on a "cooldown" before trying again
        if (sleeve.hp.current < lastSleeveHp[i] || sleeve.shock > lastSleeveShock[i]) {
            bladeburnerCooldown[i] = Date.now() + options['failed-bladeburner-contract-cooldown'];
            log(ns, `Sleeve ${i} appears to have recently failed its designated bladeburner task '${action} - ${contractName}' ` +
                `(HP ${lastSleeveHp[i].toFixed(1)} -> ${sleeve.hp.current.toFixed(1)}, ` +
                `Shock: ${lastSleeveShock[i].toFixed(2)} -> ${sleeve.shock.toFixed(2)}). ` +
                `Will try again in ${formatDuration(options['failed-bladeburner-contract-cooldown'])}`);
        } // If the contract success chance appears too low, or there are insufficient contracts remaining, smaller cooldown
        else if (!onCooldown() && (contractChance <= minBbProbability || contractCount < minBbContracts)) {
            bladeburnerCooldown[i] = Date.now() + waitForContractCooldown;
            log(ns, `Delaying sleeve ${i} designated bladeburner task '${action} - ${contractName}' - ` +
                (contractCount < minBbContracts ? `Insufficient contract count (${contractCount} < ${minBbContracts})` :
                    `Player chance is too low (${(contractChance * 100).toFixed(2)}% < ${(minBbProbability * 100)}%). `) +
                `Will try again in ${formatDuration(waitForContractCooldown)}`);
        }
        // As current city chaos gets progressively bad, assign more and more sleeves to Diplomacy to help get it under control
        if (bladeburnerCityChaos > (10 - i) * 10) // Later sleeves are first to get assigned, sleeve 0 is last at 100 chaos.
            [action, contractName] = ["Diplomacy"];
        // If the sleeve is on cooldown ,do not perform their designated bladeburner task
        else if (onCooldown()) { // When on cooldown from a failed task, recover shock if applicable, or else add contracts
            if (sleeve.shock > 0) return shockRecoveryTask(sleeve, i, `bladeburner task is on cooldown`);
            [action, contractName] = ["Infiltrate Synthoids"]; // Fall-back to something long-term useful
        }
        return [`Bladeburner ${action} ${contractName || ''}`.trimEnd(),
        /*   */ `ns.sleeve.setToBladeburnerAction(ns.args[0], ns.args[1], ns.args[2])`, [i, action, contractName ?? ''],
        /*   */ `doing ${action}${contractName ? ` - ${contractName}` : ''} in Bladeburner.`];
    }
    // If there's nothing more productive to do (above) and there's still shock, prioritize recovery
    if (sleeve.shock > 0)
        return shockRecoveryTask(sleeve, i, `there appears to be nothing better to do`);
    // In BN8, CrimeMoney=0 — crime earns nothing. Use remaining sleeves for faction rep
    // (especially useful since FavorToDonateToFaction=0 means any faction accepts donations).
    if (isBN8 && playerInfo.factions && playerInfo.factions.length > 0) {
        const availFactions = playerInfo.factions.filter(f => !assignedFactions.has(f) && f !== gangFaction && !noWorkFactions.has(f));
        if (availFactions.length > 0) {
            // Same logic as main block: XP factions take priority when cycle is active.
            const currentFaction = currentFactionFromTask(task[i]);
            let faction;
            const currentIsXpBn8 = currentFaction && XP_FACTIONS.has(currentFaction);
            const xpAvailBn8 = availFactions.filter(f => XP_FACTIONS.has(f));
            if (xpCycleActive && xpAvailBn8.length > 0 && !currentIsXpBn8) {
                const factionReps = await getFactionReps(ns, playerInfo.factions);
                xpAvailBn8.sort((a, b) => (factionReps[a] ?? 0) - (factionReps[b] ?? 0));
                faction = xpAvailBn8[0];
            } else if (currentFaction && availFactions.includes(currentFaction)) {
                faction = currentFaction;
            } else {
                const factionReps = await getFactionReps(ns, playerInfo.factions);
                availFactions.sort((a, b) => (factionReps[a] ?? 0) - (factionReps[b] ?? 0));
                faction = availFactions[0];
            }
            const work = works[workByFaction[faction] || 0];
            assignedFactions.add(faction);
            return [
                `work for faction '${faction}' (${work})`,
                `ns.sleeve.setToFactionWork(ns.args[0], ns.args[1], ns.args[2])`,
                [i, faction, work],
                `earning rep with ${faction} (BN8: crime earns $0, faction work is better)`
            ];
        }
    }
    // Finally, do crime for Karma/money. Pick the best crime based on money/sec (accounting for success chance).
    const crime = await pickBestCrime(ns, sleeve);
    return await crimeTask(ns, crime, i, sleeve, `there appears to be nothing better to do`);
}

/** Helper to prepare the shock recovery task
 * @param {SleevePerson} sleeve */
function shockRecoveryTask(sleeve, i, reason) {
    return [`recover from shock`, `ns.sleeve.setToShockRecovery(ns.args[0])`, [i],
    /*   */ `recovering from shock (${sleeve.shock.toFixed(2)}%) beacause ${reason}...`];
}

/** Returns a map of { factionName → rep } for the given factions, cached for 60s.
 * Requires SF4. Returns {} if unavailable.
 * @param {NS} ns
 * @param {string[]} factions */
async function getFactionReps(ns, factions) {
    if (!(4 in ownedSourceFiles) || !factions?.length) return {};
    if (Date.now() > factionRepCacheExpiry) {
        cachedFactionRep = await getNsDataThroughFile(ns,
            `Object.fromEntries(ns.args.map(f => [f, ns.singularity.getFactionRep(f)]))`,
            '/Temp/sleeve-faction-rep.txt', factions) ?? {};
        factionRepCacheExpiry = Date.now() + 60000;
    }
    return cachedFactionRep;
}

/** Picks the best crime for a sleeve by maximising money/sec = money * successChance / time.
 * Falls back to the original Homicide-vs-Mug logic when SF4 is unavailable.
 * Crime stats are cached in cachedCrimeStats so we only pay the RAM cost once per crime per session.
 * @param {NS} ns
 * @param {SleevePerson} sleeve */
async function pickBestCrime(ns, sleeve) {
    if (options.crime) return options.crime;
    // Ensure stats are cached for every crime.
    // With SF4: fetch via getCrimeStats (only once per crime per session).
    // Without SF4: use CRIME_DATA hardcoded table — all 12 crimes still evaluated.
    for (const name of allCrimeNames) {
        if (!cachedCrimeStats[name]) {
            cachedCrimeStats[name] = (4 in ownedSourceFiles)
                ? await getNsDataThroughFile(ns, `ns.singularity.getCrimeStats(ns.args[0])`, null, [name])
                : CRIME_DATA[name];
        }
    }
    let bestCrime = 'Mug', bestScore = -1;
    for (const name of allCrimeNames) {
        const stats = cachedCrimeStats[name];
        if (!stats?.money || !stats?.time) continue;
        const chance = await calculateCrimeChance(ns, sleeve, name);
        if (chance < 0.01) continue; // Skip crimes we essentially cannot succeed at
        const moneyPerSec = stats.money * chance / (stats.time / 1000);
        if (moneyPerSec > bestScore) { bestScore = moneyPerSec; bestCrime = name; }
    }
    return bestCrime;
}

/** Helper to prepare the crime task
 * @param {NS} ns
 * @param {SleevePerson} sleeve
 * @returns {Promise<[string, string, any[], string]>} a 4-tuple of task name, command, args, and status message */
async function crimeTask(ns, crime, i, sleeve, reason) {
    const successChance = await calculateCrimeChance(ns, sleeve, crime);
    return [`commit ${crime}`, `ns.sleeve.setToCommitCrime(ns.args[0], ns.args[1])`, [i, crime],
    /*   */ `committing ${crime} with chance ${(successChance * 100).toFixed(2)}% because ${reason}` +
    /*   */ (options.crime || crime == "Homicide" ? '' : // If auto-criming, user may be curious how close we are to switching to homicide
    /*   */     ` (Note: Homicide chance would be ${((await calculateCrimeChance(ns, sleeve, "Homicide")) * 100).toFixed(2)}%)`)];
}


/** Sets a sleeve to its designated task, with some extra error handling logic for working for factions.
 * @param {NS} ns
 * @param {number} i - Sleeve number
 * @param {string} designatedTask - string describing the designated task
 * @param {string} command - dynamic command to initiate this work
 * @param {any[]} args - arguments consumed by the dynamic command
 * */
async function setSleeveTask(ns, i, designatedTask, command, args) {
    let strAction = `Set sleeve ${i} to ${designatedTask}`;
    // Track whether the API returned false (unsupported work type / invalid args) vs threw an
    // exception (most commonly: "another sleeve is already working for this faction").
    // These two failure modes must be handled differently for faction work:
    //   - false return  → the work type genuinely isn't supported; advance workByFaction
    //   - thrown error  → a transient conflict (duplicate assignment, timing); don't advance
    //     workByFaction, and critically, never add the faction to noWorkFactions
    let apiReturnedFalse = false;
    try { // Assigning a task can throw an error rather than simply returning false. We must suppress this
        if (await getNsDataThroughFile(ns, command, `/Temp/sleeve-${command.slice(10, command.indexOf("("))}.txt`, args)) {
            task[i] = designatedTask;
            log(ns, `SUCCESS: ${strAction}`);
            return true;
        }
        apiReturnedFalse = true; // returned false — work type not supported or invalid
    } catch { }
    // If assigning the task failed...
    lastRerollTime[i] = 0;
    // If working for a faction, it's possible the current work isn't supported, so try the next one.
    if (designatedTask.startsWith('work for faction')) {
        const faction = args[1]; // Hack: Not obvious, but the second argument will be the faction name in this case.
        if (apiReturnedFalse) {
            // API returned false → this work type is genuinely not offered by the faction.
            // Advance to the next work type. Only add to noWorkFactions once all types exhausted.
            let nextWorkIndex = (workByFaction[faction] || 0) + 1;
            if (nextWorkIndex >= works.length) {
                // All three work types returned false — this is a special faction
                // (Bladeburners, Church of the Machine God, Shadows of Anarchy, etc.) that
                // offers no assignable sleeve work. Blacklist it permanently so we never
                // waste loop ticks trying again.
                noWorkFactions.add(faction);
                log(ns, `WARN: Failed to ${strAction}. None of the ${works.length} work types are supported by "${faction}" (likely a special faction with no assignable work). Permanently excluding it from sleeve assignments.`, true, 'warning');
                nextWorkIndex = 0;
            } else
                log(ns, `INFO: Failed to ${strAction} — work type not supported. Trying the next work type (${works[nextWorkIndex]})`);
            workByFaction[faction] = nextWorkIndex;
        } else {
            // API threw an exception — most likely "Sleeve X cannot work for faction Y because
            // Sleeve Z is already working for them." This is a transient conflict, not a sign
            // that the faction is unsupported. Do NOT advance workByFaction and do NOT add to
            // noWorkFactions. assignedFactions will prevent the duplicate on the very next tick.
            log(ns, `INFO: Failed to ${strAction} (exception — likely duplicate sleeve assignment or transient conflict). workByFaction NOT incremented; will resolve next tick.`);
        }
    } else if (designatedTask.startsWith('Bladeburner')) { // Bladeburner action may be out of operations
        bladeburnerCooldown[i] = Date.now(); // There will be a cooldown before this task is assigned again.
    } else if (designatedTask.startsWith('study') || designatedTask.startsWith('train')) {
        // Gym/study failure almost always means the sleeve isn't in the correct city yet
        // (travel may have failed due to low funds, or the game needed one more tick to process it).
        // Clear task[i] so the next loop re-attempts travel rather than silently retrying
        // enrolment against the wrong city indefinitely.
        task[i] = ''; // force re-evaluation next tick
        log(ns, `WARN: Failed to ${strAction} — sleeve may not be in the correct city yet. ` +
            `Will retry travel + enrolment next tick.`, false, 'warning');
    } else
        log(ns, `ERROR: Failed to ${strAction}`, true, 'error');
    return false;
}

let promptedForTrainingBudget = false;
/** @param {NS} ns
 * For when we are at risk of going into debt while training with sleeves.
 * Contains some fancy logic to spawn an external script that will prompt the user and wait for an answer. */
async function promptForTrainingBudget(ns) {
    if (promptedForTrainingBudget) return;
    promptedForTrainingBudget = true;
    await ns.write(trainingReserveFile, '', "w");
    if (options['training-reserve'] === null && !options['disable-training'])
        await runCommand(ns, `let ans = await ns.prompt("Do you want to let sleeves put you in debt while they train?"); \n` +
            `await ns.write("${trainingReserveFile}", ans ? '-1E100' : '0', "w")`, '/Temp/sleeves-training-reserve-prompt.js');
}

/** @param {NS} ns
 * @param {SleevePerson} sleeve
 * Calculate the chance a sleeve has of committing a crime successfully.
 * Game formula (Crime.ts successRate):
 *   chance = (Σ weight×skill + 0.025×INT) / 975 / difficulty × mults.crime_success × intBonus */
async function calculateCrimeChance(ns, sleeve, crimeName) {
    // If not in the cache, retrieve this crime's stats
    const crimeStats = cachedCrimeStats[crimeName] ?? (cachedCrimeStats[crimeName] = (4 in ownedSourceFiles ?
        await getNsDataThroughFile(ns, `ns.singularity.getCrimeStats(ns.args[0])`, null, [crimeName]) :
        CRIME_DATA[crimeName])); // Hardcoded fallback for all 12 crimes when SF4 is unavailable
    if (!crimeStats) return 0;
    let chance =
        (crimeStats.hacking_success_weight || 0) * sleeve.skills.hacking +
        (crimeStats.strength_success_weight || 0) * sleeve.skills.strength +
        (crimeStats.defense_success_weight || 0) * sleeve.skills.defense +
        (crimeStats.dexterity_success_weight || 0) * sleeve.skills.dexterity +
        (crimeStats.agility_success_weight || 0) * sleeve.skills.agility +
        (crimeStats.charisma_success_weight || 0) * sleeve.skills.charisma +
        0.025 * (sleeve.skills.intelligence ?? 0); // IntelligenceCrimeWeight from Constants.ts
    chance /= 975;  // MaxSkillLevel
    chance /= crimeStats.difficulty;
    chance *= sleeve.mults?.crime_success ?? 1; // Sleeve aug multiplier
    // INT bonus: 1 + (INT^0.8)/600 — same as calculateIntelligenceBonus in game source
    chance *= 1 + Math.pow(sleeve.skills.intelligence ?? 0, 0.8) / 600;
    return Math.min(chance, 1);
}