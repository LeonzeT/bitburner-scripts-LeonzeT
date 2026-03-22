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
 * dashboard-servers.js — on-demand, Servers tab (~3 GB static)
 *
 * ALL ns.cloud.* calls are delegated to temp scripts via ns.exec.
 * This script only uses: ns.exec(1.3) + ns.isRunning(0.05) + ns.read/write(0)
 * = ~3 GB total static RAM.
 *
 * Old version: ~8 GB (all cloud API referenced directly, held entire time)
 * New version: ~3 GB sustained, ~8 GB peak during 1s gather
 *
 * @param {NS} ns
 */

const CMD_PORT        = 18;
const SERVERS_FILE    = '/Temp/dashboard-servers.txt';
const ACTIVE_TAB_FILE = '/Temp/dashboard-active-tab.txt';
const MY_TAB          = 'Servers';
const GATHER_SCRIPT   = '/Temp/dash-servers-gather.js';
const GATHER_OUT      = '/Temp/dash-servers-gathered.txt';
const CMD_SCRIPT      = '/Temp/dash-servers-cmd.js';

function writeGatherScript(ns) {
    ns.write(GATHER_SCRIPT, [
        'export async function main(ns) {',
        '  const safe = f => { try { return f(); } catch { return undefined; } };',
        '  const d = {};',
        '  try {',
        '    const names  = ns.cloud.getServerNames();',
        '    const maxRam = ns.cloud.getRamLimit();',
        '    const limit  = ns.cloud.getServerLimit();',
        '    d.purchasedServers = names.map(n => {',
        '      const cur  = safe(() => ns.getServerMaxRam(n))  ?? 0;',
        '      const used = safe(() => ns.getServerUsedRam(n)) ?? 0;',
        '      const next = Math.min(maxRam, cur * 2);',
        '      const upgradeCost = next > cur',
        '        ? safe(() => ns.cloud.getServerUpgradeCost(n, next)) ?? null : null;',
        '      return { name: n, maxRam: cur, usedRam: used, upgradeCost, nextRam: next };',
        '    });',
        '    d.serverLimit  = limit;',
        '    d.serverMaxRam = maxRam;',
        '    d.serverCosts  = {};',
        '    for (let i = 3; i <= 20; i++) {',
        '      const ram = 2 ** i;',
        '      if (ram <= maxRam) d.serverCosts[ram] = safe(() => ns.cloud.getServerCost(ram)) ?? null;',
        '    }',
        '  } catch {}',
        '  d.serversLoaded    = true;',
        '  d.serversTimestamp = Date.now();',
        '  ns.write("/Temp/dash-servers-gathered.txt", JSON.stringify(d), "w");',
        '}',
    ].join('\n'), 'w');
}

async function runTemp(ns, script, timeout = 5000) {
    const pid = ns.exec(script, 'home');
    if (!pid) { ns.print('WARN: could not exec ' + script); return false; }
    const deadline = Date.now() + timeout;
    while (ns.isRunning(pid) && Date.now() < deadline) await ns.sleep(50);
    return !ns.isRunning(pid);
}

async function runCmd(ns, code) {
    ns.write(CMD_SCRIPT, `export async function main(ns) { ${code} }`, 'w');
    return runTemp(ns, CMD_SCRIPT, 3000);
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const uiScript = ns.getScriptName().replace(/dashboard-servers\.js$/, 'dashboard.js');
    const cmdPort  = ns.getPortHandle(CMD_PORT);
    ns.atExit(() => ns.write(SERVERS_FILE, '', 'w'));
    writeGatherScript(ns);

    while (true) {
        if (!ns.isRunning(uiScript, 'home')) {
            ns.print('UI closed. Exiting.'); ns.write(SERVERS_FILE, '', 'w'); return;
        }
        try {
            const activeTab = ns.read(ACTIVE_TAB_FILE).trim();
            if (activeTab && activeTab !== MY_TAB) {
                ns.print(`Tab = "${activeTab}". Freeing RAM.`);
                ns.write(SERVERS_FILE, '', 'w'); return;
            }
        } catch {}

        // Process commands via temp scripts
        while (!cmdPort.empty()) {
            try {
                const cmd = JSON.parse(cmdPort.read());
                switch (cmd.type) {
                    case 'upgradeServer':
                        await runCmd(ns, `ns.cloud.upgradeServer("${cmd.name}", ${cmd.nextRam})`);
                        break;
                    case 'deleteServer':
                        await runCmd(ns, `ns.cloud.deleteServer("${cmd.name}")`);
                        break;
                    case 'purchaseServer':
                        await runCmd(ns, `ns.cloud.purchaseServer("${cmd.name}", ${cmd.ram})`);
                        break;
                }
            } catch (e) { ns.print('CMD error: ' + (e?.message ?? e)); }
        }

        // Gather data via temp script
        if (await runTemp(ns, GATHER_SCRIPT)) {
            try {
                const raw = ns.read(GATHER_OUT);
                if (raw) ns.write(SERVERS_FILE, raw, 'w');
            } catch {}
        }

        await ns.sleep(1000);
    }
}