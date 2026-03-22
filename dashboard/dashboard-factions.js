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
 * dashboard-factions.js — on-demand, Factions tab only (~3 GB static)
 *
 * ALL ns.singularity.* calls are delegated to temp scripts via ns.exec,
 * matching the same pattern as dashboard-shortcuts.js and dashboard-servers.js.
 * This script only uses: ns.exec(1.3) + ns.isRunning(0.05) + ns.read/write(0)
 * = ~3 GB total static RAM.
 *
 * Singularity costs at SF4-1 are ×16 — keeping them inline would cost
 * 528 GB for gathering alone, or 980 GB including all command handlers.
 * With exec-delegation, we only pay the full cost for <1s per gather cycle.
 *
 * RAM comparison:
 *   Old (inline):   SF4-1 ~980 GB  |  SF4-2 ~248 GB  |  SF4-3 ~65 GB
 *   New (exec):     SF4-1   ~3 GB  |  SF4-2   ~3 GB  |  SF4-3  ~3 GB
 *
 * @param {NS} ns
 */

const SING_PORT       = 18;
const FACTIONS_FILE   = '/Temp/dashboard-factions.txt';
const ACTIVE_TAB_FILE = '/Temp/dashboard-active-tab.txt';
const PLAYER_FILE     = '/Temp/dashboard-player.txt';
const MY_TAB          = 'Factions';
const GATHER_SCRIPT   = '/Temp/dash-factions-gather.js';
const GATHER_OUT      = '/Temp/dash-factions-gathered.txt';
const CMD_SCRIPT      = '/Temp/dash-factions-cmd.js';

function writeGatherScript(ns) {
    ns.write(GATHER_SCRIPT, `
export async function main(ns) {
    const safe = f => { try { return f(); } catch { return undefined; } };
    const d = {};

    // Read player from file (written every 1s by dashboard-data.js — free, 0 GB here)
    let player = null;
    try { const r = ns.read('${PLAYER_FILE}'); player = r ? JSON.parse(r) : null; } catch {}
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
    ns.write('${GATHER_OUT}', JSON.stringify(d), 'w');
}
`, 'w');
}

async function runTemp(ns, script, timeout = 8000) {
    const pid = ns.exec(script, 'home');
    if (!pid) { ns.print('WARN: could not exec ' + script); return false; }
    const deadline = Date.now() + timeout;
    while (ns.isRunning(pid) && Date.now() < deadline) await ns.sleep(50);
    return !ns.isRunning(pid);
}

async function runCmd(ns, code, uiScript = '') {
    ns.write(CMD_SCRIPT, `export async function main(ns) { ${code} }`, 'w');
    return runTemp(ns, CMD_SCRIPT, 5000);
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const uiScript = ns.getScriptName().replace(/dashboard-factions\.js$/, 'dashboard.js');
    const cmdPort  = ns.getPortHandle(SING_PORT);
    writeGatherScript(ns);

    ns.atExit(() => ns.write(FACTIONS_FILE, '', 'w'));

    while (true) {
        if (!ns.isRunning(uiScript, 'home')) {
            ns.print('UI closed. Exiting.'); ns.write(FACTIONS_FILE, '', 'w'); return;
        }
        try {
            const activeTab = ns.read(ACTIVE_TAB_FILE).trim();
            if (activeTab && activeTab !== MY_TAB) {
                ns.print(`Tab = "${activeTab}". Freeing RAM.`);
                ns.write(FACTIONS_FILE, '', 'w'); return;
            }
        } catch {}

        // Process commands via temp scripts — singularity calls only cost RAM during exec
        while (!cmdPort.empty()) {
            try {
                const cmd = JSON.parse(cmdPort.read());
                switch (cmd.type) {
                    case 'buyAug':
                        await runCmd(ns, `ns.singularity.purchaseAugmentation("${cmd.faction}", "${cmd.aug}")`);
                        break;
                    case 'workForFaction':
                        await runCmd(ns, `ns.singularity.workForFaction("${cmd.faction}", "${cmd.workType}", ${!!cmd.focus})`);
                        break;
                    case 'donateToFaction':
                        await runCmd(ns, `ns.singularity.donateToFaction("${cmd.faction}", ${cmd.amount})`);
                        break;
                    case 'installAugs':
                        // Pass uiScript so dashboard relaunches automatically after reset
                        await runCmd(ns, `ns.singularity.installAugmentations("${uiScript}")`);
                        break;
                    case 'upgradeRam':
                        await runCmd(ns, 'ns.singularity.upgradeHomeRam()');
                        break;
                    case 'upgradeCores':
                        await runCmd(ns, 'ns.singularity.upgradeHomeCores()');
                        break;
                    case 'buyProgram':
                        await runCmd(ns, `ns.singularity.purchaseProgram("${cmd.program}")`);
                        break;
                    case 'purchaseTor':
                        await runCmd(ns, 'ns.singularity.purchaseTor()');
                        break;
                    case 'clearWffOverride':
                        ns.write('/Temp/wff-override.txt', '', 'w');
                        break;
                    default:
                        // Commands for other tabs (ascendMember, server ops, etc.) can
                        // land here if tabs switch mid-flight — silently ignore them.
                        ns.print(`Ignored cmd: ${cmd.type}`);
                }
            } catch (e) { ns.print('CMD error: ' + (e?.message ?? e)); }
        }

        // Gather data via temp script — pays singularity RAM only for <1s
        if (await runTemp(ns, GATHER_SCRIPT, 8000)) {
            try {
                const raw = ns.read(GATHER_OUT);
                if (raw) ns.write(FACTIONS_FILE, raw, 'w');
            } catch {}
        }

        await ns.sleep(2000); // Faction data changes slowly — 2s refresh is plenty
    }
}