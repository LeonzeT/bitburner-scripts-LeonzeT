// Resolve registered script paths via script-paths.json (0 GB — ns.read only)
let _scriptPaths = null;
function resolveScript(ns, key) {
    if (!_scriptPaths) {
        _scriptPaths = {};
        try { const r = ns.read('/script-paths.json'); if (r && r !== '') { _scriptPaths = JSON.parse(r); delete _scriptPaths._comment; } } catch {}
    }
    return _scriptPaths[key] ?? (key.endsWith('.js') ? key : key + '.js');
}
/**
 * dashboard-shortcuts.js — on-demand, Shortcuts tab (~3 GB static)
 *
 * ALL ns.singularity.* calls are delegated to a temp gather script via ns.exec.
 * This script only uses: ns.exec(1.3) + ns.isRunning(0.05) + ns.read/write(0)
 * = ~3 GB sustained. The temp script pays the full singularity cost for <1s/cycle.
 *
 * Singularity costs scale with SF4 level (×16 at SF4-0, ×4 at SF4-1, ×1 at SF4-3).
 * By delegating, we only pay that cost during brief temp script runs.
 *
 * Commands (upgradeRam, upgradeCores, installAugs, buyProgram, purchaseTor,
 * purchaseWse/Tix/4S, launchManager, launchCrawler, killManager, killCrawler,
 * launchInfil, killInfil) are ALL handled upstream by dashboard-data.js
 * (FORWARD_CMDS / LOCAL_CMDS). This script is gather-only — it does not
 * consume port 18.
 *
 * @param {NS} ns
 */

const SHORTCUTS_FILE  = '/Temp/dashboard-shortcuts.txt';
const ACTIVE_TAB_FILE = '/Temp/dashboard-active-tab.txt';
const MY_TAB          = 'Shortcuts';
const GATHER_SCRIPT   = '/Temp/dash-shortcuts-gather.js';
const GATHER_OUT      = '/Temp/dash-shortcuts-gathered.txt';

// ── Infiltration location data from source (Locations/data/LocationsMetadata.ts)
// ssl = startingSecurityLevel. Only locations with infiltrationData are listed.
const INFIL_LOCATION_DATA = {
    'Aevum': {
        'AeroCorp':                      8.18,
        'Bachman & Associates':          8.19,
        'Clarke Incorporated':           9.55,
        'ECorp':                        17.02,
        'Fulcrum Technologies':         15.54,
        'Galactic Cybersystems':         7.89,
        'NetLink Technologies':          3.29,
        'Aevum Police Headquarters':     5.35,
        'Rho Construction':              5.02,
        'Watchdog Security':             5.85,
    },
    'Chongqing': {
        'KuaiGong International':       16.25,
        'Solaris Space Systems':        12.59,
    },
    'Ishima': {
        'Nova Medical':                  5.02,
        'Omega Software':                3.20,
        'Storm Technologies':            5.38,
    },
    'New Tokyo': {
        'DefComm':                       7.18,
        'Global Pharmaceuticals':        5.90,
        'Noodle Bar':                    2.50,
        'VitaLife':                      5.52,
    },
    'Sector-12': {
        'Alpha Enterprises':             3.62,
        'Blade Industries':             10.59,
        'Carmichael Security':           4.66,
        'DeltaOne':                      5.90,
        'Four Sigma':                    8.18,
        'Icarus Microsystems':           6.02,
        "Joe's Guns":                    3.13,
        'MegaCorp':                     16.36,
        'Universal Energy':              5.90,
    },
    'Volhaven': {
        'CompuTek':                      3.59,
        'Helios Labs':                   7.28,
        'LexoCorp':                      4.35,
        'NWO':                           8.53,
        'OmniTek Incorporated':          7.74,
        'Omnia Cybersystems':            6.00,
        'SysCore Securities':            4.77,
    },
};

function writeGatherScript(ns) {
    const locationDataJson = JSON.stringify(INFIL_LOCATION_DATA);

    ns.write(GATHER_SCRIPT, `
export async function main(ns) {
    const safe = f => { try { return f(); } catch { return undefined; } };
    const d = {};

    // Home upgrades
    d.homeRamCost   = safe(() => ns.singularity.getUpgradeHomeRamCost());
    d.homeCoresCost = safe(() => ns.singularity.getUpgradeHomeCoresCost());
    d.homeMaxRam    = safe(() => ns.getServerMaxRam("home")) ?? 0;
    d.homeCores     = safe(() => ns.getServer("home").cpuCores) ?? null;

    // Pending augs (for the "Install Now" button nudge)
    try {
        const installed = safe(() => ns.singularity.getOwnedAugmentations(false)) ?? [];
        const withPend  = safe(() => ns.singularity.getOwnedAugmentations(true))  ?? [];
        d.pendingAugs   = withPend.length - installed.length;
    } catch {}

    // Darkweb
    d.hasTor = safe(() => ns.hasTorRouter()) ?? false;
    try {
        const progs = safe(() => ns.singularity.getDarkwebPrograms()) ?? [];
        d.darkwebPrograms = progs.map(p => ({
            name:  p,
            owned: safe(() => ns.fileExists(p, "home")) ?? false,
            cost:  safe(() => ns.singularity.getDarkwebProgramCost(p)) ?? null,
        }));
    } catch { d.darkwebPrograms = []; }

    // ── Infiltration locations with difficulty + reward ─────────────────────
    //
    // Difficulty formula (src/Infiltration/formulas/game.ts):
    //   totalStats = str + def + dex + agi + cha
    //   difficulty = max(0, ssl - (totalStats^0.9 / 250) - (int / 1600))
    //   displayed  = difficulty * (100 / 3.5)   → 0–100
    //
    // Rewards come from ns.infiltration.getInfiltration(name) (0 GB):
    //   reward.sellCash  — sell intel for money
    //   reward.tradeRep  — trade intel for rep
    //   reward.SoARep    — Shadows of Anarchy rep (if in faction)
    //
    const MAX_DIFF      = 3.5;
    const DISPLAY_SCALE = 100 / MAX_DIFF;
    const locationData  = ${locationDataJson};

    // Read player snapshot (free — written each cycle by dashboard-data.js gather)
    let playerStats = { str:0, def:0, dex:0, agi:0, cha:0, int:0 };
    try {
        const raw = ns.read("/Temp/dashboard-player.txt");
        if (raw && raw !== "") {
            const p = JSON.parse(raw);
            playerStats = {
                str: p.skills?.strength     ?? 0,
                def: p.skills?.defense      ?? 0,
                dex: p.skills?.dexterity    ?? 0,
                agi: p.skills?.agility      ?? 0,
                cha: p.skills?.charisma     ?? 0,
                int: p.skills?.intelligence ?? 0,
            };
        }
    } catch {}

    const { str, def, dex, agi, cha, int: intel } = playerStats;
    const totalStats = str + def + dex + agi + cha;
    const statBonus  = Math.pow(totalStats, 0.9) / 250;
    const intBonus   = intel / 1600;

    function calcDiff(ssl) {
        return Math.max(0, ssl - statBonus - intBonus);
    }

    // Get location list from API, fall back to hardcoded
    let rawLocs = [];
    try {
        const apiLocs = ns.infiltration.getPossibleLocations();
        if (Array.isArray(apiLocs) && apiLocs.length > 0) {
            rawLocs = apiLocs.map(l => ({ city: l.city, name: l.name }));
        }
    } catch {}
    if (rawLocs.length === 0) {
        for (const [city, companies] of Object.entries(locationData)) {
            for (const name of Object.keys(companies)) rawLocs.push({ city, name });
        }
    }

    // Compute difficulty and fetch rewards for each non-impossible location.
    // ns.infiltration.getInfiltration() costs 0 GB — safe to call in a loop.
    const withData = [];
    for (const l of rawLocs) {
        const ssl  = locationData[l.city]?.[l.name] ?? null;
        const diff = ssl !== null ? calcDiff(ssl) : null;
        if (diff !== null && diff >= MAX_DIFF) continue;   // filter impossible

        let sellCash = null, tradeRep = null, soaRep = null;
        try {
            const info = ns.infiltration.getInfiltration(l.name);
            sellCash = info.reward?.sellCash ?? null;
            tradeRep = info.reward?.tradeRep ?? null;
            soaRep   = info.reward?.SoARep   ?? null;
        } catch {}

        withData.push({
            city: l.city,
            name: l.name,
            ssl,
            diff,
            displayDiff: diff !== null ? diff * DISPLAY_SCALE : null,
            sellCash,
            tradeRep,
            soaRep,
        });
    }

    // Sort easiest-first for the dropdowns
    d.infilLocations = withData.sort((a, b) => {
        if (a.diff === null && b.diff === null) return a.name.localeCompare(b.name);
        if (a.diff === null) return 1;
        if (b.diff === null) return -1;
        return a.diff - b.diff;
    });

    // Best rewards across all available locations
    const withCash = withData.filter(l => l.sellCash != null);
    const withRep  = withData.filter(l => l.tradeRep != null);
    d.infilBestMoney = withCash.length > 0
        ? withCash.reduce((best, l) => l.sellCash > best.sellCash ? l : best)
        : null;
    d.infilBestRep = withRep.length > 0
        ? withRep.reduce((best, l) => l.tradeRep > best.tradeRep ? l : best)
        : null;

    // Infiltration running status + active args
    d.infilRamTarget = 2048;
    d.infilRamPct    = Math.min(1, (d.homeMaxRam ?? 0) / 2048);
    try {
        const procs     = safe(() => ns.ps("home")) ?? [];
        const infilProc = procs.find(p =>
            p.filename === 'autoinfil.js' || p.filename.endsWith('/autoinfil.js'));
        d.infilRunning  = !!infilProc;
        if (infilProc) {
            const iArgs      = infilProc.args ?? [];
            const reward     = iArgs[iArgs.indexOf('--reward')  + 1] ?? 'money';
            const faction    = iArgs.indexOf('--faction') >= 0
                ? iArgs[iArgs.indexOf('--faction') + 1] : null;
            const company    = iArgs.indexOf('--company') >= 0
                ? iArgs[iArgs.indexOf('--company') + 1] : null;
            const city       = iArgs.indexOf('--city') >= 0
                ? iArgs[iArgs.indexOf('--city') + 1] : null;
            d.infilMode    = reward === 'rep' && faction ? \`rep → \${faction}\` : 'money';
            d.infilCompany = company;
            d.infilCity    = city;
            d.infilReward  = reward;
            d.infilFaction = faction ?? null;
        } else {
            d.infilMode    = null;
            d.infilCompany = null;
            d.infilCity    = null;
        }
    } catch { d.infilRunning = false; d.infilMode = null; d.infilCompany = null; d.infilCity = null; }

    d.shortcutsLoaded    = true;
    d.shortcutsTimestamp = Date.now();
    ns.write("/Temp/dash-shortcuts-gathered.txt", JSON.stringify(d), "w");
}
`, 'w');
}

async function runTemp(ns, script, timeout = 5000) {
    const pid = ns.exec(script, 'home');
    if (!pid) { ns.print('WARN: could not exec ' + script); return false; }
    const deadline = Date.now() + timeout;
    while (ns.isRunning(pid) && Date.now() < deadline) await ns.sleep(50);
    return !ns.isRunning(pid);
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const uiScript = ns.getScriptName().replace(/dashboard-shortcuts\.js$/, 'dashboard.js');
    ns.atExit(() => ns.write(SHORTCUTS_FILE, '', 'w'));
    writeGatherScript(ns);

    while (true) {
        if (!ns.isRunning(uiScript, 'home')) {
            ns.print('UI closed. Exiting.'); ns.write(SHORTCUTS_FILE, '', 'w'); return;
        }
        try {
            const activeTab = ns.read(ACTIVE_TAB_FILE).trim();
            if (activeTab && activeTab !== MY_TAB) {
                ns.print(`Tab = "${activeTab}". Freeing RAM.`);
                ns.write(SHORTCUTS_FILE, '', 'w'); return;
            }
        } catch {}

        // Gather data via temp script — pays singularity RAM only for <1s
        if (await runTemp(ns, GATHER_SCRIPT)) {
            try {
                const raw = ns.read(GATHER_OUT);
                if (raw) ns.write(SHORTCUTS_FILE, raw, 'w');
            } catch {}
        }

        await ns.sleep(1000);
    }
}