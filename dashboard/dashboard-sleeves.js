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
 * dashboard-sleeves.js — on-demand, Sleeves tab (~3 GB static)
 *
 * ALL ns.sleeve.* calls are delegated to a temp gather script.
 * This script only uses: ns.exec(1.3) + ns.isRunning(0.05) + ns.read/write(0)
 * = ~3 GB sustained. The temp script peaks at ~14 GB during its <1s run
 * (ns.sleeve.* = 4 GB per function × 3 functions).
 *
 * Old version: ~14 GB (was a broken copy of dashboard-data.js!)
 * New version: ~3 GB sustained
 *
 * @param {NS} ns
 */

const SING_PORT       = 18;
const SLEEVES_FILE    = '/Temp/dashboard-sleeves.txt';
const SLEEVE_OVERRIDE_FILE = '/Temp/sleeve-overrides.txt'; // { [index]: taskSpec }
const ACTIVE_TAB_FILE = '/Temp/dashboard-active-tab.txt';
const MY_TAB          = 'Sleeves';
const GATHER_SCRIPT   = '/Temp/dash-sleeves-gather.js';
const GATHER_OUT      = '/Temp/dash-sleeves-gathered.txt';

function writeGatherScript(ns) {
    ns.write(GATHER_SCRIPT, [
        'export async function main(ns) {',
        '  const safe = f => { try { return f(); } catch { return undefined; } };',
        '  const d = {};',
        '  try {',
        '    const count = ns.sleeve.getNumSleeves();',
        '    const sleeves = [];',
        '    for (let i = 0; i < count; i++) {',
        '      const s = safe(() => ns.sleeve.getSleeve(i));',
        '      const t = safe(() => ns.sleeve.getTask(i));',
        '      if (!s) continue;',
        '      // Format task description',
        '      let task = "Idle";',
        '      if (t) {',
        '        if (t.type === "CRIME")        task = "Crime: " + (t.crimeType ?? "?");',
        '        else if (t.type === "CLASS")    task = "Class: " + (t.classType ?? "?") + " @ " + (t.location ?? "?");',
        '        else if (t.type === "COMPANY")  task = "Work: " + (t.companyName ?? "?");',
        '        else if (t.type === "FACTION")  task = "Faction: " + (t.factionName ?? "?") + " (" + (t.factionWorkType ?? "?") + ")";',
        '        else if (t.type === "RECOVERY") task = "Shock Recovery";',
        '        else if (t.type === "SYNCHRO")  task = "Synchronize";',
        '        else if (t.type === "BLADEBURNER") task = "Bladeburner: " + (t.actionName ?? "?");',
        '        else if (t.type === "INFILTRATE") task = "Infiltrating";',
        '        else if (t.type === "SUPPORT")  task = "Bladeburner Support";',
        '        else task = t.type ?? "Unknown";',
        '      }',
        '      sleeves.push({',
        '        index: i, task,',
        '        shock: s.shock ?? 0,',
        '        sync:  s.sync  ?? 0,',
        '        str: s.skills?.strength  ?? s.str ?? 0,',
        '        def: s.skills?.defense   ?? s.def ?? 0,',
        '        dex: s.skills?.dexterity ?? s.dex ?? 0,',
        '        agi: s.skills?.agility   ?? s.agi ?? 0,',
        '        hack: s.skills?.hacking  ?? s.hack ?? 0,',
        '        cha: s.skills?.charisma  ?? s.cha ?? 0,',
        '      });',
        '    }',
        '    d.sleeves = sleeves;',
        '  } catch (e) { d.sleeves = []; }',
        '  // Read per-sleeve overrides',
        '  try {',
        '    const ov = ns.read("/Temp/sleeve-overrides.txt");',
        '    d.sleeveOverrides = ov && ov !== "" ? JSON.parse(ov) : {};',
        '  } catch { d.sleeveOverrides = {}; }',
        '  d._writer = "dashboard/dashboard-sleeves.js";',
        '  d._ts = Date.now();',
        '  ns.write("/Temp/dash-sleeves-gathered.txt", JSON.stringify(d), "w");',
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

/**
 * Build the one-liner code to apply a task spec to a sleeve.
 * Returns empty string for unknown types (safe no-op).
 */
function buildApplyCode(cmd) {
    const i = cmd.index;
    const t = cmd.task;
    if (!t) return '';
    switch (t.type) {
        case 'CRIME':     return `ns.sleeve.setToCommitCrime(${i}, "${t.crimeType}");`;
        case 'FACTION':   return `ns.sleeve.setToFactionWork(${i}, "${t.factionName}", "${t.workType}");`;
        case 'COMPANY':   return `ns.sleeve.setToCompanyWork(${i}, "${t.companyName}");`;
        case 'CLASS':     return `ns.sleeve.setToUniversityCourse(${i}, "${t.university}", "${t.course}");`;
        case 'GYM':       return `ns.sleeve.setToGymWorkout(${i}, "${t.gym}", "${t.stat}");`;
        case 'RECOVERY':  return `ns.sleeve.setToShockRecovery(${i});`;
        case 'SYNCHRO':   return `ns.sleeve.setToSynchronize(${i});`;
        case 'BLADEBURNER': return `ns.sleeve.setToBladeburnerAction(${i}, "${t.actionType}", "${t.actionName}");`;
        default: return '';
    }
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const uiScript = ns.getScriptName().replace(/dashboard-sleeves\.js$/, 'dashboard.js');
    ns.atExit(() => ns.write(SLEEVES_FILE, '', 'w'));
    writeGatherScript(ns);

    while (true) {
        if (!ns.isRunning(uiScript, 'home')) {
            ns.print('UI closed. Exiting.'); ns.write(SLEEVES_FILE, '', 'w'); return;
        }
        try {
            const activeTab = ns.read(ACTIVE_TAB_FILE).trim();
            if (activeTab && activeTab !== MY_TAB) {
                ns.print(`Tab = "${activeTab}". Freeing RAM.`);
                ns.write(SLEEVES_FILE, '', 'w'); return;
            }
        } catch {}

        // Process commands from port 18
        const cmdPort = ns.getPortHandle(SING_PORT);
        while (!cmdPort.empty()) {
            try {
                const cmd = JSON.parse(cmdPort.read());
                if (cmd.type === 'setSleeveTask') {
                    // Write override and immediately apply the task
                    let overrides = {};
                    try { const r = ns.read(SLEEVE_OVERRIDE_FILE); overrides = r && r !== '' ? JSON.parse(r) : {}; } catch {}
                    overrides[String(cmd.index)] = cmd.task; // task = { type, ...params }
                    ns.write(SLEEVE_OVERRIDE_FILE, JSON.stringify(overrides), 'w');
                    // Apply immediately via a one-shot temp script
                    const applyCode = buildApplyCode(cmd);
                    if (applyCode) {
                        ns.write('/Temp/dash-sleeve-cmd.js', `export async function main(ns) { ${applyCode} }`, 'w');
                        ns.exec('/Temp/dash-sleeve-cmd.js', 'home');
                    }
                } else if (cmd.type === 'clearSleeveOverride') {
                    let overrides = {};
                    try { const r = ns.read(SLEEVE_OVERRIDE_FILE); overrides = r && r !== '' ? JSON.parse(r) : {}; } catch {}
                    delete overrides[String(cmd.index)];
                    ns.write(SLEEVE_OVERRIDE_FILE, JSON.stringify(overrides), 'w');
                } else if (cmd.type === 'clearAllSleeveOverrides') {
                    ns.write(SLEEVE_OVERRIDE_FILE, '{}', 'w');
                } else {
                    ns.print(`Ignored cmd: ${cmd.type}`);
                }
            } catch (e) { ns.print('SLEEVES CMD error: ' + (e?.message ?? e)); }
        }

        // Gather data via temp script
        if (await runTemp(ns, GATHER_SCRIPT)) {
            try {
                const raw = ns.read(GATHER_OUT);
                if (raw) ns.write(SLEEVES_FILE, raw, 'w');
            } catch {}
        }

        await ns.sleep(1000);
    }
}