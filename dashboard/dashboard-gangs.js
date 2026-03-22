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
 * dashboard-gangs.js — on-demand, Gang tab only (~5.6 GB)
 *
 * SLIMMED DOWN: Gang data is now written by gangs.js directly to
 * /Temp/dashboard-gangs.txt every territory tick (~20s). This script
 * no longer makes any ns.gang.* read calls — it just:
 *   1. Copies the data file gangs.js writes (ns.read/write = 0 GB)
 *   2. Handles the ascend button command (ns.gang.ascendMember = 4 GB)
 *
 * Old version: ~17 GB (inGang + getGangInfo + getMemberNames + getMemberInfo
 *              + getOtherGangInfo + canRecruit + getAscensionResult + ascendMember)
 * New version: ~5.6 GB (ascendMember + base)
 *
 * @param {NS} ns
 */

const SING_PORT       = 18;
const GANGS_FILE      = '/Temp/dashboard-gangs.txt';
const ACTIVE_TAB_FILE = '/Temp/dashboard-active-tab.txt';
const MY_TAB          = 'Gang';

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const uiScript = ns.getScriptName().replace(/dashboard-gangs\.js$/, 'dashboard.js');
    const singPort = ns.getPortHandle(SING_PORT);

    // Clear stale data whenever this script exits for any reason
    // (tab change, UI close, or external kill via terminal/crash)
    ns.atExit(() => ns.write(GANGS_FILE, '', 'w'));

    while (true) {
        if (!ns.isRunning(uiScript, 'home')) {
            ns.print('UI closed. Exiting.'); ns.write(GANGS_FILE, '', 'w'); return;
        }
        try {
            const activeTab = ns.read(ACTIVE_TAB_FILE).trim();
            if (activeTab && activeTab !== MY_TAB) {
                ns.print(`Tab = "${activeTab}". Freeing RAM.`); ns.write(GANGS_FILE, '', 'w'); return;
            }
        } catch {}

        // Process commands from the dashboard (ascend button)
        while (!singPort.empty()) {
            const raw = singPort.read();
            try {
                const cmd = JSON.parse(raw);
                if (cmd.type === 'ascendMember') {
                    const result = ns.gang.ascendMember(cmd.member);
                    ns.print(result
                        ? `Ascended ${cmd.member}`
                        : `Ascend failed for ${cmd.member}`);
                }
            } catch (e) { ns.print('CMD error: ' + (e?.message ?? e)); }
        }

        // Data is written by gangs.js — nothing to do here.
        // The dashboard reads GANGS_FILE directly in its merge loop.
        // If gangs.js isn't running yet, write an empty-state marker so the
        // dashboard shows "Loading..." instead of stale data.
        // If gangs.js hasn't written yet (or just cleared), leave the file
        // empty so the dashboard shows "Loading..." rather than "Not in a gang".
        // gangs.js will write real data within ~1s of its main loop running.

        await ns.sleep(1000);
    }
}