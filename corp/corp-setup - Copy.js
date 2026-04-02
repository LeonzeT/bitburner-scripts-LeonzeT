/**
 * corp/corp-setup.js  —  Corporation bootstrapper
 *
 * Runs once to take the corp from nothing through investment rounds 1 and 2,
 * establishing a fully automated Tobacco + Agriculture + Chemical supply chain.
 * Writes '/corp-setup-done.txt' = 'true' on completion, then launches
 * corp-autopilot.js and exits.
 *
 * Supply chain (Agriculture + Chemical + Tobacco — the optimal chain per docs)
 * ────────────────────────────────────────────────────────────────────────────
 *  Agriculture → exports Plants → Chemical  (Chemical needs Plants + Water)
 *  Chemical    → exports Chemicals → Agriculture  (Agri needs Chemicals + Water)
 *  Agriculture → exports Plants → Tobacco   (FIFO: Tobacco set first)
 *  Water is purchased from the open market via Smart Supply (quality=1, free)
 *
 * Why Chemical, not Water Utilities?
 *  Chemical has the highest scienceFactor (0.75) of all material industries.
 *  High RP in Chemical → high-quality Chemicals → high-quality Plants in Agri
 *  → high effective rating on Tobacco products.  Water Utilities produces
 *  nothing that participates in this quality loop; Smart Supply covers Water.
 *
 * Setup phases
 * ────────────
 *  0  Create corp + buy essential unlocks
 *  1  Agriculture — all 6 cities, offices, warehouses, initial boost materials
 *  2  Accept round 1 (≥ MIN_ROUND1; buys SmartStorage + Advert while waiting)
 *  3  Launch Chemical + Tobacco; supply-chain exports; first product
 *  4  Accept round 2 (≥ MIN_ROUND2; research/upgrades/boosts/dummies while waiting)
 *  5  Final scaling — hand off to corp-autopilot.js
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
const PHASE3_CHEM_START_CITIES = [HQ_CITY];
const PHASE3_TOB_START_CITIES = [HQ_CITY];

// ── Investment thresholds ─────────────────────────────────────────────────────
// Round 1 (10% dilution, offer = val×0.3): need enough post-acceptance funds
// to cover Chemical ($70B) + Tobacco ($20B) + city expansions (~50B each) + buffer.
// At 25B we accepted with nothing left to fund Phase 3 → infinite crash loop.
const MIN_ROUND1 = 34e9;  // Accept early — 210B is unreachable from Agriculture alone
const MIN_ROUND2 = 5e12;
const ROUND1_FREEZE_RATIO = 0.80;
const ROUND1_SOFT_ACCEPT = 28e9;
const ROUND1_NO_IMPROVE_LIMIT = 6;
const MAX_ROUND1_SMART_STORAGE = 2;
const MAX_ROUND1_WAREHOUSE_LEVEL = 2;
const ROUND1_USE_CUSTOM_SUPPLY = true;
const ROUND1_TARGET = ROUND1_USE_CUSTOM_SUPPLY ? 210e9 : MIN_ROUND1;
const ROUND1_SOFT_FLOOR = ROUND1_USE_CUSTOM_SUPPLY ? 200e9 : ROUND1_SOFT_ACCEPT;
const ROUND1_STAGNATION_LIMIT = ROUND1_USE_CUSTOM_SUPPLY ? 12 : ROUND1_NO_IMPROVE_LIMIT;
const ROUND1_SMART_STORAGE_TARGET = ROUND1_USE_CUSTOM_SUPPLY ? 4 : MAX_ROUND1_SMART_STORAGE;
const ROUND1_WAREHOUSE_TARGET = ROUND1_USE_CUSTOM_SUPPLY ? 3 : MAX_ROUND1_WAREHOUSE_LEVEL;
const ROUND1_ADVERT_TARGET = ROUND1_USE_CUSTOM_SUPPLY ? 4 : 2;
const ROUND1_SUPPLY_BUFFER_CYCLES = 2.5;
const ROUND1_SUPPLY_SEED = { Water: 75, Chemicals: 30 };
const PHASE3_CHEM_MIN_RESERVE = 18e9;
const PHASE3_CHEM_MID_RESERVE = 30e9;
const PHASE3_CHEM_FREEZE_GAP = 8e9;
const PHASE3_AGRI_TARGET_OFFICE = 8;
const PHASE3_AGRI_TARGET_WAREHOUSE = 8;
const PHASE3_AGRI_TARGET_ADVERT = 8;
const PHASE3_AGRI_GLOBAL_UPGRADE_TARGET = 6;
const PHASE3_CHEM_INITIAL_OFFICE = 3;
const PHASE3_CHEM_INITIAL_WAREHOUSE = 2;
const PHASE3_TOB_INITIAL_HQ_OFFICE = 6;
const PHASE3_EXPORT_RESERVE = 2e9;
const PHASE3_CHEM_WATER_SEED = 120;
const PHASE3_CHEM_WATER_BUFFER_CYCLES = 3;
const ROUND2_AGRI_OFFICE = 8;
const ROUND2_AGRI_WAREHOUSE = 4;
const ROUND2_AGRI_ADVERT = 8;
const ROUND2_AGRI_SMALL_JOBS = { ops: 1, eng: 1, rnd: 2 };
const ROUND2_AGRI_JOBS = { ops: 1, eng: 2, biz: 1, mgmt: 1, rnd: 3 };
const ROUND2_TOB_HQ_OFFICE = 15;
const ROUND2_TOB_SUPPORT_OFFICE = 3;
const ROUND2_TOB_ADVERT = 2;
const ROUND2_TOB_HQ_SMALL_JOBS = { ops: 1, eng: 3, biz: 1, mgmt: 1 };
const ROUND2_TOB_HQ_MID_JOBS = { ops: 2, eng: 4, biz: 1, mgmt: 2 };
const ROUND2_CHEM_OFFICE = 3;
const ROUND2_TOB_HQ_JOBS = { ops: 3, eng: 7, biz: 1, mgmt: 4 };
const ROUND2_TOB_SUPPORT_JOBS = { rnd: 3 };
const ROUND2_CHEM_JOBS = { eng: 1, rnd: 2 };
const ROUND2_CHEM_BOOTSTRAP_SUPPORT_CITIES = 2;
const ROUND2_RESERVE_MIN = 45e9;
const ROUND2_RESERVE_MID = 75e9;
const ROUND2_RESERVE_HIGH = 105e9;
const ROUND2_RESERVE_PEAK = 130e9;
const ROUND2_FREEZE_BEST_OFFER = 1.25e12;
const ROUND2_TOB_SUPPORT_TRIGGER = 4e11;
const ROUND2_AGRI_OFFICE_TRIGGER = 3.5e11;
const ROUND2_CHEM_FULL_TRIGGER = 8e11;
const ROUND2_DUMMY_TRIGGER = 2.2e11;
const ROUND2_DUMMY_STAGNATION_LIMIT = 2;
const ROUND2_DUMMY_BUFFER = 60e9;
const ROUND2_GLOBAL_UPGRADE_TARGET = 8;
const ROUND2_PRODUCT_MIN_INVEST = 2e8;
const ROUND2_PRODUCT_MAX_INVEST = 5e9;

// ── RP targets before the quality loop is strong enough (from docs) ───────────
// "Waiting for 700RP/390RP in Agriculture/Chemical respectively is enough."
const RP_TARGET_AGRI = 700;
const RP_TARGET_CHEM = 390;

// ── Flags / temp files ────────────────────────────────────────────────────────
const SETUP_DONE_FLAG = '/corp-setup-done.txt';
const SETUP_PHASE_FILE = '/corp-setup-phase.txt';
const SETUP_LOCK = '/Temp/corp-setup.lock.txt';

// ── Job strings — exact CorpEmployeeJob enum values ───────────────────────────
const JOBS = {
    ops: 'Operations', eng: 'Engineer', biz: 'Business',
    mgmt: 'Management', rnd: 'Research & Development', unassigned: 'Unassigned',
};

// ── Unlock strings ────────────────────────────────────────────────────────────
const UNLOCKS = {
    warehouseAPI: 'Warehouse API', officeAPI: 'Office API',
    smartSupply: 'Smart Supply', export: 'Export',
    mktDemand: 'Market Research - Demand', mktComp: 'Market Data - Competition',
};

// ── Boost material optimiser — Lagrange multiplier method (docs: boost-material.md) ──
// Maximises division production multiplier subject to warehouse space constraint.
// At small warehouse sizes only Real Estate is worth buying (factor 0.72, size 0.005).
// Hardware enters at S≥106, AI Cores at S≥121, Robots never for Agri/Chem.
function optimalBoosts(S, factors, sizes, names) {
    const c = [...factors], s = [...sizes], n = [...names];
    while (c.length) {
        const csum = c.reduce((a, b) => a + b, 0);
        const qtys = c.map((ci, j) => {
            const oc = csum - ci;
            const os = s.reduce((a, sk, k) => k !== j ? a + sk : a, 0);
            return (S - 500 * (s[j] / ci * oc - os)) / (csum / ci) / s[j];
        });
        const neg = qtys.reduce((w, v, i) => v < 0 && (w === -1 || v < qtys[w]) ? i : w, -1);
        if (neg === -1) return Object.fromEntries(n.map((k, i) => [k, Math.floor(qtys[i])]));
        c.splice(neg, 1); s.splice(neg, 1); n.splice(neg, 1);
    }
    return {};
}

// ── Per-division boost material coefficients and sizes ────────────────────────
// Source: IndustryData.ts (realEstateFactor/hardwareFactor/robotFactor/aiCoreFactor)
// Sizes: MaterialInfo.ts
const AGRI_FACTORS = [0.72, 0.20, 0.30, 0.30];
const AGRI_SIZES = [0.005, 0.06, 0.5, 0.1];
const AGRI_MATS = ['Real Estate', 'Hardware', 'Robots', 'AI Cores'];

// Chemical: realEstate=0.25, hardware=0.20, robot=0.25, aiCore=0.20
// scienceFactor=0.75 (highest material industry) — why Chemical is mandatory
const CHEM_FACTORS = [0.25, 0.20, 0.25, 0.20];
const CHEM_SIZES = [0.005, 0.06, 0.5, 0.1];
const CHEM_MATS = ['Real Estate', 'Hardware', 'Robots', 'AI Cores'];

// ── Research queues ───────────────────────────────────────────────────────────
// Excluded (per docs): AutoBrew/AutoPartyManager ("useless"), Capacity.I/II ("not useful").
// CPH4 prerequisite 'Automatic Drug Administration' is included.
const TOB_RESEARCH = [
    'Hi-Tech R&D Laboratory',      // +10% RP; prerequisite for all others
    'Market-TA.I',                 // Prerequisite only
    'Market-TA.II',                // TOP PRIORITY: optimal product pricing
    'uPgrade: Fulcrum',            // +5% product production  [10% RP rule]
    'Drones',                      // Prerequisite
    'Drones - Assembly',           // +20% production  [10% RP rule]
    'Self-Correcting Assemblers',  // +10% production  [10% RP rule]
    'Overclock',                   // +25% int/eff; prereq for Sti.mu
    'Sti.mu',                      // +max morale
    'Automatic Drug Administration', // Prereq for Go-Juice + CPH4
    'Go-Juice',                    // +max energy
    'CPH4 Injections',             // +10% all employee stats
];
const MAT_RESEARCH = [
    'Hi-Tech R&D Laboratory',
    'Drones',
    'Drones - Assembly',           // [10% RP rule]
    'Self-Correcting Assemblers',  // [10% RP rule]
    'Drones - Transport',          // +50% warehouse storage
    'Overclock', 'Sti.mu',
    'Automatic Drug Administration', 'Go-Juice', 'CPH4 Injections',
];

// Production research — only buy when cost < 10% of RP pool (not 50%).
// Depleting RP before product completes tanks product quality and markup.
const PRODUCTION_RESEARCH = new Set([
    'Drones - Assembly', 'Self-Correcting Assemblers', 'uPgrade: Fulcrum',
]);

// ── Market cycle ──────────────────────────────────────────────────────────────
const CYCLE_SECS = 10;
const CYCLE_MS = 11000;

const argsSchema = [['self-fund', false]];
export function autocomplete(data) { data.flags(argsSchema); return []; }

// ═════════════════════════════════════════════════════════════════════════════
export async function main(ns) {
    const opts = ns.flags(argsSchema);
    ns.disableLog('ALL');
    ns.ui.openTail();
    const c = ns.corporation;

    function resolvePath(key, fallbackFile) {
        try {
            const p = JSON.parse(ns.read('/script-paths.json') || '{}');
            if (typeof p[key] === 'string' && p[key].length > 0) return p[key];
        } catch { }
        const script = ns.getScriptName();
        const slash = script.lastIndexOf('/');
        return slash === -1 ? fallbackFile : `${script.slice(0, slash)}/${fallbackFile}`;
    }

    function getBoostConfig(industry, fallbackFactors, fallbackSizes, mats) {
        try {
            const data = c.getIndustryData(industry);
            return {
                factors: [
                    data.realEstateFactor ?? fallbackFactors[0],
                    data.hardwareFactor ?? fallbackFactors[1],
                    data.robotFactor ?? fallbackFactors[2],
                    data.aiCoreFactor ?? fallbackFactors[3],
                ],
                sizes: mats.map((mat, i) => c.getMaterialData(mat)?.size ?? fallbackSizes[i]),
                mats: [...mats],
            };
        } catch {
            return { factors: [...fallbackFactors], sizes: [...fallbackSizes], mats: [...mats] };
        }
    }

    const AGRI_BOOST = getBoostConfig(IND_AGRI, AGRI_FACTORS, AGRI_SIZES, AGRI_MATS);
    const CHEM_BOOST = getBoostConfig(IND_CHEM, CHEM_FACTORS, CHEM_SIZES, CHEM_MATS);

    function getRequiredMaterialsConfig(industry, fallback) {
        try { return { ...(c.getIndustryData(industry).requiredMaterials ?? fallback) }; }
        catch { return { ...fallback }; }
    }

    const ROUND1_AGRI_REQUIRED = getRequiredMaterialsConfig(IND_AGRI, { Water: 0.5, Chemicals: 0.2 });
    const ROUND1_AGRI_MAT_SIZES = Object.fromEntries(
        Object.keys(ROUND1_AGRI_REQUIRED).map((mat) => [mat, c.getMaterialData(mat)?.size ?? 0.05]),
    );

    // ── Lock ──────────────────────────────────────────────────────────────────
    function readLock() {
        try { return JSON.parse(ns.read(SETUP_LOCK) || 'null'); } catch { return null; }
    }
    function lockValid(lock) {
        if (!lock || typeof lock !== 'object') return false;
        if (lock.host !== ns.getHostname()) return false;
        return ns.ps(lock.host).some(p => p.pid === lock.pid && p.filename === ns.getScriptName());
    }
    function acquireLock() {
        if (lockValid(readLock())) return false;
        ns.write(SETUP_LOCK, JSON.stringify({
            pid: ns.pid, host: ns.getHostname(),
            file: ns.getScriptName(), started: Date.now(),
        }), 'w');
        return true;
    }
    if (!acquireLock()) { log(ns, 'corp-setup is already running.', true, 'warning'); return; }
    ns.atExit(() => { try { ns.rm(SETUP_LOCK, 'home'); } catch { } });

    // ── Phase tracking ────────────────────────────────────────────────────────
    function readPhase() {
        try { const n = parseInt(ns.read(SETUP_PHASE_FILE).trim(), 10); return isFinite(n) && n >= 0 ? n : 0; }
        catch { return 0; }
    }
    function writePhase(n) { try { ns.write(SETUP_PHASE_FILE, String(n), 'w'); } catch { } }
    function readDoneFlag() {
        try { return ns.read(SETUP_DONE_FLAG).trim() === 'true'; } catch { return false; }
    }
    function isPilotRunning() {
        const pilot = resolvePath('corp-autopilot', 'corp-autopilot.js');
        try { return ns.ps('home').some(p => p.filename === pilot); } catch { return false; }
    }
    function inferPhase() {
        if (!c.hasCorporation()) return 0;
        const corp = c.getCorporation();
        const divs = new Set(corp.divisions);
        const hasCoreUnlocks = c.hasUnlock(UNLOCKS.warehouseAPI) && c.hasUnlock(UNLOCKS.officeAPI);
        if (!hasCoreUnlocks) return 0;
        if (!divs.has(DIV_AGRI)) return 1;
        const agriInfraReady = divisionInfraReady(DIV_AGRI);
        const agriOfficesReady = CITIES.every((city) => {
            try {
                const office = c.getOffice(DIV_AGRI, city);
                return office.size >= 4 && office.numEmployees >= 4;
            } catch { return false; }
        });
        const agriBoosted = CITIES.every((city) => {
            try { return AGRI_BOOST.mats.some((mat) => c.getMaterial(DIV_AGRI, city, mat).stored > 0); }
            catch { return false; }
        });
        const agriPhase1Done = agriInfraReady && agriOfficesReady && c.getDivision(DIV_AGRI).researchPoints >= 55 && agriBoosted;
        if (!agriPhase1Done) return 1;
        const round = c.getInvestmentOffer().round;
        if (round <= 1) return 2;
        if (!divs.has(DIV_CHEM) || !divs.has(DIV_TOBACCO) || !c.hasUnlock(UNLOCKS.export)) return 3;
        if (round <= 2) return 4;
        return (readDoneFlag() || isPilotRunning()) ? 6 : 5;
    }
    function reconcilePhase() {
        const saved = readPhase();
        const inferred = inferPhase();
        if (saved !== inferred) {
            log(ns, `INFO: Reconciled setup phase ${saved} -> ${inferred} from corporation state.`, true, 'info');
            writePhase(inferred);
        }
        return inferred;
    }

    let phase = reconcilePhase();

    if (phase >= 6) {
        ns.write(SETUP_DONE_FLAG, 'true', 'w');
        const pilot = resolvePath('corp-autopilot', 'corp-autopilot.js');
        if (!ns.ps('home').some(p => p.filename === pilot)) ns.run(pilot);
        return;
    }
    if (!c.hasCorporation() && phase !== 0) {
        phase = 0;
        writePhase(0);
        try { ns.rm(SETUP_DONE_FLAG, 'home'); } catch { }
    }

    async function waitCycles(n = 1) { await ns.sleep(CYCLE_MS * n); }

    // ── Job assignment (two-pass — zero first, then set targets) ─────────────
    // setJobAssignment operates on employeeNextJobs (pending state).
    // Pass 1 zeros all → freed to Unassigned pool. Pass 2 draws from that pool.
    function assignJobs(div, city, { ops = 0, eng = 0, biz = 0, mgmt = 0, rnd = 0 } = {}) {
        for (const job of [JOBS.ops, JOBS.eng, JOBS.biz, JOBS.mgmt, JOBS.rnd])
            try { c.setJobAssignment(div, city, job, 0); } catch { }
        if (ops > 0) try { c.setJobAssignment(div, city, JOBS.ops, ops); } catch { }
        if (eng > 0) try { c.setJobAssignment(div, city, JOBS.eng, eng); } catch { }
        if (biz > 0) try { c.setJobAssignment(div, city, JOBS.biz, biz); } catch { }
        if (mgmt > 0) try { c.setJobAssignment(div, city, JOBS.mgmt, mgmt); } catch { }
        if (rnd > 0) try { c.setJobAssignment(div, city, JOBS.rnd, rnd); } catch { }
    }

    function fillOffice(div, city, targetSize, jobCounts) {
        const off = c.getOffice(div, city);
        if (off.size < targetSize) c.upgradeOfficeSize(div, city, targetSize - off.size);
        const n = c.getOffice(div, city).numEmployees;
        for (let i = n; i < targetSize; i++) c.hireEmployee(div, city, JOBS.unassigned);
        assignJobs(div, city, jobCounts);
    }

    // ── Boost materials ───────────────────────────────────────────────────────
    // Uses 70% of warehouse capacity for boosts (30% reserved for production stock).
    // Warehouse size = level × 100 × SmartStorageMult × DivResearchMult.
    function getBoostTargets(div, city, factors, sizes, mats) {
        try {
            const wh = c.getWarehouse(div, city);
            return optimalBoosts(wh.size * 0.70, [...factors], [...sizes], [...mats]);
        } catch { return {}; }
    }

    async function applyBoostMaterials(div, city, targets) {
        let anyNeeded = false;
        for (const [mat, target] of Object.entries(targets)) {
            const stored = c.getMaterial(div, city, mat).stored;
            const needed = Math.max(0, target - stored);
            if (needed > 0) { c.buyMaterial(div, city, mat, needed / CYCLE_SECS); anyNeeded = true; }
        }
        if (anyNeeded) {
            await waitCycles(1);
            for (const mat of Object.keys(targets)) c.buyMaterial(div, city, mat, 0);
        }
    }

    // Re-apply boosts whenever warehouse capacity changes from level, Smart Storage, or research.
    const prevWHCapacity = {};
    async function refreshBoosts(div, factors, sizes, mats) {
        for (const city of CITIES) {
            try {
                const key = `${div}|${city}`;
                const cap = c.getWarehouse(div, city).size;
                if (cap !== prevWHCapacity[key]) {
                    prevWHCapacity[key] = cap;
                    await applyBoostMaterials(div, city, getBoostTargets(div, city, factors, sizes, mats));
                }
            } catch { }
        }
    }

    // ── Division helpers ──────────────────────────────────────────────────────
    function hasDiv(div) {
        try { return c.getCorporation().divisions.includes(div); } catch { return false; }
    }

    function expandIndustryCost(industry) {
        try { return c.getIndustryData(industry).startingCost; } catch { return Infinity; }
    }

    function expandToCities(div, targetCities = CITIES) {
        const existing = c.getDivision(div).cities;
        for (const city of targetCities) {
            if (!existing.includes(city)) try { c.expandCity(div, city); } catch { }
        }
        for (const city of targetCities)
            if (!c.hasWarehouse(div, city)) try { c.purchaseWarehouse(div, city); } catch { }
    }

    function buyUnlock(name) {
        try {
            if (!c.hasUnlock(name)) { c.purchaseUnlock(name); log(ns, `  Purchased: ${name}`, false, 'info'); }
        } catch (e) { log(ns, `  WARN: Could not buy "${name}": ${e?.message}`, false, 'warning'); }
    }

    function enableSmartSupply(div) {
        if (!c.hasUnlock(UNLOCKS.smartSupply)) return;
        for (const city of CITIES)
            try { if (c.hasWarehouse(div, city)) c.setSmartSupply(div, city, true); } catch { }
    }

    function setLeftovers(div, city, materials) {
        if (!c.hasUnlock(UNLOCKS.smartSupply)) return;
        for (const material of materials) {
            try { c.setSmartSupplyOption(div, city, material, 'leftovers'); } catch { }
        }
    }

    function divisionInfraReady(div, targetCities = CITIES) {
        try {
            const cities = c.getDivision(div).cities;
            return targetCities.every(city => cities.includes(city) && c.hasWarehouse(div, city));
        } catch {
            return false;
        }
    }

    async function waitForDivisionInfrastructure(div, label, targetCities = CITIES) {
        while (!divisionInfraReady(div, targetCities)) {
            expandToCities(div, targetCities);
            if (!divisionInfraReady(div, targetCities)) {
                log(ns, `  Waiting for ${label} city/warehouse expansion...`, false);
                await waitCycles(2);
            }
        }
    }

    async function waitForWarehouseLevel(div, city, targetLevel) {
        while (true) {
            try {
                const wh = c.getWarehouse(div, city);
                if (wh.level >= targetLevel) return;
                c.upgradeWarehouse(div, city, 1);
            } catch { }
            await waitCycles(1);
        }
    }

    async function waitFillOffice(div, city, targetSize, jobCounts) {
        while (true) {
            try {
                fillOffice(div, city, targetSize, jobCounts);
                return;
            } catch { }
            await waitCycles(1);
        }
    }

    function maintainAgriSalesAndJobs(jobCounts = { ops: 1, eng: 1, biz: 1, mgmt: 1 }) {
        for (const city of CITIES) {
            try { c.sellMaterial(DIV_AGRI, city, 'Food', 'MAX', 'MP'); } catch { }
            try { c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP'); } catch { }
            try { assignJobs(DIV_AGRI, city, jobCounts); } catch { }
        }
    }

    function maintainRound1AgriSupply() {
        if (!ROUND1_USE_CUSTOM_SUPPLY) return;
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                const freeSpace = Math.max(0, wh.size - wh.sizeUsed);
                const rawProd = Math.max(
                    c.getMaterial(DIV_AGRI, city, 'Plants').productionAmount || 0,
                    c.getMaterial(DIV_AGRI, city, 'Food').productionAmount || 0,
                    0,
                );
                const needed = {};
                let totalNeedSize = 0;
                for (const [mat, coeff] of Object.entries(ROUND1_AGRI_REQUIRED)) {
                    const stored = c.getMaterial(DIV_AGRI, city, mat).stored;
                    const seed = ROUND1_SUPPLY_SEED[mat] ?? 0;
                    const target = Math.max(seed, rawProd * coeff * CYCLE_SECS * ROUND1_SUPPLY_BUFFER_CYCLES);
                    const deficit = Math.max(0, target - stored);
                    needed[mat] = deficit;
                    totalNeedSize += deficit * (ROUND1_AGRI_MAT_SIZES[mat] ?? 0.05);
                }
                const scale = totalNeedSize > freeSpace && totalNeedSize > 0 ? freeSpace / totalNeedSize : 1;
                for (const [mat, deficit] of Object.entries(needed)) {
                    c.buyMaterial(DIV_AGRI, city, mat, Math.max(0, deficit * scale / CYCLE_SECS));
                }
            } catch { }
        }
    }

    function stopRound1AgriSupply() {
        if (!ROUND1_USE_CUSTOM_SUPPLY) return;
        for (const city of CITIES) {
            for (const mat of Object.keys(ROUND1_AGRI_REQUIRED)) {
                try { c.buyMaterial(DIV_AGRI, city, mat, 0); } catch { }
            }
        }
    }

    function maintainChemicalWaterSupply(cities = PHASE3_CHEM_START_CITIES) {
        for (const city of cities) {
            try {
                if (!c.hasWarehouse(DIV_CHEM, city)) continue;
                const wh = c.getWarehouse(DIV_CHEM, city);
                const freeSpace = Math.max(0, wh.size - wh.sizeUsed);
                const chemProd = Math.max(c.getMaterial(DIV_CHEM, city, 'Chemicals').productionAmount || 0, 0);
                const stored = c.getMaterial(DIV_CHEM, city, 'Water').stored;
                const target = Math.max(PHASE3_CHEM_WATER_SEED, chemProd * 0.5 * CYCLE_SECS * PHASE3_CHEM_WATER_BUFFER_CYCLES);
                const deficit = Math.max(0, target - stored);
                const maxBySpace = (ROUND1_AGRI_MAT_SIZES.Water ?? 0.05) > 0 ? freeSpace / (ROUND1_AGRI_MAT_SIZES.Water ?? 0.05) : deficit;
                c.buyMaterial(DIV_CHEM, city, 'Water', Math.max(0, Math.min(deficit, maxBySpace) / CYCLE_SECS));
            } catch { }
        }
    }

    function stopChemicalWaterSupply(cities = CITIES) {
        for (const city of cities) {
            try { c.buyMaterial(DIV_CHEM, city, 'Water', 0); } catch { }
        }
    }

    function unlockCost(name, fallback = Infinity) {
        try { return c.getUnlockCost(name); } catch { return fallback; }
    }

    function configureExports() {
        if (!c.hasUnlock(UNLOCKS.export)) return;
        const EXP = '(IPROD+IINV/10)*(-1)';
        for (const city of CITIES) {
            try { c.exportMaterial(DIV_AGRI, city, DIV_TOBACCO, city, 'Plants', EXP); } catch { }
            try { c.exportMaterial(DIV_AGRI, city, DIV_CHEM, city, 'Plants', EXP); } catch { }
            try { c.exportMaterial(DIV_CHEM, city, DIV_AGRI, city, 'Chemicals', EXP); } catch { }
        }
        for (const city of CITIES) {
            setLeftovers(DIV_AGRI, city, ['Chemicals', 'Water']);
            setLeftovers(DIV_CHEM, city, ['Plants', 'Water']);
            setLeftovers(DIV_TOBACCO, city, ['Plants']);
        }
    }

    function tryUpgradeWarehouseTo(div, city, targetLevel) {
        try {
            while (c.getWarehouse(div, city).level < targetLevel) {
                const cost = c.getUpgradeWarehouseCost(div, city, 1);
                if (c.getCorporation().funds < cost) break;
                c.upgradeWarehouse(div, city, 1);
            }
        } catch { }
    }

    function tryFillOffice(div, city, targetSize, jobs) {
        try { fillOffice(div, city, targetSize, jobs); } catch { }
    }

    function tobaccoProducts() {
        try { return [...c.getDivision(DIV_TOBACCO).products]; } catch { return []; }
    }

    function hasActiveTobaccoDevelopment() {
        for (const name of tobaccoProducts()) {
            try {
                if (c.getProduct(DIV_TOBACCO, HQ_CITY, name).developmentProgress < 100) return true;
            } catch { }
        }
        return false;
    }

    function nextTobaccoProductName() {
        let max = 0;
        for (const name of tobaccoProducts()) {
            const m = /^Tobac-v(\d+)$/.exec(name);
            if (!m) continue;
            const n = Number(m[1]);
            if (Number.isFinite(n)) max = Math.max(max, n);
        }
        return `Tobac-v${max + 1}`;
    }

    function getTobaccoProductStats() {
        let highestProgress = 0;
        let finishedProducts = 0;
        for (const name of tobaccoProducts()) {
            try {
                const progress = c.getProduct(DIV_TOBACCO, HQ_CITY, name).developmentProgress || 0;
                if (progress > highestProgress) highestProgress = progress;
                if (progress >= 100) finishedProducts++;
            } catch { }
        }
        return { highestProgress, finishedProducts };
    }

    function ensureTobaccoProduct(reserve = 0) {
        if (!hasDiv(DIV_TOBACCO) || hasActiveTobaccoDevelopment()) return;
        try {
            const invest = Math.max(ROUND2_PRODUCT_MIN_INVEST, Math.min(c.getCorporation().funds * 0.01, ROUND2_PRODUCT_MAX_INVEST));
            if (c.getCorporation().funds - invest < reserve) return;
            const name = nextTobaccoProductName();
            c.makeProduct(DIV_TOBACCO, HQ_CITY, name, invest / 2, invest / 2);
            log(ns, `INFO: Started product ${name} with ${formatMoney(invest)} investment.`, true, 'info');
        } catch { }
    }

    function canSpend(cost, reserve = 0) {
        return Number.isFinite(cost) && cost >= 0 && c.getCorporation().funds - cost >= reserve;
    }

    function getRound2Reserve(bestOffer, rpGateCleared) {
        const funds = c.getCorporation().funds;
        if (rpGateCleared || bestOffer >= 2e12) return Math.max(ROUND2_RESERVE_PEAK, funds * 0.90);
        if (bestOffer >= ROUND2_FREEZE_BEST_OFFER) return Math.max(ROUND2_RESERVE_HIGH, funds * 0.82);
        if (bestOffer >= 5e11) return Math.max(ROUND2_RESERVE_MID, funds * 0.72);
        return Math.max(ROUND2_RESERVE_MIN, funds * 0.58);
    }

    function supportCities() {
        return CITIES.filter((city) => city !== HQ_CITY);
    }

    function getRound2AgriJobs(size) {
        return size >= ROUND2_AGRI_OFFICE ? ROUND2_AGRI_JOBS : ROUND2_AGRI_SMALL_JOBS;
    }

    function getRound2TobaccoHQJobs(size) {
        if (size >= ROUND2_TOB_HQ_OFFICE) return ROUND2_TOB_HQ_JOBS;
        if (size >= 9) return ROUND2_TOB_HQ_MID_JOBS;
        return ROUND2_TOB_HQ_SMALL_JOBS;
    }

    function maintainRound2DivisionState() {
        if (hasDiv(DIV_AGRI)) {
            for (const city of CITIES) {
                try {
                    c.sellMaterial(DIV_AGRI, city, 'Food', 'MAX', 'MP');
                    c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP');
                    const office = c.getOffice(DIV_AGRI, city);
                    fillOffice(DIV_AGRI, city, office.size, getRound2AgriJobs(office.size));
                } catch { }
            }
        }

        if (hasDiv(DIV_CHEM)) {
            for (const city of c.getDivision(DIV_CHEM).cities) {
                try {
                    const office = c.getOffice(DIV_CHEM, city);
                    fillOffice(DIV_CHEM, city, office.size, ROUND2_CHEM_JOBS);
                    if (c.hasWarehouse(DIV_CHEM, city)) c.sellMaterial(DIV_CHEM, city, 'Chemicals', 'MAX', 'MP');
                } catch { }
            }
        }

        if (hasDiv(DIV_TOBACCO)) {
            for (const city of c.getDivision(DIV_TOBACCO).cities) {
                try {
                    const office = c.getOffice(DIV_TOBACCO, city);
                    const jobs = city === HQ_CITY ? getRound2TobaccoHQJobs(office.size) : ROUND2_TOB_SUPPORT_JOBS;
                    fillOffice(DIV_TOBACCO, city, office.size, jobs);
                } catch { }
            }
        }
    }

    function tryRound2AgriStep(reserve, allowOfficeGrowth = false) {
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                if (wh.level < ROUND2_AGRI_WAREHOUSE) {
                    const cost = c.getUpgradeWarehouseCost(DIV_AGRI, city, 1);
                    if (canSpend(cost, reserve)) {
                        c.upgradeWarehouse(DIV_AGRI, city, 1);
                        return `Agriculture ${city} warehouse -> ${wh.level + 1}`;
                    }
                }
            } catch { }
        }
        try {
            if (c.getHireAdVertCount(DIV_AGRI) < ROUND2_AGRI_ADVERT) {
                const cost = c.getHireAdVertCost(DIV_AGRI);
                if (canSpend(cost, reserve)) {
                    c.hireAdVert(DIV_AGRI);
                    return `Agriculture advert -> ${c.getHireAdVertCount(DIV_AGRI)}`;
                }
            }
        } catch { }
        if (!allowOfficeGrowth) return null;
        for (const city of CITIES) {
            try {
                const off = c.getOffice(DIV_AGRI, city);
                if (off.size < ROUND2_AGRI_OFFICE) {
                    const increase = ROUND2_AGRI_OFFICE - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_AGRI, city, increase);
                    if (canSpend(cost, reserve)) {
                        fillOffice(DIV_AGRI, city, ROUND2_AGRI_OFFICE, ROUND2_AGRI_JOBS);
                        return `Agriculture ${city} office -> ${ROUND2_AGRI_OFFICE}`;
                    }
                }
            } catch { }
        }
        return null;
    }

    function tryRound2UpgradeStep(reserve) {
        for (const upg of ['Smart Factories', 'Smart Storage']) {
            try {
                if (c.getUpgradeLevel(upg) >= ROUND2_GLOBAL_UPGRADE_TARGET) continue;
                const cost = c.getUpgradeLevelCost(upg);
                if (!canSpend(cost, reserve)) continue;
                c.levelUpgrade(upg);
                return `${upg} -> ${c.getUpgradeLevel(upg)}`;
            } catch { }
        }
        return null;
    }

    function tryRound2ChemStep(reserve, maxSupportCities = supportCities().length) {
        if (!hasDiv(DIV_CHEM)) return null;
        try {
            const hqWh = c.getWarehouse(DIV_CHEM, HQ_CITY);
            if (hqWh.level < 2) {
                const cost = c.getUpgradeWarehouseCost(DIV_CHEM, HQ_CITY, 1);
                if (canSpend(cost, reserve)) {
                    c.upgradeWarehouse(DIV_CHEM, HQ_CITY, 1);
                    return `Chemical ${HQ_CITY} warehouse -> ${hqWh.level + 1}`;
                }
            }
        } catch { }
        for (const city of supportCities().slice(0, Math.max(0, maxSupportCities))) {
            try {
                if (!c.getDivision(DIV_CHEM).cities.includes(city)) {
                    if (canSpend(9e9, reserve)) {
                        c.expandCity(DIV_CHEM, city);
                        return `Chemical expanded to ${city}`;
                    }
                    continue;
                }
                if (!c.hasWarehouse(DIV_CHEM, city)) {
                    if (canSpend(5e9, reserve)) {
                        c.purchaseWarehouse(DIV_CHEM, city);
                        return `Chemical warehouse purchased in ${city}`;
                    }
                    continue;
                }
                const off = c.getOffice(DIV_CHEM, city);
                if (off.numEmployees < off.size) {
                    fillOffice(DIV_CHEM, city, ROUND2_CHEM_OFFICE, ROUND2_CHEM_JOBS);
                    return `Chemical staffed in ${city}`;
                }
                assignJobs(DIV_CHEM, city, ROUND2_CHEM_JOBS);
                try { c.sellMaterial(DIV_CHEM, city, 'Chemicals', 'MAX', 'MP'); } catch { }
            } catch { }
        }
        tryFillOffice(DIV_CHEM, HQ_CITY, ROUND2_CHEM_OFFICE, ROUND2_CHEM_JOBS);
        try { c.sellMaterial(DIV_CHEM, HQ_CITY, 'Chemicals', 'MAX', 'MP'); } catch { }
        return null;
    }

    function tryRound2TobaccoStep(reserve, allowSupportCities = false, allowAdvert = true) {
        if (!hasDiv(DIV_TOBACCO)) return null;
        try {
            const off = c.getOffice(DIV_TOBACCO, HQ_CITY);
            if (off.size < ROUND2_TOB_HQ_OFFICE) {
                const increase = ROUND2_TOB_HQ_OFFICE - off.size;
                const cost = c.getOfficeSizeUpgradeCost(DIV_TOBACCO, HQ_CITY, increase);
                if (canSpend(cost, reserve)) {
                    fillOffice(DIV_TOBACCO, HQ_CITY, ROUND2_TOB_HQ_OFFICE, ROUND2_TOB_HQ_JOBS);
                    return `Tobacco HQ office -> ${ROUND2_TOB_HQ_OFFICE}`;
                }
            } else {
                assignJobs(DIV_TOBACCO, HQ_CITY, ROUND2_TOB_HQ_JOBS);
            }
        } catch { }
        if (allowAdvert) {
            try {
                if (c.getHireAdVertCount(DIV_TOBACCO) < ROUND2_TOB_ADVERT) {
                    const cost = c.getHireAdVertCost(DIV_TOBACCO);
                    if (canSpend(cost, reserve)) {
                        c.hireAdVert(DIV_TOBACCO);
                        return `Tobacco advert -> ${c.getHireAdVertCount(DIV_TOBACCO)}`;
                    }
                }
            } catch { }
        }
        if (!allowSupportCities) return null;
        for (const city of supportCities()) {
            try {
                if (!c.getDivision(DIV_TOBACCO).cities.includes(city)) {
                    if (canSpend(9e9, reserve)) {
                        c.expandCity(DIV_TOBACCO, city);
                        return `Tobacco expanded to ${city}`;
                    }
                    continue;
                }
                if (!c.hasWarehouse(DIV_TOBACCO, city)) {
                    if (canSpend(5e9, reserve)) {
                        c.purchaseWarehouse(DIV_TOBACCO, city);
                        return `Tobacco warehouse purchased in ${city}`;
                    }
                    continue;
                }
                const off = c.getOffice(DIV_TOBACCO, city);
                if (off.size < ROUND2_TOB_SUPPORT_OFFICE) {
                    const increase = ROUND2_TOB_SUPPORT_OFFICE - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_TOBACCO, city, increase);
                    if (canSpend(cost, reserve)) {
                        fillOffice(DIV_TOBACCO, city, ROUND2_TOB_SUPPORT_OFFICE, ROUND2_TOB_SUPPORT_JOBS);
                        return `Tobacco ${city} office -> ${ROUND2_TOB_SUPPORT_OFFICE}`;
                    }
                    continue;
                }
                if (off.numEmployees < off.size) {
                    fillOffice(DIV_TOBACCO, city, ROUND2_TOB_SUPPORT_OFFICE, ROUND2_TOB_SUPPORT_JOBS);
                    return `Tobacco staffed in ${city}`;
                }
                assignJobs(DIV_TOBACCO, city, ROUND2_TOB_SUPPORT_JOBS);
            } catch { }
        }
        return null;
    }

    function tryRound2DummyStep(bestOffer, stagnantChecks, reserve, allowEarly = false) {
        if (!allowEarly && (bestOffer < ROUND2_DUMMY_TRIGGER || stagnantChecks < ROUND2_DUMMY_STAGNATION_LIMIT)) return null;
        const cityCost = supportCities().length * 9e9;
        const dummyCost = expandIndustryCost('Restaurant') + cityCost;
        const floor = Math.max(25e9, reserve * 0.5);
        if (!canSpend(dummyCost, floor)) return null;
        try {
            for (let i = 1; i <= 5; i++) {
                const dName = `Dummy-${i}`;
                if (c.getCorporation().divisions.includes(dName)) continue;
                c.expandIndustry('Restaurant', dName);
                for (const city of CITIES) {
                    try { c.expandCity(dName, city); } catch { }
                    try { c.purchaseWarehouse(dName, city); } catch { }
                }
                return `Created ${dName}`;
            }
        } catch { }
        return null;
    }

    function manageRound2Scaling(bestOffer, rpGateCleared, stagnantChecks) {
        const reserve = getRound2Reserve(bestOffer, rpGateCleared);
        ensureTobaccoProduct(reserve);

        const { highestProgress, finishedProducts } = getTobaccoProductStats();
        const freezeGrowth = !rpGateCleared && bestOffer >= ROUND2_FREEZE_BEST_OFFER;
        const chemCities = hasDiv(DIV_CHEM) ? c.getDivision(DIV_CHEM).cities.length : 0;
        const allowTobSupportCities = !freezeGrowth &&
            (finishedProducts > 0 || highestProgress >= 90 || bestOffer >= ROUND2_TOB_SUPPORT_TRIGGER || rpGateCleared);
        const earlyChemSupportTarget =
            finishedProducts > 0 || highestProgress >= 100 || bestOffer >= ROUND2_CHEM_FULL_TRIGGER || rpGateCleared
                ? supportCities().length
                : ROUND2_CHEM_BOOTSTRAP_SUPPORT_CITIES;

        const tobAction = tryRound2TobaccoStep(reserve, allowTobSupportCities, true);
        if (tobAction) return { action: tobAction, reserve };

        const chemBootstrap = chemCities < Math.min(CITIES.length, 1 + earlyChemSupportTarget);
        if (chemBootstrap) {
            const chemAction = tryRound2ChemStep(reserve, earlyChemSupportTarget);
            if (chemAction) return { action: chemAction, reserve };
        }

        const agriAction = tryRound2AgriStep(reserve, !freezeGrowth && (bestOffer >= ROUND2_AGRI_OFFICE_TRIGGER || rpGateCleared));
        if (agriAction) return { action: agriAction, reserve };

        const upgradeAction = tryRound2UpgradeStep(reserve);
        if (upgradeAction) return { action: upgradeAction, reserve };

        const dummyAction = tryRound2DummyStep(
            bestOffer,
            stagnantChecks,
            reserve,
            finishedProducts > 0 || highestProgress >= 100,
        );
        if (dummyAction) return { action: dummyAction, reserve };

        const chemAction = tryRound2ChemStep(reserve, supportCities().length);
        if (chemAction) return { action: chemAction, reserve };

        if (freezeGrowth) {
            tryFillOffice(DIV_TOBACCO, HQ_CITY, ROUND2_TOB_HQ_OFFICE, ROUND2_TOB_HQ_JOBS);
            tryFillOffice(DIV_CHEM, HQ_CITY, ROUND2_CHEM_OFFICE, ROUND2_CHEM_JOBS);
        }

        return { action: null, reserve };
    }

    function getPhase3ChemicalReserve() {
        const chemCost = expandIndustryCost(IND_CHEM);
        const funds = c.getCorporation().funds;
        const gap = Math.max(0, chemCost - funds);
        if (gap <= PHASE3_CHEM_FREEZE_GAP) {
            return Math.max(chemCost - 2e9, funds * 0.95);
        }
        if (gap <= 20e9) {
            return Math.max(PHASE3_CHEM_MID_RESERVE, funds * 0.72);
        }
        return Math.max(PHASE3_CHEM_MIN_RESERVE, funds * 0.60);
    }

    async function investInAgricultureWhileWaitingForChemical() {
        maintainAgriSalesAndJobs({ ops: 2, eng: 3, biz: 1, mgmt: 1, rnd: 1 });
        if (!c.hasUnlock(UNLOCKS.smartSupply)) maintainRound1AgriSupply();
        tryResearch(DIV_AGRI, MAT_RESEARCH);

        const reserve = getPhase3ChemicalReserve();
        const corpFunds = () => c.getCorporation().funds;

        for (const city of CITIES) {
            try {
                const off = c.getOffice(DIV_AGRI, city);
                if (off.size < PHASE3_AGRI_TARGET_OFFICE) {
                    const increase = PHASE3_AGRI_TARGET_OFFICE - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_AGRI, city, increase);
                    if (corpFunds() - cost >= reserve) {
                        fillOffice(DIV_AGRI, city, PHASE3_AGRI_TARGET_OFFICE, { ops: 2, eng: 3, biz: 1, mgmt: 1, rnd: 1 });
                    }
                } else {
                    fillOffice(DIV_AGRI, city, off.size, { ops: 2, eng: 3, biz: 1, mgmt: 1, rnd: 1 });
                }
            } catch { }

            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                if (wh.level < PHASE3_AGRI_TARGET_WAREHOUSE) {
                    const cost = c.getUpgradeWarehouseCost(DIV_AGRI, city, 1);
                    if (corpFunds() - cost >= reserve) {
                        c.upgradeWarehouse(DIV_AGRI, city, 1);
                    }
                }
            } catch { }
        }

        try {
            while (c.getHireAdVertCount(DIV_AGRI) < PHASE3_AGRI_TARGET_ADVERT) {
                const cost = c.getHireAdVertCost(DIV_AGRI);
                if (corpFunds() - cost < reserve) break;
                c.hireAdVert(DIV_AGRI);
            }
        } catch { }

        for (const upg of ['Smart Factories', 'Smart Storage']) {
            try {
                while (c.getUpgradeLevel(upg) < PHASE3_AGRI_GLOBAL_UPGRADE_TARGET) {
                    const cost = c.getUpgradeLevelCost(upg);
                    if (corpFunds() - cost < reserve) break;
                    c.levelUpgrade(upg);
                }
            } catch { }
        }
        await refreshBoosts(DIV_AGRI, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);
    }

    // Docs: "Buy tea / throw party every cycle. Maintain maximum energy/morale."
    function boostMorale(...divs) {
        for (const div of divs)
            for (const city of CITIES) {
                try { c.buyTea(div, city); } catch { }
                try { c.throwParty(div, city, 500e3); } catch { }
            }
    }

    // ── Research (with RP threshold enforcement) ──────────────────────────────
    function tryResearch(div, queue) {
        try {
            const rp = c.getDivision(div).researchPoints;
            for (const name of queue) {
                if (c.hasResearched(div, name)) continue;
                const cost = c.getResearchCost(div, name);
                // Production research: 10% pool threshold. Others: 50%.
                const threshold = PRODUCTION_RESEARCH.has(name) ? 10 : 2;
                if (rp >= cost * threshold) {
                    c.research(div, name);
                    log(ns, `  Researched "${name}" (${div})`, false, 'info');
                }
            }
        } catch { }
    }

    // ── Upgrades ──────────────────────────────────────────────────────────────
    // All names are exact CorpUpgradeName enum VALUES (not keys).
    function buyUpgrades(upgs, mult) {
        const funds = c.getCorporation().funds;
        for (const upg of upgs)
            try { if (funds > c.getUpgradeLevelCost(upg) * mult) c.levelUpgrade(upg); } catch { }
    }

    // ── Product pricing ───────────────────────────────────────────────────────
    // setProductMarketTA2 sets auto-pricing only.
    // sellProduct must ALSO be called to configure the sell AMOUNT (MAX).
    // Without this the product sells 0 units if the amount was never set.
    function priceProducts() {
        for (const pName of c.getDivision(DIV_TOBACCO).products) {
            try {
                const prod = c.getProduct(DIV_TOBACCO, HQ_CITY, pName);
                if (prod.developmentProgress < 100) continue;
                if (c.hasResearched(DIV_TOBACCO, 'Market-TA.II'))
                    c.setProductMarketTA2(DIV_TOBACCO, pName, true);
                else if (c.hasResearched(DIV_TOBACCO, 'Market-TA.I'))
                    c.setProductMarketTA1(DIV_TOBACCO, pName, true);
                const price = c.hasResearched(DIV_TOBACCO, 'Market-TA.II') ? 'MP'
                    : c.hasResearched(DIV_TOBACCO, 'Market-TA.I') ? 'MP*2'
                        : 'MP*3';
                for (const city of c.getDivision(DIV_TOBACCO).cities)
                    c.sellProduct(DIV_TOBACCO, city, pName, 'MAX', price, true);
            } catch { }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 0 — Create corp + essential unlocks
    // ─────────────────────────────────────────────────────────────────────────
    if (phase <= 0) {
        if (!c.hasCorporation()) {
            log(ns, `INFO: Creating "${CORP_NAME}"...`, true, 'info');
            const inBn3 = ns.getResetInfo().currentNode === 3;
            if (!c.createCorporation(CORP_NAME, !inBn3 || opts['self-fund'])) {
                log(ns, `ERROR: Could not create corp. ${inBn3 ? 'Need SF3.' : 'Need SF3 or $150B.'}`, true, 'error');
                return;
            }
            await waitCycles(1);
        }
        log(ns, `INFO: "${c.getCorporation().name}" active. Funds: ${formatMoney(c.getCorporation().funds)}`, true);
        for (const name of [UNLOCKS.warehouseAPI, UNLOCKS.officeAPI]) buyUnlock(name);
        if (!ROUND1_USE_CUSTOM_SUPPLY) {
            buyUnlock(UNLOCKS.smartSupply);
        } else {
            log(ns, 'INFO: Delaying Smart Supply until after round 1 to improve valuation.', true, 'info');
        }
        writePhase(1); phase = 1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1 — Agriculture: all cities, offices, warehouses, initial boosts
    // ─────────────────────────────────────────────────────────────────────────
        if (phase <= 1) {
            if (!c.getCorporation().divisions.includes(DIV_AGRI)) {
                log(ns, 'INFO: Expanding into Agriculture ($40B)...', true, 'info');
                c.expandIndustry(IND_AGRI, DIV_AGRI);
            }
            expandToCities(DIV_AGRI);
            if (!ROUND1_USE_CUSTOM_SUPPLY) enableSmartSupply(DIV_AGRI);
            // Docs: "Upgrade from 3 to 4. Set 4 employees to R&D and wait until RP ≥ 55.
            // Switch to Ops(1)+Eng(1)+Biz(1)+Mgmt(1) before buying boost materials."
            for (const city of CITIES)
                fillOffice(DIV_AGRI, city, 4, { rnd: 4 });
            for (const city of CITIES) {
                try { c.sellMaterial(DIV_AGRI, city, 'Food', 'MAX', 'MP'); } catch { }
                try { c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP'); } catch { }
            }
            maintainRound1AgriSupply();
            await waitCycles(1);
            // Wait for RP ≥ 55 before buying boost materials (docs requirement).
            log(ns, 'INFO: Waiting for Agriculture RP ≥ 55 before buying boost materials...', true);
            while (c.getDivision(DIV_AGRI).researchPoints < 55) {
                maintainRound1AgriSupply();
                await ns.sleep(5000);
            }
            log(ns, 'INFO: RP ≥ 55 — switching to production jobs.', true, 'success');
            for (const city of CITIES)
                assignJobs(DIV_AGRI, city, { ops: 1, eng: 1, biz: 1, mgmt: 1 });
            maintainRound1AgriSupply();
            await waitCycles(1);
            log(ns, 'INFO: Applying Phase 1 Agriculture boost materials...', true);
            for (const city of CITIES)
                await applyBoostMaterials(DIV_AGRI, city,
                    getBoostTargets(DIV_AGRI, city, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats));
        writePhase(2); phase = 2;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2 — Wait for and accept investment round 1
    // Docs: "Focus on Smart Storage and warehouse upgrade. Buy 2 Advert levels."
    // ─────────────────────────────────────────────────────────────────────────
    if (phase <= 2) {
        log(ns, `INFO: Waiting for round-1 offer ≥ ${formatMoney(ROUND1_TARGET)}...`, true);
        let bestOffer = 0;
        let stagnantChecks = 0;
        let spendingFrozen = false;
        let phase2PrepDone = false;

        while (true) {
            await waitCycles(2);

            // Keep Agriculture selling and jobs assigned — no office expansion yet.
            for (const city of CITIES) {
                try { c.sellMaterial(DIV_AGRI, city, 'Food', 'MAX', 'MP'); } catch { }
                try { c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP'); } catch { }
                try { assignJobs(DIV_AGRI, city, { ops: 1, eng: 1, biz: 1, mgmt: 1 }); } catch { }
            }
            maintainRound1AgriSupply();

            const offer = c.getInvestmentOffer();
            if (offer.funds > bestOffer) {
                bestOffer = offer.funds;
                stagnantChecks = 0;
            } else {
                stagnantChecks++;
            }
            if (bestOffer >= ROUND1_TARGET * ROUND1_FREEZE_RATIO) spendingFrozen = true;

            const funds = c.getCorporation().funds;
            if (!phase2PrepDone && !spendingFrozen) {
                // Round 1 wants a small amount of infra spending, not continuous reinvestment.
                if (funds > 2e9)
                    try {
                        while (c.getUpgradeLevel('Smart Storage') < ROUND1_SMART_STORAGE_TARGET
                            && c.getCorporation().funds > c.getUpgradeLevelCost('Smart Storage') * 2) {
                            c.levelUpgrade('Smart Storage');
                        }
                    } catch { }
                if (funds > 1e9)
                    for (const city of CITIES)
                        try {
                            while (c.getWarehouse(DIV_AGRI, city).level < ROUND1_WAREHOUSE_TARGET
                                && c.getCorporation().funds > 1e9) {
                                c.upgradeWarehouse(DIV_AGRI, city, 1);
                            }
                        } catch { }
                if (funds > 3e9)
                    try {
                        while (c.getHireAdVertCount(DIV_AGRI) < ROUND1_ADVERT_TARGET
                            && c.getCorporation().funds > c.getHireAdVertCost(DIV_AGRI) * 2) {
                            c.hireAdVert(DIV_AGRI);
                        }
                    } catch { }
                phase2PrepDone = true;
                spendingFrozen = true;
            }

            // Re-apply boosts if warehouse capacity has grown.
            await refreshBoosts(DIV_AGRI, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);

            log(ns, `  Round ${offer.round} offer: ${formatMoney(offer.funds)} (best ${formatMoney(bestOffer)})`, false);
            if (offer.round > 1) { log(ns, 'INFO: Round 1 already accepted.', true, 'info'); break; }
            if (offer.round === 1 && offer.funds >= ROUND1_TARGET) {
                c.acceptInvestmentOffer();
                log(ns, `INFO: Accepted Round 1 — received ${formatMoney(offer.funds)}!`, true, 'success');
                break;
            }
            if (offer.round === 1 && spendingFrozen && stagnantChecks >= ROUND1_STAGNATION_LIMIT && offer.funds >= ROUND1_SOFT_FLOOR) {
                c.acceptInvestmentOffer();
                log(ns, `INFO: Accepted Round 1 soft floor — received ${formatMoney(offer.funds)} after offer plateau.`, true, 'success');
                break;
            }
        }
        if (!ROUND1_USE_CUSTOM_SUPPLY && c.hasUnlock(UNLOCKS.smartSupply)) {
            stopRound1AgriSupply();
            enableSmartSupply(DIV_AGRI);
        }
        await waitCycles(1);
        writePhase(3); phase = 3;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3 — Launch Chemical + Tobacco; supply chain; first product
    // ─────────────────────────────────────────────────────────────────────────
    if (phase <= 3) {
        log(ns, 'INFO: Phase 3 — launching Chemical and Tobacco without a cash deadlock...', true, 'info');
        // Keep Agriculture alive on custom supply until Smart Supply is affordable later.

        // Launch Chemical as soon as it is affordable.
        while (!hasDiv(DIV_CHEM)) {
            const chemCost = expandIndustryCost(IND_CHEM);
            if (c.getCorporation().funds >= chemCost) {
                c.expandIndustry(IND_CHEM, DIV_CHEM);
                log(ns, 'INFO: Chemical launched.', true, 'success');
                break;
            }
            await investInAgricultureWhileWaitingForChemical();
            const corp = c.getCorporation();
            const profit = corp.revenue - corp.expenses;
            log(ns, `  Waiting for Chemical: ${formatMoney(corp.funds)} / ${formatMoney(chemCost)} | profit ${formatMoney(profit)}/s`, false);
            await waitCycles(3);
        }

        await waitForDivisionInfrastructure(DIV_CHEM, 'Chemical', PHASE3_CHEM_START_CITIES);
        for (const city of PHASE3_CHEM_START_CITIES) {
            await waitForWarehouseLevel(DIV_CHEM, city, PHASE3_CHEM_INITIAL_WAREHOUSE);
            await waitFillOffice(DIV_CHEM, city, PHASE3_CHEM_INITIAL_OFFICE, { ops: 1, eng: 1, rnd: 1 });
        }
        for (const city of PHASE3_CHEM_START_CITIES) {
            try { c.sellMaterial(DIV_CHEM, city, 'Chemicals', 'MAX', 'MP'); } catch { }
        }

        while (!c.hasUnlock(UNLOCKS.export)) {
            const cost = unlockCost(UNLOCKS.export, 20e9);
            if (c.getCorporation().funds >= cost + PHASE3_EXPORT_RESERVE) {
                buyUnlock(UNLOCKS.export);
                break;
            }
            maintainRound1AgriSupply();
            maintainChemicalWaterSupply();
            const corp = c.getCorporation();
            log(ns, `  Waiting for Export: ${formatMoney(corp.funds)} / ${formatMoney(cost)}`, false);
            await waitCycles(2);
        }
        configureExports();
        maintainChemicalWaterSupply();

        // Launch Tobacco as soon as it is affordable.
        while (!hasDiv(DIV_TOBACCO)) {
            const tobCost = expandIndustryCost(IND_TOBACCO);
            if (c.getCorporation().funds >= tobCost) {
                c.expandIndustry(IND_TOBACCO, DIV_TOBACCO);
                log(ns, 'INFO: Tobacco launched.', true, 'success');
                break;
            }
            maintainRound1AgriSupply();
            maintainChemicalWaterSupply();
            log(ns, `  Waiting for Tobacco: ${formatMoney(c.getCorporation().funds)} / ${formatMoney(tobCost)}`, false);
            await waitCycles(3);
        }

        await waitForDivisionInfrastructure(DIV_TOBACCO, 'Tobacco', PHASE3_TOB_START_CITIES);
        await waitFillOffice(DIV_TOBACCO, HQ_CITY, PHASE3_TOB_INITIAL_HQ_OFFICE, { ops: 1, eng: 3, biz: 1, mgmt: 1 });

        boostMorale(DIV_CHEM, DIV_TOBACCO);
        configureExports();

        for (const city of PHASE3_CHEM_START_CITIES) await waitForWarehouseLevel(DIV_CHEM, city, 3);
        for (const city of PHASE3_TOB_START_CITIES) await waitForWarehouseLevel(DIV_TOBACCO, city, 3);
        for (const city of CITIES) await waitForWarehouseLevel(DIV_AGRI, city, 3);

        if (!c.getDivision(DIV_TOBACCO).products.includes('Tobac-v1')) {
            const invest = Math.max(1e8, Math.min(c.getCorporation().funds * 0.01, 2e9));
            try {
                c.makeProduct(DIV_TOBACCO, HQ_CITY, 'Tobac-v1', invest / 2, invest / 2);
                log(ns, `INFO: Started product Tobac-v1 with ${formatMoney(invest)} investment.`, true, 'info');
            } catch { }
        }

        // Stay lean between round 1 and round 2. Early corp-wide upgrades help less
        // than preserving funds for valuation while Tobacco/Chemical ramp up.

        writePhase(4); phase = 4;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 4 — Wait for and accept investment round 2
    // ─────────────────────────────────────────────────────────────────────────
    if (phase <= 4) {
        log(ns, `INFO: Waiting for round-2 offer ≥ ${formatMoney(MIN_ROUND2)}...`, true);

        // Initialise warehouse tracking for boost refresh.
        for (const div of [DIV_AGRI, DIV_CHEM])
            for (const city of CITIES)
                try { prevWHCapacity[`${div}|${city}`] = c.getWarehouse(div, city).size; } catch { }

        let rpGateCleared = false;
        let bestRound2Offer = 0;
        let stagnantRound2Checks = 0;

        while (true) {
            await waitCycles(3);
            boostMorale(DIV_TOBACCO, DIV_AGRI, DIV_CHEM);
            if (!c.hasUnlock(UNLOCKS.smartSupply)) {
                maintainRound1AgriSupply();
                maintainChemicalWaterSupply();
            }
            configureExports();
            maintainRound2DivisionState();

            // Price finished products (sellProduct required even when TA2 active).
            priceProducts();

            // Research with RP threshold (50% general, 10% production).
            tryResearch(DIV_TOBACCO, TOB_RESEARCH);
            tryResearch(DIV_AGRI, MAT_RESEARCH);
            tryResearch(DIV_CHEM, MAT_RESEARCH);

            // Wilson must be bought BEFORE Advert — it multiplies future Advert benefit (not retroactive).
            // Docs: "Buy Wilson if you can afford it, then use ≥20% of funds on Advert."
            try {
                const wCost = c.getUpgradeLevelCost('Wilson Analytics');
                if (false && c.getCorporation().funds > wCost * 2) c.levelUpgrade('Wilson Analytics');
            } catch { }

            if (false) buyUpgrades([
                'Smart Factories', 'Smart Storage',
                'Nuoptimal Nootropic Injector Implants',  // Correct spacing
                'Neural Accelerators', 'FocusWires', 'Speech Processor Implants',
                'ABC SalesBots',
            ], 1.5);

            // Advert for Tobacco — after Wilson.
            try {
                const funds = c.getCorporation().funds;
                const advCost = c.getHireAdVertCost(DIV_TOBACCO);
                if (false && funds > advCost && advCost < funds * 0.2) c.hireAdVert(DIV_TOBACCO);
            } catch { }

            // Re-apply boosts if SmartStorage has expanded warehouse capacity.
            await refreshBoosts(DIV_AGRI, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);
            await refreshBoosts(DIV_CHEM, CHEM_BOOST.factors, CHEM_BOOST.sizes, CHEM_BOOST.mats);

            // Dummy Restaurant divisions — each adds 12 office+warehouse pairs,
            // boosting private valuation by ×1.1 (~10% better round-2 offer).
            try {
                if (false) for (let i = 1; i <= 5; i++) {
                    const dName = `Dummy-${i}`;
                    if (c.getCorporation().divisions.includes(dName)) continue;
                    if (c.getCorporation().funds < 80e9) break;
                    c.expandIndustry('Restaurant', dName);
                    for (const city of CITIES) {
                        try { c.expandCity(dName, city); } catch { }
                        try { c.purchaseWarehouse(dName, city); } catch { }
                    }
                    log(ns, `INFO: Created ${dName} (valuation dummy, +10% offer).`, true, 'info');
                    break; // One per iteration — re-check funds next loop.
                }
            } catch { }

            // RP gate — log progress toward quality-loop threshold.
            if (!rpGateCleared) {
                try {
                    const agriRP = c.getDivision(DIV_AGRI).researchPoints;
                    const chemRP = c.getDivision(DIV_CHEM).researchPoints;
                    if (agriRP >= RP_TARGET_AGRI && chemRP >= RP_TARGET_CHEM) {
                        rpGateCleared = true;
                        log(ns, `INFO: RP targets met (Agri=${agriRP.toFixed(0)}, Chem=${chemRP.toFixed(0)}). Quality loop is strong.`, true, 'success');
                    } else {
                        log(ns, `  RP: Agri=${agriRP.toFixed(0)}/${RP_TARGET_AGRI}  Chem=${chemRP.toFixed(0)}/${RP_TARGET_CHEM}`, false);
                    }
                } catch { }
            }

            const offer = c.getInvestmentOffer();
            if (offer.funds > bestRound2Offer) {
                bestRound2Offer = offer.funds;
                stagnantRound2Checks = 0;
            } else {
                stagnantRound2Checks++;
            }
            log(ns, `  Round ${offer.round} offer: ${formatMoney(offer.funds)} (best ${formatMoney(bestRound2Offer)})`, false);
            if (offer.round > 2) { log(ns, 'INFO: Round 2 already accepted.', true, 'info'); break; }
            if (offer.round === 2 && offer.funds >= MIN_ROUND2) {
                c.acceptInvestmentOffer();
                log(ns, `INFO: Accepted Round 2 — received ${formatMoney(offer.funds)}!`, true, 'success');
                break;
            }
            const scaling = manageRound2Scaling(bestRound2Offer, rpGateCleared, stagnantRound2Checks);
            if (scaling.action) {
                log(ns, `  Round 2 scaling: ${scaling.action} (reserve ${formatMoney(scaling.reserve)})`, false);
            }
            await refreshBoosts(DIV_AGRI, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);
            await refreshBoosts(DIV_CHEM, CHEM_BOOST.factors, CHEM_BOOST.sizes, CHEM_BOOST.mats);
        }
        await waitCycles(1);
        writePhase(5); phase = 5;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5 — Final scaling before autopilot handoff
    // ─────────────────────────────────────────────────────────────────────────
    if (phase <= 5) {
        log(ns, 'INFO: Phase 5 — final scaling pass...', true);

        await waitForDivisionInfrastructure(DIV_CHEM, 'Chemical');
        await waitForDivisionInfrastructure(DIV_TOBACCO, 'Tobacco');
        if (!c.hasUnlock(UNLOCKS.smartSupply)) buyUnlock(UNLOCKS.smartSupply);
        if (c.hasUnlock(UNLOCKS.smartSupply)) {
            stopRound1AgriSupply();
            stopChemicalWaterSupply();
            enableSmartSupply(DIV_AGRI);
            enableSmartSupply(DIV_CHEM);
            enableSmartSupply(DIV_TOBACCO);
        }
        configureExports();

        for (const city of CITIES) {
            const isHQ = city === HQ_CITY;
            // HQ: product dev focus. Satellites: R&D-heavy (80% in R&D).
            fillOffice(DIV_TOBACCO, city,
                isHQ ? 30 : 20,
                isHQ
                    ? { ops: 5, eng: 11, biz: 2, mgmt: 9, rnd: 3 }
                    : { ops: 1, eng: 2, biz: 0, mgmt: 1, rnd: 16 });
            // Agriculture: Engineer-heavy for material quality.
            fillOffice(DIV_AGRI, city, 20, { ops: 6, eng: 8, biz: 1, mgmt: 3, rnd: 2 });
            // Chemical: small and Engineer-heavy — don't over-invest (docs).
            fillOffice(DIV_CHEM, city, 9, { ops: 1, eng: 5, biz: 0, mgmt: 1, rnd: 2 });
        }

        for (const div of [DIV_TOBACCO, DIV_AGRI, DIV_CHEM])
            for (const city of CITIES)
                try {
                    const wh = c.getWarehouse(div, city);
                    if (wh.level < 6) c.upgradeWarehouse(div, city, 6 - wh.level);
                } catch { }

        boostMorale(DIV_TOBACCO, DIV_AGRI, DIV_CHEM);

        // Top up boosts using Lagrange-optimal targets for the post-upgrade warehouse size.
        log(ns, 'INFO: Topping up boost materials...', true);
        for (const city of CITIES) {
            await applyBoostMaterials(DIV_AGRI, city,
                getBoostTargets(DIV_AGRI, city, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats));
            await applyBoostMaterials(DIV_CHEM, city,
                getBoostTargets(DIV_CHEM, city, CHEM_BOOST.factors, CHEM_BOOST.sizes, CHEM_BOOST.mats));
        }

        writePhase(6); phase = 6;
    }

    // ── Handoff ───────────────────────────────────────────────────────────────
    ns.write(SETUP_DONE_FLAG, 'true', 'w');
    log(ns, '═══════════════════════════════════════════════════════', true);
    log(ns, 'INFO: Setup complete! Handing off to corp-autopilot.js.', true, 'success');
    log(ns, '═══════════════════════════════════════════════════════', true);

    const PILOT = resolvePath('corp-autopilot', 'corp-autopilot.js');
    try { if (!ns.ps('home').some(p => p.filename === PILOT)) ns.run(PILOT); }
    catch { ns.run(PILOT); }
}
