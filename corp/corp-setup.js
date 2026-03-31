/**
 * corp/corp-setup.js  —  Corporation bootstrapper
 *
 * Runs once to take the corp from nothing through investment rounds 1 and 2,
 * establishing a fully automated Agriculture + Chemical + Tobacco supply chain.
 * Writes '/corp-setup-done.txt' = 'true' on completion, then launches
 * corp-autopilot.js and exits.
 *
 * The script is idempotent — each phase checks whether its work is already
 * done and skips ahead, so it's safe to kill and restart.
 *
 * Setup phases
 * ────────────
 *  0  Create corp + buy essential unlocks
 *  1  Agriculture — all 6 cities, offices, warehouses, boost materials
 *  2  Accept investment round 1  (waits until offer ≥ MIN_ROUND1)
 *  3  Launch Chemical; set up Agri↔Chemical exports
 *  4  Accept investment round 2  (waits until offer ≥ MIN_ROUND2), then launch Tobacco
 *  5  Final office/warehouse scaling — hand off to corp-autopilot.js
 *
 * Supply chain
 * ────────────
 *  Chemical division → exports Chemicals → Agriculture division
 *  Agriculture     →  exports Plants  →  Tobacco division
 *  (Chemicals and Hardware bought from market via Smart Supply)
 *
 * @param {NS} ns
 */
import { log, formatMoney } from '/helpers.js';

// ── Division / industry names ─────────────────────────────────────────────────
const CORP_NAME = 'Nite-Corp';
const DIV_TOBACCO = 'Tobacco';
const DIV_AGRI = 'Agriculture';
const DIV_CHEM = 'Chemical';
const IND_TOBACCO = 'Tobacco';
const IND_AGRI = 'Agriculture';
const IND_CHEM = 'Chemical';

// ── Geography ─────────────────────────────────────────────────────────────────
const CITIES = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];
const HQ_CITY = 'Sector-12';

// ── Investment thresholds ─────────────────────────────────────────────────────
// Round 1: offer = valuation × 0.1 × 3 = 0.3 × valuation.
// 25B is an early bootstrap threshold that avoids stalling the corp.
const MIN_ROUND1 = 75e9;
const MIN_ROUND2 = 100e9;

// ── Flags / temp files ────────────────────────────────────────────────────────
const SETUP_DONE_FLAG = '/corp-setup-done.txt';
const SETUP_PHASE_FILE = '/corp-setup-phase.txt';
const SETUP_LOCK = '/Temp/corp-setup.lock.txt';

// ── Exact strings from Enums.ts ───────────────────────────────────────────────
const JOBS = {
    ops: 'Operations',
    eng: 'Engineer',
    biz: 'Business',
    mgmt: 'Management',
    rnd: 'Research & Development',
    intern: 'Intern',
    unassigned: 'Unassigned',
};

const UNLOCKS = {
    warehouseAPI: 'Warehouse API',
    officeAPI: 'Office API',
    smartSupply: 'Smart Supply',
    export: 'Export',
    mktDemand: 'Market Research - Demand',
    mktComp: 'Market Data - Competition',
};

// ── Boost material optimiser (Lagrange multiplier method from docs) ───────────
function optimalBoosts(S, factors, sizes, names) {
    const c = [...factors], s = [...sizes], n = [...names];
    while (c.length) {
        const csum = c.reduce((a, b) => a + b, 0);
        const qtys = c.map((ci, j) => {
            const oc = csum - ci, os = s.reduce((a, sk, k) => k !== j ? a + sk : a, 0);
            return (S - 500 * (s[j] / ci * oc - os)) / (csum / ci) / s[j];
        });
        const negIdx = qtys.reduce((worst, v, i) => v < 0 && (worst === -1 || v < qtys[worst]) ? i : worst, -1);
        if (negIdx === -1) return Object.fromEntries(n.map((k, i) => [k, Math.floor(qtys[i])]));
        c.splice(negIdx, 1); s.splice(negIdx, 1); n.splice(negIdx, 1);
    }
    return {};
}

// Per-division boost material factors and sizes
const AGRI_FACTORS = [0.72, 0.20, 0.30, 0.30]; // RE, HW, Robots, AI
const AGRI_SIZES = [0.005, 0.06, 0.5, 0.1];
const AGRI_MATS = ['Real Estate', 'Hardware', 'Robots', 'AI Cores'];

const CHEM_FACTORS = [0.25, 0.25, 0.20, 0.20];
const CHEM_SIZES = [0.005, 0.5, 0.06, 0.1];
const CHEM_MATS = ['Real Estate', 'Robots', 'Hardware', 'AI Cores'];

// ── Market cycle duration ─────────────────────────────────────────────────────
const CYCLE_SECS = 10;
const CYCLE_MS = 11000;

const argsSchema = [
    ['self-fund', false],
];

export function autocomplete(data) {
    data.flags(argsSchema);
    return [];
}

export async function main(ns) {
    const opts = ns.flags(argsSchema);
    ns.disableLog('ALL');
    ns.ui.openTail();
    const c = ns.corporation;

    function resolvePath(key, fallback) {
        try {
            const p = JSON.parse(ns.read('/script-paths.json'));
            return p[key] ?? fallback;
        } catch {
            return fallback;
        }
    }

    function readLock() {
        try {
            return JSON.parse(ns.read(SETUP_LOCK) || 'null');
        } catch {
            return null;
        }
    }

    function lockStillValid(lock) {
        if (!lock || typeof lock !== 'object') return false;
        if (lock.host !== ns.getHostname()) return false;
        return ns.ps(lock.host).some(p => p.pid === lock.pid && p.filename === ns.getScriptName());
    }

    function readSetupPhase() {
        try {
            const raw = ns.read(SETUP_PHASE_FILE).trim();
            if (raw === '') return 0;
            const phase = Number.parseInt(raw, 10);
            return Number.isFinite(phase) && phase >= 0 ? phase : 0;
        } catch {
            return 0;
        }
    }

    function writeSetupPhase(phase) {
        try { ns.write(SETUP_PHASE_FILE, String(phase), 'w'); } catch { }
    }

    function acquireLock() {
        const lock = readLock();
        if (lockStillValid(lock)) return false;

        ns.write(SETUP_LOCK, JSON.stringify({
            pid: ns.pid,
            host: ns.getHostname(),
            file: ns.getScriptName(),
            started: Date.now(),
        }), 'w');

        return true;
    }

    async function waitCycles(n = 1) {
        await ns.sleep(CYCLE_MS * n);
    }

    if (!acquireLock()) {
        log(ns, 'corp-setup is already running.', true, 'warning');
        return;
    }

    let setupPhase = readSetupPhase();
    let setupCompleted = false;

    if (!c.hasCorporation() && setupPhase !== 0) {
        setupPhase = 0;
        writeSetupPhase(0);
    }

    if (c.hasCorporation() && setupPhase >= 6) {
        writeSetupPhase(6);
        try { ns.write(SETUP_DONE_FLAG, 'true', 'w'); } catch { }
        const PILOT_SCRIPT = resolvePath('corp-autopilot', 'corp/corp-autopilot.js');
        try {
            const running = ns.ps('home').some(p => p.filename === PILOT_SCRIPT);
            if (!running) ns.run(PILOT_SCRIPT);
        } catch {
            ns.run(PILOT_SCRIPT);
        }
        return;
    }

    function getBoostTargets(div, city, factors, sizes, mats) {
        try {
            const wh = c.getWarehouse(div, city);
            return optimalBoosts(wh.size * 0.70, [...factors], [...sizes], [...mats]);
        } catch {
            return {};
        }
    }

    function assignJobs(div, city, { ops = 0, eng = 0, biz = 0, mgmt = 0, rnd = 0 } = {}) {
        for (const job of [JOBS.ops, JOBS.eng, JOBS.biz, JOBS.mgmt, JOBS.rnd]) {
            try { c.setJobAssignment(div, city, job, 0); } catch { }
        }
        try { c.setJobAssignment(div, city, JOBS.ops, ops); } catch { }
        try { c.setJobAssignment(div, city, JOBS.eng, eng); } catch { }
        try { c.setJobAssignment(div, city, JOBS.biz, biz); } catch { }
        try { c.setJobAssignment(div, city, JOBS.mgmt, mgmt); } catch { }
        try { c.setJobAssignment(div, city, JOBS.rnd, rnd); } catch { }
    }

    function fillOffice(div, city, targetSize, jobCounts) {
        const office = c.getOffice(div, city);
        if (office.size < targetSize) {
            c.upgradeOfficeSize(div, city, targetSize - office.size);
        }
        const numEmployees = c.getOffice(div, city).numEmployees;
        for (let i = numEmployees; i < targetSize; i++) {
            c.hireEmployee(div, city, JOBS.unassigned);
        }
        assignJobs(div, city, jobCounts);
    }

    async function applyBoostMaterials(div, city, targets) {
        for (const [mat, target] of Object.entries(targets)) {
            const stored = c.getMaterial(div, city, mat).stored;
            const needed = Math.max(0, target - stored);
            if (needed > 0) c.buyMaterial(div, city, mat, needed / CYCLE_SECS);
        }
        await waitCycles(1);
        for (const mat of Object.keys(targets)) {
            c.buyMaterial(div, city, mat, 0);
        }
    }

    function expandToAllCities(div) {
        const existing = c.getDivision(div).cities;
        for (const city of CITIES) {
            if (!existing.includes(city)) c.expandCity(div, city);
        }
        for (const city of CITIES) {
            if (!c.hasWarehouse(div, city)) c.purchaseWarehouse(div, city);
        }
    }

    function buyUnlock(name) {
        try {
            if (!c.hasUnlock(name)) {
                c.purchaseUnlock(name);
                log(ns, '  Purchased unlock: ' + name, false, 'info');
            }
        } catch (e) {
            log(ns, '  WARN: Could not buy unlock "' + name + '": ' + e?.message, false, 'warning');
        }
    }

    function enableSmartSupply(div) {
        if (!c.hasUnlock(UNLOCKS.smartSupply)) return;
        for (const city of CITIES) {
            try {
                if (c.hasWarehouse(div, city)) c.setSmartSupply(div, city, true);
            } catch { }
        }
    }

    function setSmartSupplyLeftovers(div, materials) {
        if (!c.hasUnlock(UNLOCKS.smartSupply)) return;
        for (const city of CITIES) {
            for (const mat of materials) {
                try { c.setSmartSupplyOption(div, city, mat, 'leftovers'); } catch { }
            }
        }
    }

    function boostMorale(div) {
        for (const city of CITIES) {
            try { c.buyTea(div, city); } catch { }
            try { c.throwParty(div, city, 500e3); } catch { }
        }
    }

    function keepAgriRunning() {
        for (const city of CITIES) {
            try { c.sellMaterial(DIV_AGRI, city, 'Food', 'MAX', 'MP'); } catch { }
            try { c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP'); } catch { }

            try {
                fillOffice(DIV_AGRI, city, 9, { ops: 4, eng: 2, biz: 1, mgmt: 1, rnd: 1 });
            } catch { }

        }
    }

    ns.atExit(() => {
        try { ns.rm(SETUP_LOCK, 'home'); } catch { }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 0 — Create corp + buy essential unlocks
    // ─────────────────────────────────────────────────────────────────────────
    if (setupPhase <= 0) {
    if (!c.hasCorporation()) {
        log(ns, `INFO: Creating "${CORP_NAME}"...`, true, 'info');
        const inBn3 = ns.getResetInfo().currentNode === 3;
        const selfFund = !inBn3 || opts['self-fund'];
        const ok = c.createCorporation(CORP_NAME, selfFund);
        if (!ok) {
            log(ns, `ERROR: Could not create corporation. ${inBn3 ? 'Need SF3.' : 'Need SF3 or $150B player funds.'}`, true, 'error');
            return;
        }
        await waitCycles(1);
    }

    const corp0 = c.getCorporation();
    log(ns, `INFO: "${corp0.name}" active. Funds: ${formatMoney(corp0.funds)}`, true);

    for (const name of [
        UNLOCKS.warehouseAPI,
        UNLOCKS.officeAPI,
        UNLOCKS.smartSupply,
        UNLOCKS.export,
        UNLOCKS.mktDemand,
        UNLOCKS.mktComp,
    ]) {
        buyUnlock(name);
    }

        writeSetupPhase(1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1 — Agriculture: all cities, offices, warehouses, boost materials
    // ─────────────────────────────────────────────────────────────────────────
    if (setupPhase <= 1) {
    if (!c.getCorporation().divisions.includes(DIV_AGRI)) {
        log(ns, `INFO: Expanding into Agriculture ($40 B)...`, true, 'info');
        c.expandIndustry(IND_AGRI, DIV_AGRI);
    }

    expandToAllCities(DIV_AGRI);
    enableSmartSupply(DIV_AGRI);

    for (const city of CITIES) {
        fillOffice(DIV_AGRI, city, 9, { ops: 4, eng: 2, biz: 1, mgmt: 1, rnd: 1 });
    }

    boostMorale(DIV_AGRI);
    await waitCycles(1);

    for (const city of CITIES) {
        c.sellMaterial(DIV_AGRI, city, 'Food', 'MAX', 'MP');
        c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP');
    }

    log(ns, 'INFO: Applying Phase 1 Agriculture boost materials...', true);
    for (const city of CITIES) {
        const targets = getBoostTargets(DIV_AGRI, city, AGRI_FACTORS, AGRI_SIZES, AGRI_MATS);
        await applyBoostMaterials(DIV_AGRI, city, targets);
    }

        writeSetupPhase(2);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2 — Wait for and accept investment round 1
    // ─────────────────────────────────────────────────────────────────────────
    if (setupPhase <= 2) {
    log(ns, `INFO: Waiting for round-1 offer ≥ ${formatMoney(MIN_ROUND1)}...`, true);
    while (true) {
        await waitCycles(2);

        keepAgriRunning();

        if (c.getCorporation().funds > 5e9) {
            for (const city of CITIES) {
                try {
                    if (c.getWarehouse(DIV_AGRI, city).level < 3) {
                        c.upgradeWarehouse(DIV_AGRI, city, 1);
                    }
                } catch { }
            }
        }

        const offer = c.getInvestmentOffer();
        log(ns, `  Round ${offer.round} offer: ${formatMoney(offer.funds)}`, false);

        if (offer.round > 1) {
            log(ns, 'INFO: Round 1 already accepted — skipping wait.', true, 'info');
            break;
        }

        if (offer.round === 1 && offer.funds >= MIN_ROUND1) {
            c.acceptInvestmentOffer();
            log(ns, `INFO: Accepted Round 1 — received ${formatMoney(offer.funds)}!`, true, 'success');
            break;
        }
    }
    await waitCycles(1);

        writeSetupPhase(3);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3 — Launch Chemical; supply chain; scale Agri
    // ─────────────────────────────────────────────────────────────────────────
    if (setupPhase <= 3) {
    log(ns, 'INFO: Phase 3 — launching Chemical division...', true);

    for (const city of CITIES) {
        fillOffice(DIV_AGRI, city, 15, { ops: 6, eng: 3, biz: 1, mgmt: 3, rnd: 2 });
    }

    boostMorale(DIV_AGRI);
    log(ns, 'INFO: Applying Phase 2 Agriculture boost materials...', true);
    for (const city of CITIES) {
        const targets = getBoostTargets(DIV_AGRI, city, AGRI_FACTORS, AGRI_SIZES, AGRI_MATS);
        await applyBoostMaterials(DIV_AGRI, city, targets);
    }

    if (!c.getCorporation().divisions.includes(DIV_CHEM)) {
        log(ns, `INFO: Expanding into Chemical ($70 B)...`, true, 'info');
        c.expandIndustry(IND_CHEM, DIV_CHEM);
    }

    expandToAllCities(DIV_CHEM);
    enableSmartSupply(DIV_CHEM);

    for (const city of CITIES) {
        fillOffice(DIV_CHEM, city, 9, { ops: 2, eng: 4, biz: 0, mgmt: 2, rnd: 1 });
    }

    boostMorale(DIV_CHEM);

    for (const city of CITIES) {
        c.sellMaterial(DIV_CHEM, city, 'Chemicals', 'MAX', 'MP');
    }

    log(ns, 'INFO: Applying Chemical boost materials...', true);
    for (const city of CITIES) {
        const targets = getBoostTargets(DIV_CHEM, city, CHEM_FACTORS, CHEM_SIZES, CHEM_MATS);
        await applyBoostMaterials(DIV_CHEM, city, targets);
    }

    for (const city of CITIES) {
        try { c.exportMaterial(DIV_CHEM, city, DIV_AGRI, city, 'Chemicals', 'PROD'); } catch { }
    }
    setSmartSupplyLeftovers(DIV_AGRI, ['Water', 'Chemicals']);
    setSmartSupplyLeftovers(DIV_CHEM, ['Plants', 'Water']);

        writeSetupPhase(4);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 4 — Wait for and accept investment round 2
    // ─────────────────────────────────────────────────────────────────────────
    if (setupPhase <= 4) {
    log(ns, `INFO: Waiting for round-2 offer ≥ ${formatMoney(MIN_ROUND2)}...`, true);

    const RESEARCH_QUEUE = [
        'Hi-Tech R&D Laboratory',
        'Market-TA.I',
        'Market-TA.II',
        'uPgrade: Fulcrum',
        'uPgrade: Capacity.I',
        'Drones',
        'Drones - Assembly',
        'Self-Correcting Assemblers',
        'Overclock',
        'CPH4 Injections',
    ];

    const MAT_RESEARCH_QUEUE = [
        'Hi-Tech R&D Laboratory',
        'Drones',
        'Drones - Assembly',
        'Self-Correcting Assemblers',
        'Drones - Transport',
        'Overclock',
        'CPH4 Injections',
    ];

    while (true) {
        await waitCycles(3);

        for (const div of [DIV_AGRI, DIV_CHEM]) {
            boostMorale(div);
        }

        if (c.getCorporation().divisions.includes(DIV_TOBACCO)) {
            for (const pName of c.getDivision(DIV_TOBACCO).products) {
                try {
                    const prod = c.getProduct(DIV_TOBACCO, HQ_CITY, pName);
                    if (prod.developmentProgress >= 100) {
                        if (c.hasResearched(DIV_TOBACCO, 'Market-TA.II')) {
                            c.setProductMarketTA2(DIV_TOBACCO, pName, true);
                        } else if (c.hasResearched(DIV_TOBACCO, 'Market-TA.I')) {
                            c.setProductMarketTA1(DIV_TOBACCO, pName, true);
                            c.sellProduct(DIV_TOBACCO, HQ_CITY, pName, 'MAX', 'MP*2', true);
                        } else {
                            c.sellProduct(DIV_TOBACCO, HQ_CITY, pName, 'MAX', 'MP*3', true);
                        }
                    }
                } catch { }
            }

            for (const rName of RESEARCH_QUEUE) {
                try {
                    if (!c.hasResearched(DIV_TOBACCO, rName)) {
                        const div = c.getDivision(DIV_TOBACCO);
                        if (div.researchPoints >= c.getResearchCost(DIV_TOBACCO, rName)) {
                            c.research(DIV_TOBACCO, rName);
                            log(ns, `INFO: Researched "${rName}" (Tobacco)`, false, 'info');
                        }
                    }
                } catch { }
            }
        }

        for (const [div, queue] of [[DIV_AGRI, MAT_RESEARCH_QUEUE], [DIV_CHEM, MAT_RESEARCH_QUEUE]]) {
            for (const rName of queue) {
                try {
                    if (!c.hasResearched(div, rName)) {
                        const d = c.getDivision(div);
                        if (d.researchPoints >= c.getResearchCost(div, rName)) {
                            c.research(div, rName);
                            log(ns, `INFO: Researched "${rName}" (${div})`, false, 'info');
                        }
                    }
                } catch { }
            }
        }

        const funds = c.getCorporation().funds;
        for (const upg of [
            'Smart Factories',
            'Smart Storage',
            'NuoptimalNootropicInjectorImplants',
            'Neural Accelerators',
            'FocusWires',
            'Speech Processor Implants',
            'ABC SalesBots',
            'Wilson Analytics',
        ]) {
            try {
                if (funds > c.getUpgradeLevelCost(upg) * 1.5) c.levelUpgrade(upg);
            } catch { }
        }

        const offer = c.getInvestmentOffer();
        log(ns, `  Round ${offer.round} offer: ${formatMoney(offer.funds)}`, false);

        if (offer.round > 2) {
            log(ns, 'INFO: Round 2 already accepted — skipping wait.', true, 'info');
            break;
        }

        if (offer.round === 2 && offer.funds >= MIN_ROUND2) {
            c.acceptInvestmentOffer();
            log(ns, `INFO: Accepted Round 2 — received ${formatMoney(offer.funds)}!`, true, 'success');
            break;
        }
    }
    await waitCycles(1);

        writeSetupPhase(5);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5 — Launch Tobacco and final scaling before handoff
    // ─────────────────────────────────────────────────────────────────────────
    if (setupPhase <= 5) {
    log(ns, 'INFO: Phase 5 — final scaling pass...', true);

    if (!c.getCorporation().divisions.includes(DIV_TOBACCO)) {
        if (c.getCorporation().funds >= 20e9) {
            log(ns, `INFO: Expanding into Tobacco ($20 B)...`, true, 'info');
            c.expandIndustry(IND_TOBACCO, DIV_TOBACCO);
        }
    }

    if (c.getCorporation().divisions.includes(DIV_TOBACCO)) {
        expandToAllCities(DIV_TOBACCO);
        enableSmartSupply(DIV_TOBACCO);
        setSmartSupplyLeftovers(DIV_AGRI, ['Water', 'Chemicals']);
        setSmartSupplyLeftovers(DIV_CHEM, ['Plants', 'Water']);
        setSmartSupplyLeftovers(DIV_TOBACCO, ['Plants']);

        for (const city of CITIES) {
            try { c.exportMaterial(DIV_AGRI, city, DIV_TOBACCO, city, 'Plants', 'PROD'); } catch { }
        }

        const FIRST_PRODUCT = 'Tobac-v1';
        const tobDiv = c.getDivision(DIV_TOBACCO);
        if (!tobDiv.products.includes(FIRST_PRODUCT)) {
            const funds = c.getCorporation().funds;
            const invest = Math.min(funds * 0.05, 2e9);
            try {
                c.makeProduct(DIV_TOBACCO, HQ_CITY, FIRST_PRODUCT, invest / 2, invest / 2);
                log(ns, `INFO: Started developing "${FIRST_PRODUCT}" (${formatMoney(invest)} total invest)`, true, 'info');
            } catch (e) {
                log(ns, `WARN: Could not start first product: ${e?.message}`, false, 'warning');
            }
        }
    }

    for (const city of CITIES) {
        const isHQ = city === HQ_CITY;
        fillOffice(
            DIV_TOBACCO,
            city,
            isHQ ? 30 : 20,
            isHQ
                ? { ops: 9, eng: 8, biz: 3, mgmt: 7, rnd: 3 }
                : { ops: 6, eng: 4, biz: 2, mgmt: 5, rnd: 3 }
        );
        fillOffice(DIV_AGRI, city, 20, { ops: 8, eng: 4, biz: 1, mgmt: 4, rnd: 3 });
        fillOffice(DIV_CHEM, city, 15, { ops: 3, eng: 7, biz: 0, mgmt: 3, rnd: 2 });
    }

    for (const div of [DIV_TOBACCO, DIV_AGRI, DIV_CHEM]) {
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(div, city);
                if (wh.level < 6) c.upgradeWarehouse(div, city, 6 - wh.level);
            } catch { }
        }
    }

    log(ns, 'INFO: Topping up Agriculture boost materials...', true);
    const AGRI_BOOST_FINAL = { 'Real Estate': 10000, 'Hardware': 500, 'Robots': 60, 'AI Cores': 400 };
    const CHEM_BOOST_FINAL = { 'Real Estate': 3000, 'Hardware': 300, 'Robots': 50, 'AI Cores': 200 };
    for (const city of CITIES) {
        await applyBoostMaterials(DIV_AGRI, city, AGRI_BOOST_FINAL);
        await applyBoostMaterials(DIV_CHEM, city, CHEM_BOOST_FINAL);
    }

    boostMorale(DIV_TOBACCO);
    boostMorale(DIV_AGRI);
    boostMorale(DIV_CHEM);

    try {
        if (c.getCorporation().funds > c.getHireAdVertCost(DIV_TOBACCO) * 2) {
            c.hireAdVert(DIV_TOBACCO);
            log(ns, 'INFO: Hired AdVert for Tobacco.', false, 'info');
        }
    } catch { }

    }

    writeSetupPhase(6);
    setupCompleted = true;
    try { ns.write(SETUP_DONE_FLAG, 'true', 'w'); } catch { }
    log(ns, '═══════════════════════════════════════════════════════', true);
    log(ns, 'INFO: Setup complete! Handing off to corp-autopilot.js.', true, 'success');
    log(ns, '═══════════════════════════════════════════════════════', true);

    const PILOT_SCRIPT = resolvePath('corp-autopilot', 'corp/corp-autopilot.js');
    try {
        const running = ns.ps('home').some(p => p.filename === PILOT_SCRIPT);
        if (!running) ns.run(PILOT_SCRIPT);
    } catch {
        ns.run(PILOT_SCRIPT);
    }
}