const LOG_FILE = '/Temp/corp-workers.log.txt';
const SNAPSHOT_FILE = '/Temp/corp-debug-last.txt';

const KEY_UPGRADES = [
    'Smart Factories',
    'Smart Storage',
    'ABC SalesBots',
    'Wilson Analytics',
    'Project Insight',
];

const KEY_UNLOCKS = [
    'Export',
    'Warehouse API',
    'Office API',
    'Smart Supply',
];

function parseOptions(args) {
    const opts = {
        phase: 0,
        source: '',
    };
    for (let i = 0; i < args.length; i++) {
        const arg = String(args[i]);
        if (arg === '--phase' && i + 1 < args.length) {
            opts.phase = Number(args[++i]) || 0;
        } else if (arg === '--source' && i + 1 < args.length) {
            opts.source = String(args[++i]);
        }
    }
    return opts;
}

function appendWorkerLog(ns, worker, message) {
    try {
        const stamp = new Date().toISOString();
        ns.write(LOG_FILE, `${stamp} [${worker}] ${message}\n`, 'a');
    } catch { }
}

function writeSnapshot(ns, payload) {
    try {
        ns.write(SNAPSHOT_FILE, JSON.stringify(payload), 'w');
    } catch { }
}

export async function main(ns) {
    const opts = parseOptions(ns.args);
    const c = ns.corporation;
    try {
        if (!c?.hasCorporation?.()) {
            writeSnapshot(ns, {
                time: Date.now(),
                source: opts.source,
                phase: opts.phase,
                hasCorp: false,
            });
            return;
        }

        const corp = c.getCorporation();
        const divisions = [];
        for (const name of Array.isArray(corp?.divisions) ? corp.divisions : []) {
            try {
                const div = c.getDivision(name);
                divisions.push({
                    name,
                    cities: Array.isArray(div?.cities) ? div.cities.length : 0,
                    researchPoints: Number(div?.researchPoints ?? 0),
                    awareness: Number(div?.awareness ?? 0),
                    popularity: Number(div?.popularity ?? 0),
                    adverts: Number(div?.numAdVerts ?? 0),
                    products: Array.isArray(div?.products) ? div.products.length : 0,
                });
            } catch {
                divisions.push({ name });
            }
        }

        const upgrades = {};
        for (const name of KEY_UPGRADES) {
            try {
                upgrades[name] = Number(c.getUpgradeLevel(name) ?? 0);
            } catch { }
        }

        const unlocks = {};
        for (const name of KEY_UNLOCKS) {
            try {
                unlocks[name] = Boolean(c.hasUnlock(name));
            } catch { }
        }

        writeSnapshot(ns, {
            time: Date.now(),
            source: opts.source,
            phase: opts.phase,
            hasCorp: true,
            public: Boolean(corp?.public),
            round: Number(c.getInvestmentOffer().round ?? 0),
            funds: Number(corp?.funds ?? 0),
            revenue: Number(corp?.revenue ?? 0),
            expenses: Number(corp?.expenses ?? 0),
            state: String(corp?.state ?? ''),
            divisions,
            upgrades,
            unlocks,
        });
    } catch (error) {
        appendWorkerLog(ns, 'corp-debug-worker', `fatal: ${error?.stack ?? error?.message ?? error}`);
        writeSnapshot(ns, {
            time: Date.now(),
            source: opts.source,
            phase: opts.phase,
            error: String(error?.message ?? error),
        });
    }
}
