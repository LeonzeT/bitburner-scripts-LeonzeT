// Resolve registered script paths via script-paths.json (0 GB — ns.read only)
let _scriptPaths = null;
function resolveScript(ns, key) {
    if (!_scriptPaths) {
        _scriptPaths = {};
        try { const r = ns.read('/script-paths.json'); if (r && r !== '') { _scriptPaths = JSON.parse(r); delete _scriptPaths._comment; } } catch {}
    }
    return _scriptPaths[key] ?? (key.endsWith('.js') ? key : key + '.js');
}
export async function main(ns) {
    for (const s of ns.cloud.getServerNames())
        ns.scp('hacking/hwgw-grow.js', s, 'home');
    ns.tprint('Done — hwgw-grow.js copied to all purchased servers.');
}