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
 * dashboard-gangs.js — on-demand, Gang tab only (~3 GB)
 *
 * SLIMMED DOWN FURTHER: ns.gang.ascendMember (4 GB) is now delegated
 * to a one-shot temp script via ns.exec instead of being called directly.
 * This script now only uses exec + isRunning + read/write = ~3 GB static.
 *
 * Old version: ~5.6 GB (ascendMember inlined = 4 GB held entire time Gang tab is open)
 * New version: ~3 GB sustained, ~5.6 GB peak for <1s during an ascend action
 *
 * Gang data is still written by gangs.js directly to /Temp/dashboard-gangs.txt
 * every territory tick (~20s). This script only:
 *   1. Handles the ascend button command (delegated to temp script)
 *   2. Manages its own lifecycle (tab switching, UI close detection)
 *
 * @param {NS} ns
 */

const SING_PORT       = 18;
const GANGS_FILE      = '/Temp/dashboard-gangs.txt';
const ACTIVE_TAB_FILE = '/Temp/dashboard-active-tab.txt';
const MY_TAB          = 'Gang';
const CMD_SCRIPT      = '/Temp/dash-gangs-cmd.js';

async function runTemp(ns, script, timeout = 3000) {
    const pid = ns.exec(script, 'home');
    if (!pid) { ns.print('WARN: could not exec ' + script); return false; }
    const deadline = Date.now() + timeout;
    while (ns.isRunning(pid) && Date.now() < deadline) await ns.sleep(50);
    return !ns.isRunning(pid);
}

// Delegate a gang command to a one-shot temp script.
// ns.gang.ascendMember costs 4 GB — only held during the <1s the temp runs.
async function runCmd(ns, code) {
    ns.write(CMD_SCRIPT, `export async function main(ns) { ${code} }`, 'w');
    return runTemp(ns, CMD_SCRIPT, 3000);
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const uiScript = ns.getScriptName().replace(/dashboard-gangs\.js$/, 'dashboard.js');
    const singPort = ns.getPortHandle(SING_PORT);

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

        // Handle the ascend button command via a temp script.
        // No ns.gang.* call appears in this file directly.
        while (!singPort.empty()) {
            const raw = singPort.read();
            try {
                const cmd = JSON.parse(raw);
                if (cmd.type === 'ascendMember') {
                    // Delegate to temp script — ns.gang.ascendMember costs 4 GB static.
                    // Temp script pays that cost for <1s, then exits.
                    await runCmd(ns, `
                        const result = ns.gang.ascendMember(${JSON.stringify(cmd.member)});
                        ns.print(result ? "Ascended ${cmd.member}" : "Ascend failed for ${cmd.member}");
                    `);
                }
                // Other commands can arrive if tabs switch mid-flight — silently ignore.
            } catch (e) { ns.print('CMD error: ' + (e?.message ?? e)); }
        }

        // Data is written by gangs.js — nothing to read or compute here.
        // The dashboard reads GANGS_FILE directly in its merge loop.

        await ns.sleep(1000);
    }
}