import {
    log, getFilePath, initScriptPaths, getConfiguration, instanceCount, getNsDataThroughFile, runCommand, waitForProcessToComplete,
    getActiveSourceFiles, tryGetBitNodeMultipliers, getStocksValue, unEscapeArrayArgs,
    formatMoney, formatDuration, formatNumber, getErrorInfo, tail, jsonReplacer
} from '/helpers.js'
const argsSchema = [ // The set of all command line arguments
    ['next-bn', 0], // If we destroy the current BN, the next BN to start
    ['disable-auto-destroy-bn', false], // Set to true if you do not want to auto destroy this BN when done
    ['install-at-aug-count', 8], // Automatically install when we can afford this many new augmentations (with NF only counting as 1). Note: This number will automatically be increased by 1 for every level of SF11 you have (up to 3)
    ['install-at-aug-plus-nf-count', 12], // or... automatically install when we can afford this many augmentations including additional levels of Neuroflux.  Note: This number will automatically be increased by 1 for every level of SF11 you have (up to 3)
    ['install-for-augs', ["The Red Pill"]], // or... automatically install as soon as we can afford one of these augmentations
    ['install-countdown', 5 * 60 * 1000], // If we're ready to install, wait this long first to see if more augs come online (we might just be gaining momentum)
    ['time-before-boosting-best-hack-server', 15 * 60 * 1000], // Wait this long before picking our best hack-income server and spending hashes on boosting it
    ['reduced-aug-requirement-per-hour', 0.5], // For every hour since the last reset, require this many fewer augs to install.
    ['interval', 2000], // Wake up this often (milliseconds) to check on things
    ['interval-check-scripts', 10000], // Get a listing of all running processes on home this frequently
    ['high-hack-threshold', 8000], // Once hack level reaches this, we start daemon in high-performance hacking mode
    ['enable-bladeburner', null], // (Deprecated) Bladeburner is now always enabled if it's available. Use '--disable-bladeburner' to explicitly turn off
    ['disable-bladeburner', false], // This will instruct daemon.js not to run the bladeburner.js, even if bladeburner is available.
    ['disable-hacknet', false], // Disable all hacknet purchasing and hash-spending. Auto-enabled in BNs where HacknetNodeMoney < 0.5 (BNs 3,4,5,6,7,11,13,14).
    ['skip-factions', []], // Additional factions to permanently exclude from work-for-factions.js (e.g. ['Aevum','Sector-12'])
    ['wait-for-4s-threshold', 0.9], // Set to 0 to not reset until we have 4S. If money is above this ratio of the 4S Tix API cost, don't reset until we buy it.
    ['disable-wait-for-4s', false], // If true, will doesn't wait for the 4S Tix API to be acquired under any circumstantes
    ['disable-rush-gangs', false], // Set to true to disable focusing work-for-faction on Karma until gangs are unlocked
    ['disable-casino', false], // Set to true to disable running the casino.js script automatically
    ['spend-hashes-on-server-hacking-threshold', 0.1], // Threshold for how good hacking multipliers must be to merit spending hashes for boosting hack income. Set to a large number to disable this entirely.
    ['on-completion-script', null], // Spawn this script when we defeat the bitnode
    ['on-completion-script-args', []], // Optional args to pass to the script when we defeat the bitnode
    ['xp-mode-interval-minutes', 55], // Every time this many minutes has elapsed, toggle daemon.js to runing in --xp-only mode, which prioritizes earning hack-exp rather than money
    ['xp-mode-duration-minutes', 5], // The number of minutes to keep daemon.js in --xp-only mode before switching back to normal money-earning mode.
    ['no-tail-windows', false], // Set to true to prevent the default behaviour of opening a tail window for certain launched scripts. (Doesn't affect scripts that open their own tail windows)
];
export function autocomplete(data, args) {
    data.flags(argsSchema);
    const lastFlag = args.length > 1 ? args[args.length - 2] : null;
    if (["--on-completion-script"].includes(lastFlag))
        return data.scripts;
    return [];
}
/** The entire program is now wrapped in the main functino to avoid objects in
 * global shared memory surviving between multiple invocations of this script.
 * @param {NS} ns **/
export async function main(ns) {
    const persistentLog = "log.autopilot.txt";
    const factionManagerOutputFile = "/Temp/affordable-augs.txt"; // Temp file produced by faction manager with status information
    const defaultBnOrder = [ // The order in which we intend to play bitnodes
        // 1st Priority: Key new features and/or major stat boosts
        4.3,  // Normal. Need singularity to automate everything, and need the API costs reduced from 16x -> 4x -> 1x reliably do so from the start of each BN
        1.2,  // Easy.   Big boost to all multipliers (16% -> 24%), and no penalties to slow us down. Should go quick.
        5.1,  // Normal. Unlock intelligence stat early to maximize growth, getBitNodeMultipliers + Formulas.exe for more accurate scripts, and +8% hack mults
        1.3,  // Easy.   The last bonus is not as big a jump (24% -> 28%), but it's low-hanging fruit
        2.1,  // Easy.   Unlocks gangs, which reduces the need to grind faction and company rep for getting access to most augmentations, speeding up all BNs
        // 2nd Priority: More new features, from Harder BNs. Things will slow down for a while, but the new features should pay in dividends for all future BNs
        10.1, // Hard.   Unlock Sleeves (which tremendously speed along gangs outside of BN2) and grafting (can speed up slow rep-gain BNs). // TODO: Buying / upgrading sleeve mem has no API, requires manual interaction. Can we automate this with UI clicking like casino.js?
        8.2,  // Hard.   8.1 immediately unlocks stocks, 8.2 doubles stock earning rate with shorts. Stocks are never nerfed in any BN (4S can be made too pricey though), and we have a good pre-4S stock script.
        13.1, // Hard.   Unlock Stanek's Gift. We've put a lot of effort into min/maxing the Tetris, so we should try to get it early, even though it's a hard BN. I might change my mind and push this down if it proves too slow.
        7.1,  // Hard.   Unlocks the bladeburner API (and bladeburner outside of BN 6/7). Many recommend it before BN9 since it ends up being a faster win condition in some of the tougher bitnodes ahead.
        9.1,  // Hard.   Unlocks hacknet servers. Hashes can be earned and spent on cash very early in a tough BN to help kick-start things. Hacknet productin/costs improved by 12%
        14.2, // Hard.   Boosts go.js bonuses, but note that we can automate IPvGO from the very start (BN1.1), no need to unlock it. 14.1 doubles all bonuses. 14.2 unlocks the cheat API.
        // 3nd Priority: With most features unlocked, max out SF levels roughly in the order of greatest boost and/or easiest difficulty, to hardest and/or less worthwhile
        2.3,  // Easy.   Boosts to crime success / money / CHA will speed along gangs, training and earning augmentations in the future
        5.3,  // Normal. Diminishing boost to hacking multipliers (8% -> 12% -> 14%), but relatively normal bitnode, especially with other features unlocked
        11.3, // Normal. Decrease augmentation cost scaling in a reset (4% -> 6% -> 7%) (can buy more augs per reset). Also boosts company salary/rep (32% -> 48% -> 56%), which we have little use for with gangs.)
        14.3, // Hard.   Makes go.js cheats slightly more successful, increases max go favour from (100->120) and not too difficult to get out of the way
        13.3, // Hard.   Make stanek's gift bigger to get more/different boosts
        9.2,  // Hard.   Start with 128 GB home ram. Speeds up slow-starting new BNs, but less important with good ram-dodging scripts. Hacknet productin/costs improved by 12% -> 18%.
        9.3,  // Hard.   Start each new BN with an already powerful hacknet server, but *only until the first reset*, which is a bit of a damper. Hacknet productin/costs improved by 18% -> 21%
        10.3, // Hard.   Get the last 2 sleeves (6 => 8) to boost their productivity ~30%. These really help with Bladeburner below. Putting this a little later because buying sleeves memory upgrades requires manual intervention right now.
        // 4th Priority: Play some Bladeburners. Mostly not used to beat other BNs, because for much of the BN this can't be done concurrently with player actions like crime/faction work, and no other BNs are "tuned" to be beaten via Bladeburner win condition
        6.3,  // Normal. The 3 easier bladeburner BNs. Boosts combat stats by 8% -> 12% -> 14%
        7.3,  // Hard.   The remaining 2 hard bladeburner BNs. Boosts all Bladeburner mults by 8% -> 12% -> 14%, so no interaction with other BNs unless trying to win via Bladeburner.
        // Low Priority:
        8.3,  // Hard.   Just gives stock "Limit orders" which we don't use in our scripts,
        3.3,  // Hard.   Corporations. I have no corp scripts, maybe one day I will. The history here is: in 2021, corps were too exploity and broke the game (inf. money). Also the APIs were buggy and new, so I skipped it. Autopilot will win normally while ignoring corps.
        12.9999 // Easy. Keep playing forever. Only stanek scales very well here, there is much work to be done to be able to climb these faster.
    ];
    const augTRP = "The Red Pill";
    const augStanek = `Stanek's Gift - Genesis`;
    let options; // The options used at construction time
    let playerInGang = false, rushGang = false; // Tells us whether we're should be trying to work towards getting into a gang
    let playerInBladeburner = false; // Whether we've joined bladeburner
    let wdHack = (/**@returns{null|number}*/() => null)(); // If the WD server is available (i.e. TRP is installed), caches the required hack level
    let ranCasino = false; // Flag to indicate whether we've stolen 10b from the casino yet
    let reservedPurchase = 0; // The amount of player money that has been reserved to purchase augmentations
    let alreadyJoinedDaedalus = false, autoJoinDaedalusUnavailable = false, reservingMoneyForDaedalus = false, disableStockmasterForDaedalus = false; // Flags to indicate that we should be keeping 100b cash on hand to earn an invite to Daedalus
    let prioritizeHackForDaedalus = false, prioritizeHackForWd = false;
    let lastScriptsCheck = 0; // Last time we got a listing of all running scripts
    let homeRam = 0; // Amount of RAM on the home server, last we checked
    let killScripts = []; // A list of scripts flagged to be restarted due to changes in priority
    let dictOwnedSourceFiles = (/**@returns{{[k: number]: number;}}*/() => [])(); // Player owned source files
    let dictServerHackReqs = (/**@returns{{[serverName: string]: number;}}*/() => undefined)(); // Hacking requirement for each server
    let unlockedSFs = [], nextBn = 0; // Info for the current bitnode
    let resetInfo = (/**@returns{ResetInfo}*/() => undefined)(); // Information about the current bitnode
    let bitNodeMults = (/**@returns{BitNodeMultipliers}*/() => undefined)(); // bitNode multipliers that can be automatically determined after SF-5
    let playerInstalledAugCount = (/**@returns{null|number}*/() => null)(); // Number of augs installed, or null if we don't have SF4 and can't tell.
    let installedAugmentations = [];
    let acceptedStanek = false, stanekLaunched = false;
    let daemonStartTime = 0; // The time we personally launched daemon.
    let lastContractSweep = 0; // Timestamp of last coding-contracts.js run
    let installCountdown = 0; // Start of a countdown before we install augmentations.
    let installCountdownResets = 0; // Number of times we've reset the countdown because our affordable augs has increased
    // XP/money cycling state machine for efficiently reaching hack 2500 (Daedalus) or wdHack.
    // Instead of grinding forever, alternate: 30min XP grind → 30min money-making → install hacking augs → repeat.
    // Each cycle gives better hacking multipliers, making subsequent grinds faster.
    let xpCyclePhase = 'idle'; // 'idle' | 'grinding' | 'money'
    let xpCyclePhaseStart = 0; // Timestamp when current phase started
    let xpCycleTargetHack = 0; // Hack level we're grinding toward (level-gate exit)
    let xpCycleStartAffordable = 0; // affordable_count_ex_nf when grind phase started
    let xpCycleSkipCount  = 0; // Consecutive skipped cycles (ramp up if repeatedly trivial)
    // XP cycle duration adapts based on actual XP/s from xp-grind.
    // Updated each grinding phase tick from /Temp/xp-grind-status.txt.
    // Bounds: 15 min (don't cycle too fast — money phase needs time) to
    //         45 min (don't grind forever if XP/s is very low).
    const XP_CYCLE_MIN_MS = 15 * 60 * 1000;
    const XP_CYCLE_MAX_MS = 45 * 60 * 1000;
    let   xpCycleDuration = 30 * 60 * 1000; // initial estimate, replaced once xp-grind reports
    let bnCompletionSuppressed = false; // Flag if we've detected that we've won the BN, but are suppressing a restart
    let sleevesMaxedOut = false; // Flag used only when the player is replaying BN 10 with all sleeves but has suppressed auto-destroying the BN, to allow continued auto-installs
    let loggedBnCompletion = false; // Flag set to ensure that if we choose to stay in the BN, we only log the "BN completed" message once per reset.
    let have4STixApi = false; // Whether we have access to the 4S (stockmarket) API. Once confirmed true, we can stop checking.
    let have4SData = false; // Whether we have access to 4S (stockmarket) data. Once confirmed true, we can stop checking.
    // Local script-paths.json cache — populated in main_start(), used by resolveScript()
    let _localPathsJson = {};
    /** Resolve a script name via script-paths.json → getFilePath → bare name.
     *  Returns the first path that exists on home, or best guess if none found. */
    function resolveScript(name) {
        const bare = name.replace(/\.js$/, '').replace(/^.*\//, '');
        const candidates = [
            _localPathsJson[bare],      // script-paths.json lookup
            getFilePath(name),           // helpers.js resolver
            name,                        // as-is
        ].filter(Boolean);
        for (const c of candidates)
            if (ns.fileExists(c, 'home')) return c;
        return candidates[0] ?? name;
    }
    // Replacements for player properties deprecated since 2.3.0
    function getTimeInAug() { return Date.now() - resetInfo.lastAugReset; }
    function getTimeInBitnode() { return Date.now() - resetInfo.lastNodeReset; }
    /** @param {NS} ns **/
    async function main_start(ns) {
        const runOptions = getConfiguration(ns, argsSchema);
        if (!runOptions || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
        options = runOptions; // We don't set the global "options" until we're sure this is the only running instance
        initScriptPaths(ns); // Load script-paths.json so getFilePath() resolves reorganized paths (0 GB)
        // Also load script-paths.json locally — robust fallback if helpers.js wasn't updated
        try {
            const raw = ns.read('/script-paths.json');
            if (raw && raw !== '') { _localPathsJson = JSON.parse(raw); delete _localPathsJson._comment; }
        } catch {}
        log(ns, "INFO: Auto-pilot engaged...", true, 'info');
        // The game does not allow boolean flags to be turned "off" via command line, only on. Since this gets saved, notify the user about how they can turn it off.
        const flagsSet = ['disable-auto-destroy-bn', 'disable-bladeburner', 'disable-wait-for-4s', 'disable-rush-gangs', 'disable-hacknet'].filter(f => options[f]);
        for (const flag of flagsSet)
            log(ns, `WARNING: You have previously enabled the flag "--${flag}". Because of the way this script saves its run settings, the ` +
                `only way to now turn this back off will be to manually edit or delete the file ${ns.getScriptName()}.config.txt`, true);
        let startUpRan = false, keepRunning = true;
        while (keepRunning) {
            try {
                // Start-up actions, wrapped in error handling in case of temporary failures
                if (!startUpRan) startUpRan = await startUp(ns);
                // Main loop: Monitor progress in the current BN and automatically reset when we can afford TRP, or N augs.
                keepRunning = await mainLoop(ns);
            }
            catch (err) {
                log(ns, `WARNING: autopilot.js Caught (and suppressed) an unexpected error:` +
                    `\n${getErrorInfo(err)}`, false, 'warning');
                keepRunning = shouldWeKeepRunning(ns);
            }
            await ns.sleep(options['interval']);
        }
    }
    /** @param {NS} ns **/
    async function startUp(ns) {
        await persistConfigChanges(ns);
        // Collect and cache some one-time data
        resetInfo = await getNsDataThroughFile(ns, 'ns.getResetInfo()');
        bitNodeMults = await tryGetBitNodeMultipliers(ns);
        dictOwnedSourceFiles = await getActiveSourceFiles(ns, false);
        unlockedSFs = await getActiveSourceFiles(ns, true);
        homeRam = await getNsDataThroughFile(ns, `ns.getServerMaxRam(ns.args[0])`, null, ["home"]);
        try {
            if (!(4 in unlockedSFs)) {
                log(ns, `WARNING: This script requires SF4 (singularity) functions to assess purchasable augmentations ascend automatically. ` +
                    `Some functionality will be disabled and you'll have to manage working for factions, purchasing, and installing augmentations yourself.`, true);
                installedAugmentations = [];
                playerInstalledAugCount = null; // 'null' is treated as 'Unknown'
            } else {
                installedAugmentations = await getNsDataThroughFile(ns, 'ns.singularity.getOwnedAugmentations()', '/Temp/player-augs-installed.txt');
                playerInstalledAugCount = installedAugmentations.length;
            }
        } catch (err) {
            if (unlockedSFs[4] || 0 == 3) throw err; // No idea why this failed, treat as temporary and allow auto-retry.
            log(ns, `WARNING: You only have SF4 level ${unlockedSFs[4]}. Without level 3, some singularity functions will be ` +
                `too expensive to run until you have bought a lot of home RAM.`, true);
        }
        // We currently no longer have any one-time logic that needs to be run at the start of a new bitnode
        //if (getTimeInBitnode() < 60 * 1000) // Skip initialization if we've been in the bitnode for more than 1 minute
        //    await initializeNewBitnode(ns);
        // Decide what the next-up bitnode should be
        const getSFLevel = bn => Number(bn + "." + ((dictOwnedSourceFiles[bn] || 0) + (resetInfo.currentNode == bn ? 1 : 0)));
        const nextSfEarned = getSFLevel(resetInfo.currentNode);
        const nextRecommendedSf = defaultBnOrder.find(v => v - Math.floor(v) > getSFLevel(Math.floor(v)) - Math.floor(v));
        const nextRecommendedBn = Math.floor(nextRecommendedSf);
        nextBn = options['next-bn'] || nextRecommendedBn;
        log(ns, `INFO: After the current BN (${nextSfEarned}), the next recommended BN is ${nextRecommendedBn} until you have SF ${nextRecommendedSf}.` +
            `\nYou are currently earning SF${nextSfEarned}, and you already own the following source files: ` +
            Object.keys(dictOwnedSourceFiles).map(bn => `${bn}.${dictOwnedSourceFiles[bn]}`).join(", "));
        if (nextBn != nextRecommendedBn)
            log(ns, `WARN: The next recommended BN is ${nextRecommendedBn}, but the --next-bn parameter is set to override this with ${nextBn}.`, true, 'warning');
        return true;
    }
    /** Write any configuration changes to disk so that they will survive resets and new bitnodes
     * @param {NS} ns **/
    async function persistConfigChanges(ns) {
        // Because we cannot pass args to "install" and "destroy" functions, we write them to disk to override defaults
        const changedArgs = argsSchema
            .filter(a => JSON.stringify(options[a[0]], jsonReplacer) != JSON.stringify(a[1]), jsonReplacer)
            .map(a => [a[0], options[a[0]]]);
        // Fix Bug #237 - do not overwrite the config file if one of the arguments provided is of the wrong type
        // This is a copy of new code in helpers.js which generates warnings, but otherwise ignores the errors.
        // We evaluate the same logic here because we want to act on the errors (avoid persisting them)
        for (const [key, finalValue] of changedArgs) {
            const defaultValue = argsSchema.find(kvp => kvp[0] == key)[1];
            const strFinalValue = JSON.stringify(finalValue, jsonReplacer);
            const strDefaultValue = JSON.stringify(defaultValue, jsonReplacer);
            log(ns, `INFO: Default config has been modified: ${key}=${strFinalValue} (type="${typeof finalValue})" ` +
                `does not match default value of ${key}=${strDefaultValue} (type="${typeof defaultValue}").`);
            if ((typeof finalValue) !== (typeof defaultValue) && defaultValue != null) {
                log(ns, `WARNING: A configuration value provided (${key}=${strFinalValue} - ` +
                    `type="${typeof finalValue}") does not match the expected type "${typeof defaultValue}" ` +
                    `based on the default value (${key}=${strDefaultValue}).` +
                    `\nThis configuration will NOT be persisted, and the script may behave unpredictably.`);
                return;
            }
            if (finalValue !== defaultValue && (typeof finalValue == 'number') && Number.isNaN(finalValue)) {
                log(ns, `WARNING: A numeric configuration value (--${key}) got a value of "NaN" (Not a Number), ` +
                    `which likely indicates it was set to a string value that could not be parsed. ` +
                    `Please double-check the script arguments for mistakes or typos.` +
                    `\nThis configuration will NOT be persisted, and the script may behave unpredictably.`);
                return;
            }
        }
        const strConfigChanges = JSON.stringify(changedArgs, jsonReplacer);
        // Only update the config file if it doesn't match the most resent set of run args
        const configPath = `${ns.getScriptName()}.config.txt`
        const currentConfig = ns.read(configPath);
        if ((strConfigChanges.length > 2 || currentConfig) && strConfigChanges != currentConfig) {
            ns.write(configPath, strConfigChanges, "w");
            log(ns, `INFO: Updated "${configPath}" to persist the most recent run args through resets: ${strConfigChanges}`, true, 'info');
        }
    }
    /** Logic run once at the beginning of a new BN
     * @param {NS} ns */
    async function initializeNewBitnode(ns) {
        // Nothing to do here (yet)
    }
    /** Logic run periodically throughout the BN
     * @param {NS} ns */
    async function mainLoop(ns) {
        const player = await getPlayerInfo(ns);
        await updateCachedData(ns);
        let stocksValue = 0;
        try { stocksValue = await getStocksValue(ns); } catch { /* Assume if this fails (insufficient ram) we also have no stocks */ }
        manageReservedMoney(ns, player, stocksValue);
        await checkOnDaedalusStatus(ns, player, stocksValue);
        await checkIfBnIsComplete(ns, player);
        await maybeAcceptStaneksGift(ns, player);
        await checkOnRunningScripts(ns, player);
        await maybeDoCasino(ns, player);
        await maybeInstallAugmentations(ns, player);
        return shouldWeKeepRunning(ns); // Return false to shut down autopilot.js if we installed augs, or don't have enough home RAM
    }
    /** Ram-dodge getting player info.
     * @param {NS} ns
     * @returns {Promise<Player>} */
    async function getPlayerInfo(ns) {
        return await getNsDataThroughFile(ns, `ns.getPlayer()`);
    }
    /** Update some information that can be safely cached for small periods of time
     * @param {NS} ns */
    async function updateCachedData(ns) {
        // Now that grafting is a thing, we need to check if new augmentations have been installed between resets
        if ((4 in unlockedSFs)) { // Note: Installed augmentations can also be obtained from getResetInfo() (without SF4), but this seems unintended and will probably be removed from the game.
            try {
                installedAugmentations = await getNsDataThroughFile(ns, 'ns.singularity.getOwnedAugmentations()', '/Temp/player-augs-installed.txt');
                playerInstalledAugCount = installedAugmentations.length;
            } catch (err) {
                log(ns, `WARNING: failed to update owned augmentations (low RAM?)`, true);
            }
        }
    }
    /** Logic run periodically to if there is anything we can do to speed along earning a Daedalus invite
     * @param {NS} ns
     * @param {Player} player **/
    async function checkOnDaedalusStatus(ns, player, stocksValue) {
        // If we've already installed the red pill we no longer need to try to join this faction.
        if (installedAugmentations.includes(augTRP) || (wdHack != null && Number.isFinite(wdHack) && wdHack > 0))
            return alreadyJoinedDaedalus = true;
        // ── Post-join: actively push toward buying TRP ──
        if (alreadyJoinedDaedalus) {
            if (!(4 in unlockedSFs)) return; // Can't automate without singularity
            // First check: is TRP already affordable? faction-manager handles purchasing,
            // but we should know if we're done grinding/donating.
            const facmanRaw = ns.read('/Temp/affordable-augs.txt');
            if (facmanRaw) {
                try {
                    const facman = JSON.parse(facmanRaw);
                    if (facman.affordable_augs?.includes(augTRP) || facman.awaiting_install_augs?.includes(augTRP)) {
                        log(ns, `INFO: TRP is affordable or already purchased. Donation/grinding complete.`);
                        return; // faction-manager will handle the purchase; autopilot will trigger install
                    }
                } catch {}
            }
            // Check if we have enough favor to donate for rep
            let daedalusFavor = 0;
            try {
                daedalusFavor = await getNsDataThroughFile(ns,
                    `ns.singularity.getFactionFavor(ns.args[0])`, '/Temp/daedalus-favor.txt', ['Daedalus']);
            } catch {}
            // The favor threshold for donations is dynamic per BN.
            // Base: 150 favor. BN mults scale it (BN8: ×0 = instant, BN3: ×0.5 = 75).
            const favorThreshold = Math.ceil(150 * (bitNodeMults.FavorToDonateToFaction ?? 1));
            const canDonate = favorThreshold === 0 || daedalusFavor >= favorThreshold;
            if (canDonate) {
                // Donate money to build Daedalus rep until TRP is affordable.
                // Use a reasonable chunk — don't drain everything. Keep a reserve for
                // stockmaster re-investment and aug purchases.
                const reserve = Math.max(Number(ns.read("reserve.txt") || 0), 1e9);
                const donateAmount = Math.floor((player.money - reserve) * 0.5);
                if (donateAmount > 1e6) {
                    const donated = await getNsDataThroughFile(ns,
                        `ns.singularity.donateToFaction(ns.args[0], ns.args[1])`, null, ['Daedalus', donateAmount]);
                    if (donated)
                        log(ns, `SUCCESS: Donated ${formatMoney(donateAmount)} to Daedalus for rep ` +
                            `(favor: ${daedalusFavor}/${favorThreshold}).`, false, 'success');
                }
                // Clear the grind flag if it was set from a previous cycle where we couldn't donate
                ns.write('/Temp/Daedalus-rep-grind-active.txt', '', 'w');
            } else {
                // Can't donate — need to grind rep via faction work + share threads.
                // Write flag so work-for-factions.js and sleeve.js prioritize Daedalus,
                // and daemon keeps --no-share OFF (share boosts active faction work rep).
                ns.write('/Temp/Daedalus-rep-grind-active.txt', 'true', 'w');
            }
            return;
        }
        if (autoJoinDaedalusUnavailable) return;
        // See if we even have enough augmentations to attempt to join Daedalus (once we have a count of our augmentations)
        if (playerInstalledAugCount !== null && playerInstalledAugCount < bitNodeMults.DaedalusAugsRequirement) {
            if (!(10 in unlockedSFs))
                autoJoinDaedalusUnavailable = true; // Won't be able to unlock daedalus this ascend if we can't graft augs and have to install for them
            return; // Either way, for now we can't get into Daedalus without more augmentations
        }
        // See if we've already joined this faction
        if (player.factions.includes("Daedalus")) {
            alreadyJoinedDaedalus = true;
            disableStockmasterForDaedalus = false;
            // Always force the XP cycle to exit and re-check scripts when Daedalus is joined.
            // This guarantees xp-grind is killed and daemon relaunches without --xp-only.
            if (xpCyclePhase !== 'idle') {
                log(ns, `INFO: Daedalus joined! Forcing XP cycle to idle.`, true, 'info');
                xpCyclePhase = 'idle';
            }
            lastScriptsCheck = 0; // Force immediate script re-evaluation
            // If we previously took any action to "rush" Daedalus, keep the momentum going by restarting work-for-factions.js
            // so that it immediately re-assesses priorities and sees there's a new priority faction to earn reputation for.
            if (prioritizeHackForDaedalus || reservingMoneyForDaedalus) {
                let reason;
                if (prioritizeHackForDaedalus) {
                    prioritizeHackForDaedalus = false; // Can turn off this flag now so daemon.js can be reverted
                    reason = "by prioritizing hack exp gains";
                }
                if (reservingMoneyForDaedalus) {
                    reservingMoneyForDaedalus = false; // Turn this flag off now so we reset our reserve.txt
                    reason = (reason ? reason + " and" : "by") + " saving up our money";
                }
                log(ns, `SUCCESS: We sped along joining the faction 'Daedalus' ${reason}. ` + // Pat ourselves on the back
                    `Restarting work-for-factions.js to speed along earn rep.`, false, 'success');
                killScripts.push(resolveScript('work-for-factions')); // Schedule this to be killed (will be restarted) on the next script loop.
            }
            return;
        }
        const moneyReq = 100E9;
        // If we've previously set a flag to wait for the daedalus invite and reserve money, try to speed-along joining them
        if (reservingMoneyForDaedalus && player.money >= moneyReq) // If our cash has dipped below the threshold again, we may need to take action below
            return await getNsDataThroughFile(ns, 'ns.singularity.joinFaction(ns.args[0])', null, ["Daedalus"]); // Note, we should have already checked that we have SF4 access before reserving money
        // Remaining logic below is for rushing a Daedalus invite in the current reset
        const totalWorth = player.money + stocksValue;
        // Check for sufficient hacking level before attempting to reserve money
        if (player.skills.hacking < 2500) {
            // If we happen to already have enough money for daedalus and are only waiting on hack-level,
            // set a flag to switch daemon.js into --xp-only mode, to prioritize earning hack exp over money
            // If the aug gate is already cleared (playerInstalledAugCount >= requirement), we know
            // we will eventually need hack 2500 — go XP mode as soon as money is in reach regardless
            // of current hack level. Otherwise fall back to the 50% heuristic so we don't waste time
            // in XP mode on runs where hack income is too low to ever reach 2500.
            // In BN8, FavorToDonateToFaction=0 means you can donate to Daedalus immediately
            // regardless of aug count — treat the gate as always cleared.
            // FavorToDonateToFaction=0 means you can donate rep to factions without
            // any favor threshold — aug count is irrelevant for Daedalus in that case.
            // This covers BN8 and any future BN with the same property.
            const canDonateImmediately = (bitNodeMults.FavorToDonateToFaction ?? 1) === 0;
            const augGateCleared = canDonateImmediately ||
                (playerInstalledAugCount !== null &&
                playerInstalledAugCount >= bitNodeMults.DaedalusAugsRequirement);
            if (totalWorth >= moneyReq && (augGateCleared || player.skills.hacking >= (2500 * 0.5)))
                prioritizeHackForDaedalus = true;
            //log(ns, `total worth: ${formatMoney(totalWorth)} moneyReq: ${formatMoney(moneyReq)} prioritizeHackForDaedalus: ${prioritizeHackForDaedalus}`)
            return reservingMoneyForDaedalus = false; // Don't reserve money until hack level suffices
        }
        // If we have sufficient augs and hacking, the only requirement left is the money (100b)
        // If our net worth is sufficient, reserve our money and liquidate stocks if necessary until we get the invite
        if (player.money < moneyReq && totalWorth > moneyReq * 1.001 /* slight buffer to account for timing issues */) {
            // Note: Without SF4, we have no way of knowing how many augmentations we own, so we should probably
            //       never reserve money in case this requirement is not met, or we're potentially just wasting money
            if (!(4 in unlockedSFs)) {
                log(ns, `SUCCESS: ${player.money < moneyReq ? "If you sell your stocks, y" : "Y"}ou should have enough money ` +
                    `(>=${formatMoney(moneyReq)}) and a sufficiently high hack level (>=${2500}) to get an invite from the faction Daedalus. ` +
                    `Before you attempt this though, ensure you have ${bitNodeMults.DaedalusAugsRequirement} ` +
                    `augmentations installed (scripts cannot check this without SF4).`, true, 'success');
                return autoJoinDaedalusUnavailable = true; // We won't show this again.
            }
            reservingMoneyForDaedalus = true; // Flag to pause all spending (set reserve.txt) until we've gotten the Daedalus invite
            if (player.money < moneyReq) { // Only liquidate stocks if we don't have enough cash lying around.
                disableStockmasterForDaedalus = true; // Flag to keep stockmaster offline until we've gotten a daedalus invite
                log(ns, "INFO: Temporarily liquidating stocks to earn an invite to Daedalus...", true, 'info');
                launchScriptHelper(ns, resolveScript('stockmaster'), ['--liquidate']);
            } // else if we don't liquidate stocks, and our money dips below 100E9 again, we can always do it on the next loop
        } else if ((bitNodeMults.FavorToDonateToFaction ?? 1) === 0) {
            // FavorToDonateToFaction=0: can donate immediately once we have $100b.
            // Reserve the money and wait for enough wealth to liquidate stocks.
            reservingMoneyForDaedalus = true;
        } // Cancel the reserve if our money drops below the threshold before getting an invite (due to other scripts not respecting the reserve?)
        else if (reservingMoneyForDaedalus && totalWorth < moneyReq * 0.999 /* slight buffer to let cash recover */) {
            reservingMoneyForDaedalus = false; // Cancel the hold on funds, and wait for total worth to increase again
            disableStockmasterForDaedalus = false; // Allow stockmaster to be relaunched
            log(ns, `WARN: We previously had sufficient wealth to earn a Daedalus invite (>=${formatMoney(moneyReq)}), ` +
                `but our wealth somehow decreased (to ${formatMoney(totalWorth)}) before the invite was recieved, ` +
                `so we'll need to wait for it to recover and try again later.`, false, 'warning');
        }
    }
    /** Logic run periodically throughout the BN to see if we are ready to complete it.
     * @param {NS} ns
     * @param {Player} player */
    async function checkIfBnIsComplete(ns, player) {
        if (bnCompletionSuppressed) return true;
        // Always re-read wdHack when TRP is installed — the cached file from before
        // TRP was installed will contain -1 (Infinity) and never update otherwise.
        const trpIsInstalled = installedAugmentations.includes(augTRP);
        if (wdHack === null || wdHack === Number.POSITIVE_INFINITY || trpIsInstalled) {
            // Delete the stale cache file to force getNsDataThroughFile to re-run the temp script
            if (wdHack === Number.POSITIVE_INFINITY || trpIsInstalled)
                ns.write('/Temp/wd-hackingLevel.txt', '', 'w');
            wdHack = await getNsDataThroughFile(ns, 'ns.scan("The-Cave").includes("w0r1d_d43m0n") ? ' +
                'ns.getServerRequiredHackingLevel("w0r1d_d43m0n"): -1',
                '/Temp/wd-hackingLevel.txt');
            if (wdHack == -1) wdHack = Number.POSITIVE_INFINITY;
            if (trpIsInstalled && wdHack !== Number.POSITIVE_INFINITY)
                log(ns, `INFO: w0r1d_d43m0n detected. Required hack level: ${wdHack}. Current: ${player.skills.hacking}`);
        }
        // Detect if a BN win condition has been met
        let bnComplete = player.skills.hacking >= wdHack;
        // We cannot technically destroy WD until we have root. If we recently reset, we may have to wait a bit
        // for daemon.js to get a little money, buy the crack tools, and nuke the server first.
        if (bnComplete) {
            const caveRooted = await getNsDataThroughFile(ns, 'ns.hasRootAccess(ns.args[0])', null, ["w0r1d_d43m0n"]);
            if (!caveRooted) {
                log(ns, `INFO: Hack level sufficient (${player.skills.hacking} >= ${wdHack}) but w0r1d_d43m0n not rooted. Attempting crack...`);
                if ((4 in unlockedSFs) && ns.serverExists("darkweb")) {
                    // Check what programs are missing and estimate cost
                    const progCosts = { "BruteSSH.exe": 500e3, "FTPCrack.exe": 1.5e6, "relaySMTP.exe": 5e6, "HTTPWorm.exe": 30e6, "SQLInject.exe": 250e6 };
                    const missing = Object.entries(progCosts).filter(([p]) => !ns.fileExists(p, "home"));
                    const totalCost = missing.reduce((sum, [, c]) => sum + c, 0);
                    // If we don't have enough cash but stocks could cover it, liquidate
                    if (missing.length > 0 && player.money < totalCost * 1.05) {
                        let stocksValue = 0;
                        try { stocksValue = await getStocksValue(ns); } catch {}
                        if (player.money + stocksValue >= totalCost * 1.05) {
                            log(ns, `INFO: Need ${formatMoney(totalCost)} for ${missing.length} crack program(s) but only ${formatMoney(player.money)} cash. Liquidating stocks...`, true, 'info');
                            launchScriptHelper(ns, resolveScript('stockmaster'), ['--liquidate']);
                            await ns.sleep(5000); // Give stockmaster time to sell positions
                        }
                    }
                    // Now try to buy
                    for (const [prog] of missing) {
                        const bought = await getNsDataThroughFile(ns,
                            `ns.singularity.purchaseProgram(ns.args[0])`, null, [prog]);
                        if (bought) log(ns, `SUCCESS: Purchased ${prog} (needed for w0r1d_d43m0n)`, true, 'success');
                    }
                }
                // Try cracking
                const pid = launchScriptHelper(ns, '/Tasks/crack-host.js', ['w0r1d_d43m0n']);
                if (pid) await waitForProcessToComplete(ns, pid);
                // Re-check root after crack attempt
                const nowRooted = await getNsDataThroughFile(ns, 'ns.hasRootAccess(ns.args[0])', null, ["w0r1d_d43m0n"]);
                if (!nowRooted) {
                    log(ns, `WARN: Still can't root w0r1d_d43m0n. May need more crack programs (need money).`);
                    bnComplete = false;
                }
            }
        }
        // Detect the BB win condition (requires SF7 (bladeburner API) or being in BN6)
        if (7 in unlockedSFs) // No point making this async check if bladeburner API is unavailable
            playerInBladeburner = playerInBladeburner || await getNsDataThroughFile(ns, 'ns.bladeburner.inBladeburner()');
        if (!bnComplete && playerInBladeburner)
            bnComplete = await getNsDataThroughFile(ns,
                `ns.bladeburner.getActionCountRemaining('Black Operations', 'Operation Daedalus') === 0`,
                '/Temp/bladeburner-completed.txt');
        // HEURISTIC: If we naturally get within 75% of the w0r1d_d43m0n hack stat requirement,
        //    switch daemon.js to prioritize earning hack exp for the remainder of the BN.
        // Also trigger immediately if TRP is installed — the ONLY remaining goal is hack level.
        // BUT: don't trigger if hack level is already sufficient — the bottleneck is root access, not XP.
        const hackLevelInsufficient = player.skills.hacking < wdHack;
        if (hackLevelInsufficient && (trpIsInstalled || player.skills.hacking >= (wdHack * 0.75)))
            prioritizeHackForWd = true;
        else if (!hackLevelInsufficient)
            prioritizeHackForWd = false; // Hack level met — don't waste time on XP
        if (!bnComplete) return false; // No win conditions met
        if (!loggedBnCompletion) {
            const text = `BN ${resetInfo.currentNode}.${(dictOwnedSourceFiles[resetInfo.currentNode] || 0) + 1} completed at ` +
                `${formatDuration(getTimeInBitnode())} ` +
                `(${(player.skills.hacking >= wdHack ? `hack (${wdHack.toFixed(0)})` : 'bladeburner')} win condition)`;
            persist_log(ns, text);
            log(ns, `SUCCESS: ${text}`, true, 'success');
            loggedBnCompletion = true; // Flag set to ensure that if we choose to stay in the BN, we only log the "BN completed" message once per reset.
        }
        // Run the --on-completion-script if specified
        if (options['on-completion-script']) {
            const pid = launchScriptHelper(ns, options['on-completion-script'], unEscapeArrayArgs(options['on-completion-script-args']), false);
            if (pid) await waitForProcessToComplete(ns, pid);
        }
        // Check if there is some reason not to automatically destroy this BN
        if (resetInfo.currentNode == 10) { // Suggest the user doesn't reset until they buy all sleeves and max memory
            const shouldHaveSleeveCount = Math.min(8, 6 + (dictOwnedSourceFiles[10] || 0));
            const numSleeves = await getNsDataThroughFile(ns, `ns.sleeve.getNumSleeves()`);
            let reasonToStay = null;
            if (numSleeves < shouldHaveSleeveCount)
                reasonToStay = `Detected that you only have ${numSleeves} sleeves, but you could have ${shouldHaveSleeveCount}.`;
            else {
                let sleeveInfo = (/** @returns {SleevePerson[]} */() => [])();
                sleeveInfo = await getNsDataThroughFile(ns, `ns.args.map(i => ns.sleeve.getSleeve(i))`, '/Temp/sleeve-getSleeve-all.txt', [...Array(numSleeves).keys()]);
                if (sleeveInfo.some(s => s.memory < 100))
                    reasonToStay = `Detected that you have ${numSleeves}/${shouldHaveSleeveCount} sleeves, but they do not all have the maximum memory of 100:\n  ` +
                        sleeveInfo.map((s, i) => `- Sleeve ${i} has ${s.memory}/100 memory`).join('\n  ');
                else
                    sleevesMaxedOut = true; // Flag is used elsewhere to allow continued installs
            }
            if (reasonToStay) {
                log_once(ns, `WARNING: ${reasonToStay}\nTry not to leave BN10 before buying all you can from the faction "The Covenant", especially sleeve memory!` +
                    `\nNOTE: You can ONLY buy sleeves & memory from The Covenant in BN10, which is why it's important to do this before you leave.`, true);
                return true; // Return true, but do not set `bnCompletionSuppressed = true` so we can auto-reset once the user intervenes.
            }
        }
        if (options['disable-auto-destroy-bn']) {
            log(ns, `--disable-auto-destroy-bn is set, you can manually exit the bitnode when ready.`, true);
            return bnCompletionSuppressed = true;
        }
        if (!(4 in unlockedSFs)) {
            log(ns, `You do not own SF4, so you must manually exit the bitnode (` +
                `${player.skills.hacking >= wdHack ? "by hacking W0r1dD43m0n" : "on the bladeburner BlackOps tab"}).`, true);
            return bnCompletionSuppressed = true;
        }
        // Clean out our temp folder and flags so we don't have any stale data when the next BN starts.
        let pid = launchScriptHelper(ns, 'cleanup.js');
        if (pid) await waitForProcessToComplete(ns, pid);
        // In all likelihood, daemon.js has already nuked this like it does all servers, but in case it hasn't:
        pid = launchScriptHelper(ns, '/Tasks/crack-host.js', ['w0r1d_d43m0n']);
        if (pid) await waitForProcessToComplete(ns, pid);
        // Use the new special singularity function to automate entering a new BN
        pid = await runCommand(ns, `ns.singularity.destroyW0r1dD43m0n(ns.args[0], ns.args[1]` +
            `, { sourceFileOverrides: new Map() }` + // Work around a long-standing bug on bitburner-official.github.io TODO: Remove when no longer needed
            `)`, '/Temp/singularity-destroyW0r1dD43m0n.js', [nextBn, ns.getScriptName()]);
        if (pid) {
            log(ns, `SUCCESS: Initiated process ${pid} to execute 'singularity.destroyW0r1dD43m0n' with args: [${nextBn}, ${ns.getScriptName()}]`, true, 'success')
            await waitForProcessToComplete(ns, pid);
            log(ns, `WARNING: Process is done running, why am I still here? Sleeping 10 seconds...`, true, 'error')
            await ns.sleep(10000);
        }
        persist_log(ns, log(ns, `ERROR: Tried destroy the bitnode (pid=${pid}), but we're still here...`, true, 'error'));
        //return bnCompletionSuppressed = true; // Don't suppress bn Completion, try again on our next loop.
    }
    /** Helper to get a list of all scripts running (on home)
     * @param {NS} ns */
    async function getRunningScripts(ns) {
        return await getNsDataThroughFile(ns, 'ns.ps(ns.args[0])', null, ['home']);
    }
    /** Helper to get the first instance of a running script by name.
     * @param {NS} ns
     * @param {string} baseScriptName The name of a script (before applying getFilePath)
     * @param {ProcessInfo[]} runningScripts - (optional) Cached list of running scripts to avoid repeating this expensive request
     * @param {(value: ProcessInfo, index: number, array: ProcessInfo[]) => unknown} filter - (optional) Filter the list of processes beyond just matching on the script name */
    function findScriptHelper(baseScriptName, runningScripts, filter = null) {
        const resolved = resolveScript(baseScriptName);
        const legacy = getFilePath(baseScriptName);
        const bare = baseScriptName.replace(/^.*\//, ''); // resolveScript('sleeve') → "sleeve.js"
        return runningScripts.filter(s =>
            (s.filename === resolved || s.filename === legacy || s.filename.endsWith('/' + bare) || s.filename === bare)
            && (!filter || filter(s))
        )[0];
    }
    /** Helper to kill a running script instance by name
     * @param {NS} ns
     * @param {ProcessInfo[]} runningScripts - (optional) Cached list of running scripts to avoid repeating this expensive request
     * @param {ProcessInfo} processInfo - (optional) The process to kill, if we've already found it in advance */
    async function killScript(ns, baseScriptName, runningScripts = null, processInfo = null) {
        processInfo = processInfo || findScriptHelper(baseScriptName, runningScripts || (await getRunningScripts(ns)))
        if (processInfo) {
            log(ns, `INFO: Killing script ${baseScriptName} with pid ${processInfo.pid} and args: [${processInfo.args.join(", ")}].`, false, 'info');
            return await getNsDataThroughFile(ns, 'ns.kill(ns.args[0])', null, [processInfo.pid]);
        }
        log(ns, `INFO: Skipping request to kill script ${baseScriptName}, no running instance was found...`, false, 'warning');
        return false;
    }
    /** Logic to ensure scripts are running to progress the BN
     * @param {NS} ns
     * @param {Player} player */
    async function checkOnRunningScripts(ns, player) {
        if (lastScriptsCheck > Date.now() - options['interval-check-scripts']) return;
        lastScriptsCheck = Date.now();
        const runningScripts = await getRunningScripts(ns); // Cache the list of running scripts for the duration
        const findScript = /** @param {(value: ProcessInfo, index: number, array: ProcessInfo[]) => unknown} filter @returns {ProcessInfo} */
            (baseScriptName, filter = null) => findScriptHelper(baseScriptName, runningScripts, filter);
        // Kill any scripts that were flagged for restart
        while (killScripts.length > 0)
            await killScript(ns, killScripts.pop(), runningScripts);
        // See if home ram has improved. We hold back on launching certain scripts if we are low on home RAM
        homeRam = await getNsDataThroughFile(ns, `ns.getServerMaxRam(ns.args[0])`, null, ["home"]);
        // Buy darkweb programs BEFORE stockmaster launches so crack programs get bought
        // with casino money. Crack programs unlock servers → more RAM → faster everything.
        // Ordered by priority: crack tools first (unlock servers), then utility programs.
        if ((4 in unlockedSFs) && ns.serverExists("darkweb")) {
            const darkwebPrograms = [
                // Crack programs — each unlocks more servers. Buy cheap ones first.
                "BruteSSH.exe",       //   $500K — unlocks ~10 servers
                "FTPCrack.exe",       //  $1.5M — unlocks ~15 more
                "relaySMTP.exe",      //    $5M — unlocks ~20 more
                "HTTPWorm.exe",       //   $30M — unlocks most remaining
                "SQLInject.exe",      //  $250M — unlocks everything
                // Utility programs
                "ServerProfiler.exe", //  $500K
                "DeepscanV1.exe",     //  $500K
                "AutoLink.exe",       //    $1M
                "DeepscanV2.exe",     //   $25M
                "DarkscapeNavigator.exe", // $50M — needed for darknet crawler
                "Formulas.exe",       //    $5B — huge optimization boost
            ];
            let boughtAny = false;
            for (const prog of darkwebPrograms) {
                if (!ns.fileExists(prog, "home")) {
                    const bought = await getNsDataThroughFile(ns,
                        `ns.singularity.purchaseProgram(ns.args[0])`, null, [prog]);
                    if (bought) {
                        log(ns, `SUCCESS: Purchased ${prog}`, true, 'success');
                        boughtAny = true;
                    }
                }
            }
            // Brief pause after purchases so the money is spent before stockmaster grabs it
            if (boughtAny) await ns.sleep(1500);
        }
           // Keep cash liquid for unowned darkweb programs (HTTPWorm $30M, SQLInject $250M, etc.)
        const _darkwebCosts = {
            "BruteSSH.exe": 500e3, "FTPCrack.exe": 1.5e6, "relaySMTP.exe": 5e6,
            "HTTPWorm.exe": 30e6,  "SQLInject.exe": 250e6,
            "ServerProfiler.exe": 500e3, "DeepscanV1.exe": 500e3, "AutoLink.exe": 1e6,
            "DeepscanV2.exe": 25e6, "DarkscapeNavigator.exe": 50e6,
        };
        const pendingDarkwebReserve = ns.serverExists("darkweb")
            ? Object.entries(_darkwebCosts).filter(([p]) => !ns.fileExists(p, "home"))
                .reduce((s, [, c]) => s + c, 0) : 0;
        const _existingStockmaster = findScript(resolveScript('stockmaster'));
        if (_existingStockmaster && !disableStockmasterForDaedalus && pendingDarkwebReserve > 5e6) {
            const _rIdx = _existingStockmaster.args.indexOf('--reserve');
            const _curReserve = _rIdx >= 0 ? Number(_existingStockmaster.args[_rIdx + 1]) : 0;
            if (_curReserve < pendingDarkwebReserve - 1e6)
                await killScript(ns, resolveScript('stockmaster'), runningScripts, _existingStockmaster);
        }
        // Launch stock-master in a way that emphasizes it as our main source of income early-on
        if (!findScript(resolveScript('stockmaster')) && !disableStockmasterForDaedalus && homeRam >= 32)
            launchScriptHelper(ns, resolveScript('stockmaster'), [
                // When hack earns $0 (ScriptHackMoneyGain=0), keep nearly everything invested.
                // fracH/fracB of 0.001 means 99.9% invested — cash is useless in these BNs.
                "--fracH", (bitNodeMults.ScriptHackMoneyGain ?? 1) === 0 ? 0.001 : 0.1,
                "--fracB", (bitNodeMults.ScriptHackMoneyGain ?? 1) === 0 ? 0.001 : 0.15,
                "--reserve", pendingDarkwebReserve,
            ]);
        // Launch sleeves and allow them to also ignore the reserve so they can train up to boost gang unlock speed
        if ((10 in unlockedSFs) && (2 in unlockedSFs) && !findScript(resolveScript('sleeve'))) {
            let sleeveArgs = [];
            if (!options["disable-casino"] && !ranCasino)
                sleeveArgs.push("--training-reserve", 300000); // Avoid training away our casino seed money
            if (options["disable-bladeburner"])
                sleeveArgs.push("--disable-bladeburner");
            launchScriptHelper(ns, resolveScript('sleeve'), sleeveArgs);
        }
        // Spend hacknet hashes on our boosting best hack-income server once established
        let existingSpendHashesProc = findScript('spend-hacknet-hashes.js', s => s.args.includes("--spend-on-server"))
        if ((9 in unlockedSFs) && getTimeInAug() >= options['time-before-boosting-best-hack-server']
            && 0 != bitNodeMults.ScriptHackMoney * bitNodeMults.ScriptHackMoneyGain) // No point in boosting hack income if it's scaled to 0 in the current BN
        {
            const strServerIncomeInfo = ns.read('/Temp/analyze-hack.txt');	// HACK: Steal this file that Daemon also relies on
            if (strServerIncomeInfo) {
                const incomeByServer = JSON.parse(strServerIncomeInfo);
                dictServerHackReqs ??= await getNsDataThroughFile(ns, 'Object.fromEntries(ns.args.map(server => [server, ns.getServerRequiredHackingLevel(server)]))',
                    '/Temp/getServerRequiredHackingLevel-all.txt', incomeByServer.map(s => s.hostname));
                const [bestServer, gain] = incomeByServer.filter(s => dictServerHackReqs[s.hostname] <= player.skills.hacking)
                    .reduce(([bestServer, bestIncome], target) => target.gainRate > bestIncome ? [target.hostname, target.gainRate] : [bestServer, bestIncome], [null, -1]);
                const spendHashesMultThreshold = options['spend-hashes-on-server-hacking-threshold'];
                // If hacking gain multipliers are too low, assume the bitnode is meant to be won a different way and don't bother wasting hashes on boosting hack income
                // The exception is that in BN9, despite high penalties, we're definitely meant to spend hashes to boost hack income
                if (bestServer && (gain > spendHashesMultThreshold || resetInfo.currentNode == 9)) {
                    // Check whether we should be spending hashes to reduce minimum security
                    const serverMinSecurity = await getNsDataThroughFile(ns, 'ns.getServerMinSecurityLevel(ns.args[0])', null, [bestServer]);
                    const shouldReduceMinSecurity = serverMinSecurity > 2; // Each purchase reduces by 2%. Can't go below 1, but not worth the cost to keep going below 2.
                    // If we were already spending hashes to boost a server, check to see if things have changed
                    if (existingSpendHashesProc) {
                        const currentBoostTarget = existingSpendHashesProc.args[1 + existingSpendHashesProc.args.indexOf("--spend-on-server")];
                        const isReducingSecurity = existingSpendHashesProc.args.includes("Reduce_Minimum_Security");
                        if (currentBoostTarget != bestServer || isReducingSecurity != shouldReduceMinSecurity) {
                            log(ns, `Killing a prior spend-hacknet-hashes.js process targetting ${currentBoostTarget} because ` +
                                (currentBoostTarget != bestServer ? `The new best income server is ${bestServer}.` : 'We no longer need to reduce minimum security.'), true);
                            await killScript(ns, 'spend-hacknet-hashes.js', null, existingSpendHashesProc);
                            existingSpendHashesProc = false;
                        }
                    }
                    if (!existingSpendHashesProc) { // 
                        log(ns, `Identified that the best hack income server is ${bestServer} worth ${formatMoney(gain)}/sec.`);
                        const spendHashesArgs = ["--liquidate", "--spend-on-server", bestServer, "--spend-on", "Increase_Maximum_Money"];
                        if (shouldReduceMinSecurity) spendHashesArgs.push("--spend-on", "Reduce_Minimum_Security");
                        launchScriptHelper(ns, 'spend-hacknet-hashes.js', spendHashesArgs);
                    }
                } else if (gain <= 1)
                    log_once(ns, `INFO: The best server (${bestServer})'s hack income multiplier (${formatNumber(gain)}) is currently too severely penalized ` +
                        `(< ${spendHashesMultThreshold}) to merit launching spend-hacknet-hashes.js to boost servers. (Configure with --spend-hashes-on-server-hacking-threshold)`);
                else
                    log(ns, `WARNING: strServerIncomeInfo was not empty, but could not determine best server:\n${strServerIncomeInfo}`);
            }
        }
        const existingDaemon = findScript(resolveScript('daemon'));
        let daemonArgs = []; // The args we currently want deamon to have
        let daemonRelaunchMessage; // Will hold any special messages we want to show the user if relaunching daemon.
        // If daemon.js is already running in --looping-mode, we should not restart it, because
        // TODO: currently daemon.js has no ability to kill it's loops on shutdown (so the next instance will be stuck with no RAM available)
        if (existingDaemon?.args.includes("--looping-mode"))
            daemonArgs = existingDaemon.args;
        else {
            // Determine the arguments we want to run daemon.js with. We will either pass these directly, or through stanek.js if we're running it first.
            const hackThreshold = options['high-hack-threshold']; // If player.skills.hacking level is about 8000, tweak daemon to increase income rates
            // When our hack level gets sufficiently high, hack/grow/weaken go so fast that spawning new scripts for each cycle becomes very
            // expensive / laggy. To help with this, daemon.js supports "looping mode", to just spawn one long-lived script that does H/G/W in a loop.
            if (false /* TODO: LOOPING MODE DISABLED UNTIL WORKING BETTER */ && player.skills.hacking >= hackThreshold) {
                daemonArgs = ["--looping-mode", "--cycle-timing-delay", 40, "--queue-delay", 2000, "--initial-max-targets", 61, "--silent-misfires",
                    "--recovery-thread-padding", Math.min(5.0, player.skills.hacking / hackThreshold)]; // Use more recovery thread padding as our hack level increases
                // Log a special notice if we're going to be relaunching daemon.js for this reason
                if (!existingDaemon || !(existingDaemon.args.includes("--looping-mode")))
                    daemonRelaunchMessage = `Hack level (${player.skills.hacking}) is >= ${hackThreshold} (--high-hack-threshold): Starting daemon.js in high-performance hacking mode.`;
            } else if (player.skills.hacking >= hackThreshold) { // "tight" mode. Tighter batches to increase income rate, at the cost of more frequent misfires
                daemonArgs = ["--cycle-timing-delay", 40, "--queue-delay", 50, "--silent-misfires",
                    "--recovery-thread-padding", Math.min(5.0, player.skills.hacking / hackThreshold)]; // Use more recovery thread padding as our hack level increases
            }
            else if (homeRam < 32) { // If we're in early BN 1.1 (i.e. with < 32GB home RAM), avoid squandering RAM
                daemonArgs.push("--no-share", "--initial-max-targets", 1);
            } else { // XP-ONLY MODE: We can shift daemon.js to this when we want to prioritize earning hack exp rather than money
                // Only do this if we aren't in --looping mode because TODO: currently it does not kill it's loops on shutdown, so they'd be stuck in hack exp mode
                // If xp-grind.js is available, it handles Daedalus/WD hack XP grinding FAR more
                // effectively (all servers, pure weaken). In that case, don't put daemon in --xp-only
                // mode — let daemon run normally for stock manipulation, rooting, etc.
                const xpGrindPath = resolveScript(resolveScript('xp-grind'));
                const xpGrindAvailable = ns.fileExists(xpGrindPath, 'home');
                // Don't put daemon in --xp-only when xp-grind handles it, OR during money phase
                const xpHandledExternally = xpGrindAvailable || xpCyclePhase === 'money';
                let useXpOnlyMode = !xpHandledExternally && (prioritizeHackForDaedalus || prioritizeHackForWd) ||
                    // In BNs that give no money for hacking (ScriptHackMoneyGain=0),
                    // skip --xp-only on daemon: xp-grind.js handles XP grinding in
                    // those BNs and daemon's hacking serves stock manipulation instead.
                    (bitNodeMults.ScriptHackMoney * bitNodeMults.ScriptHackMoneyGain == 0
                        && (bitNodeMults.FavorToDonateToFaction ?? 1) !== 0);
                if (!useXpOnlyMode && !xpHandledExternally) { // Only use periodic xp-mode if xp-grind.js isn't handling it
                    const xpInterval = Number(options['xp-mode-interval-minutes']);
                    const xpDuration = Number(options['xp-mode-duration-minutes']);
                    const minutesInAug = getTimeInAug() / 60.0 / 1000.0;
                    if (xpInterval > 0 && xpDuration > 0 && (minutesInAug % (xpInterval + xpDuration)) <= xpDuration)
                        useXpOnlyMode = true; // We're in the time window where we should focus hack exp
                    // If daemon.js was previously running in hack exp mode, prepare a message indicating that we 're switching back
                    else if (existingDaemon?.args.includes("--xp-only"))
                        daemonRelaunchMessage = `Time is up for "xp-mode", Relaunching daemon.js normally to focus on earning money for ${xpInterval} minutes (--xp-mode-interval-minutes)`;
                }
                if (useXpOnlyMode) {
                    daemonArgs.push("--xp-only", "--silent-misfires", "--no-share");
                    // If daemon.js isn't already running in hack exp mode, prepare a message to communicate the change
                    if (!existingDaemon?.args.includes("--xp-only"))
                        daemonRelaunchMessage = prioritizeHackForWd ? `We're close to the required hack level destroy the BN.` :
                            prioritizeHackForDaedalus ? `Hack Level is the only missing requirement for Daedalus, so we will run daemon.js in --xp-only mode to try and speed along the invite.` :
                                (bitNodeMults.ScriptHackMoney * bitNodeMults.ScriptHackMoneyGain == 0) ?
                                    `The current BitNode does not give any money from hacking, so we will run daemon.js in --xp-only mode.` :
                                    `Relaunching daemon.js to focus on earning Hack Experience for ${options['xp-mode-duration-minutes']} minutes (--xp-mode-duration-minutes)`;
                } else if (xpHandledExternally && (prioritizeHackForDaedalus || prioritizeHackForWd)) {
                    // xp-grind.js will handle XP grinding — daemon stays in normal mode
                    if (!existingDaemon?.args.includes("--xp-only") && existingDaemon)
                        daemonRelaunchMessage = null; // Don't relaunch daemon just because XP priority changed
                }
            }
            // Prevent daemon from starting "work-for-faction.js" since we now manage that script
            daemonArgs.push('--disable-script', getFilePath(resolveScript('work-for-factions')));
            // When hwgw-manager.js is installed:
            //   --skip-hwgw-exec-hosts  : daemon reads /Temp/hwgw-exec-hosts.txt and evicts its
            //                            own workers from those servers, then suppresses all
            //                            hack/grow/weaken scheduling while hwgw is active.
            //                            Default is already true in daemon, but we push it
            //                            explicitly so intent is clear and survives arg changes.
            //   --disable-stock-manipulation: hwgw-manager now owns stock manipulation via
            //                            unified scoring. Daemon passing {stock:true} on top
            //                            wastes manipulation budget and can fight the direction.
            if (ns.fileExists(getFilePath(resolveScript('hwgw-manager')), 'home')) {
                daemonArgs.push('--skip-hwgw-exec-hosts');
                daemonArgs.push('--disable-stock-manipulation');
            }
            // BN8 stock manipulation is now handled entirely by hwgw-manager.js
            // (unified scoring gives stock-linked servers full weight when hack income = 0).
            // daemon no longer needs --stock-manipulation-focus here.
            // Don't run the script to join and manage bladeburner if it is explicitly disabled
            if (options['disable-bladeburner']) daemonArgs.push('--disable-script', getFilePath(resolveScript('bladeburner')));
            // Relay the option to suppress tail windows
            if (options['no-tail-windows']) daemonArgs.push('--no-tail-windows');
            // Disable hacknet in BNs where its income multiplier is too low to matter.
            // HacknetNodeMoney < 0.5 means even fully upgraded nodes earn < 50% of BN1 rate —
            // the capital cost almost never recovers within an aug cycle.
            // BN9 (1.0) and BN12 (1.0) are the exceptions where hacknet is actually useful.
            // Can also be forced via --disable-hacknet flag regardless of BN.
            const hacknetMultiplier = bitNodeMults?.HacknetNodeMoney ?? 1;
            if (options['disable-hacknet'] || (hacknetMultiplier < 0.5 && resetInfo.currentNode !== 9)) {
                daemonArgs.push('--disable-hacknet');
            }
            // If we have SF4, but not level 3, instruct daemon.js to reserve additional home RAM
            if ((4 in unlockedSFs) && unlockedSFs[4] < 3)
                daemonArgs.push('--reserved-ram', 32 * ((unlockedSFs[4] ?? 0) == 2 ? 4 : 16));
        }
        // Once stanek's gift is accepted, launch it once per reset before we launch daemon (Note: stanek's gift is auto-purchased by faction-manager.js on your first install)
        let stanekRunning = (13 in unlockedSFs) && findScript('stanek.js') !== undefined;
        if ((13 in unlockedSFs) && !stanekLaunched && !stanekRunning && installedAugmentations.includes(augStanek)) {
            stanekLaunched = true; // Once we've know we've launched stanek once, we never have to again this reset.
            const stanekArgs = ["--on-completion-script", resolveScript('daemon')]
            if (options['no-tail-windows']) stanekArgs.push('--no-tail'); // Relay the option to suppress tail windows
            if (daemonArgs.length >= 0) stanekArgs.push("--on-completion-script-args", JSON.stringify(daemonArgs)); // Pass in all the args we wanted to run daemon.js with
            launchScriptHelper(ns, 'stanek.js', stanekArgs);
            stanekRunning = true;
        }
        // If stanek is running, tell daemon to reserve all home RAM for it.
        if (stanekRunning)
            daemonArgs.push("--reserved-ram", 1E100);
        // Launch (or re-launch) daemon if it is not already running with all our desired args.
        // Hack: Ignore numeric arguments in the comparison, since we e.g. tweak --recovery-thread-padding over time
        let launchDaemon = !existingDaemon || daemonArgs.some(arg => !existingDaemon.args.includes(arg) && !Number.isFinite(arg)) ||
            // Special cases: We also must relaunch daemon if it is running with certain flags we wish to remove
            (["--xp-only", "--disable-hacknet"].some(arg => !daemonArgs.includes(arg) && existingDaemon.args.includes(arg)))
        if (launchDaemon) {
            if (existingDaemon) {
                daemonRelaunchMessage ??= `Relaunching daemon.js with new arguments since the current instance doesn't include all the args we want.`;
                log(ns, daemonRelaunchMessage);
            }
            let daemonPid = launchScriptHelper(ns, resolveScript('daemon'), daemonArgs);
            daemonStartTime = Date.now();
            // Open the tail window if it's the start of a new BN. Especially useful to new players.
            if (getTimeInBitnode() < 1000 * 60 * 5 || homeRam == 8) // First 5 minutes, or BN1.1 where we have 8GB ram
                tail(ns, daemonPid);
        }
        // Default work for faction args we think are ideal for speed-running BNs
        const workForFactionsArgs = [
            "--fast-crimes-only" // Essentially means we do mug until we can do homicide, then stick to homicide
            // Disable the gang aug strip: the gang faction offers ~98 augs, which the strip removes from
            // every other faction's list, making them all appear complete with 0 remaining augs.
            // We still want to grind rep with those factions to buy their augs directly.
        ];
        // Pass through any explicitly skipped factions.
        // Use: run autopilot.js --skip-factions Aevum Sector-12 (etc.)
        // These are added to work-for-factions.js --skip, which prevents joining on invite
        // AND prevents working for them even if already joined.
        if (options['skip-factions']?.length > 0)
            workForFactionsArgs.push('--skip', ...options['skip-factions']);
        // Relay the options to suppress tail windows and ignore bladeburner
        if (options['no-tail-windows']) workForFactionsArgs.push('--no-tail-windows');
        if (options['disable-bladeburner']) workForFactionsArgs.push("--no-bladeburner-check")
        // The following args are ideal when running resolveScript('work-for-factions') to rush unlocking gangs (earn karma)
        const rushGangsArgs = workForFactionsArgs.concat(...[ // Everything above, plus...
            "--crime-focus", // Start off by trying to work for each of the crime factions (generally have combat reqs)
            "--training-stat-per-multi-threshold", 200, // Be willing to spend more time grinding for stats rather than skipping a faction
            "--prioritize-invites"]); // Don't actually start working for factions until we've earned as many invites as we think we can
        // If gangs are unlocked, micro-manage how resolveScript('work-for-factions') is running by killing off unwanted instances
        if (2 in unlockedSFs) {
            // Check if we've joined a gang yet. (Never have to check again once we know we're in one)
            if (!playerInGang) playerInGang = await getNsDataThroughFile(ns, 'ns.gang.inGang()');
            rushGang = !options['disable-rush-gangs'] && !playerInGang;
            // Detect if a resolveScript('work-for-factions') instance is running with args that don't match our goal. We aren't too picky,
            // (so the player can run with custom args), but should have --crime-focus if (and only if) we're still working towards a gang.
            const wrongWork = findScript(resolveScript('work-for-factions'), !rushGang ? s => s.args.includes("--crime-focus") :
                s => !rushGangsArgs.every(a => s.args.includes(a))); // Require all rushGangsArgs if we're not in a gang yet.
            // If running with the wrong args, kill it so we can start it with the desired args
            if (wrongWork) await killScript(ns, resolveScript('work-for-factions'), null, wrongWork);
            // Start gangs immediately (even though daemon would eventually start it) since we want any income they provide right away after an ascend
            // TODO: Consider monitoring gangs territory progress and increasing their budget / decreasing their reserve to help kick-start them
            if (playerInGang && !findScript(resolveScript('gangs')))
                launchScriptHelper(ns, resolveScript('gangs'));
        }
        // Launch work-for-factions if it isn't already running (rules for maybe killing unproductive instances are above)
        // Note: We delay launching our own resolveScript('work-for-factions') until daemon has warmed up, so we don't steal it's "kickstartHackXp" study focus
        if ((4 in unlockedSFs) && !findScript(resolveScript('work-for-factions')) && Date.now() - daemonStartTime > 30000) {
            // If we're trying to rush gangs, run in such a way that we will spend most of our time doing crime, reducing Karma (also okay early income)
            // NOTE: Default work-for-factions behaviour is to spend hashes on coding contracts, which suits us fine
            launchScriptHelper(ns, resolveScript('work-for-factions'), rushGang ? rushGangsArgs : workForFactionsArgs);
        }
        // Launch coding-contracts.js periodically to auto-solve .cct files found on network servers.
        // Requires SF4 (singularity) for getData/attempt API. Runs every 5 minutes; contracts spawn
        // roughly every 3-4 server restarts (~10-20 min) so this cadence catches them promptly.
        // RAM cost: ~12.5 GB per run (exits immediately after sweeping all servers).
        const contractScript = getFilePath('coding-contracts.js');
        const contractSweepInterval = 5 * 60 * 1000; // 5 minutes
        if ((4 in unlockedSFs) && ns.fileExists(contractScript, 'home')
                && !findScript('coding-contracts.js')
                && Date.now() - lastContractSweep > contractSweepInterval) {
            lastContractSweep = Date.now();
            launchScriptHelper(ns, contractScript, [], false);
        }
        // Launch hwgw-manager if conditions are met. It provides a true HWGW pipeline batcher that
        // significantly outperforms daemon.js's sequential batch model, particularly on high-RAM setups.
        // Conditions:
        //   1. Hacking must produce income in this BN (BN8 has ScriptHackMoneyGain = 0 — skip it there)
        //   2. At least one purchased server must exist to give workers an isolated execution pool
        //   3. Daemon must have warmed up (same 30s delay as work-for-factions, avoids startup RAM contention)
        //   4. The script itself must be present on home (graceful no-op if not installed yet)
        // HWGW viable check:
        //   BN8: ScriptHackMoneyGain=0 → hacking earns nothing for the player (stocks-only BN)
        //   BN2/3/9/11: effective hack income (ScriptHackMoney * ServerMaxMoney) < 2% of baseline
        //               → servers are too poor for HWGW prep to ever stabilise profitably
        const bnHackMoney      = bitNodeMults?.ScriptHackMoney    ?? 1;
        const bnHackMoneyGain  = bitNodeMults?.ScriptHackMoneyGain ?? 1;
        const bnServerMaxMoney = bitNodeMults?.ServerMaxMoney      ?? 1;
        const bnCloudLimit     = bitNodeMults?.CloudServerLimit    ?? 1;
        // hwgw-manager is viable when EITHER:
        //   a) hacking earns money this BN (normal income mode), OR
        //   b) stockmaster is running (manipulation-only mode, e.g. BN8).
        // The manager's unified scoring handles both cases internally —
        // no BN-specific branches here.
        const stockmasterRunning = !!findScript(resolveScript('stockmaster'));
        const hwgwViable = (bnHackMoney * bnHackMoneyGain > 0 &&
                            bnHackMoney * bnServerMaxMoney >= 0.02)
                        || stockmasterRunning;
        const hwgwScript = getFilePath(resolveScript('hwgw-manager'));
        if (hwgwViable && ns.fileExists(hwgwScript, 'home') && !findScript(resolveScript('hwgw-manager'))
                && Date.now() - daemonStartTime > 30000) {
            // In BN9, CloudServerLimit=0 means no purchased servers exist — hwgw-manager
            // runs in world-server-only mode and doesn't need a purchased server to start.
            // For all other BNs, require at least one server with RAM to act as exec host.
            let hasExecHosts = bnCloudLimit === 0; // BN9: world-only is fine, skip purchased check
            if (!hasExecHosts) {
                const execHostsRaw = ns.read('/Temp/hwgw-exec-hosts.txt');
                try {
                    hasExecHosts = execHostsRaw
                        ? JSON.parse(execHostsRaw).length > 0
                        : getAllRootedHosts_autopilot(ns).some(h =>
                            h !== 'home' && !h.startsWith('hacknet') && ns.getServerMaxRam(h) >= 8);
                } catch { hasExecHosts = false; }
            }
            if (hasExecHosts) {
                // Scale --min-money with hack level so low-level runs don't get locked out of
                // weaker servers, while high-level runs ignore junk targets automatically.
                const hackLvl = player.skills.hacking;
                const minMoney = hackLvl >= 1000 ? 1e9
                               : hackLvl >= 500  ? 1e8
                               : hackLvl >= 100  ? 1e7
                               : 0;
                const hwgwArgs = ['--quiet'];
                if (minMoney > 0) hwgwArgs.push('--min-money', minMoney);
                launchScriptHelper(ns, hwgwScript, hwgwArgs, false);
            }
        }
        // Auto-launch the NEXUS dashboard when home has enough RAM to spare.
        // 128 GB is the threshold — below that, the ~7 GB always-on cost is too steep
        // relative to the scripts competing for home RAM.
        const dashScript = getFilePath(resolveScript('dashboard'));
        // Use resolveScript('dashboard') (the same path findScript resolves via getFilePath)
        // NOT 'dashboard.js' — getFilePath('dashboard.js') resolves to a different path,
        // causing findScript to always return undefined → relaunches every loop.
        if (homeRam >= 128 && ns.fileExists(dashScript, 'home') && !findScript(resolveScript('dashboard'))) {
            launchScriptHelper(ns, dashScript, [], false);
        }
        // Auto-launch the darknet crawler once DarkscapeNavigator.exe is available.
        // DarkscapeNavigator.exe ($50M) is bought from darkweb by program-manager.js.
        // The crawler propagates workers across darknet and runs share loops on them.
        const crawlerScript = getFilePath(resolveScript('darknet-crawler'));
        if (ns.fileExists('DarkscapeNavigator.exe', 'home')
                && ns.fileExists(crawlerScript, 'home')
                && !findScript(resolveScript('darknet-crawler'))) {
            launchScriptHelper(ns, crawlerScript, ['--phish'], false);
        }
        // ── XP/Money Cycling State Machine ─────────────────────────────────────
        // Instead of grinding forever to reach hack 2500, alternate between
        // 30 min XP grinding and 30 min money-making. Each money phase, install
        // hacking augs → better mults → faster grind next cycle.
        //
        // States:
        //   'idle'     → normal autopilot. Enters 'grinding' when needHackXp triggers.
        //   'grinding' → xp-grind running. After 30 min without goal met → 'money'.
        //   'money'    → normal income. After 30 min with ≥1 aug affordable → install.
        //
        // TRP persists through aug resets (like all installed augs), so cycling is always safe.
        const trpInstalled = installedAugmentations.includes(augTRP) ||
            (wdHack != null && Number.isFinite(wdHack) && wdHack > 0);
        const needHackXp = prioritizeHackForDaedalus || prioritizeHackForWd ||
            (trpInstalled && player.skills.hacking < (wdHack ?? Infinity));
        const xpGrindScript = resolveScript(resolveScript('xp-grind'));
        const xpGrindExists = ns.fileExists(xpGrindScript, 'home');
        const xpGrindRunning = findScript(resolveScript('xp-grind'));
        const phaseElapsed = Date.now() - xpCyclePhaseStart;

        // Reset to idle if XP is no longer needed (e.g. Daedalus joined, BN complete)
        if (!needHackXp && xpCyclePhase !== 'idle') {
            log(ns, `INFO: XP cycle: goal met! Returning to idle.`, true, 'success');
            if (xpGrindRunning) {
                const xpProc = findScript(resolveScript('xp-grind'));
                if (xpProc) await getNsDataThroughFile(ns, 'ns.kill(ns.args[0])', null, [xpProc.pid]);
            }
            xpCyclePhase = 'idle';
            try { ns.write('/Temp/xp-grind-active.txt', '', 'w'); } catch {} // clear flag
            // Relaunch hwgw-manager immediately — it was killed when grinding started and
            // won't restart on its own until the next checkOnRunningScripts tick.
            if (hwgwViable && ns.fileExists(hwgwScript, 'home') && !findScript(resolveScript('hwgw-manager'))) {
                const hackLvl = player.skills.hacking;
                const minMoney = hackLvl >= 1000 ? 1e9 : hackLvl >= 500 ? 1e8 : hackLvl >= 100 ? 1e7 : 0;
                const hwgwArgs = ['--quiet'];
                if (minMoney > 0) hwgwArgs.push('--min-money', minMoney);
                log(ns, `INFO: XP cycle: goal met — launching hwgw-manager.`, false, 'info');
                launchScriptHelper(ns, hwgwScript, hwgwArgs, false);
            }
        }

        // ── State: IDLE → GRINDING (worthiness check) ──────────────────────────
        if (xpCyclePhase === 'idle' && needHackXp && xpGrindExists) {
            // Before committing to a grind cycle, estimate its value.
            // Grinding is a net negative if it's so fast it's trivial (HWGW is worth
            // more than a 10-second weaken loop), AND no aug rep milestone is close.
            //
            // estimatedMs: how long to gain targetLevels at current XP/s
            // repProximityBonus: extra levels to grind if a sleeve is close to
            //   unlocking a key XP aug (Neuregen etc.) — don't stop short of the finish line
            let estimatedMs = xpCycleDuration; // use last known estimate as initial guess
            let targetLevels = Math.min(10, Math.max(5, Math.ceil(((wdHack ?? 2500) - player.skills.hacking) * 0.02)));
            let repBonus = 0; // extra levels to push a sleeve over the aug rep threshold
            try {
                const statusRaw = ns.read('/Temp/xp-grind-status.txt');
                if (statusRaw && statusRaw !== '') {
                    const st = JSON.parse(statusRaw);
                    const xpPerSec = st.xpPerSec ?? 0;
                    const hackLvl  = st.hackLevel ?? player.skills.hacking;
                    if (xpPerSec > 0) {
                        const remaining = Math.max(1, (wdHack ?? 2500) - hackLvl);
                        // 2% of remaining levels, capped 5–20.
                        // Small enough that the grind exits quickly when XP is fast
                        // (n00dles finishes in seconds), meaningful when XP is slow.
                        targetLevels = Math.min(10, Math.max(5, Math.ceil(remaining * 0.02)));
                        const xpPerLevel = 175 * hackLvl;
                        const levelsPerSec = xpPerSec / xpPerLevel;
                        estimatedMs = (targetLevels / levelsPerSec) * 1000;

                        // Rep proximity: check if any XP faction sleeve is within
                        // striking distance of a key aug. If so, extend grind target
                        // by enough levels to give them meaningful extra time.
                        // Each grind level ≈ 1 weaken cycle worth of extra sleeve rep time.
                        // We estimate sleeve rep gain as ~1 rep/s (conservative) and
                        // check against the rep requirements of priority XP augs.
                        // Aug rep thresholds (from game source):
                        //   Neuregen: 37,500 rep   (Chongqing)
                        //   NeuralRetentionEnhancement: 20,000 rep  (NiteSec)
                        //   NeuralAccelerator: 25,000 rep  (BitRunners)
                        const XP_AUG_REP = { 'Chongqing': 37500, 'NiteSec': 20000,
                                              'BitRunners': 25000, 'The Black Hand': 25000 };
                        const facmanRaw = ns.read('/Temp/affordable-augs.txt');
                        if (facmanRaw && facmanRaw !== '') {
                            // affordable-augs doesn't contain current faction reps,
                            // but we can estimate from sleeve status:
                            // if Neuregen is already in affordable_augs, no bonus needed.
                            const fm = JSON.parse(facmanRaw);
                            const alreadyAffordable = new Set(fm.affordable_augs ?? []);
                            const alreadyOwned = new Set(fm.installed_augs ?? []);
                            // Check each XP faction we might have a sleeve grinding
                            for (const [faction, repReq] of Object.entries(XP_AUG_REP)) {
                                // Skip if aug already owned or affordable
                                const augName = faction === 'Chongqing' ? 'Neuregen'
                                    : faction === 'NiteSec' ? 'Neural Retention Enhancement'
                                    : 'Neural Accelerator';
                                if (alreadyAffordable.has(augName) || alreadyOwned.has(augName)) continue;
                                // If player has joined the faction, a sleeve may be grinding it.
                                // We can't read exact faction rep here without SF4 cost, but
                                // affordable-augs runs faction-manager which has this info.
                                // As a heuristic: if the aug appears in unpurchased_count context
                                // and we're in the XP cycle, assume the faction is being farmed
                                // and grant a 5-level bonus (≈ meaningful extra sleeve time).
                                // This is conservative — it doesn't extend grind by more than
                                // 5 levels unless estimatedMs is already long.
                                if ((player.factions ?? []).includes(faction)) {
                                    repBonus = Math.max(repBonus, 5);
                                }
                            }
                        }
                    }
                }
            } catch { /* use defaults */ }

            // Worthiness threshold: if grinding completes in < 90 seconds AND
            // no aug is affordable AND no rep bonus, it's not worth killing HWGW.
            // Allow up to 3 consecutive skips before forcing a grind anyway
            // (ensures augs don't get permanently deferred on fast machines).
            const facmanRaw2 = ns.read('/Temp/affordable-augs.txt');
            let affordableNow = 0;
            try { if (facmanRaw2) affordableNow = JSON.parse(facmanRaw2).affordable_count_ex_nf ?? 0; } catch {}

            const trivial = estimatedMs < 90_000 && repBonus === 0 && affordableNow === 0;
            if (trivial && xpCycleSkipCount < 3) {
                xpCycleSkipCount++;
                log(ns, `INFO: XP cycle: grinding would complete in ${(estimatedMs/1000).toFixed(1)}s — ` +
                    `not worth killing HWGW. Skipping (${xpCycleSkipCount}/3 before forced grind).`);
                // Don't enter grinding — stay idle and let HWGW keep running
            } else {
                xpCycleSkipCount = 0;
                // Compute the hack level we're targeting (level-gate exit)
                const startHack    = player.skills.hacking;
                const totalTargetLevels = Math.ceil(targetLevels + repBonus);
                xpCycleTargetHack  = startHack + totalTargetLevels;
                xpCycleStartAffordable = affordableNow;
                // Pre-compute duration for the money phase (same formula)
                xpCycleDuration = Math.min(XP_CYCLE_MAX_MS, Math.max(XP_CYCLE_MIN_MS, estimatedMs));
                xpCyclePhase = 'grinding';
                xpCyclePhaseStart = Date.now();
                try { ns.write('/Temp/xp-grind-active.txt', 'grinding', 'w'); } catch {}
                log(ns, `INFO: XP cycle: entering GRINDING. Target: hack ${startHack} → ${xpCycleTargetHack} ` +
                    `(+${totalTargetLevels} levels${repBonus > 0 ? `, incl. +${repBonus} rep-proximity bonus` : ''}). ` +
                    `Est: ${(estimatedMs/1000).toFixed(0)}s. Hack: ${startHack}`, true, 'info');
            }
        }

        // ── State: GRINDING ──
        if (xpCyclePhase === 'grinding') {
            // Launch xp-grind if not running
            if (!xpGrindRunning && xpGrindExists) {
                const hwgwProc = findScript(resolveScript('hwgw-manager'));
                if (hwgwProc) {
                    log(ns, `INFO: Killing hwgw-manager to free RAM for XP grinding.`);
                    await killScript(ns, resolveScript('hwgw-manager'), runningScripts, hwgwProc);
                    // Write '' (not '[]') so the hwgw-manager launch block's fallback host
                    // scan (getAllRootedHosts_autopilot) fires on the next tick. Writing '[]'
                    // is truthy so JSON.parse('[]').length > 0 === false, which permanently
                    // blocks the relaunch — hwgw-manager never restarts after XP grinding ends.
                    ns.write('/Temp/hwgw-exec-hosts.txt', '', 'w');
                    await ns.sleep(2000);
                }
                if ((10 in unlockedSFs) && (2 in unlockedSFs) && !findScript(resolveScript('sleeve')))
                    launchScriptHelper(ns, resolveScript('sleeve'), options['disable-bladeburner'] ? ['--disable-bladeburner'] : []);
                launchScriptHelper(ns, xpGrindScript, ['--reserve', 128], false); // no target arg → auto-selects optimal server
            }

            // ── Level-gate exit ──────────────────────────────────────────────
            // Exit once we've reached the target hack level (or the absolute cap).
            // Also update xpCycleDuration each tick so the money phase duration
            // stays calibrated to actual XP/s even as hack level rises.
            try {
                const statusRaw = ns.read('/Temp/xp-grind-status.txt');
                if (statusRaw && statusRaw !== '') {
                    const st = JSON.parse(statusRaw);
                    const xpPerSec = st.xpPerSec ?? 0;
                    const hackLvl  = st.hackLevel ?? player.skills.hacking;
                    if (xpPerSec > 0) {
                        const remaining    = Math.max(1, (wdHack ?? 2500) - hackLvl);
                        const targetLvls2  = Math.min(10, Math.max(5, Math.ceil(remaining * 0.02)));
                        const xpPerLevel   = 175 * hackLvl;
                        const levelsPerSec = xpPerSec / xpPerLevel;
                        xpCycleDuration = Math.min(XP_CYCLE_MAX_MS,
                            Math.max(XP_CYCLE_MIN_MS, (targetLvls2 / levelsPerSec) * 1000));
                    }
                }
            } catch { /* keep current estimate */ }

            const hackGoalMet = xpCycleTargetHack > 0 && player.skills.hacking >= xpCycleTargetHack;
            const timedOut    = phaseElapsed >= XP_CYCLE_MAX_MS;
            // Early exit if new augs became affordable during the grind
            // (e.g. a sleeve crossed a faction rep threshold mid-grind).
            let newAugsAvailable = false;
            try {
                const fmr = ns.read('/Temp/affordable-augs.txt');
                if (fmr) newAugsAvailable = (JSON.parse(fmr).affordable_count_ex_nf ?? 0) > xpCycleStartAffordable;
            } catch {}

            if (hackGoalMet || timedOut || newAugsAvailable) {
                const reason = newAugsAvailable ? `new aug(s) became affordable mid-grind`
                    : hackGoalMet ? `hack ${player.skills.hacking} reached target ${xpCycleTargetHack}`
                    : `45-min cap hit (hack: ${player.skills.hacking}/${xpCycleTargetHack})`;
                log(ns, `INFO: XP cycle: grinding done — ${reason}. ` +
                    `Elapsed: ${(phaseElapsed/1000).toFixed(0)}s. Switching to MONEY phase.`, true, 'info');
                if (xpGrindRunning) {
                    const xpProc = findScript(resolveScript('xp-grind'));
                    if (xpProc) await getNsDataThroughFile(ns, 'ns.kill(ns.args[0])', null, [xpProc.pid]);
                }
                xpCyclePhase = 'money';
                xpCyclePhaseStart = Date.now();
                try { ns.write('/Temp/xp-grind-active.txt', 'money', 'w'); } catch {}

                // Immediately relaunch hwgw-manager now that XP grinding is done and RAM is free.
                // The general launch block can't do this reliably on its own because it checks
                // execHostsRaw — which was cleared to '' above when grinding started — and won't
                // see any hosts until hwgw-manager itself writes them on startup.
                // Launching it here is the earliest possible moment: xp-grind is dead, RAM is free.
                if (hwgwViable && ns.fileExists(hwgwScript, 'home') && !findScript(resolveScript('hwgw-manager'))) {
                    const hackLvl = player.skills.hacking;
                    const minMoney = hackLvl >= 1000 ? 1e9
                                   : hackLvl >= 500  ? 1e8
                                   : hackLvl >= 100  ? 1e7
                                   : 0;
                    const hwgwArgs = ['--quiet'];
                    if (minMoney > 0) hwgwArgs.push('--min-money', minMoney);
                    log(ns, `INFO: XP cycle: launching hwgw-manager for money phase.`, false, 'info');
                    launchScriptHelper(ns, hwgwScript, hwgwArgs, false);
                }
            }
        }

        // ── State: MONEY ──
        if (xpCyclePhase === 'money') {
            // xp-grind should NOT be running in money phase
            if (xpGrindRunning) {
                const xpProc = findScript(resolveScript('xp-grind'));
                if (xpProc) await getNsDataThroughFile(ns, 'ns.kill(ns.args[0])', null, [xpProc.pid]);
            }

            // Money phase also uses the same adaptive duration.
            // (xpCycleDuration was set at the end of the last grind phase)
            if (phaseElapsed >= xpCycleDuration) {
                const facman = ns.read('/Temp/affordable-augs.txt');
                let affordableCount = 0;
                try {
                    if (facman) affordableCount = JSON.parse(facman).affordable_count ?? 0;
                } catch {}

                if (affordableCount >= 1) {
                    log(ns, `INFO: XP cycle: 30 min money phase done. ${affordableCount} aug(s) affordable. ` +
                        `Triggering install for hacking boost.`, true, 'info');
                    // Force a quick install by setting install countdown to now
                    installCountdown = Date.now();
                    reservedPurchase = 1; // Trigger the install logic in maybeInstallAugmentations
                    xpCyclePhase = 'idle'; // Reset — autopilot will re-enter grinding after install
                } else {
                    log(ns, `INFO: XP cycle: 30 min money phase done but no augs affordable. Back to grinding.`, true, 'info');
                    // Kill hwgw-manager proactively so grinding starts with full RAM on the very
                    // next tick, rather than waiting for the grinding block to kill it one tick later.
                    const hwgwProcMoney = findScript(resolveScript('hwgw-manager'));
                    if (hwgwProcMoney) {
                        log(ns, `INFO: Killing hwgw-manager to free RAM for XP grinding.`);
                        await killScript(ns, resolveScript('hwgw-manager'), runningScripts, hwgwProcMoney);
                        ns.write('/Temp/hwgw-exec-hosts.txt', '', 'w');
                        await ns.sleep(2000);
                    }
                    xpCyclePhase = 'grinding';
                    xpCyclePhaseStart = Date.now();
                }
            }
        }
    }
    /** Get the source of the player's earnings by category.
     * @param {NS} ns
     * @returns {Promise<MoneySources>} */
    async function getPlayerMoneySources(ns) {
        return await getNsDataThroughFile(ns, 'ns.getMoneySources()');
    }
    /** Accept Stanek's gift immediately at the start of the BN (as opposed to just before the first install)
     * if it looks like it will scale well.
     * @param {NS} ns
     * @param {Player} player */
    async function maybeAcceptStaneksGift(ns, player) {
        // Look for any reason not to accept stanek's gift (do the quickest checks first)
        if (acceptedStanek) return;
        // Don't get Stanek's gift too early if its size is reduced in this BN
        if (bitNodeMults.StaneksGiftExtraSize < 0) return;
        // If Stanek's gift size isn't reduced, but is penalized, don't get it too early 
        if (bitNodeMults.StaneksGiftExtraSize == 0 && bitNodeMults.StaneksGiftPowerMultiplier < 1) return;
        // Otherwise, it is not penalized in any way, it's probably safe to get it immediately despite the 10% penalty to all stats
        // If we won't have access to Stanek yet, skip this
        if (!(13 in unlockedSFs)) return;
        // If we've already accepted Stanek's gift (Genesis aug is installed), skip
        if (installedAugmentations.includes(augStanek)) return acceptedStanek = true;
        // If we have more than Neuroflux (aug) installed, we won't be allowed to accept the gift (but we can try)
        if (installedAugmentations.length > 1)
            log(ns, `WARNING: We think it's a good idea to accept Stanek's Gift, but it appears to be too late - other augmentations have been installed. Trying Anyway...`);
        // Use the API to accept Stanek's gift
        if (await getNsDataThroughFile(ns, 'ns.stanek.acceptGift()')) {
            log(ns, `SUCCESS: Accepted Stanek's Gift!`, true, 'success');
            installedAugmentations.push(augStanek); // Manually add Genesis to installed augmentations so checkOnRunningScripts picks up on the change.
        } else
            log(ns, `WARNING: autopilot.js tried to accepted Stanek's Gift, but was denied.`, true, 'warning');
        // Whether we succeded or failed, don't try again - if we're denied entry (due to having an augmentation) we will never be allowed in
        acceptedStanek = true;
    }
    /** Logic to steal 10b from the casino
     * @param {NS} ns
     * @param {Player} player */
    async function maybeDoCasino(ns, player) {
        if (ranCasino || options['disable-casino']) return;
        // Figure out whether we've already been kicked out of the casino for earning more than 10b there
        const moneySources = await getPlayerMoneySources(ns);
        const casinoEarnings = moneySources.sinceInstall.casino;
        if (casinoEarnings >= 1e10) {
            log(ns, `INFO: Skipping running casino.js, as we've previously earned ${formatMoney(casinoEarnings)} and been kicked out.`);
            return ranCasino = true;
        }
        // If we already have more than 1t money but hadn't run casino.js yet, don't bother. Another 10b won't move the needle much.
        const playerWealth = player.money + (await getStocksValue(ns));
        if (playerWealth >= 1e12) {
            log(ns, `INFO: Skipping running casino.js, since we're already ridiculously wealthy (${formatMoney(playerWealth)} > 1t).`);
            return ranCasino = true;
        }
        // If we're making more than ~5b / minute from the start of the BN, there's no need to run casino.
        // In BN8 this is impossible, so in that case we don't even check and head straight to the casino.
        if (resetInfo.currentNode != 8) {
            // If we've been in the BN for less than 1 minute, wait a while to establish player's income rate 
            if (getTimeInAug() < 60000)
                return log_once(ns, `INFO: Waiting a minute to establish player income before deciding whether casino.js is needed.`);
            // Since it's possible that the CashRoot Startker Kit could give a false income velocity, account for that.
            const cashRootBought = installedAugmentations.includes(`CashRoot Starter Kit`);
            const incomePerMs = (playerWealth - (cashRootBought ? 1e6 : 0)) / getTimeInAug();
            const incomePerMinute = incomePerMs * 60_000;
            if (incomePerMinute >= 5e9) {
                log(ns, `INFO: Skipping running casino.js this augmentation, since our income (${formatMoney(incomePerMinute)}/min) >= 5b/min`);
                return ranCasino = true;
            }
        }
        // If we aren't in Aevum already, wait until we have the 200K required to travel (plus some extra buffer to actually spend at the casino)
        if (player.city != "Aevum" && player.money < 300000)
            return log_once(ns, `INFO: Waiting until we have ${formatMoney(300000)} to travel to Aevum and run casino.js`);
        // Run casino.js (and expect this script to get killed in the process)
        // Make sure resolveScript('work-for-factions') is dead first, lest it steal focus and break the casino script before it has a chance to kill all scripts.
        await killScript(ns, resolveScript('work-for-factions'));
        await killScript(ns, resolveScript('daemon')); // We also have to kill daemon which can make us study.
        // Kill any action, in case we are studying or working out, as it might steal focus or funds before we can bet it at the casino.
        if (4 in unlockedSFs) // No big deal if we can't, casino.js has logic to find the stop button and click it.
            _ = await getNsDataThroughFile(ns, `ns.singularity.stopAction()`);
        const pid = launchScriptHelper(ns, 'casino.js', ['--kill-all-scripts', true, '--on-completion-script', ns.getScriptName()]);
        if (pid) {
            await waitForProcessToComplete(ns, pid);
            await ns.sleep(10000); // Give time for this script to be killed if the game is being restarted by casino.js
            // Otherwise, something went wrong
            log(ns, `ERROR: Something went wrong. casino.js was run, but we haven't been killed. It must have run into a problem...`)
        }
    }
    /** Retrieves the last faction manager output file, parses, and provides type-hints for it.
     * @returns {{ installed_augs: string[], installed_count: number, installed_count_nf: number, installed_count_ex_nf: number,
     *             owned_augs: string[], owned_count: number, owned_count_nf: number, owned_count_ex_nf: number,
     *             awaiting_install_augs: string[], awaiting_install_count: number, awaiting_install_count_nf: number, awaiting_install_count_ex_nf: number,
     *             affordable_augs: string[], affordable_count: number, affordable_count_nf: number, affordable_count_ex_nf: number,
     *             total_rep_cost: number, total_aug_cost: number, unowned_count: number }} */
    function getFactionManagerOutput(ns) {
        const facmanOutput = ns.read(factionManagerOutputFile)
        return !facmanOutput ? null : JSON.parse(facmanOutput)
    }
    /** Logic to detect if it's a good time to install augmentations, and if so, do so
     * @param {NS} ns
     * @param {Player} player */
    async function maybeInstallAugmentations(ns, player) {
        if (!(4 in unlockedSFs))  // Cannot automate augmentations or installs without singularity
            return setStatus(ns, `No singularity access, so you're on your own. You should manually work for factions and install augmentations!`);
        // If we previously attempted to reserve money for an augmentation purchase order, do a fresh facman run to ensure it's still available
        if (reservedPurchase && installCountdown <= Date.now()) {
            log(ns, "INFO: Manually running faction-manager.js to ensure previously reserved purchase is still obtainable.");
            ns.write(factionManagerOutputFile, "", "w"); // Reset the output file to ensure it isn't stale
            const pid = launchScriptHelper(ns, 'faction-manager.js');
            await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down (and output to be generated)
        }
        // Grab the latest output from faction manager to see if it's a good time to reset
        const facman = getFactionManagerOutput(ns);
        if (!facman) {
            setStatus(ns, `Faction manager output not available. Will try again later.`);
            return reservedPurchase = 0;
        }
        playerInstalledAugCount = facman.installed_count; // Augmentations bought *and installed* by the player (used for Daedalus requirement)
        // If we're in BN9 (where hacknet is most important) and we're still on our first reset (where we have an upgraded hacknet node), resist installing
        const inFirstBn9Aug = resetInfo.currentNode == 9 && Math.abs(resetInfo.lastNodeReset - resetInfo.lastAugReset) < 1000;
        // Reduce the augmentations required to reset over time, except in cetain situations. This is because in most situations,
        // pefoming an ascention in a slow-going BN will let us lock in bonuses that will speed up overall pogression.
        let reducedAugReq = Math.floor(options['reduced-aug-requirement-per-hour'] * getTimeInAug() / 3.6E6);
        // In our first BN9 augmentation and in BN8, use this mechanic to actually *increase* aug count requirements.
        if (inFirstBn9Aug || resetInfo.currentNode == 8) // In BN8, no reset bonuses are possible, and we'd lose our stock progress
            reducedAugReq = -2; // In our first BN9 augmentation, delay resetting as we'd lose our boosted hacknet server
        // Collect additional information about how many augmentations we need before it's worth resetting, based on the current configuration
        const sf11Level = dictOwnedSourceFiles[11] ?? 0; // SF11 makes augs scale cheaper, so for each level, require +1 augs
        const augsNeeded = Math.max(1, options['install-at-aug-count'] + sf11Level - reducedAugReq);
        const augsNeededInclNf = Math.max(1, options['install-at-aug-plus-nf-count'] + sf11Level - reducedAugReq);
        // Get a count of pending augmentations (augs we plan to buy, plus any we've bought but not yet installed)
        const pendingAugCount = facman.affordable_count_ex_nf + facman.awaiting_install_count_ex_nf; // Excludes neuroflux levels
        const pendingNfCount = facman.affordable_count_nf + facman.awaiting_install_count_nf; // Only neuroflux levels
        const pendingAugInclNfCount = pendingAugCount + pendingNfCount; // Includes neuroflux levels
        // Create a list of augmentations pending install or pending puchase to display. Group all nf augs into one.
        const strNF = "NeuroFlux Governor"
        let augsToInstall = facman.awaiting_install_augs.filter(aug => aug != strNF)
            .concat(...facman.affordable_augs.filter(aug => aug != strNF));
        if (pendingNfCount > 0)
            augsToInstall.push(`${strNF} (x${pendingNfCount})`)
        // Determine whether we can afford enough augmentations to merit a reset
        let totalCost = facman.total_rep_cost + facman.total_aug_cost;
        const augSummary = `${pendingAugCount} of ${facman.unpurchased_count - 1} remaining augmentations` + // Unowned - 1 because we can always buy more Neuroflux
            (pendingNfCount > 0 ? ` + ${pendingNfCount} levels of NeuroFlux.` : '.') +
            (pendingAugCount > 0 ? `\n    Augs: [\"${augsToInstall.join("\", \"")}\"]` : '');
        let resetStatus = `Reserving ${formatMoney(totalCost)} to install ${augSummary}`
        let shouldReset = options['install-for-augs'].some(a => facman.affordable_augs.includes(a)) ||
            pendingAugCount >= augsNeeded || pendingAugInclNfCount >= augsNeededInclNf;
        // If we are in Daedalus, and we do not yet have enough favour to unlock rep donations with Daedalus,
        // but we DO have enough rep to earn that favor on our next restart, trigger an install immediately (need at least 1 aug)
        // (doesn't apply in BN8, since we can immediately donate to all factions)
        if (
            player.factions.includes("Daedalus") &&
            bitNodeMults.FavorToDonateToFaction !== 0 &&
            ns.read("/Temp/Daedalus-donation-rep-attained.txt")
        ) {
            shouldReset = true;
            resetStatus = `We have enough reputation with Daedalus to unlock donations on our next reset.\n${resetStatus}`;
            if (totalCost == 0) totalCost = 1; // Hack, logic below expects some non-zero reserve in preparation for ascending.
        }
        // Heuristic: if we can afford 4 or more augs in the first ~20 minutes, it's usually worth doing a "quick install"
        // For example, in BN8, we get a big cash influx on each reset and can buy reputation immediately, so it's worth
        //     doing an few immediate installs to purchase upgrades, then reset for more free cash.
        // When in a gang, require a more augs and don't countdown as quickly, since each reset reduces gang member ascention multipliers
        const quickInstallThreshold = playerInGang ? 6 : 4;
        if (!inFirstBn9Aug && (
            (getTimeInAug() < 20 * 60 * 1000 && pendingAugInclNfCount >= quickInstallThreshold) ||
            // Heuristic: In BN8, reinstall repeatedly for the first 10 minutes to purchase every little thing we can with our flat 10B casino winnings
            (resetInfo.currentNode == 8 && getTimeInBitnode() < 10 * 60 * 1000))) {
            shouldReset = true;
            resetStatus = `We haven't been in this reset for long. We can do a quick reset immediately for a quick stat boost.\n${resetStatus}`;
            if (options['install-countdown'] > 30 * 1000 && !playerInGang)
                options['install-countdown'] = 30 * 1000; // Install relatively quickly in this scenario (30s)
        }
        // If not ready to reset, set a status with our progress and return
        if (!shouldReset) {
            setStatus(ns, `Currently at ${formatDuration(getTimeInAug())} since last aug. ` +
                `Waiting for ${augsNeeded} new augs (or ${augsNeededInclNf} including NeuroFlux levels) before installing.` +
                `\nCan currently get: ${augSummary}` + (pendingAugCount == 0 ? '' : `\n  Total Cost: ${formatMoney(totalCost)}`) +
                ` (\`run faction-manager.js\` for details)`, augSummary);
            return reservedPurchase = 0; // If we were previously reserving money for a purchase, reset that flag now
        }
        // If we want to reset, but there is a reason to delay, don't reset
        if (await shouldDelayInstall(ns, player, facman)) // If we're currently in a state where we should not be resetting, skip reset logic
            return reservedPurchase = 0;
        // Ensure the money needed for the above augs doesn't get ripped out from under us by reserving it
        if (reservedPurchase < totalCost) {
            // A countdown is displayed to give the user a heads up, and give us time to potentially earn money for more augmentations
            if (reservedPurchase == 0)
                installCountdown = Date.now() + options['install-countdown'];
            else { // If we were already reserving for a purchase and the number went up, log a notice of the timer being reset.
                let purchaseChangeLog = `INFO: The augmentation purchase we can afford has increased from ${formatMoney(reservedPurchase)} to ${formatMoney(totalCost)}.`
                // First, check if we're ready to install TRP - if so, don't delay the install for any additional augmentations.
                if (!augsToInstall.includes(augTRP)) {
                    // Otherwise, each time we can afford more augs, reset the install delay timer to take advantage of "momentum"
                    // and potentially purchase many more augmentations in this reset. To avoid delaying an install indefinitely,
                    // we reduce the additional time we're willing to wait a little bit each time this happens.
                    installCountdownResets++;
                    const newCountDown = Date.now() + Math.max(10 * 1000, // At a bare minimum, wait 10 more seconds
                        // Heuristic: Linearly reduce the cooldown until we have doubled the aug count needed.
                        options['install-countdown'] * (1 - (installCountdownResets / augsNeededInclNf)));
                    if (newCountDown > installCountdown) { // If the existing countdown remaining was longer than this, leave it be
                        installCountdown = newCountDown;
                        purchaseChangeLog = purchaseChangeLog + ' Resetting the timer before we install augmentations.'
                    }
                }
                log(ns, purchaseChangeLog, true);
            }
            ns.write("reserve.txt", totalCost, "w"); // Should prevent other scripts from spending this money
        }
        // We must wait until the configured cooldown elapses before we install augs.
        if (installCountdown > Date.now()) {
            resetStatus += `\n  Waiting for ${formatDuration(options['install-countdown'])} (--install-countdown) ` +
                `to elapse before we install, in case we're close to being able to purchase more augmentations...`;
            setStatus(ns, resetStatus);
            ns.toast(`Heads up: Autopilot plans to reset in ${formatDuration(installCountdown - Date.now())}`, 'info');
            return reservedPurchase = totalCost;
        }
        // Otherwise, we've got the money reserved, we can afford the augs, we should be confident to ascend
        const resetLog = `  Invoking ascend.js at ${formatDuration(getTimeInAug()).padEnd(11)} since last aug to install: ${augSummary}`;
        persist_log(ns, log(ns, resetLog, true, 'info'));
        // Kick off ascend.js
        let errLog;
        const ascendArgs = ['--install-augmentations', true, '--on-reset-script', ns.getScriptName()]
        if (pendingAugInclNfCount == 0) // If we know we would install 0 augs, but still wish to reset, we must enable soft resetting
            ascendArgs.push("--allow-soft-reset")
        let pid = launchScriptHelper(ns, 'ascend.js', ascendArgs);
        if (pid) {
            await waitForProcessToComplete(ns, pid, true); // Wait for the script to shut down (Ascend should get killed as it does, since the BN will be rebooting)
            await ns.sleep(1000); // If we've been scheduled to be killed, awaiting an NS function should trigger it?
            errLog = `ERROR: ascend.js ran, but we're still here. Something must have gone wrong. Will try again later`;
        } else
            errLog = `ERROR: Failed to launch ascend.js (pid == 0). Will try again later`;
        // If we got this far, something went wrong
        persist_log(ns, log(ns, errLog, true, 'error'));
    }
    /** Logic to detect if we are close to a milestone and should postpone installing augmentations until it is hit
     * @param {NS} ns
     * @param {Player} player
     * @param {{ installed_augs: string[], installed_count: number, installed_count_nf: number, installed_count_ex_nf: number,
     *           owned_augs: string[], owned_count: number, owned_count_nf: number, owned_count_ex_nf: number,
     *           awaiting_install_augs: string[], awaiting_install_count: number, awaiting_install_count_nf: number, awaiting_install_count_ex_nf: number,
     *           affordable_augs: string[], affordable_count: number, affordable_count_nf: number, affordable_count_ex_nf: number,
     *           total_rep_cost: number, total_aug_cost: number, unowned_count: number }} facmanOutput
    */
    async function shouldDelayInstall(ns, player, facmanOutput) {
        // Don't install if we're currently grafting an augmentation
        if (await checkIfGrafting(ns))
            return true;
        // Are we close to being able to afford 4S TIX data?
        if (!have4STixApi) have4STixApi = await getNsDataThroughFile(ns, `ns.stock.has4SDataTixApi()`);
        if (!options['disable-wait-for-4s'] && !have4STixApi) {
            if (!have4SData) have4SData = await getNsDataThroughFile(ns, `ns.stock.has4SData()`);
            const totalWorth = player.money + await getStocksValue(ns);
            const totalCost = 25E9 * bitNodeMults.FourSigmaMarketDataApiCost +
                (have4SData ? 0 : 1E9 * bitNodeMults.FourSigmaMarketDataCost);
            const ratio = totalWorth / totalCost;
            // If we're e.g. 50% of the way there, hold off, regardless of the '--wait-for-4s' setting
            // TODO: If ratio is > 1, we can afford it - but stockmaster won't buy until it has e.g. 20% more than the cost
            //       (so it still has money to invest). It doesn't know we want to restart ASAP. Perhaps we should purchase ourselves?
            if (ratio >= options['wait-for-4s-threshold']) {
                setStatus(ns, `Not installing until scripts purchase the 4SDataTixApi because we have ` +
                    `${(100 * totalWorth / totalCost).toFixed(0)}% of the cost (controlled by --wait-for-4s-threshold)`);
                return true;
            }
        }
        if (resetInfo.currentNode == 8) { // Many special rules for this special Bitnode
            if (player.factions.includes("Daedalus")) { // If we've already joined Daedalus
                // In BN8, large sums of money are hard to accumulate, so if we've made it into Daedalus, but can't purchase TRP rep yet,
                // remain in the BN until we have enough rep and/or money to buy TRP (Reminder: in BN8, donations are immediately unlocked for all factions)    
                if (!installedAugmentations.includes(augTRP) && !facmanOutput.affordable_augs.includes(augTRP) && !facmanOutput.awaiting_install_augs.includes(augTRP)) {
                    setStatus(ns, `We're in Daedalus, so we won't install until we can afford to purchase "${augTRP}".`);
                    return true;
                }
            } else if (playerInstalledAugCount >= bitNodeMults.DaedalusAugsRequirement && player.skills.hacking >= (2500 * 0.9)) {
                // If we meet the Daedalus aug count requirement and at least 90% of the required hack level, wait to earn the invite
                setStatus(ns, `Not installing because we're in BN8 and we have enough augs and ` + (player.skills.hacking < 2500 ? 'nearly ' : '')
                    + 'enough hack level to get invited to Daedalus once we hit $100b.');
                return true;
            } else if (getTimeInAug() > 4 * 60 * 60 * 1000) { // 4 hours = 4hrs/min * 60mins/sec * 60secs/ms * 1000ms
                // If we've been in BN8 for more than 4 hours, we shouldn't reset unless we're making significant progress towards unlocking Daedalus.
                // because it takes so long to build up money, and nothing we install will accellerate our earnings in the next augmentation.
                const augsReadyToInstall = facmanOutput.awaiting_install_count_ex_nf + facmanOutput.affordable_count_ex_nf;
                if (augsReadyToInstall < 10) { // Heuristic: 10 augs per install means max 3 installs before we meet the Daedalus aug requirement
                    setStatus(ns, `Not installing because we've in BN8 for more than 4 hours (~${Math.round(getTimeInAug() / 1000 / 60 / 60)}h) and aren't in Daedalus yet, ` +
                        `so our threshold is at least 10 new augs installed to merit resetting (currently at ${augsReadyToInstall}).`);
                    return true;
                }
            }
        }
        // If we're reserving money because we're close to getting an invite to Daedalus don't reset.
        if (reservingMoneyForDaedalus) {
            setStatus(ns, `Not installing since we are close to earning an invite from Daedalus.`);
            return true;
        }
        // In BN10, it takes a while to build up the 100q needed to purchase the last sleeve, so don't reset if we're close
        if (resetInfo.currentNode == 10 && player.money >= 10e15 && !sleevesMaxedOut) { // Heuristic: If we hit 10q (10% the cost of the last sleeve) before an install, we can probably go all the way
            setStatus(ns, `Not installing anymore since we are nearing the 100q needed to purchase the 6th sleeve from the Covenant.`);
            return true;
        }
        // TODO: Bladeburner black-op in progress
        // TODO: Close to the rep needed for unlocking donations with a new faction?
        return false;
    }
    let wasGrafting = false;
    /** Checks if we are current grafting. If so, certain actions should not be taken.
     * @param {NS} ns
     * @returns {bool} true if the player is grafting, false otherwise. */
    async function checkIfGrafting(ns) {
        let currentWork = (/**@returns{Task|null}*/() => null)();
        currentWork = await getNsDataThroughFile(ns, 'ns.singularity.getCurrentWork()');
        // Never interrupt grafting
        if (currentWork?.type == "GRAFTING") {
            if (!wasGrafting) // Only log the first time we detect we've started grafting
                log(ns, "Grafting in progress. autopilot.js will make sure to not install augmentations or otherwise interrupt it.");
            return wasGrafting = true;
        }
        else
            return wasGrafting = false
    }
    /** Consolidated logic for all the times we want to reserve money
     * @param {NS} ns
     * @param {Player} player */
    function manageReservedMoney(ns, player, stocksValue) {
        if (reservedPurchase) return; // Do not mess with money reserved for installing augmentations
        const currentReserve = Number(ns.read("reserve.txt") || 0);
        if (reservingMoneyForDaedalus) // Reserve 100b to get the daedalus invite
            return currentReserve == 100E9 ? true : ns.write("reserve.txt", 100E9, "w");
        // Otherwise, reserve money for stocks for a while, as it's our main source of income early in the BN
        // It also acts as a decent way to save up for augmentations
        const minStockValue = 8E9; // At a minimum 8 of the 10 billion earned from the casino must be reserved for buying stock
        // As we earn more money, reserve a percentage of it for further investing in stock. Decrease this as the BN progresses.
        const minStockPercent = Math.max(0, 0.8 - 0.1 * getTimeInBitnode() / 3.6E6); // Reduce by 10% per hour in the BN
        const reserveCap = 1E12; // As we start start to earn crazy money, we will hit the stock market cap, so cap the maximum reserve
        // Dynamically update reserved cash based on how much money is already converted to stocks.
        const reserve = Math.min(reserveCap, Math.max(0, player.money * minStockPercent, minStockValue - stocksValue));
        return currentReserve == reserve ? true : ns.write("reserve.txt", reserve, "w"); // Reserve for stocks
        // NOTE: After several iterations, I decided that the above is actually best to keep in all scenarios:
        // - Casino.js ignores the reserve, so the above takes care of ensuring our casino seed money isn't spent
        // - In low-income situations, stockmaster will be our best source of income. We invoke it such that it ignores
        //	 the global reserve, so this 8B is for stocks only. The 2B remaining is plenty to kickstart the rest.
        // - Once high-hack/gang income is achieved, this 8B will not be missed anyway.
        /*
        if(!ranCasino) {
            ns.write("reserve.txt", 300000, "w"); // Prevent other scripts from spending our casino seed money
            return moneyReserved = true;
        }
        // Otherwise, clear any reserve we previously had
        if(moneyReserved) ns.write("reserve.txt", 0, "w"); // Remove the casino reserve we would have placed
        return moneyReserved = false;
        */
    }
    /** Logic to determine whether we should keep running, or shut down autopilot.js for some reason.
     * @param {NS} ns
     * @returns {boolean} true if we should keep running. False if we should shut down this script. */
    function shouldWeKeepRunning(ns) {
        if (4 in unlockedSFs)
            return true; // If we have SF4 - run always
        // If we've gotten daemon.js launched, but only have 8GB ram, we must shut down for now
        if (homeRam == 8 && daemonStartTime > 0) {
            log(ns, `WARN: (not an actual warning, just trying to make this message stand out.)` +
                `\n` + '-'.repeat(100) +
                `\n\n  Welcome to bitburner and thanks for using my scripts!` +
                `\n\n  Currently, your available RAM on home (8 GB) is too small to keep autopilot.js running.` +
                `\n  The priority should just be to run resolveScript('daemon') for a while until you have enough money to` +
                `\n  purchase some home RAM (which you must do manually at a store like [alpha ent.] in the city),` +
                `\n\n  Once you have more home ram, feel free to 'run ${ns.getScriptName()}' again!` +
                `\n\n` + '-'.repeat(100), true);
            return false; // Daemon.js needs more room to breath
        }
        // Otherwise, keep running
        return true;
    }
    /** Helper to launch a script and log whether if it succeeded or failed
     * @param {NS} ns */
    /** Lightweight BFS used only to detect whether any purchased servers exist.
     * Called by the hwgw-manager launch check as a fallback when the exec-hosts
     * file hasn't been written yet (i.e. on the very first manager startup).
     * Kept local to avoid importing ns.getPurchasedServers() cost into autopilot. */
    function getAllRootedHosts_autopilot(ns) {
        const visited = new Set(), queue = ["home"], hosts = [];
        while (queue.length > 0) {
            const h = queue.shift();
            if (visited.has(h)) continue;
            visited.add(h);
            if (h === "home" || ns.hasRootAccess(h)) hosts.push(h);
            for (const n of ns.scan(h)) if (!visited.has(n)) queue.push(n);
        }
        return hosts;
    }
    function launchScriptHelper(ns, baseScriptName, args = [], convertFileName = true) {
        if (!options['no-tail-windows'])
            tail(ns); // If we're going to be launching scripts, show our tail window so that we can easily be killed if the user wants to interrupt.
        let pid, err;
        try { pid = ns.run(convertFileName ? resolveScript(baseScriptName) : baseScriptName, 1, ...args); }
        catch (e) { err = e; }
        if (pid)
            log(ns, `INFO: Launched ${baseScriptName} (pid: ${pid}) with args: [${args.join(", ")}]`, true);
        else
            log(ns, `ERROR: Failed to launch ${baseScriptName} with args: [${args.join(", ")}]` +
                (err ? `\nCaught: ${getErrorInfo(err)}` : ''), true, 'error');
        return pid;
    }
    let lastStatusLog = ""; // The current or last-assigned long-term status (what this script is waiting to happen)
    /** Helper to set a global status and print it if it changes
     * @param {NS} ns */
    function setStatus(ns, status, uniquePart = null) {
        uniquePart = uniquePart || status; // Can be used to consider a logs "the same" (not worth re-printing) even if they have some different text
        if (lastStatusLog == uniquePart) return;
        lastStatusLog = uniquePart
        log(ns, status);
    }
    /** Append the specified text (with timestamp) to a persistent log in the home directory
     * @param {NS} ns */
    function persist_log(ns, text) {
        ns.write(persistentLog, `${(new Date()).toISOString().substring(0, 19)} ${text}\n`, "a")
    }
    let logged_once = new Set();
    /** Helper to log a message, but only the first time it is encountered.
     * @param {NS} ns
     * @param {string} message The message to log, only if it hasn't been previously logged. 
     * @param {boolean} alsoPrintToTerminal Set to true to print not only to the current script's tail file, but to the terminal
     * @param {""|"success"|"warning"|"error"|"info"} toastStyle - If specified, your log will will also become a toast notification */
    function log_once(ns, message, alsoPrintToTerminal, toastStyle) {
        if (logged_once.has(message))
            return;
        logged_once.add(log(ns, message, alsoPrintToTerminal, toastStyle));
    }
    // Invoke the main function
    await main_start(ns);
}