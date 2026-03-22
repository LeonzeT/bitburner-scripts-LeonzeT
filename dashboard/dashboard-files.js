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
 * /lib/dashboard-files.js — Central registry of all dashboard data files.
 *
 * 0 GB to import (no ns.* references). Use this as the single source of truth
 * for file paths, writer scripts, and staleness thresholds.
 *
 * Usage in any script:
 *   import { FILES } from '/lib/dashboard-files.js'
 *   ns.write(FILES.gangs.path, JSON.stringify({ _writer: FILES.gangs.writer, _ts: Date.now(), ... }), 'w');
 *
 * Usage in dashboard health overlay:
 *   Object.entries(FILES).forEach(([key, f]) => {
 *       const raw = ns.read(f.path);
 *       const data = raw ? JSON.parse(raw) : null;
 *       const age = data?._ts ? Date.now() - data._ts : Infinity;
 *       console.log(`${key}: ${age < f.staleAfter ? '✓' : '⚠'} ${age}ms (${f.writer})`);
 *   });
 */

export const FILES = {
    // ── Always-on data (written by always-running scripts) ────────────────────
    data: {
        path:       '/Temp/dashboard-data.txt',
        writer:     'dashboard-data.js (temp gather)',
        staleAfter: 3000,    // gathers every 1s, 3s = missed 2 cycles
        desc:       'Player, home, HWGW targets, stock flags, process list',
    },
    player: {
        path:       '/Temp/dashboard-player.txt',
        writer:     'dashboard-data.js (temp gather)',
        staleAfter: 3000,
        desc:       'ns.getPlayer() snapshot — read by factions for free',
    },
    gangs: {
        path:       '/Temp/dashboard-gangs.txt',
        writer:     'gangs/gangs.js',
        staleAfter: 25000,   // full write every territory tick (~20s), live patch every 1s
        desc:       'Gang info, members, ascension results, rival gangs',
    },
    hwgwStatus: {
        path:       '/Temp/hwgw-status.txt',
        writer:     'hacking/hwgw-manager.js',
        staleAfter: 5000,
        desc:       'Active targets, batch counts, hackChance per target',
    },
    hwgwHosts: {
        path:       '/Temp/hwgw-exec-hosts.txt',
        writer:     'hacking/hwgw-manager.js',
        staleAfter: 10000,
        desc:       'List of exec host servers',
    },

    // ── On-demand data (written by tab companion scripts, only while tab is open) ─
    factions: {
        path:       '/Temp/dashboard-factions.txt',
        writer:     'dashboard/dashboard-factions.js',
        staleAfter: 3000,
        desc:       'Faction list, rep, favor, augs, work types',
    },
    shortcuts: {
        path:       '/Temp/dashboard-shortcuts.txt',
        writer:     'dashboard-shortcuts.js (temp gather)',
        staleAfter: 3000,
        desc:       'Home upgrade costs, darkweb programs, pending augs',
    },
    servers: {
        path:       '/Temp/dashboard-servers.txt',
        writer:     'dashboard-servers.js (temp gather)',
        staleAfter: 3000,
        desc:       'Purchased servers list, upgrade costs',
    },
    stocks: {
        path:       '/Temp/dashboard-stocks.txt',
        writer:     'stockmaster.js / dashboard-stocks.js',
        staleAfter: 8000,
        desc:       'Per-symbol stock data, positions, forecast',
    },
    sleeves: {
        path:       '/Temp/dashboard-sleeves.txt',
        writer:     'dashboard/dashboard-sleeves.js',
        staleAfter: 3000,
        desc:       'Sleeve count, tasks, stats, shock',
    },

    // ── Shared utility files (written by various scripts) ─────────────────────
    bnMults: {
        path:       '/Temp/bitNode-multipliers.txt',
        writer:     'helpers.js / daemon.js',
        staleAfter: Infinity, // only changes on BN start
        desc:       'BitNode multipliers — static per run',
    },
    affordableAugs: {
        path:       '/Temp/affordable-augs.txt',
        writer:     'faction-manager.js',
        staleAfter: 60000,
        desc:       'Aug purchase readiness summary',
    },
    forceTarget: {
        path:       '/Temp/hwgw-force-target.txt',
        writer:     'dashboard (user input)',
        staleAfter: Infinity,
        desc:       'User-selected HWGW target override',
    },
    dnetPasswords: {
        path:       '/Temp/dnet-passwords.txt',
        writer:     'darknet/darknet-crawler.js',
        staleAfter: Infinity,
        desc:       'Cracked server passwords',
    },
    activeTab: {
        path:       '/Temp/dashboard-active-tab.txt',
        writer:     'dashboard/dashboard-data.js',
        staleAfter: Infinity,
        desc:       'Current active dashboard tab (controls which on-demand script runs)',
    },
};

/**
 * Metadata keys that all writers should include in their JSON:
 *   _writer:  string — which script wrote this file (for debugging)
 *   _ts:      number — Date.now() when written (for staleness detection)
 *
 * Example:
 *   const d = { _writer: 'gangs/gangs.js', _ts: Date.now(), ...actualData };
 *   ns.write(FILES.gangs.path, JSON.stringify(d), 'w');
 */