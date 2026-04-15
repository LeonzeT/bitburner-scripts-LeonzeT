const DIV_AGRI = 'Agriculture';
const DIV_CHEM = 'Chemical';
const DIV_TOBACCO = 'Tobacco';

const TOB_RESEARCH = [
    'Hi-Tech R&D Laboratory',
    'uPgrade: Fulcrum',
    'uPgrade: Capacity.I',
    'uPgrade: Dashboard',
    'uPgrade: Capacity.II',
    'Drones',
    'Drones - Assembly',
    'Drones - Transport',
    'Market-TA.I',
    'Market-TA.II',
];

const MAT_RESEARCH = [
    'Hi-Tech R&D Laboratory',
    'uPgrade: Fulcrum',
    'uPgrade: Capacity.I',
    'uPgrade: Dashboard',
    'uPgrade: Capacity.II',
    'Market-TA.I',
    'Market-TA.II',
];

const PRODUCTION_RESEARCH = new Set([
    'Hi-Tech R&D Laboratory',
    'Drones',
    'Drones - Assembly',
    'Drones - Transport',
]);

const LOG_FILE = '/Temp/corp-workers.log.txt';
const SNAPSHOT_FILE = '/Temp/corp-research-last.txt';

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

function getResearchSpendThreshold(phase, div, name) {
    if (PRODUCTION_RESEARCH.has(name)) return 10;
    if (phase >= 7 && div === DIV_TOBACCO && name === 'Market-TA.II') return 1;
    return 2;
}

function tryResearchQueue(c, phase, div, queue, purchases) {
    try {
        let availableRp = Number(c.getDivision(div).researchPoints ?? 0);
        for (const name of queue) {
            if (c.hasResearched(div, name)) continue;
            const cost = Number(c.getResearchCost(div, name) ?? 0);
            const threshold = getResearchSpendThreshold(phase, div, name);
            if (availableRp < cost * threshold) continue;
            try {
                c.research(div, name);
                availableRp -= cost;
                purchases.push({ div, name, cost });
            } catch { }
        }
    } catch { }
}

export async function main(ns) {
    const opts = parseOptions(ns.args);
    const c = ns.corporation;
    try {
        if (!c?.hasCorporation?.()) return;
        const corp = c.getCorporation();
        const divs = new Set(Array.isArray(corp?.divisions) ? corp.divisions : []);
        const purchases = [];
        if (divs.has(DIV_TOBACCO)) tryResearchQueue(c, opts.phase, DIV_TOBACCO, TOB_RESEARCH, purchases);
        if (divs.has(DIV_AGRI)) tryResearchQueue(c, opts.phase, DIV_AGRI, MAT_RESEARCH, purchases);
        if (divs.has(DIV_CHEM)) tryResearchQueue(c, opts.phase, DIV_CHEM, MAT_RESEARCH, purchases);
        writeSnapshot(ns, {
            time: Date.now(),
            source: opts.source,
            phase: opts.phase,
            count: purchases.length,
            purchases,
        });
    } catch (error) {
        appendWorkerLog(ns, 'corp-research-worker', `fatal: ${error?.stack ?? error?.message ?? error}`);
        writeSnapshot(ns, {
            time: Date.now(),
            source: opts.source,
            phase: opts.phase,
            error: String(error?.message ?? error),
        });
    }
}
