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
 * purchaseWse/Tix/4S, launchManager, launchCrawler, killManager, killCrawler)
 * are ALL handled upstream by dashboard-data.js (FORWARD_CMDS / LOCAL_CMDS).
 * This script is gather-only — it does not consume port 18.
 *
 * @param {NS} ns
 */

const SHORTCUTS_FILE  = '/Temp/dashboard-shortcuts.txt';
const ACTIVE_TAB_FILE = '/Temp/dashboard-active-tab.txt';
const MY_TAB          = 'Shortcuts';
const GATHER_SCRIPT   = '/Temp/dash-shortcuts-gather.js';
const GATHER_OUT      = '/Temp/dash-shortcuts-gathered.txt';

function writeGatherScript(ns) {
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