/**
 * lib/paths.js — Centralized script path resolver (0 GB RAM cost)
 *
 * Reads script-paths.json and resolves logical script names to actual file paths.
 * Uses only ns.read() (0 GB) so importing this adds zero RAM overhead.
 *
 * Usage:
 *   import { getPath, getWorkerPaths, getAllPaths } from './lib/paths.js';
 *
 *   const batcherPath = getPath(ns, 'hwgw-batcher');  // → "hacking/hwgw-batcher.js"
 *   const workers = getWorkerPaths(ns);                // → { hack, grow, weaken, prep }
 *
 * Fallback: if script-paths.json doesn't exist (e.g. fresh BN before files are
 * copied), returns bare filenames like "hwgw-batcher.js". Scripts still work —
 * they just need to be in the root directory.
 *
 * NOTE: This is NOT an ns-dependent module at the top level. Functions accept
 * ns as a parameter so the module can also be used in non-async contexts by
 * passing a mock { read: (f) => ... } object.
 */

// Cache parsed paths so we only read the file once per script lifetime
let _cache = null;

/**
 * Load and cache the path registry. Returns {} if file is missing.
 * @param {{ read: (f: string) => string }} ns — only ns.read is needed (0 GB)
 * @returns {Record<string, string>}
 */
function loadPaths(ns) {
    if (_cache) return _cache;
    try {
        const raw = ns.read('/script-paths.json');
        if (raw && raw !== '') {
            _cache = JSON.parse(raw);
            // Remove the comment field
            delete _cache._comment;
        }
    } catch { /* file missing or corrupt — use fallbacks */ }
    _cache ??= {};
    return _cache;
}

/** Clear the cache — useful if paths.json was updated at runtime */
export function clearCache() { _cache = null; }

/**
 * Resolve a logical script name to its file path.
 * Falls back to `<key>.js` if the key isn't found in the registry.
 *
 * @param {{ read: (f: string) => string }} ns
 * @param {string} key — logical name, e.g. 'hwgw-batcher', 'sleeve', 'gangs'
 * @returns {string} resolved file path
 */
export function getPath(ns, key) {
    const paths = loadPaths(ns);
    return paths[key] ?? `${key}.js`;
}

/**
 * Get all HWGW worker paths as a named object.
 * @param {{ read: (f: string) => string }} ns
 * @returns {{ hack: string, grow: string, weaken: string, prep: string }}
 */
export function getWorkerPaths(ns) {
    return {
        hack:   getPath(ns, 'hwgw-hack'),
        grow:   getPath(ns, 'hwgw-grow'),
        weaken: getPath(ns, 'hwgw-weaken'),
        prep:   getPath(ns, 'hwgw-prep'),
    };
}

/**
 * Get all HWGW paths (workers + orchestrators).
 * @param {{ read: (f: string) => string }} ns
 */
export function getHwgwPaths(ns) {
    return {
        ...getWorkerPaths(ns),
        batcher: getPath(ns, 'hwgw-batcher'),
        manager: getPath(ns, 'hwgw-manager'),
    };
}

/**
 * Get all dashboard paths.
 * @param {{ read: (f: string) => string }} ns
 */
export function getDashboardPaths(ns) {
    return {
        main:      getPath(ns, 'dashboard'),
        data:      getPath(ns, 'dashboard-data'),
        gangs:     getPath(ns, 'dashboard-gangs'),
        sleeves:   getPath(ns, 'dashboard-sleeves'),
        servers:   getPath(ns, 'dashboard-servers'),
        factions:  getPath(ns, 'dashboard-factions'),
        shortcuts: getPath(ns, 'dashboard-shortcuts'),
        stocks:    getPath(ns, 'dashboard-stocks'),
    };
}

/**
 * Return the full parsed registry (all keys → paths).
 * @param {{ read: (f: string) => string }} ns
 * @returns {Record<string, string>}
 */
export function getAllPaths(ns) {
    return { ...loadPaths(ns) };
}

/**
 * Standalone resolver for scripts that can't import this module (e.g. temp scripts,
 * scripts that need absolute minimum RAM). Copy-paste this function directly.
 *
 * Usage:
 *   const resolvePath = (ns, key) => {
 *       try { const p = JSON.parse(ns.read('/script-paths.json')); return p[key] ?? key + '.js'; }
 *       catch { return key + '.js'; }
 *   };
 */