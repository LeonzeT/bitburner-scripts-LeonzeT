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
 *  5  Post-round-2 ramp — spend the new cash on missing divisions and core scaling
 *  6  Final scaling — top up boosts, then hand off to corp-autopilot.js
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
const DELAY_TOBACCO_UNTIL_POST_ROUND2 = true;

// ── Investment thresholds ─────────────────────────────────────────────────────
// Round 1 (10% dilution, offer = val×0.3): need enough post-acceptance funds
// to cover Chemical ($70B) + Tobacco ($20B) + city expansions (~50B each) + buffer.
// At 25B we accepted with nothing left to fund Phase 3 → infinite crash loop.
const MIN_ROUND1 = 34e9;  // Accept early — 210B is unreachable from Agriculture alone
const MIN_ROUND2 = 5e12;
const ROUND2_INVESTMENT_SHARE_PCT = 0.35;
const ROUND2_INVESTMENT_MULTIPLIER = 2;
const ROUND2_EFFECTIVE_OFFER_MULT = ROUND2_INVESTMENT_SHARE_PCT * ROUND2_INVESTMENT_MULTIPLIER;
const ROUND2_OW_MULT_BASE = 1.0079741404289038;
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
const ROUND2_AGRI_PRODUCTION_JOBS = { ops: 1, eng: 1, biz: 1, mgmt: 1 };
const ROUND2_AGRI_JOBS = { ops: 1, eng: 2, biz: 1, mgmt: 1, rnd: 3 };
const ROUND2_CLASSIC_AGRI_OFFICE = 9;
const ROUND2_CLASSIC_AGRI_WAREHOUSE = 10;
const ROUND2_CLASSIC_AGRI_JOBS = { ops: 2, eng: 2, biz: 1, mgmt: 2, rnd: 2 };
const ROUND2_CLASSIC_AGRI_MID_JOBS = { ops: 2, eng: 2, biz: 1, mgmt: 1, rnd: 2 };
const ROUND2_CLASSIC_AGRI_POSTFILL_SALES_JOBS = { ops: 2, eng: 2, biz: 3, mgmt: 2 };
const ROUND2_CLASSIC_AGRI_POSTFILL_SALES_MID_JOBS = { ops: 2, eng: 2, biz: 2, mgmt: 2 };
const ROUND2_BN3_SALESBOT_TARGET = 5;
const ROUND2_BN3_SALESBOT_BUFFER = 10e9;
const ROUND2_BN3_POSTFILL_SMART_STORAGE_TARGET = 12;
const ROUND2_BN3_POSTFILL_STORAGE_AVG_PCT = 0.90;
const ROUND2_BN3_POSTFILL_STORAGE_PEAK_PCT = 0.98;
const ROUND2_BN3_POSTFILL_STORAGE_BUFFER = 8e9;
const ROUND2_BN3_LATE_SALESBOT_TARGET = 5;
const ROUND2_BN3_LATE_SALESBOT_BUFFER = 4e9;
const ROUND2_BN3_LATE_POSTFILL_SMART_STORAGE_TARGET = 14;
const ROUND2_BN3_LATE_POSTFILL_STORAGE_BUFFER = 1e9;
const ROUND2_TOB_HQ_OFFICE = 15;
const ROUND2_TOB_SUPPORT_OFFICE = 3;
const ROUND2_TOB_ADVERT = 2;
const ROUND2_TOB_HQ_SMALL_JOBS = { ops: 1, eng: 3, biz: 1, mgmt: 1 };
const ROUND2_TOB_HQ_MID_JOBS = { ops: 2, eng: 4, biz: 1, mgmt: 2 };
const ROUND2_CHEM_OFFICE = 3;
const ROUND2_TOB_HQ_JOBS = { ops: 3, eng: 7, biz: 1, mgmt: 4 };
const ROUND2_TOB_SUPPORT_JOBS = { rnd: 3 };
const ROUND2_CHEM_JOBS = { eng: 1, rnd: 2 };
const ROUND2_TOB_HQ_OFFICE_AGGR = 18;
const ROUND2_TOB_HQ_JOBS_AGGR = { ops: 3, eng: 8, biz: 1, mgmt: 4, rnd: 2 };
const ROUND2_TOB_SUPPORT_OFFICE_AGGR = 9;
const ROUND2_TOB_SUPPORT_JOBS_AGGR = { eng: 1, mgmt: 1, rnd: 7 };
const ROUND2_CHEM_OFFICE_AGGR = 6;
const ROUND2_CHEM_JOBS_AGGR = { ops: 1, eng: 2, mgmt: 1, rnd: 2 };
const ROUND2_CHEM_JOBS_SMALL = { ops: 1, eng: 1, rnd: 1 };
const ROUND2_CHEM_JOBS_MID = { ops: 1, eng: 2, rnd: 1 };
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
const ROUND2_GLOBAL_UPGRADE_TARGET_LATE = 10;
const ROUND2_AGRI_WAREHOUSE_LATE = 10;
const ROUND2_LATE_PUSH_TRIGGER = 8e11;
const ROUND2_LATE_PUSH_RESERVE = 20e9;
const ROUND2_LATE_PUSH_RESERVE_PCT = 0.30;
const ROUND2_LATE_PUSH_STAGNATION = 6;
const ROUND2_LATE_PUSH_FORCE_TRIGGER = 1.5e12;
const ROUND2_LATE_DUMMY_TRIGGER = 9e11;
const ROUND2_STAGNATION_ABS = 10e9;
const ROUND2_STAGNATION_PCT = 0.01;
const ROUND2_CLASSIC_RESERVE = 2e9;
const ROUND2_CLASSIC_RESERVE_PCT = 0.05;
const ROUND2_CLASSIC_DUMMY_TRIGGER = 2.5e12;
const ROUND2_CLASSIC_DUMMY_STAGNATION = 10;
const ROUND2_BN3_RESERVE = 2e9;
const ROUND2_BN3_RESERVE_PCT = 0.05;
const ROUND2_BN3_SMART_TARGET = 10;
const ROUND2_BN3_MATERIAL_TARGETS = { 'Hardware': 2800, 'Robots': 96, 'AI Cores': 2520, 'Real Estate': 146400 };
const ROUND2_BN3_HEADROOM_MATERIAL_TARGETS = { 'Hardware': 2520, 'Robots': 86, 'AI Cores': 2268, 'Real Estate': 131760 };
const ROUND2_BN3_RE_PUSH_USAGE_PCT = 0.85;
const ROUND2_BN3_RE_PUSH_MIN_SPEND = 1e9;
const ROUND2_BN3_DUMMY_TRIGGER = 1.8e12;
const ROUND2_BN3_DUMMY_BUFFER = 5e9;
const ROUND2_BN3_DUMMY_MAX = 1;
const ROUND2_BN3_LEAN_TOB_HQ_OFFICE = 9;
const ROUND2_BN3_LEAN_TOB_ADVERT = 1;
const ROUND2_BN3_LEAN_TOB_PRODUCT_RESERVE = 5e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT = 0.0075;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_POSTDONE = 0.03;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_LATE = 0.04;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP = 1e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_POSTDONE = 2.5e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_LATE = 5e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_POSTDONE = 5e8;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_LATE = 2.5e9;
const ROUND2_BN3_LEAN_TOB_SUPPORT_TRIGGER = 2.6e12;
const ROUND2_BN3_LEAN_TOB_SUPPORT_STAGNATION = 6;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_TRIGGER = 2.75e12;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_STAGNATION = 8;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_OFFICE = 12;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_ADVERT = 2;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_BUFFER = 4e9;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_ADVERT_BUFFER = 8e9;
const ROUND2_BN3_LEAN_TOB_PREFILL_HQ_TRIGGER = 2.0e12;
const ROUND2_BN3_LEAN_TOB_PREFILL_HQ_STAGNATION = 4;
const ROUND2_BN3_LEAN_TOB_PREFILL_HQ_BUFFER = 4e9;
const ROUND2_BN3_LEAN_TOB_PREFILL_ADVERT_BUFFER = 8e9;
const ROUND2_BN3_LATE_VALUATION_TRIGGER = 2.4e12;
const ROUND2_BN3_LATE_VALUATION_STAGNATION = 8;
const ROUND2_BN3_LATE_WILSON_TARGET = 1;
const ROUND2_BN3_LATE_WILSON_BUFFER = 2e9;
const ROUND2_BN3_LATE_TOB_ADVERT_TARGET = 3;
const ROUND2_BN3_LATE_TOB_ADVERT_BUFFER = 4e9;
const ROUND2_BN3_LATE_TOB_ADVERT4_TRIGGER = 2.8e12;
const ROUND2_BN3_LATE_TOB_ADVERT4_STAGNATION = 20;
const ROUND2_BN3_LATE_TOB_ADVERT5_TRIGGER = 3.3e12;
const ROUND2_BN3_LATE_TOB_ADVERT5_STAGNATION = 40;
const ROUND2_BN3_LATE_TOB_ADVERT6_TRIGGER = 3.8e12;
const ROUND2_BN3_LATE_TOB_ADVERT6_STAGNATION = 60;
const ROUND2_BN3_LATE_SECOND_DUMMY_TRIGGER = 3.3e12;
const ROUND2_BN3_LATE_SECOND_DUMMY_STAGNATION = 40;
const ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_TOLERANCE = 1e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_STAGNATION = 12;
const ROUND2_BN3_LEAN_TOB_SPEED_HQ_TRIGGER = 1.0e12;
const ROUND2_BN3_LEAN_TOB_SPEED_HQ_STAGNATION = 6;
const ROUND2_BN3_LEAN_TOB_SPEED_HQ_OFFICE = 18;
const ROUND2_BN3_LEAN_TOB_SPEED_HQ_BUFFER = 8e9;
const ROUND2_BN3_LEAN_TOB_SPEED_ADVERT_BUFFER = 16e9;
const ROUND2_BN3_LEAN_TOB_EARLY_SUPPORT_TRIGGER = 1.0e12;
const ROUND2_BN3_LEAN_TOB_EARLY_SUPPORT_STAGNATION = 6;
const ROUND2_BN3_LEAN_TOB_EARLY_SUPPORT_MIN_CASH = 0.5e9;
const ROUND2_BN3_LEAN_TOB_POSTDONE_HQ_OFFICE = 18;
const ROUND2_BN3_LEAN_TOB_POSTDONE_HQ_MIN_CASH = 1e9;
const ROUND2_BN3_LEAN_TOB_POSTDONE_ADVERT = 2;
const ROUND2_BN3_LEAN_TOB_POSTDONE_ADVERT_MIN_CASH = 1e9;
const ROUND2_BN3_LEAN_TOB_SUPPORT_OFFICE_POSTDONE = 9;
const ROUND2_BN3_LEAN_TOB_SUPPORT_JOBS_POSTDONE = { ops: 1, eng: 3, biz: 2, mgmt: 3 };
const ROUND2_TOB_PLANT_DIRECT_BUFFER_CYCLES = 25;
const ROUND2_TOB_PLANT_EXPORT_BUFFER_CYCLES = 2;
const ROUND2_TOB_PLANT_EXPORT_SEED = 400;
const ROUND2_BN3_SOFT_ACCEPT = 1.6e12;
const ROUND2_BN3_ACCEPT_NEAR_BEST_RATIO = 0.97;
const ROUND2_BN3_ACCEPT_NEAR_BEST_STAGNATION = 2;
const ROUND2_BN3_ACCEPT_DECAY_RATIO = 0.92;
const ROUND2_BN3_ACCEPT_DECAY_STAGNATION = 4;
const ROUND2_BN3_PRAGMATIC_ACCEPT = 3.2e12;
const ROUND2_BN3_PRAGMATIC_ACCEPT_FLOOR = 3.1e12;
const ROUND2_BN3_PRAGMATIC_ACCEPT_NEAR_BEST_RATIO = 0.97;
const ROUND2_BN3_PRAGMATIC_ACCEPT_NEAR_BEST_STAGNATION = 10;
const ROUND2_BN3_PRAGMATIC_ACCEPT_DECAY_RATIO = 0.95;
const ROUND2_BN3_PRAGMATIC_ACCEPT_DECAY_STAGNATION = 20;
const ROUND2_POST_ACCEPT_BOOTSTRAP_RESERVE = 25e9;
const ROUND2_POST_ACCEPT_BOOTSTRAP_RESERVE_PCT = 0.02;
const ROUND2_POST_ACCEPT_SMART_FACTORIES_TARGET = 12;
const ROUND2_POST_ACCEPT_SMART_STORAGE_TARGET = 14;
const ROUND2_POST_ACCEPT_WILSON_TARGET = 2;
const ROUND2_POST_ACCEPT_TOB_ADVERT_TARGET = 4;
const ROUND2_POST_ACCEPT_AGRI_OFFICE = 20;
const ROUND2_POST_ACCEPT_TOB_HQ_OFFICE = 30;
const ROUND2_POST_ACCEPT_TOB_SUPPORT_OFFICE = 20;
const ROUND2_POST_ACCEPT_CHEM_OFFICE = 9;
const ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL = 6;
const ROUND2_POST_ACCEPT_TOB_HQ_JOBS = { ops: 5, eng: 11, biz: 2, mgmt: 9, rnd: 3 };
const ROUND2_POST_ACCEPT_TOB_SUPPORT_JOBS = { ops: 1, eng: 2, biz: 0, mgmt: 1, rnd: 16 };
const ROUND2_POST_ACCEPT_AGRI_JOBS = { ops: 6, eng: 8, biz: 1, mgmt: 3, rnd: 2 };
const ROUND2_POST_ACCEPT_CHEM_JOBS = { ops: 1, eng: 5, biz: 0, mgmt: 1, rnd: 2 };
const ROUND2_PRODUCT_MIN_INVEST = 2e8;
const ROUND2_PRODUCT_MAX_INVEST = 5e9;
const ROUND2_PRODUCT_MAX_INVEST_AGGR = 12e9;
const ROUND2_AGGR_PRODUCT_INVEST_PCT = 0.04;
const ROUND2_AGGR_WARMUP_TARGET = 1.25e12;
const ROUND2_AGGR_WARMUP_STAGNATION = 12;
const ROUND2_AGGR_SMART_SUPPLY_TRIGGER = 6e11;
const ROUND2_AGGR_ACCELERATE_TRIGGER = 4.25e11;
const ROUND2_AGGR_TOB_HQ_WARMUP = 9;
const ROUND2_AGGR_TOB_HQ_WARMUP_JOBS = { ops: 2, eng: 5, mgmt: 2 };
const ROUND2_AGGR_CHEM_HQ_WARMUP = 6;
const ROUND2_AGGR_FREEZE_PROGRESS = 45;
const ROUND2_AGGR_EARLY_SUPPORT_PROGRESS = 60;
const ROUND2_AGGR_EARLY_SUPPORT_TRIGGER = 1.1e12;

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

// Tobacco: realEstate=0.15, hardware=0.15, robot=0.20, aiCore=0.15
const TOB_FACTORS = [0.15, 0.15, 0.20, 0.15];
const TOB_SIZES = [0.005, 0.06, 0.5, 0.1];
const TOB_MATS = ['Real Estate', 'Hardware', 'Robots', 'AI Cores'];

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

const argsSchema = [['self-fund', false], ['round1-only', false], ['aggressive-round2', false], ['classic-round2', false], ['bn3-round2', false], ['legacy-round2', false], ['bn3-soft-accept', false], ['bn3-hard-5t-goal', false], ['bn3-re-push', false], ['bn3-dummy-round2', false], ['bn3-postfill-sales', false], ['bn3-salesbots', false], ['bn3-postfill-storage', false], ['bn3-headroom-fill', false], ['bn3-lean-tob-round2', false], ['bn3-lean-tob-support', false], ['bn3-lean-tob-hq-push', false], ['income-mode', false]];
export function autocomplete(data) { data.flags(argsSchema); return []; }

function parseOptions(ns) {
    const defaults = Object.fromEntries(argsSchema);
    const opts = { ...defaults };
    for (let i = 0; i < ns.args.length; i++) {
        const arg = ns.args[i];
        if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
        const key = arg.slice(2);
        if (!(key in opts)) continue;
        const defaultValue = defaults[key];
        if (typeof defaultValue === 'boolean') {
            opts[key] = true;
        } else if (i + 1 < ns.args.length) {
            opts[key] = ns.args[++i];
        }
    }
    return opts;
}

// ═════════════════════════════════════════════════════════════════════════════
export async function main(ns) {
    const opts = parseOptions(ns);
    ns.disableLog('ALL');
    ns.ui.openTail();
    const c = ns.corporation;

    function useBn3Round2() {
        return opts['bn3-round2'] || opts['legacy-round2'];
    }

    function useBn3Round2RealEstatePush() {
        return useBn3Round2() && opts['bn3-re-push'];
    }

    function useBn3Round2Dummy() {
        return useBn3Round2() && opts['bn3-dummy-round2'];
    }

    function useBn3PostfillSales() {
        return useBn3Round2() && opts['bn3-postfill-sales'];
    }

    function useBn3Round2SalesBots() {
        return useBn3Round2() && opts['bn3-salesbots'];
    }

    function useBn3PostfillStorage() {
        return useBn3Round2() && opts['bn3-postfill-storage'];
    }

    function useBn3HeadroomFill() {
        return useBn3Round2() && opts['bn3-headroom-fill'];
    }

    function useBn3LeanTobRound2() {
        return useBn3Round2() && opts['bn3-lean-tob-round2'];
    }

    function useBn3LeanTobSupport() {
        return useBn3LeanTobRound2() && opts['bn3-lean-tob-support'];
    }

    function useBn3LeanTobHQPush() {
        return useBn3LeanTobRound2() && opts['bn3-lean-tob-hq-push'];
    }

    function useBn3Hard5tGoal() {
        return useBn3Round2() && opts['bn3-hard-5t-goal'];
    }

    function useBn3SoftAccept() {
        if (useBn3Hard5tGoal()) return false;
        return opts['bn3-soft-accept'] || useBn3LeanTobRound2();
    }

    function useIncomeMode() {
        return opts['income-mode'];
    }

    function getBn3MaterialTargets() {
        return useBn3HeadroomFill() ? ROUND2_BN3_HEADROOM_MATERIAL_TARGETS : ROUND2_BN3_MATERIAL_TARGETS;
    }

    function delayChemicalUntilPostRound2() {
        return useBn3Round2();
    }

    function delayTobaccoUntilPostRound2() {
        if (useBn3LeanTobRound2()) return false;
        if (useBn3Round2()) return true;
        return DELAY_TOBACCO_UNTIL_POST_ROUND2 && !opts['aggressive-round2'];
    }

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
    const TOB_BOOST = getBoostConfig(IND_TOBACCO, TOB_FACTORS, TOB_SIZES, TOB_MATS);

    function getRequiredMaterialsConfig(industry, fallback) {
        try { return { ...(c.getIndustryData(industry).requiredMaterials ?? fallback) }; }
        catch { return { ...fallback }; }
    }

const ROUND1_AGRI_REQUIRED = getRequiredMaterialsConfig(IND_AGRI, { Water: 0.5, Chemicals: 0.2 });
const ROUND1_AGRI_MAT_SIZES = Object.fromEntries(
    Object.keys(ROUND1_AGRI_REQUIRED).map((mat) => [mat, c.getMaterialData(mat)?.size ?? 0.05]),
);
    const agriSupplyProdHints = {};
  const DEBUG_ASSET_MATS = ['Water', 'Chemicals', 'Food', 'Plants', 'Real Estate', 'Hardware', 'Robots', 'AI Cores'];
    let latestRound2Offer = 0;
    let lastRound2AssetProxy = null;
    let lastTobaccoProductError = '';
    let lastExportRouteError = '';

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
        const requireTobaccoBeforeRound2 = !delayTobaccoUntilPostRound2();
        const requireChemicalBeforeRound2 = !delayChemicalUntilPostRound2();
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
        if (!requireChemicalBeforeRound2 && round <= 2) return 4;
        if (!divs.has(DIV_CHEM) || (requireTobaccoBeforeRound2 && !divs.has(DIV_TOBACCO)) || !c.hasUnlock(UNLOCKS.export)) return 3;
        if (round <= 2) return 4;
        if (!isPostRound2BootstrapReady()) return 5;
        return (readDoneFlag() || isPilotRunning()) ? 7 : 6;
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

    if (phase >= 7) {
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

    function getDivisionBoostConfig(div) {
        if (div === DIV_AGRI) return AGRI_BOOST;
        if (div === DIV_CHEM) return CHEM_BOOST;
        if (div === DIV_TOBACCO) return TOB_BOOST;
        return null;
    }

    function estimateBoostTargetsForSize(div, nextSize) {
        const config = getDivisionBoostConfig(div);
        if (!config || !Number.isFinite(nextSize) || nextSize <= 0) return {};
        return optimalBoosts(nextSize * 0.70, [...config.factors], [...config.sizes], [...config.mats]);
    }

    function getMaterialBuyPrice(div, city, mat) {
        try {
            const info = c.getMaterial(div, city, mat);
            return Math.max(0, Number(info.marketPrice ?? info.averagePrice ?? 0));
        } catch {
            return 0;
        }
    }

    function estimateBoostTopUpCost(div, city, nextSize) {
        try {
            const targets = estimateBoostTargetsForSize(div, nextSize);
            let total = 0;
            for (const [mat, target] of Object.entries(targets)) {
                const stored = c.getMaterial(div, city, mat).stored;
                const needed = Math.max(0, target - stored);
                total += needed * getMaterialBuyPrice(div, city, mat);
            }
            return total;
        } catch {
            return 0;
        }
    }

    function estimateMaterialTargetSpend(div, city, targets) {
        try {
            let total = 0;
            for (const [mat, target] of Object.entries(targets)) {
                const stored = c.getMaterial(div, city, mat).stored;
                total += Math.max(0, target - stored) * getMaterialBuyPrice(div, city, mat);
            }
            return total;
        } catch {
            return Infinity;
        }
    }

    function getCorpOfficeInitialCost() {
        try { return Number(c.getConstants().officeInitialCost ?? 4e9); } catch { return 4e9; }
    }

    function getCorpWarehouseInitialCost() {
        try { return Number(c.getConstants().warehouseInitialCost ?? 5e9); } catch { return 5e9; }
    }

    function estimateWarehouseUpgradeSpend(div, city) {
        try {
            const wh = c.getWarehouse(div, city);
            const cost = c.getUpgradeWarehouseCost(div, city, 1);
            if (!Number.isFinite(cost)) return Infinity;
            if (!getDivisionBoostConfig(div) || wh.level <= 0) return cost;
            const nextSize = wh.size * ((wh.level + 1) / wh.level);
            return cost + estimateBoostTopUpCost(div, city, nextSize);
        } catch {
            return Infinity;
        }
    }

    function estimateSmartStorageUpgradeSpend() {
        try {
            const level = c.getUpgradeLevel('Smart Storage');
            const cost = c.getUpgradeLevelCost('Smart Storage');
            if (!Number.isFinite(cost)) return Infinity;
            const currentMult = 1 + level * 0.1;
            const nextMult = 1 + (level + 1) * 0.1;
            const sizeRatio = currentMult > 0 ? nextMult / currentMult : 1;
            let total = cost;
            for (const div of [DIV_AGRI, DIV_CHEM]) {
                if (!getDivisionBoostConfig(div)) continue;
                for (const city of CITIES) {
                    try {
                        if (!c.hasWarehouse(div, city)) continue;
                        const wh = c.getWarehouse(div, city);
                        total += estimateBoostTopUpCost(div, city, wh.size * sizeRatio);
                    } catch { }
                }
            }
            return total;
        } catch {
            return Infinity;
        }
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

    function enableSmartSupply(div, cities = CITIES) {
        if (!c.hasUnlock(UNLOCKS.smartSupply)) return;
        for (const city of cities)
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

    function maintainRound1AgriSupply(cities = CITIES) {
        if (!ROUND1_USE_CUSTOM_SUPPLY) return;
        for (const city of cities) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                const freeSpace = Math.max(0, wh.size - wh.sizeUsed);
                const observedProd = Math.max(
                    c.getMaterial(DIV_AGRI, city, 'Plants').productionAmount || 0,
                    c.getMaterial(DIV_AGRI, city, 'Food').productionAmount || 0,
                    0,
                );
                const officeSize = Math.max(1, Number(c.getOffice(DIV_AGRI, city).size ?? 0));
                const bootstrapProd = Math.max(
                    8,
                    officeSize * (useBn3Round2() ? 3 : 2),
                );
                const hintedProd = Math.max(Number(agriSupplyProdHints[city] ?? 0) * 0.9, bootstrapProd);
                const rawProd = Math.max(observedProd, hintedProd);
                agriSupplyProdHints[city] = Math.max(Number(agriSupplyProdHints[city] ?? 0), observedProd, bootstrapProd);
                const needed = {};
                let totalNeedSize = 0;
                for (const [mat, coeff] of Object.entries(ROUND1_AGRI_REQUIRED)) {
                    const stored = c.getMaterial(DIV_AGRI, city, mat).stored;
                    const seed = Math.max(
                        ROUND1_SUPPLY_SEED[mat] ?? 0,
                        useBn3Round2()
                            ? (((mat === 'Water' ? 0.06 : 0.024) * Number(wh.size ?? 0)) / Math.max(ROUND1_AGRI_MAT_SIZES[mat] ?? 0.05, 1e-9))
                            : 0,
                    );
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

    function stopRound1AgriSupply(cities = CITIES) {
        if (!ROUND1_USE_CUSTOM_SUPPLY) return;
        for (const city of cities) {
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

    function shouldLeanOnTobaccoPlantExports() {
        return hasDiv(DIV_AGRI) && c.hasUnlock(UNLOCKS.export);
    }

    function maintainTobaccoPlantSupply(cities = CITIES) {
        if (!hasDiv(DIV_TOBACCO) || c.hasUnlock(UNLOCKS.smartSupply)) return;
        const exportBuffered = shouldLeanOnTobaccoPlantExports();
        for (const city of cities) {
            try {
                if (!c.hasWarehouse(DIV_TOBACCO, city)) continue;
                const wh = c.getWarehouse(DIV_TOBACCO, city);
                const freeSpace = Math.max(0, wh.size - wh.sizeUsed);
                const plants = c.getMaterial(DIV_TOBACCO, city, 'Plants');
                const stored = Math.max(0, Number(plants.stored ?? 0));
                const consumption = Math.max(0, -Number(plants.productionAmount ?? 0));
                const target = exportBuffered
                    ? Math.max(ROUND2_TOB_PLANT_EXPORT_SEED, consumption * CYCLE_SECS * ROUND2_TOB_PLANT_EXPORT_BUFFER_CYCLES)
                    : Math.max(200, consumption * CYCLE_SECS * ROUND2_TOB_PLANT_DIRECT_BUFFER_CYCLES);
                const deficit = Math.max(0, target - stored);
                const maxBySpace = (ROUND1_AGRI_MAT_SIZES.Plants ?? 0.05) > 0
                    ? freeSpace / (ROUND1_AGRI_MAT_SIZES.Plants ?? 0.05)
                    : deficit;
                c.buyMaterial(DIV_TOBACCO, city, 'Plants', Math.max(0, Math.min(deficit, maxBySpace) / CYCLE_SECS));
            } catch { }
        }
    }

    function stopTobaccoPlantSupply(cities = CITIES) {
        if (!hasDiv(DIV_TOBACCO)) return;
        for (const city of cities) {
            try { c.buyMaterial(DIV_TOBACCO, city, 'Plants', 0); } catch { }
        }
    }

    function stopChemicalWaterSupply(cities = CITIES) {
        for (const city of cities) {
            try { c.buyMaterial(DIV_CHEM, city, 'Water', 0); } catch { }
        }
    }

    function getDivisionSmartSupplyCounts(div, cities = CITIES) {
        let enabled = 0;
        let total = 0;
        for (const city of cities) {
            try {
                if (!c.hasWarehouse(div, city)) continue;
                total++;
                if (c.getWarehouse(div, city).smartSupplyEnabled) enabled++;
            } catch { }
        }
        return { enabled, total };
    }

    function maintainPreRound2SupplyState(cities = CITIES) {
        if (c.hasUnlock(UNLOCKS.smartSupply)) {
            stopTobaccoPlantSupply(cities);
            enableSmartSupply(DIV_AGRI, cities);
            enableSmartSupply(DIV_CHEM, cities);
            enableSmartSupply(DIV_TOBACCO, cities);
            return;
        }
        maintainRound1AgriSupply(cities);
        maintainChemicalWaterSupply(cities.filter((city) => PHASE3_CHEM_START_CITIES.includes(city)));
        // Bitburner Smart Supply only buys product inputs from the previous cycle's
        // production, so a product division stuck at 0 production will keep buying 0.
        // Keep a direct Plants safety-net alive until Smart Supply itself is unlocked.
        maintainTobaccoPlantSupply(cities);
    }

    function unlockCost(name, fallback = Infinity) {
        try { return c.getUnlockCost(name); } catch { return fallback; }
    }

    function canConfigureMaterialExport(sourceDiv, sourceCity, targetDiv, targetCity, material) {
        try {
            if (!hasDiv(sourceDiv) || !hasDiv(targetDiv)) return false;
            if (!c.getDivision(sourceDiv).cities.includes(sourceCity)) return false;
            if (!c.getDivision(targetDiv).cities.includes(targetCity)) return false;
            if (!c.hasWarehouse(sourceDiv, sourceCity)) return false;
            if (!c.hasWarehouse(targetDiv, targetCity)) return false;
            c.getMaterial(sourceDiv, sourceCity, material);
            c.getMaterial(targetDiv, targetCity, material);
            return true;
        } catch {
            return false;
        }
    }

    function refreshMaterialExport(sourceDiv, sourceCity, targetDiv, targetCity, material, amount) {
        if (!canConfigureMaterialExport(sourceDiv, sourceCity, targetDiv, targetCity, material)) return false;
        const routeLabel = `${sourceDiv}/${sourceCity} ${material} -> ${targetDiv}/${targetCity}`;
        try {
            const sourceMat = c.getMaterial(sourceDiv, sourceCity, material);
            const existing = Array.isArray(sourceMat.exports)
                ? sourceMat.exports.find((exp) => exp.division === targetDiv && exp.city === targetCity)
                : null;
            if (existing?.amount === amount) return true;
            // Only rewrite the route when the formula changed; constantly
            // cancel/re-adding the same export makes debugging harder and gains nothing.
            if (existing) {
                try { c.cancelExportMaterial(sourceDiv, sourceCity, targetDiv, targetCity, material); } catch { }
            }
            c.exportMaterial(sourceDiv, sourceCity, targetDiv, targetCity, material, amount);
            lastExportRouteError = '';
            return true;
        } catch (e) {
            const msg = `${routeLabel}: ${e?.message ?? String(e)}`;
            if (msg !== lastExportRouteError) {
                lastExportRouteError = msg;
                log(ns, `WARN: Could not configure export route ${msg}`, true, 'warning');
            }
            return false;
        }
    }

    function configureExports() {
        if (!c.hasUnlock(UNLOCKS.export)) return;
        // Bootstrap destination inventories so product divisions can start consuming
        // their inputs. Keep the formula plain arithmetic so the in-game export
        // evaluator doesn't depend on helper functions or stale cycle timing.
        const TOB_PLANTS_EXP = '(-IPROD)+((600-IINV)/5)';
        const CHEM_PLANTS_EXP = '(-IPROD)+((300-IINV)/5)';
        const AGRI_CHEM_EXP = '(IPROD+IINV/10)*(-1)';
        for (const city of CITIES) {
            refreshMaterialExport(DIV_AGRI, city, DIV_TOBACCO, city, 'Plants', TOB_PLANTS_EXP);
            refreshMaterialExport(DIV_AGRI, city, DIV_CHEM, city, 'Plants', CHEM_PLANTS_EXP);
            refreshMaterialExport(DIV_CHEM, city, DIV_AGRI, city, 'Chemicals', AGRI_CHEM_EXP);
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

    function tobaccoProductVersion(name) {
        const m = /^Tobac-v(\d+)$/.exec(name);
        const n = m ? Number(m[1]) : NaN;
        return Number.isFinite(n) ? n : 0;
    }

    function getHighestTobaccoProductVersion() {
        let maxVersion = 0;
        for (const name of tobaccoProducts()) {
            maxVersion = Math.max(maxVersion, tobaccoProductVersion(name));
        }
        return maxVersion;
    }

    function getTobaccoProductCapacity() {
        if (!hasDiv(DIV_TOBACCO)) return 0;
        let capacity = 3;
        try { if (c.hasResearched(DIV_TOBACCO, 'uPgrade: Capacity.I')) capacity++; } catch { }
        try { if (c.hasResearched(DIV_TOBACCO, 'uPgrade: Capacity.II')) capacity++; } catch { }
        return capacity;
    }

    function getTobaccoRetirementCandidate() {
        let candidate = null;
        for (const name of tobaccoProducts()) {
            try {
                const product = c.getProduct(DIV_TOBACCO, HQ_CITY, name);
                const progress = Number(product.developmentProgress ?? 0);
                if (progress < 100) continue;
                const rating = Number(product.rating ?? 0);
                const version = tobaccoProductVersion(name);
                if (!candidate ||
                    rating < candidate.rating - 1e-9 ||
                    (Math.abs(rating - candidate.rating) <= 1e-9 && version < candidate.version)) {
                    candidate = { name, rating, version };
                }
            } catch { }
        }
        return candidate?.name ?? null;
    }

    function getTobaccoProductStats() {
        let highestProgress = 0;
        let activeProgress = 0;
        let activeProducts = 0;
        let finishedProducts = 0;
        for (const name of tobaccoProducts()) {
            try {
                const progress = c.getProduct(DIV_TOBACCO, HQ_CITY, name).developmentProgress || 0;
                if (progress > highestProgress) highestProgress = progress;
                if (progress >= 100) {
                    finishedProducts++;
                } else {
                    activeProducts++;
                    if (progress > activeProgress) activeProgress = progress;
                }
            } catch { }
        }
        return { highestProgress, activeProgress, activeProducts, finishedProducts };
    }

    function sumJobCounts({ ops = 0, eng = 0, biz = 0, mgmt = 0, rnd = 0 } = {}) {
        return ops + eng + biz + mgmt + rnd;
    }

    function fillJobRemainder(jobCounts, targetSize, order) {
        const filled = { ...jobCounts };
        let assigned = sumJobCounts(filled);
        for (let i = 0; assigned < targetSize; i++, assigned++) {
            const job = order[i % order.length];
            filled[job] = Number(filled[job] ?? 0) + 1;
        }
        return filled;
    }

    function getRound2TobaccoHQCompletedJobs(size) {
        if (size >= ROUND2_TOB_HQ_OFFICE) {
            return fillJobRemainder(ROUND2_TOB_HQ_JOBS, size, ['eng', 'mgmt', 'ops']);
        }
        if (size >= 9) {
            return fillJobRemainder(ROUND2_TOB_HQ_MID_JOBS, size, ['eng', 'mgmt', 'eng', 'ops', 'mgmt', 'eng']);
        }
        return fillJobRemainder(ROUND2_TOB_HQ_SMALL_JOBS, size, ['eng', 'mgmt', 'ops']);
    }

    function getTobaccoFlowStats() {
        if (!hasDiv(DIV_TOBACCO)) return {};
        try {
            const division = c.getDivision(DIV_TOBACCO);
            const revenue = Number(division.lastCycleRevenue ?? 0);
            const expenses = Number(division.lastCycleExpenses ?? 0);
            let activeProducts = 0;
            let stored = 0;
            let production = 0;
            let sell = 0;
            let imports = 0;
            let buy = 0;
            for (const name of division.products) {
                let progress = 0;
                try {
                    progress = Number(c.getProduct(DIV_TOBACCO, HQ_CITY, name).developmentProgress ?? 0);
                } catch { }
                if (progress < 100) {
                    activeProducts++;
                    continue;
                }
                for (const city of division.cities) {
                    try {
                        const info = c.getProduct(DIV_TOBACCO, city, name);
                        stored += Number(info.stored ?? 0);
                        production += Number(info.productionAmount ?? 0);
                        sell += Number(info.actualSellAmount ?? 0);
                    } catch { }
                }
            }
            let plants = 0;
            for (const city of division.cities) {
                try {
                    const plant = c.getMaterial(DIV_TOBACCO, city, 'Plants');
                    plants += Number(plant.stored ?? 0);
                    imports += Number(plant.importAmount ?? 0);
                    buy += Number(plant.buyAmount ?? 0);
                } catch { }
            }
            const office = c.getOffice(DIV_TOBACCO, HQ_CITY);
            const jobs = office.employeeJobs ?? {};
            const assigned = Number(jobs[JOBS.ops] ?? 0) +
                Number(jobs[JOBS.eng] ?? 0) +
                Number(jobs[JOBS.biz] ?? 0) +
                Number(jobs[JOBS.mgmt] ?? 0) +
                Number(jobs[JOBS.rnd] ?? 0);
            return {
                tobActive: activeProducts,
                tobRev: formatMoney(revenue),
                tobExp: formatMoney(expenses),
                tobProfit: formatMoney(revenue - expenses),
                tobStore: stored.toFixed(0),
                tobMake: `${production.toFixed(1)}/s`,
                tobSell: `${sell.toFixed(1)}/s`,
                tobPlants: plants.toFixed(0),
                tobImp: `${imports.toFixed(1)}/s`,
                tobBuy: `${buy.toFixed(1)}/s`,
                tobIdle: Math.max(0, Number(office.size ?? 0) - assigned),
            };
        } catch {
            return {};
        }
    }

    function getTobaccoExportRouteStats() {
        if (!hasDiv(DIV_AGRI) || !hasDiv(DIV_TOBACCO) || !c.hasUnlock(UNLOCKS.export)) return {};
        try {
            const exports = c.getMaterial(DIV_AGRI, HQ_CITY, 'Plants').exports ?? [];
            const route = exports.find((exp) => exp.division === DIV_TOBACCO && exp.city === HQ_CITY);
            return {
                tobRoute: route ? 'yes' : 'no',
                tobRouteAmt: route?.amount ?? 'none',
            };
        } catch {
            return {};
        }
    }

    function getTobaccoProductInvestment(bestOffer = 0) {
        const funds = c.getCorporation().funds;
        const { finishedProducts } = getTobaccoProductStats();
        let investPct = opts['aggressive-round2']
            ? ROUND2_AGGR_PRODUCT_INVEST_PCT
            : useBn3LeanTobRound2()
                ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT
                : 0.01;
        let investCap = opts['aggressive-round2']
            ? ROUND2_PRODUCT_MAX_INVEST_AGGR
            : useBn3LeanTobRound2()
                ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP
                : ROUND2_PRODUCT_MAX_INVEST;
        let investMin = ROUND2_PRODUCT_MIN_INVEST;
        if (useBn3LeanTobRound2() && finishedProducts > 0) {
            const late = bestOffer >= ROUND2_BN3_LEAN_TOB_SUPPORT_TRIGGER;
            investPct = late
                ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_LATE
                : ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_POSTDONE;
            investCap = late
                ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_LATE
                : ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_POSTDONE;
            investMin = late
                ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_LATE
                : ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_POSTDONE;
        }
        return Math.max(investMin, Math.min(funds * investPct, investCap));
    }

    function isLeanTobaccoProductCycleReady(bestOffer = 0, stagnantChecks = 0) {
        if (!useBn3LeanTobRound2()) return true;
        if (bestOffer + ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_TOLERANCE >= ROUND2_BN3_LEAN_TOB_PREFILL_HQ_TRIGGER) return true;
        return stagnantChecks >= ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_STAGNATION;
    }

    function ensureTobaccoProduct(reserve = 0, bestOffer = 0, stagnantChecks = 0) {
        if (!hasDiv(DIV_TOBACCO) || hasActiveTobaccoDevelopment()) return;
        try {
            const invest = getTobaccoProductInvestment(bestOffer);
            const funds = c.getCorporation().funds;
            if (funds - invest < reserve) return;
            const capacity = getTobaccoProductCapacity();
            const products = tobaccoProducts();
            if (products.length >= capacity) {
                const cycleReady = isLeanTobaccoProductCycleReady(bestOffer, stagnantChecks);
                if (!cycleReady) return;
                const retired = getTobaccoRetirementCandidate();
                if (!retired) return;
                c.discontinueProduct(DIV_TOBACCO, retired);
                log(ns, `INFO: Retired ${retired} to free a Tobacco product slot.`, true, 'info');
            }
            const name = nextTobaccoProductName();
            c.makeProduct(DIV_TOBACCO, HQ_CITY, name, invest / 2, invest / 2);
            lastTobaccoProductError = '';
            log(ns, `INFO: Started product ${name} with ${formatMoney(invest)} investment.`, true, 'info');
        } catch (e) {
            const msg = e?.message ?? String(e);
            if (msg !== lastTobaccoProductError) {
                lastTobaccoProductError = msg;
                log(ns, `WARN: Could not start Tobacco product: ${msg}`, true, 'warning');
            }
        }
    }

    function getBn3LeanTobaccoProductReserve(baseReserve) {
        if (!useBn3LeanTobRound2() || !hasDiv(DIV_TOBACCO)) return baseReserve;
        const { finishedProducts } = getTobaccoProductStats();
        if (finishedProducts > 0) return baseReserve;
        return Math.max(baseReserve, ROUND2_BN3_LEAN_TOB_PRODUCT_RESERVE);
    }

    function canSpend(cost, reserve = 0) {
        return Number.isFinite(cost) && cost >= 0 && c.getCorporation().funds - cost >= reserve;
    }

    function getRound2ReserveInfo(bestOffer, rpGateCleared) {
        const funds = c.getCorporation().funds;
        if (opts['aggressive-round2']) {
            const { highestProgress, finishedProducts } = getTobaccoProductStats();
            const productWarm = finishedProducts > 0 || highestProgress >= ROUND2_AGGR_FREEZE_PROGRESS;
            if (rpGateCleared || bestOffer >= 2e12) return { reserve: Math.max(80e9, funds * 0.65), label: 'aggr-peak' };
            if (productWarm && bestOffer >= ROUND2_FREEZE_BEST_OFFER) return { reserve: Math.max(55e9, funds * 0.48), label: 'aggr-high' };
            if (bestOffer >= ROUND2_AGGR_EARLY_SUPPORT_TRIGGER || highestProgress >= ROUND2_AGGR_EARLY_SUPPORT_PROGRESS) {
                return { reserve: Math.max(25e9, funds * 0.30), label: 'aggr-mid' };
            }
            return { reserve: Math.max(12e9, funds * 0.18), label: 'aggr-low' };
        }
        if (rpGateCleared || bestOffer >= 2e12) return { reserve: Math.max(ROUND2_RESERVE_PEAK, funds * 0.90), label: 'peak' };
        if (bestOffer >= ROUND2_FREEZE_BEST_OFFER) return { reserve: Math.max(ROUND2_RESERVE_HIGH, funds * 0.82), label: 'high' };
        if (bestOffer >= 5e11) return { reserve: Math.max(ROUND2_RESERVE_MID, funds * 0.72), label: 'mid' };
        return { reserve: Math.max(ROUND2_RESERVE_MIN, funds * 0.58), label: 'low' };
    }

    function getRound2Reserve(bestOffer, rpGateCleared) {
        return getRound2ReserveInfo(bestOffer, rpGateCleared).reserve;
    }

    function formatRound2Debug(parts) {
        return Object.entries(parts)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
    }

    function estimateRound2AssetProxy() {
        try {
            let assets = Number(c.getCorporation().funds ?? 0);
            for (const div of c.getCorporation().divisions) {
                let cities = [];
                try { cities = c.getDivision(div).cities ?? []; } catch { }
                for (const city of cities) {
                    for (const mat of DEBUG_ASSET_MATS) {
                        try {
                            const info = c.getMaterial(div, city, mat);
                            const stored = Number(info.stored ?? 0);
                            const price = Number(info.averagePrice ?? info.marketPrice ?? 0);
                            if (stored > 0 && price > 0) assets += stored * price;
                        } catch { }
                    }
                }
            }
            return assets;
        } catch {
            return Number(c.getCorporation().funds ?? 0);
        }
    }

    function countRound2OfficesAndWarehouses() {
        try {
            let total = 0;
            for (const div of c.getCorporation().divisions) {
                let cities = [];
                try { cities = c.getDivision(div).cities ?? []; } catch { }
                total += cities.length;
                for (const city of cities) {
                    try {
                        if (c.hasWarehouse(div, city)) total++;
                    } catch { }
                }
            }
            return total;
        } catch {
            return 0;
        }
    }

    function getAgriWarehouseUsageSummary() {
        try {
            if (!hasDiv(DIV_AGRI)) return { avg: 0, peak: 0 };
            let totalUse = 0;
            let totalSize = 0;
            let peakUse = 0;
            for (const city of CITIES) {
                try {
                    const wh = c.getWarehouse(DIV_AGRI, city);
                    const size = Number(wh.size ?? 0);
                    const used = Number(wh.sizeUsed ?? 0);
                    if (size <= 0) continue;
                    totalUse += used;
                    totalSize += size;
                    peakUse = Math.max(peakUse, used / size);
                } catch { }
            }
            if (totalSize <= 0) return { avg: 0, peak: 0 };
            return {
                avg: totalUse / totalSize,
                peak: peakUse,
            };
        } catch {
            return { avg: 0, peak: 0 };
        }
    }

    function getAgriWarehouseUseStats() {
        const usage = getAgriWarehouseUsageSummary();
        return {
            whAvg: `${(usage.avg * 100).toFixed(1)}%`,
            whPeak: `${(usage.peak * 100).toFixed(1)}%`,
        };
    }

    function getAgriFlowStats() {
        try {
            let production = 0;
            let sell = 0;
            let stored = 0;
            let water = 0;
            let chemicals = 0;
            for (const city of CITIES) {
                try {
                    const food = c.getMaterial(DIV_AGRI, city, 'Food');
                    const plants = c.getMaterial(DIV_AGRI, city, 'Plants');
                    const waterMat = c.getMaterial(DIV_AGRI, city, 'Water');
                    const chemMat = c.getMaterial(DIV_AGRI, city, 'Chemicals');
                    production += Number(food.productionAmount ?? 0) + Number(plants.productionAmount ?? 0);
                    sell += Number(food.actualSellAmount ?? 0) + Number(plants.actualSellAmount ?? 0);
                    stored += Number(food.stored ?? 0) + Number(plants.stored ?? 0);
                    water += Number(waterMat.stored ?? 0);
                    chemicals += Number(chemMat.stored ?? 0);
                } catch { }
            }
            return {
                agriProd: `${production.toFixed(1)}/s`,
                agriSell: `${sell.toFixed(1)}/s`,
                agriStock: stored.toFixed(0),
                agriWC: `${water.toFixed(0)}/${chemicals.toFixed(0)}`,
            };
        } catch {
            return {};
        }
    }

    function getStableCorpCycleStats() {
        try {
            const corp = c.getCorporation();
            let revenue = 0;
            let expenses = 0;
            for (const div of corp.divisions ?? []) {
                try {
                    const info = c.getDivision(div);
                    revenue += Number(info.lastCycleRevenue ?? 0);
                    expenses += Number(info.lastCycleExpenses ?? 0);
                } catch { }
            }
            return {
                revenue,
                expenses,
                liveRevenue: Number(corp.revenue ?? 0),
                nextState: corp.nextState ?? '?',
                prevState: corp.prevState ?? '?',
            };
        } catch {
            return { revenue: 0, expenses: 0, liveRevenue: 0, nextState: '?', prevState: '?' };
        }
    }

    function getRound2CorpDebugStats() {
        try {
            const cycle = getStableCorpCycleStats();
            const revenue = cycle.revenue;
            const expenses = cycle.expenses;
            const assetProxy = estimateRound2AssetProxy();
            const assetDelta = lastRound2AssetProxy === null ? 0 : assetProxy - lastRound2AssetProxy;
            lastRound2AssetProxy = assetProxy;
            const offerFunds = Number(latestRound2Offer ?? 0);
            const valuationAvg = offerFunds > 0 ? offerFunds / ROUND2_EFFECTIVE_OFFER_MULT : 0;
            const ow = countRound2OfficesAndWarehouses();
            const salesBots = Number(c.getUpgradeLevel('ABC SalesBots') ?? 0);
            const smartFactories = Number(c.getUpgradeLevel('Smart Factories') ?? 0);
            const smartStorage = Number(c.getUpgradeLevel('Smart Storage') ?? 0);
            const agriSmartSupply = getDivisionSmartSupplyCounts(DIV_AGRI);
            const liveRevenueDrift = Math.abs(cycle.liveRevenue - revenue) > Math.max(1e3, Math.abs(revenue) * 0.05);
            return {
                assets: formatMoney(assetProxy),
                dAssets: formatMoney(assetDelta),
                avgVal: formatMoney(valuationAvg),
                to5t: formatMoney(Math.max(0, MIN_ROUND2 - offerFunds)),
                goal: `${((offerFunds / MIN_ROUND2) * 100).toFixed(1)}%`,
                rev: formatMoney(revenue),
                exp: formatMoney(expenses),
                profit: formatMoney(revenue - expenses),
                state: `${cycle.prevState}->${cycle.nextState}`,
                revNow: liveRevenueDrift ? formatMoney(cycle.liveRevenue) : undefined,
                sf: smartFactories,
                ss: smartStorage,
                ow,
                owMult: `${Math.pow(ROUND2_OW_MULT_BASE, ow).toFixed(3)}x`,
                salesBots,
                agriSS: `${agriSmartSupply.enabled}/${agriSmartSupply.total}`,
                ...getAgriWarehouseUseStats(),
                ...getAgriFlowStats(),
            };
        } catch {
            return {};
        }
    }

    function getLeanTobaccoDebugStats() {
        if (!useBn3LeanTobRound2() || !hasDiv(DIV_TOBACCO)) return {};
        try {
            const off = c.getOffice(DIV_TOBACCO, HQ_CITY);
            const cityCount = c.getDivision(DIV_TOBACCO).cities.length;
            const { highestProgress, activeProgress, activeProducts, finishedProducts } = getTobaccoProductStats();
            return {
                leanTob: 'on',
                tobHQ: off.size,
                tobAdv: c.getHireAdVertCount(DIV_TOBACCO),
                tobCities: cityCount,
                tobProd: (activeProducts > 0 ? activeProgress : highestProgress).toFixed(0),
                tobDone: finishedProducts,
                ...getTobaccoFlowStats(),
                ...getTobaccoExportRouteStats(),
            };
        } catch {
            return { leanTob: 'on' };
        }
    }

    function supportCities() {
        return CITIES.filter((city) => city !== HQ_CITY);
    }

    function getRound2AgriOfficeTarget() {
        return (opts['classic-round2'] || useBn3Round2()) ? ROUND2_CLASSIC_AGRI_OFFICE : ROUND2_AGRI_OFFICE;
    }

    function getRound2AgriWarehouseTarget() {
        return (opts['classic-round2'] || useBn3Round2()) ? ROUND2_CLASSIC_AGRI_WAREHOUSE : ROUND2_AGRI_WAREHOUSE;
    }

    function getRound2AgriAdvertTarget() {
        return opts['classic-round2'] ? ROUND1_ADVERT_TARGET : ROUND2_AGRI_ADVERT;
    }

    function getRound2AgriJobs(size) {
        if (opts['classic-round2'] || useBn3Round2()) {
            if (size >= ROUND2_CLASSIC_AGRI_OFFICE) return ROUND2_CLASSIC_AGRI_JOBS;
            if (size >= 8) return ROUND2_CLASSIC_AGRI_MID_JOBS;
            if (size <= 4) return ROUND2_AGRI_PRODUCTION_JOBS;
        }
        return size >= ROUND2_AGRI_OFFICE ? ROUND2_AGRI_JOBS : ROUND2_AGRI_SMALL_JOBS;
    }

    function getRound2AgriPostfillSalesJobs(size) {
        if (size >= ROUND2_CLASSIC_AGRI_OFFICE) return ROUND2_CLASSIC_AGRI_POSTFILL_SALES_JOBS;
        if (size >= 8) return ROUND2_CLASSIC_AGRI_POSTFILL_SALES_MID_JOBS;
        return getRound2AgriJobs(size);
    }

    function getBn3AgriPressureReliefJobs(size) {
        if (size >= ROUND2_CLASSIC_AGRI_OFFICE) return { ops: 2, eng: 2, biz: 2, mgmt: 2, rnd: Math.max(0, size - 8) };
        if (size >= 8) return { ops: 2, eng: 2, biz: 2, mgmt: 1, rnd: Math.max(0, size - 7) };
        return getRound2AgriJobs(size);
    }

    function getBn3AgriPostfillReliefJobs(size) {
        if (size >= ROUND2_CLASSIC_AGRI_OFFICE) return { ops: 1, eng: 1, biz: 4, mgmt: 3 };
        if (size >= 8) return { ops: 1, eng: 1, biz: 4, mgmt: 2 };
        if (size <= 4) return { ops: 1, biz: 2, mgmt: 1 };
        return { ops: 1, eng: 1, biz: 2, mgmt: 1, rnd: Math.max(0, size - 5) };
    }

    function shouldUseBn3AgriPressureRelief(city) {
        if (!useBn3Round2()) return false;
        if (isBn3Round2MaterialFilled()) return false;
        try {
            const wh = c.getWarehouse(DIV_AGRI, city);
            const usage = Number(wh.size ?? 0) > 0 ? Number(wh.sizeUsed ?? 0) / Number(wh.size ?? 1) : 0;
            if (usage >= 0.95) return true;
            const food = c.getMaterial(DIV_AGRI, city, 'Food');
            const plants = c.getMaterial(DIV_AGRI, city, 'Plants');
            const stored = Number(food.stored ?? 0) + Number(plants.stored ?? 0);
            const actualSell = Number(food.actualSellAmount ?? 0) + Number(plants.actualSellAmount ?? 0);
            return usage >= 0.85 && stored > 25 && actualSell <= 0;
        } catch {
            return false;
        }
    }

    function shouldUseBn3AgriPostfillRelief(city) {
        if (!useBn3Round2()) return false;
        if (!isBn3Round2MaterialFilled()) return false;
        try {
            const wh = c.getWarehouse(DIV_AGRI, city);
            const usage = Number(wh.size ?? 0) > 0 ? Number(wh.sizeUsed ?? 0) / Number(wh.size ?? 1) : 0;
            const food = c.getMaterial(DIV_AGRI, city, 'Food');
            const plants = c.getMaterial(DIV_AGRI, city, 'Plants');
            const stored = Number(food.stored ?? 0) + Number(plants.stored ?? 0);
            const production = Math.max(0, Number(food.productionAmount ?? 0)) + Math.max(0, Number(plants.productionAmount ?? 0));
            const actualSell = Math.max(0, Number(food.actualSellAmount ?? 0)) + Math.max(0, Number(plants.actualSellAmount ?? 0));
            if (usage >= 0.95) return true;
            return usage >= 0.80 &&
                stored > Math.max(250, production * 5) &&
                actualSell < production * 0.97;
        } catch {
            return false;
        }
    }

    function getBn3PostfillSalesMode() {
        if (!useBn3PostfillSales()) return 'off';
        if (!isBn3Round2MaterialFilled()) return 'armed';
        return 'balanced';
    }

    function getRound2AgriProductionJobs(size) {
        if (size <= 4) return ROUND2_AGRI_PRODUCTION_JOBS;
        if (size < ROUND2_AGRI_OFFICE) return { ops: 2, eng: 2, biz: 1, mgmt: 1, rnd: Math.max(0, size - 6) };
        return { ops: 2, eng: 3, biz: 1, mgmt: 1, rnd: Math.max(0, size - 7) };
    }

    function getRound2TobaccoHQTargetSize() {
        if (useBn3LeanTobRound2()) return ROUND2_BN3_LEAN_TOB_HQ_OFFICE;
        return opts['aggressive-round2'] ? ROUND2_TOB_HQ_OFFICE_AGGR : ROUND2_TOB_HQ_OFFICE;
    }

    function getRound2TobaccoHQProgressJobs(size) {
        if (useBn3LeanTobRound2()) {
            // During product development Business does not speed progress, so lean
            // BN3 pushes that slot into Engineer/Management and adds Business back
            // once products are finished.
            if (size <= 6) return { ops: 1, eng: Math.max(1, size - 3), mgmt: 2 };
            if (size <= 9) return { ops: 2, eng: Math.max(1, size - 5), mgmt: 3 };
            if (size <= 15) return { ops: 3, eng: Math.max(1, size - 7), mgmt: 4 };
            return { ops: 4, eng: Math.max(1, size - 9), mgmt: 5 };
        }
        if (size <= 6) return { ops: 1, eng: Math.max(1, size - 2), mgmt: 1 };
        if (size <= 9) return { ops: 2, eng: Math.max(1, size - 4), mgmt: 2 };
        if (size <= 15) return { ops: 3, eng: Math.max(1, size - 7), mgmt: 4 };
        return { ops: 4, eng: Math.max(1, size - 9), mgmt: 5 };
    }

    function getRound2TobaccoHQJobs(size) {
        if (hasActiveTobaccoDevelopment()) return getRound2TobaccoHQProgressJobs(size);
        if (opts['aggressive-round2'] && size >= ROUND2_TOB_HQ_OFFICE_AGGR) return ROUND2_TOB_HQ_JOBS_AGGR;
        return getRound2TobaccoHQCompletedJobs(size);
    }

    function getRound2TobaccoSupportTargetSize() {
        if (useBn3LeanTobRound2()) {
            const { finishedProducts } = getTobaccoProductStats();
            return finishedProducts > 0 ? ROUND2_BN3_LEAN_TOB_SUPPORT_OFFICE_POSTDONE : 3;
        }
        return opts['aggressive-round2'] ? ROUND2_TOB_SUPPORT_OFFICE_AGGR : ROUND2_TOB_SUPPORT_OFFICE;
    }

    function getRound2TobaccoSupportJobs() {
        if (useBn3LeanTobRound2()) {
            const { finishedProducts } = getTobaccoProductStats();
            return finishedProducts > 0 ? ROUND2_BN3_LEAN_TOB_SUPPORT_JOBS_POSTDONE : { biz: 1, rnd: 2 };
        }
        return opts['aggressive-round2'] ? ROUND2_TOB_SUPPORT_JOBS_AGGR : ROUND2_TOB_SUPPORT_JOBS;
    }

    function getRound2ChemTargetOffice() {
        return opts['aggressive-round2'] ? ROUND2_CHEM_OFFICE_AGGR : ROUND2_CHEM_OFFICE;
    }

    function getRound2ChemJobs(size = getRound2ChemTargetOffice()) {
        if (opts['aggressive-round2']) {
            if (size <= 3) return ROUND2_CHEM_JOBS_SMALL;
            if (size < ROUND2_CHEM_OFFICE_AGGR) return ROUND2_CHEM_JOBS_MID;
            return ROUND2_CHEM_JOBS_AGGR;
        }
        return size <= 3 ? ROUND2_CHEM_JOBS : { ops: 1, eng: 1, rnd: Math.max(1, size - 2) };
    }

    function shouldPreserveAggressiveRound2(bestOffer, rpGateCleared, stagnantChecks) {
        if (!opts['aggressive-round2']) return false;
        const { highestProgress, finishedProducts } = getTobaccoProductStats();
        return !rpGateCleared &&
            finishedProducts === 0 &&
            highestProgress >= ROUND2_AGGR_FREEZE_PROGRESS &&
            bestOffer >= ROUND2_AGGR_WARMUP_TARGET &&
            stagnantChecks < ROUND2_AGGR_WARMUP_STAGNATION;
    }

    function maintainRound2DivisionState(preserveOffer = false) {
        if (hasDiv(DIV_AGRI)) {
            const bn3PostfillSalesMode = getBn3PostfillSalesMode();
            for (const city of CITIES) {
                try {
                    c.sellMaterial(DIV_AGRI, city, 'Food', 'MAX', 'MP');
                    c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP');
                    const office = c.getOffice(DIV_AGRI, city);
                    const pressureRelief = !preserveOffer && bn3PostfillSalesMode === 'armed' && shouldUseBn3AgriPressureRelief(city);
                    const postfillRelief = !preserveOffer && bn3PostfillSalesMode === 'balanced' && shouldUseBn3AgriPostfillRelief(city);
                    const agriJobs = preserveOffer
                        ? getRound2AgriProductionJobs(office.size)
                        : pressureRelief
                                ? getBn3AgriPressureReliefJobs(office.size)
                        : postfillRelief
                                ? getBn3AgriPostfillReliefJobs(office.size)
                        : bn3PostfillSalesMode === 'balanced'
                                ? getRound2AgriPostfillSalesJobs(office.size)
                                : getRound2AgriJobs(office.size);
                    fillOffice(
                        DIV_AGRI,
                        city,
                        office.size,
                        agriJobs,
                    );
                } catch { }
            }
        }

        if (hasDiv(DIV_CHEM)) {
            for (const city of c.getDivision(DIV_CHEM).cities) {
                try {
                    const office = c.getOffice(DIV_CHEM, city);
                    fillOffice(DIV_CHEM, city, office.size, getRound2ChemJobs(office.size));
                    if (c.hasWarehouse(DIV_CHEM, city)) c.sellMaterial(DIV_CHEM, city, 'Chemicals', 'MAX', 'MP');
                } catch { }
            }
        }

        if (hasDiv(DIV_TOBACCO)) {
            for (const city of c.getDivision(DIV_TOBACCO).cities) {
                try {
                    if (city !== HQ_CITY && !c.hasWarehouse(DIV_TOBACCO, city)) continue;
                    const office = c.getOffice(DIV_TOBACCO, city);
                    const jobs = city === HQ_CITY ? getRound2TobaccoHQJobs(office.size) : getRound2TobaccoSupportJobs();
                    fillOffice(DIV_TOBACCO, city, office.size, jobs);
                } catch { }
            }
        }
    }

    function tryRound2AgriStep(reserve, allowOfficeGrowth = false) {
        const targetWarehouse = getRound2AgriWarehouseTarget();
        const targetAdvert = getRound2AgriAdvertTarget();
        const targetOffice = getRound2AgriOfficeTarget();
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                if (wh.level < targetWarehouse) {
                    const spendCost = estimateWarehouseUpgradeSpend(DIV_AGRI, city);
                    if (canSpend(spendCost, reserve)) {
                        c.upgradeWarehouse(DIV_AGRI, city, 1);
                        return `Agriculture ${city} warehouse -> ${wh.level + 1}`;
                    }
                }
            } catch { }
        }
        try {
            if (c.getHireAdVertCount(DIV_AGRI) < targetAdvert) {
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
                if (off.size < targetOffice) {
                    const increase = targetOffice - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_AGRI, city, increase);
                    if (canSpend(cost, reserve)) {
                        fillOffice(DIV_AGRI, city, targetOffice, getRound2AgriJobs(targetOffice));
                        return `Agriculture ${city} office -> ${targetOffice}`;
                    }
                }
            } catch { }
        }
        return null;
    }

    function isRound2AgriBuiltOut() {
        try {
            if (c.getHireAdVertCount(DIV_AGRI) < getRound2AgriAdvertTarget()) return false;
        } catch { return false; }
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                const off = c.getOffice(DIV_AGRI, city);
                if (wh.level < getRound2AgriWarehouseTarget()) return false;
                if (off.size < getRound2AgriOfficeTarget()) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    function tryRound2UpgradeStep(reserve, target = ROUND2_GLOBAL_UPGRADE_TARGET) {
        for (const upg of ['Smart Factories', 'Smart Storage']) {
            try {
                if (c.getUpgradeLevel(upg) >= target) continue;
                const cost = c.getUpgradeLevelCost(upg);
                const spendCost = upg === 'Smart Storage' ? estimateSmartStorageUpgradeSpend() : cost;
                if (!canSpend(spendCost, reserve)) continue;
                c.levelUpgrade(upg);
                return `${upg} -> ${c.getUpgradeLevel(upg)}`;
            } catch { }
        }
        return null;
    }

    function tryRound2LateAgriStep(reserve) {
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                if (wh.level < ROUND2_AGRI_WAREHOUSE_LATE) {
                    const spendCost = estimateWarehouseUpgradeSpend(DIV_AGRI, city);
                    if (canSpend(spendCost, reserve)) {
                        c.upgradeWarehouse(DIV_AGRI, city, 1);
                        return `Agriculture ${city} warehouse -> ${wh.level + 1}`;
                    }
                }
            } catch { }
        }
        return null;
    }

    function tryRound2ChemStep(reserve, maxSupportCities = supportCities().length) {
        if (!hasDiv(DIV_CHEM)) return null;
        const chemTargetOffice = getRound2ChemTargetOffice();
        const chemJobs = getRound2ChemJobs(chemTargetOffice);
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
                    fillOffice(DIV_CHEM, city, chemTargetOffice, getRound2ChemJobs(off.size));
                    return `Chemical staffed in ${city}`;
                }
                if (off.size < chemTargetOffice) {
                    const increase = chemTargetOffice - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_CHEM, city, increase);
                    if (canSpend(cost, reserve)) {
                        fillOffice(DIV_CHEM, city, chemTargetOffice, chemJobs);
                        return `Chemical ${city} office -> ${chemTargetOffice}`;
                    }
                }
                assignJobs(DIV_CHEM, city, getRound2ChemJobs(off.size));
                try { c.sellMaterial(DIV_CHEM, city, 'Chemicals', 'MAX', 'MP'); } catch { }
            } catch { }
        }
        try {
            const hqOffice = c.getOffice(DIV_CHEM, HQ_CITY);
            tryFillOffice(DIV_CHEM, HQ_CITY, chemTargetOffice, getRound2ChemJobs(Math.max(hqOffice.size, chemTargetOffice)));
        } catch {
            tryFillOffice(DIV_CHEM, HQ_CITY, chemTargetOffice, chemJobs);
        }
        try { c.sellMaterial(DIV_CHEM, HQ_CITY, 'Chemicals', 'MAX', 'MP'); } catch { }
        return null;
    }

    function tryRound2TobaccoStep(reserve, allowSupportCities = false, allowAdvert = true) {
        if (!hasDiv(DIV_TOBACCO)) return null;
        const tobHQTarget = getRound2TobaccoHQTargetSize();
        const tobHQJobs = getRound2TobaccoHQJobs(tobHQTarget);
        const tobSupportTarget = getRound2TobaccoSupportTargetSize();
        const tobSupportJobs = getRound2TobaccoSupportJobs();
        const targetAdvert = useBn3LeanTobRound2() ? ROUND2_BN3_LEAN_TOB_ADVERT : ROUND2_TOB_ADVERT;
        const supportExpandCost = useBn3LeanTobRound2() ? 4e9 : 9e9;
        try {
            const off = c.getOffice(DIV_TOBACCO, HQ_CITY);
            if (off.size < tobHQTarget) {
                const increase = tobHQTarget - off.size;
                const cost = c.getOfficeSizeUpgradeCost(DIV_TOBACCO, HQ_CITY, increase);
                if (canSpend(cost, reserve)) {
                    fillOffice(DIV_TOBACCO, HQ_CITY, tobHQTarget, tobHQJobs);
                    return `Tobacco HQ office -> ${tobHQTarget}`;
                }
            } else {
                assignJobs(DIV_TOBACCO, HQ_CITY, getRound2TobaccoHQJobs(off.size));
            }
        } catch { }
        if (allowAdvert) {
            try {
                if (c.getHireAdVertCount(DIV_TOBACCO) < targetAdvert) {
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
                    if (canSpend(supportExpandCost, reserve)) {
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
                if (off.size < tobSupportTarget) {
                    const increase = tobSupportTarget - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_TOBACCO, city, increase);
                    if (canSpend(cost, reserve)) {
                        fillOffice(DIV_TOBACCO, city, tobSupportTarget, tobSupportJobs);
                        return `Tobacco ${city} office -> ${tobSupportTarget}`;
                    }
                    continue;
                }
                if (off.numEmployees < off.size) {
                    fillOffice(DIV_TOBACCO, city, tobSupportTarget, tobSupportJobs);
                    return `Tobacco staffed in ${city}`;
                }
                assignJobs(DIV_TOBACCO, city, tobSupportJobs);
            } catch { }
        }
        return null;
    }

    function tryBn3LeanTobaccoStep(reserve, bestOffer = 0, stagnantChecks = 0) {
        if (!useBn3LeanTobRound2() || !hasDiv(DIV_TOBACCO)) return null;
        const { finishedProducts } = getTobaccoProductStats();
        const postDonePush =
            finishedProducts > 0 &&
            bestOffer < ROUND2_BN3_SOFT_ACCEPT;
        const speedHQPush =
            bestOffer < ROUND2_BN3_SOFT_ACCEPT &&
            (bestOffer >= ROUND2_BN3_LEAN_TOB_SPEED_HQ_TRIGGER ||
                stagnantChecks >= ROUND2_BN3_LEAN_TOB_SPEED_HQ_STAGNATION);
        const prefillHQPush =
            bestOffer >= ROUND2_BN3_LEAN_TOB_PREFILL_HQ_TRIGGER ||
            stagnantChecks >= ROUND2_BN3_LEAN_TOB_PREFILL_HQ_STAGNATION;
        const targetOffice = postDonePush
            ? ROUND2_BN3_LEAN_TOB_POSTDONE_HQ_OFFICE
            : speedHQPush
                ? ROUND2_BN3_LEAN_TOB_SPEED_HQ_OFFICE
                : prefillHQPush
                    ? ROUND2_BN3_LEAN_TOB_HQ_PUSH_OFFICE
                    : ROUND2_BN3_LEAN_TOB_HQ_OFFICE;
        const targetAdvert = postDonePush
            ? ROUND2_BN3_LEAN_TOB_POSTDONE_ADVERT
            : finishedProducts > 0 && (speedHQPush || prefillHQPush)
                ? ROUND2_BN3_LEAN_TOB_HQ_PUSH_ADVERT
                : ROUND2_BN3_LEAN_TOB_ADVERT;
        const officeFloor = postDonePush
            ? ROUND2_BN3_LEAN_TOB_POSTDONE_HQ_MIN_CASH
            : speedHQPush
                ? reserve + ROUND2_BN3_LEAN_TOB_SPEED_HQ_BUFFER
                : prefillHQPush
                    ? reserve + ROUND2_BN3_LEAN_TOB_PREFILL_HQ_BUFFER
                    : reserve;
        const advertFloor = postDonePush
            ? ROUND2_BN3_LEAN_TOB_POSTDONE_ADVERT_MIN_CASH
            : speedHQPush
                ? reserve + ROUND2_BN3_LEAN_TOB_SPEED_ADVERT_BUFFER
                : prefillHQPush
                    ? reserve + ROUND2_BN3_LEAN_TOB_PREFILL_ADVERT_BUFFER
                    : reserve;
        try {
            const off = c.getOffice(DIV_TOBACCO, HQ_CITY);
            if (off.size < targetOffice) {
                const increase = targetOffice - off.size;
                const cost = c.getOfficeSizeUpgradeCost(DIV_TOBACCO, HQ_CITY, increase);
                if (canSpend(cost, officeFloor)) {
                    fillOffice(DIV_TOBACCO, HQ_CITY, targetOffice, getRound2TobaccoHQJobs(targetOffice));
                    return `Tobacco HQ office -> ${targetOffice}`;
                }
            }
            if (off.numEmployees < off.size) {
                fillOffice(DIV_TOBACCO, HQ_CITY, off.size, getRound2TobaccoHQJobs(off.size));
                return 'Tobacco HQ staffed';
            }
            assignJobs(DIV_TOBACCO, HQ_CITY, getRound2TobaccoHQJobs(off.size));
        } catch { }
        try {
            if (c.getHireAdVertCount(DIV_TOBACCO) < targetAdvert) {
                const cost = c.getHireAdVertCost(DIV_TOBACCO);
                if (canSpend(cost, advertFloor)) {
                    c.hireAdVert(DIV_TOBACCO);
                    return `Tobacco advert -> ${c.getHireAdVertCount(DIV_TOBACCO)}`;
                }
            }
        } catch { }
        return null;
    }

    function tryBn3LeanTobaccoEarlySupportStep(reserve, bestOffer, stagnantChecks) {
        if (!useBn3LeanTobRound2() || !hasDiv(DIV_TOBACCO)) return null;
        const { finishedProducts } = getTobaccoProductStats();
        if (finishedProducts <= 0) return null;
        if (bestOffer >= ROUND2_BN3_SOFT_ACCEPT) return null;
        if (bestOffer < ROUND2_BN3_LEAN_TOB_EARLY_SUPPORT_TRIGGER &&
            stagnantChecks < ROUND2_BN3_LEAN_TOB_EARLY_SUPPORT_STAGNATION) return null;
        try {
            if (c.getDivision(DIV_TOBACCO).cities.length > 1) return null;
        } catch {
            return null;
        }
        return tryRound2TobaccoStep(ROUND2_BN3_LEAN_TOB_EARLY_SUPPORT_MIN_CASH, true, false);
    }

    function tryAggressiveWarmupHQStep(reserve) {
        if (hasDiv(DIV_TOBACCO)) {
            try {
                const off = c.getOffice(DIV_TOBACCO, HQ_CITY);
                if (off.size < ROUND2_AGGR_TOB_HQ_WARMUP) {
                    const increase = ROUND2_AGGR_TOB_HQ_WARMUP - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_TOBACCO, HQ_CITY, increase);
                    if (canSpend(cost, reserve)) {
                        fillOffice(DIV_TOBACCO, HQ_CITY, ROUND2_AGGR_TOB_HQ_WARMUP, ROUND2_AGGR_TOB_HQ_WARMUP_JOBS);
                        return `Tobacco HQ office -> ${ROUND2_AGGR_TOB_HQ_WARMUP}`;
                    }
                }
            } catch { }
        }
        if (hasDiv(DIV_CHEM)) {
            try {
                const off = c.getOffice(DIV_CHEM, HQ_CITY);
                if (off.size < ROUND2_AGGR_CHEM_HQ_WARMUP) {
                    const increase = ROUND2_AGGR_CHEM_HQ_WARMUP - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_CHEM, HQ_CITY, increase);
                    if (canSpend(cost, reserve)) {
                        fillOffice(DIV_CHEM, HQ_CITY, ROUND2_AGGR_CHEM_HQ_WARMUP, getRound2ChemJobs(ROUND2_AGGR_CHEM_HQ_WARMUP));
                        return `Chemical HQ office -> ${ROUND2_AGGR_CHEM_HQ_WARMUP}`;
                    }
                }
            } catch { }
        }
        return null;
    }

    function tryBn3LeanTobaccoSupportStep(reserve, bestOffer, materialFilled, stagnantChecks) {
        if (!useBn3LeanTobSupport() || !useBn3LeanTobRound2() || !hasDiv(DIV_TOBACCO)) return null;
        if (!materialFilled) return null;
        if (bestOffer < ROUND2_BN3_LEAN_TOB_SUPPORT_TRIGGER && stagnantChecks < ROUND2_BN3_LEAN_TOB_SUPPORT_STAGNATION) return null;
        return tryRound2TobaccoStep(reserve, true, false);
    }

    function tryBn3LeanTobaccoHQPushStep(reserve, bestOffer, materialFilled, stagnantChecks) {
        if (!useBn3LeanTobHQPush() || !useBn3LeanTobRound2() || !hasDiv(DIV_TOBACCO)) return null;
        if (!materialFilled) return null;
        if (bestOffer < ROUND2_BN3_LEAN_TOB_HQ_PUSH_TRIGGER && stagnantChecks < ROUND2_BN3_LEAN_TOB_HQ_PUSH_STAGNATION) return null;
        const officeFloor = reserve + ROUND2_BN3_LEAN_TOB_HQ_PUSH_BUFFER;
        try {
            const off = c.getOffice(DIV_TOBACCO, HQ_CITY);
            if (off.size < ROUND2_BN3_LEAN_TOB_HQ_PUSH_OFFICE) {
                const increase = ROUND2_BN3_LEAN_TOB_HQ_PUSH_OFFICE - off.size;
                const cost = c.getOfficeSizeUpgradeCost(DIV_TOBACCO, HQ_CITY, increase);
                if (canSpend(cost, officeFloor)) {
                    fillOffice(
                        DIV_TOBACCO,
                        HQ_CITY,
                        ROUND2_BN3_LEAN_TOB_HQ_PUSH_OFFICE,
                        getRound2TobaccoHQJobs(ROUND2_BN3_LEAN_TOB_HQ_PUSH_OFFICE),
                    );
                    return `Tobacco HQ office -> ${ROUND2_BN3_LEAN_TOB_HQ_PUSH_OFFICE}`;
                }
                return null;
            }
            if (off.numEmployees < off.size) {
                fillOffice(DIV_TOBACCO, HQ_CITY, off.size, getRound2TobaccoHQJobs(off.size));
                return 'Tobacco HQ staffed';
            }
        } catch { }
        try {
            if (c.getHireAdVertCount(DIV_TOBACCO) < ROUND2_BN3_LEAN_TOB_HQ_PUSH_ADVERT) {
                const cost = c.getHireAdVertCost(DIV_TOBACCO);
                const advertFloor = reserve + ROUND2_BN3_LEAN_TOB_HQ_PUSH_ADVERT_BUFFER;
                if (canSpend(cost, advertFloor)) {
                    c.hireAdVert(DIV_TOBACCO);
                    return `Tobacco advert -> ${c.getHireAdVertCount(DIV_TOBACCO)}`;
                }
            }
        } catch { }
        return null;
    }

    function tryRound2DummyStep(bestOffer, stagnantChecks, reserve, allowEarly = false) {
        if (!allowEarly && (bestOffer < ROUND2_DUMMY_TRIGGER || stagnantChecks < ROUND2_DUMMY_STAGNATION_LIMIT)) return null;
        const cityCost = supportCities().length * 9e9;
        const warehouseCost = CITIES.length * 5e9;
        const dummyCost = expandIndustryCost('Restaurant') + cityCost + warehouseCost;
        const floor = opts['aggressive-round2'] ? Math.max(15e9, reserve * 0.35) : Math.max(25e9, reserve * 0.5);
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

    function getBn3Round2Reserve() {
        const funds = c.getCorporation().funds;
        return Math.max(ROUND2_BN3_RESERVE, funds * ROUND2_BN3_RESERVE_PCT);
    }

    function estimateBn3RemainingMaterialSpend() {
        let total = 0;
        const targets = getBn3MaterialTargets();
        for (const city of CITIES) {
            total += estimateMaterialTargetSpend(DIV_AGRI, city, targets);
        }
        return total;
    }

    function getBn3DummySpendFloor(reserve) {
        return Math.max(reserve, reserve + estimateBn3RemainingMaterialSpend() + ROUND2_BN3_DUMMY_BUFFER);
    }

    function isBn3LateValuationSpendReady(bestOffer, materialFilled, stagnantChecks) {
        if (!useBn3LeanTobRound2() || !hasDiv(DIV_TOBACCO)) return false;
        if (materialFilled) return true;
        return bestOffer >= ROUND2_BN3_LATE_VALUATION_TRIGGER &&
            stagnantChecks >= ROUND2_BN3_LATE_VALUATION_STAGNATION;
    }

    function isBn3LateThroughputReady() {
        if (!useBn3LeanTobRound2() || !hasDiv(DIV_TOBACCO)) return false;
        try {
            if (c.getDivision(DIV_TOBACCO).cities.length < CITIES.length) return false;
            if (c.getUpgradeLevel('Smart Storage') < ROUND2_BN3_LATE_POSTFILL_SMART_STORAGE_TARGET) return false;
            if (c.getUpgradeLevel('ABC SalesBots') < ROUND2_BN3_LATE_SALESBOT_TARGET) return false;
            return true;
        } catch {
            return false;
        }
    }

    function getBn3LateTobaccoAdvertTarget(bestOffer, stagnantChecks) {
        if (!isBn3LateThroughputReady()) return ROUND2_BN3_LATE_TOB_ADVERT_TARGET;
        const version = getHighestTobaccoProductVersion();
        let target = ROUND2_BN3_LATE_TOB_ADVERT_TARGET;
        if (version >= 5 &&
            (bestOffer >= ROUND2_BN3_LATE_TOB_ADVERT4_TRIGGER ||
                stagnantChecks >= ROUND2_BN3_LATE_TOB_ADVERT4_STAGNATION)) {
            target = 4;
        }
        if (version >= 6 &&
            (bestOffer >= ROUND2_BN3_LATE_TOB_ADVERT5_TRIGGER ||
                stagnantChecks >= ROUND2_BN3_LATE_TOB_ADVERT5_STAGNATION)) {
            target = 5;
        }
        if (version >= 7 &&
            (bestOffer >= ROUND2_BN3_LATE_TOB_ADVERT6_TRIGGER ||
                stagnantChecks >= ROUND2_BN3_LATE_TOB_ADVERT6_STAGNATION)) {
            target = 6;
        }
        return target;
    }

    function isBn3Round2OfficeBuiltOut() {
        for (const city of CITIES) {
            try {
                const off = c.getOffice(DIV_AGRI, city);
                if (off.size < ROUND2_CLASSIC_AGRI_OFFICE || off.numEmployees < off.size) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    function isBn3Round2UpgradeBuiltOut() {
        return ['Smart Factories', 'Smart Storage'].every((upg) => {
            try { return c.getUpgradeLevel(upg) >= ROUND2_BN3_SMART_TARGET; }
            catch { return false; }
        });
    }

    function isBn3Round2WarehouseBuiltOut() {
        for (const city of CITIES) {
            try {
                if (c.getWarehouse(DIV_AGRI, city).level < ROUND2_CLASSIC_AGRI_WAREHOUSE) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    function isBn3Round2MaterialFilled() {
        const targets = getBn3MaterialTargets();
        for (const city of CITIES) {
            try {
                for (const [mat, target] of Object.entries(targets)) {
                    if ((c.getMaterial(DIV_AGRI, city, mat).stored ?? 0) + 0.5 < target) return false;
                }
            } catch {
                return false;
            }
        }
        return true;
    }

    function isBn3PragmaticAcceptReady() {
        if (!useBn3Round2() || !useBn3LeanTobRound2()) return false;
        if (!isBn3Round2MaterialFilled()) return false;
        if (!isBn3LateThroughputReady()) return false;
        if (getHighestTobaccoProductVersion() < 5) return false;
        try {
            if (c.getUpgradeLevel('Wilson Analytics') < ROUND2_BN3_LATE_WILSON_TARGET) return false;
            if (c.getHireAdVertCount(DIV_TOBACCO) < ROUND2_BN3_LATE_TOB_ADVERT_TARGET) return false;
        } catch {
            return false;
        }
        return true;
    }

    function getBn3Round2AcceptReason(offerFunds, bestOffer, stagnantChecks) {
        if (!useBn3SoftAccept()) return null;
        if (!useBn3Round2()) return null;
        if (!isBn3Round2MaterialFilled()) return null;
        if (bestOffer >= ROUND2_BN3_SOFT_ACCEPT) {
            if (
                stagnantChecks >= ROUND2_BN3_ACCEPT_NEAR_BEST_STAGNATION &&
                offerFunds >= bestOffer * ROUND2_BN3_ACCEPT_NEAR_BEST_RATIO
            ) {
                return 'soft peak';
            }
            if (
                stagnantChecks >= ROUND2_BN3_ACCEPT_DECAY_STAGNATION &&
                offerFunds >= bestOffer * ROUND2_BN3_ACCEPT_DECAY_RATIO
            ) {
                return 'soft decay';
            }
        }
        if (!isBn3PragmaticAcceptReady()) return null;
        if (
            bestOffer >= ROUND2_BN3_PRAGMATIC_ACCEPT &&
            stagnantChecks >= ROUND2_BN3_PRAGMATIC_ACCEPT_NEAR_BEST_STAGNATION &&
            offerFunds >= bestOffer * ROUND2_BN3_PRAGMATIC_ACCEPT_NEAR_BEST_RATIO
        ) {
            return 'pragmatic plateau';
        }
        if (
            bestOffer >= ROUND2_BN3_PRAGMATIC_ACCEPT_FLOOR &&
            stagnantChecks >= ROUND2_BN3_PRAGMATIC_ACCEPT_DECAY_STAGNATION &&
            offerFunds >= bestOffer * ROUND2_BN3_PRAGMATIC_ACCEPT_DECAY_RATIO
        ) {
            return 'pragmatic fallback';
        }
        return null;
    }

    function tryBn3Round2OfficeStep(reserve) {
        for (const city of CITIES) {
            try {
                const off = c.getOffice(DIV_AGRI, city);
                if (off.size < ROUND2_CLASSIC_AGRI_OFFICE) {
                    const increase = ROUND2_CLASSIC_AGRI_OFFICE - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_AGRI, city, increase);
                    if (canSpend(cost, reserve)) {
                        fillOffice(DIV_AGRI, city, ROUND2_CLASSIC_AGRI_OFFICE, ROUND2_CLASSIC_AGRI_JOBS);
                        return `Agriculture ${city} office -> ${ROUND2_CLASSIC_AGRI_OFFICE}`;
                    }
                }
                if (off.numEmployees < off.size) {
                    fillOffice(DIV_AGRI, city, off.size, ROUND2_CLASSIC_AGRI_JOBS);
                    return `Agriculture staffed in ${city}`;
                }
            } catch { }
        }
        return null;
    }

    function tryBn3Round2UpgradeStep(reserve) {
        for (const upg of ['Smart Factories', 'Smart Storage']) {
            try {
                if (c.getUpgradeLevel(upg) >= ROUND2_BN3_SMART_TARGET) continue;
                const cost = c.getUpgradeLevelCost(upg);
                if (canSpend(cost, reserve)) {
                    c.levelUpgrade(upg);
                    return `${upg} -> ${c.getUpgradeLevel(upg)}`;
                }
            } catch { }
        }
        return null;
    }

    function tryBn3Round2WarehouseStep(reserve) {
        const candidates = [];
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                if (wh.level < ROUND2_CLASSIC_AGRI_WAREHOUSE) candidates.push({ city, level: wh.level });
            } catch { }
        }
        candidates.sort((a, b) => a.level - b.level || a.city.localeCompare(b.city));
        for (const { city } of candidates) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                const cost = c.getUpgradeWarehouseCost(DIV_AGRI, city, 1);
                if (canSpend(cost, reserve)) {
                    c.upgradeWarehouse(DIV_AGRI, city, 1);
                    return `Agriculture ${city} warehouse -> ${wh.level + 1}`;
                }
            } catch { }
        }
        return null;
    }

    async function tryBn3Round2MaterialStep(reserve) {
        const targets = getBn3MaterialTargets();
        for (const city of CITIES) {
            try {
                let needsFill = false;
                for (const [mat, target] of Object.entries(targets)) {
                    if ((c.getMaterial(DIV_AGRI, city, mat).stored ?? 0) + 0.5 < target) {
                        needsFill = true;
                        break;
                    }
                }
                if (!needsFill) continue;

                const cost = estimateMaterialTargetSpend(DIV_AGRI, city, targets);
                if (!canSpend(cost, reserve)) continue;

                stopRound1AgriSupply([city]);
                stopChemicalWaterSupply([city]);
                for (const [mat, target] of Object.entries(targets)) {
                    const stored = c.getMaterial(DIV_AGRI, city, mat).stored ?? 0;
                    const needed = Math.max(0, target - stored);
                    if (needed > 0.5) c.buyMaterial(DIV_AGRI, city, mat, needed / CYCLE_SECS);
                }
                try {
                    await waitCycles(1);
                } finally {
                    for (const mat of Object.keys(targets)) {
                        try { c.buyMaterial(DIV_AGRI, city, mat, 0); } catch { }
                    }
                    maintainPreRound2SupplyState([city]);
                }
                return `Agriculture ${city} materials -> ${useBn3HeadroomFill() ? 'BN3 headroom targets' : 'BN3 targets'}`;
            } catch { }
        }
        return null;
    }

    async function tryBn3Round2RealEstatePush(reserve) {
        const reSize = AGRI_SIZES[AGRI_MATS.indexOf('Real Estate')];
        if (!Number.isFinite(reSize) || reSize <= 0) return null;

        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                const targetUsage = wh.size * ROUND2_BN3_RE_PUSH_USAGE_PCT;
                const freeHeadroom = Math.max(0, targetUsage - wh.sizeUsed);
                if (freeHeadroom < reSize) continue;

                const price = getMaterialBuyPrice(DIV_AGRI, city, 'Real Estate');
                if (!Number.isFinite(price) || price <= 0) continue;

                const budget = Math.max(0, c.getCorporation().funds - reserve);
                const affordable = Math.floor(budget / price);
                const spaceLimited = Math.floor(freeHeadroom / reSize);
                const needed = Math.min(affordable, spaceLimited);
                if (!Number.isFinite(needed) || needed <= 0) continue;
                if (needed * price < ROUND2_BN3_RE_PUSH_MIN_SPEND) continue;

                c.buyMaterial(DIV_AGRI, city, 'Real Estate', needed / CYCLE_SECS);
                try {
                    await waitCycles(1);
                } finally {
                    try { c.buyMaterial(DIV_AGRI, city, 'Real Estate', 0); } catch { }
                }
                return `Agriculture ${city} extra Real Estate push`;
            } catch { }
        }
        return null;
    }

    function tryBn3DummyExpansion(floor, maxDummies = ROUND2_BN3_DUMMY_MAX) {
        const officeCost = getCorpOfficeInitialCost();
        const warehouseCost = getCorpWarehouseInitialCost();

        for (let i = 1; i <= maxDummies; i++) {
            const dName = `Dummy-${i}`;
            const hasDivision = c.getCorporation().divisions.includes(dName);

            if (!hasDivision) {
                const startCost = expandIndustryCost('Restaurant');
                if (!canSpend(startCost, floor)) return null;
                try {
                    c.expandIndustry('Restaurant', dName);
                    return `${dName} launched`;
                } catch {
                    return null;
                }
            }

            let dummyCities = [];
            try { dummyCities = c.getDivision(dName).cities ?? []; } catch { return null; }

            for (const city of CITIES) {
                if (!dummyCities.includes(city)) continue;
                try {
                    if (!c.hasWarehouse(dName, city)) {
                        if (!canSpend(warehouseCost, floor)) continue;
                        c.purchaseWarehouse(dName, city);
                        return `${dName} warehouse in ${city}`;
                    }
                } catch { }
            }

            for (const city of supportCities()) {
                if (dummyCities.includes(city)) continue;
                if (!canSpend(officeCost, floor)) continue;
                try {
                    c.expandCity(dName, city);
                    try {
                        if (canSpend(warehouseCost, floor) && !c.hasWarehouse(dName, city)) {
                            c.purchaseWarehouse(dName, city);
                            return `${dName} ${city} office+warehouse`;
                        }
                    } catch { }
                    return `${dName} expanded to ${city}`;
                } catch { }
            }
        }

        return null;
    }

    function tryBn3Round2DummyStep(reserve, bestOffer, materialFilled) {
        if (!useBn3Round2Dummy()) return null;
        if (!materialFilled && bestOffer < ROUND2_BN3_DUMMY_TRIGGER) return null;
        return tryBn3DummyExpansion(getBn3DummySpendFloor(reserve));
    }

    function tryBn3LateWilsonStep(reserve, bestOffer, materialFilled, stagnantChecks) {
        if (!isBn3LateValuationSpendReady(bestOffer, materialFilled, stagnantChecks)) return null;
        try {
            const level = c.getUpgradeLevel('Wilson Analytics');
            if (level >= ROUND2_BN3_LATE_WILSON_TARGET) return null;
            const cost = c.getUpgradeLevelCost('Wilson Analytics');
            const floor = reserve + ROUND2_BN3_LATE_WILSON_BUFFER;
            if (!canSpend(cost, floor)) return null;
            c.levelUpgrade('Wilson Analytics');
            return `Wilson Analytics -> ${c.getUpgradeLevel('Wilson Analytics')}`;
        } catch {
            return null;
        }
    }

    function tryBn3LateTobaccoAdvertStep(reserve, bestOffer, materialFilled, stagnantChecks) {
        if (!isBn3LateValuationSpendReady(bestOffer, materialFilled, stagnantChecks)) return null;
        try {
            if (c.getUpgradeLevel('Wilson Analytics') < ROUND2_BN3_LATE_WILSON_TARGET) return null;
        } catch {
            return null;
        }
        try {
            const targetAdvert = getBn3LateTobaccoAdvertTarget(bestOffer, stagnantChecks);
            const adverts = c.getHireAdVertCount(DIV_TOBACCO);
            if (adverts >= targetAdvert) return null;
            const cost = c.getHireAdVertCost(DIV_TOBACCO);
            const productGuard = targetAdvert > ROUND2_BN3_LATE_TOB_ADVERT_TARGET
                ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_LATE
                : 0;
            const floor = reserve + ROUND2_BN3_LATE_TOB_ADVERT_BUFFER + productGuard;
            if (!canSpend(cost, floor)) return null;
            c.hireAdVert(DIV_TOBACCO);
            return `Tobacco advert -> ${c.getHireAdVertCount(DIV_TOBACCO)}`;
        } catch {
            return null;
        }
    }

    function tryBn3LateValuationDummyStep(reserve, bestOffer, materialFilled, stagnantChecks) {
        if (!isBn3LateValuationSpendReady(bestOffer, materialFilled, stagnantChecks)) return null;
        try {
            if (!isBn3LateThroughputReady()) return null;
            if (c.getUpgradeLevel('Wilson Analytics') < ROUND2_BN3_LATE_WILSON_TARGET) return null;
            const targetAdvert = getBn3LateTobaccoAdvertTarget(bestOffer, stagnantChecks);
            if (c.getHireAdVertCount(DIV_TOBACCO) < targetAdvert) return null;
            const maxDummies = getHighestTobaccoProductVersion() >= 6 &&
                (bestOffer >= ROUND2_BN3_LATE_SECOND_DUMMY_TRIGGER ||
                    stagnantChecks >= ROUND2_BN3_LATE_SECOND_DUMMY_STAGNATION)
                ? 2
                : 1;
            return tryBn3DummyExpansion(getBn3DummySpendFloor(reserve), maxDummies);
        } catch {
            return null;
        }
    }

    function tryBn3Round2SalesBotStep(reserve, materialFilled) {
        const autoLate = useBn3LeanTobRound2() && hasDiv(DIV_TOBACCO);
        if (!(useBn3Round2SalesBots() || autoLate) || !materialFilled) return null;
        try {
            const level = c.getUpgradeLevel('ABC SalesBots');
            const target = autoLate ? ROUND2_BN3_LATE_SALESBOT_TARGET : ROUND2_BN3_SALESBOT_TARGET;
            if (level >= target) return null;
            const cost = c.getUpgradeLevelCost('ABC SalesBots');
            const floor = Math.max(reserve, reserve + (autoLate ? ROUND2_BN3_LATE_SALESBOT_BUFFER : ROUND2_BN3_SALESBOT_BUFFER));
            if (!canSpend(cost, floor)) return null;
            c.levelUpgrade('ABC SalesBots');
            return `ABC SalesBots -> ${c.getUpgradeLevel('ABC SalesBots')}`;
        } catch {
            return null;
        }
    }

    function tryBn3Round2PostfillStorageStep(reserve, materialFilled) {
        const autoLate = useBn3LeanTobRound2() && hasDiv(DIV_TOBACCO);
        if (!(useBn3PostfillStorage() || autoLate) || !materialFilled) return null;
        const usage = getAgriWarehouseUsageSummary();
        if (usage.avg < ROUND2_BN3_POSTFILL_STORAGE_AVG_PCT && usage.peak < ROUND2_BN3_POSTFILL_STORAGE_PEAK_PCT) return null;
        try {
            const level = c.getUpgradeLevel('Smart Storage');
            const target = autoLate ? ROUND2_BN3_LATE_POSTFILL_SMART_STORAGE_TARGET : ROUND2_BN3_POSTFILL_SMART_STORAGE_TARGET;
            if (level >= target) return null;
            const cost = c.getUpgradeLevelCost('Smart Storage');
            const floor = Math.max(reserve, reserve + (autoLate ? ROUND2_BN3_LATE_POSTFILL_STORAGE_BUFFER : ROUND2_BN3_POSTFILL_STORAGE_BUFFER));
            if (!canSpend(cost, floor)) return null;
            c.levelUpgrade('Smart Storage');
            return `Smart Storage -> ${c.getUpgradeLevel('Smart Storage')}`;
        } catch {
            return null;
        }
    }

    async function manageBn3Round2Scaling(bestOffer, stagnantChecks) {
        const reserve = getBn3Round2Reserve();
        if (useBn3LeanTobRound2()) ensureTobaccoProduct(getBn3LeanTobaccoProductReserve(reserve), bestOffer, stagnantChecks);
        const officeBuiltOut = isBn3Round2OfficeBuiltOut();
        const upgradeBuiltOut = isBn3Round2UpgradeBuiltOut();
        const warehouseBuiltOut = isBn3Round2WarehouseBuiltOut();
        const materialFilled = isBn3Round2MaterialFilled();
        const postfillSales = useBn3PostfillSales();
        const postfillSalesMode = getBn3PostfillSalesMode();
        const remainingFillCost = estimateBn3RemainingMaterialSpend();
        const dummyEnabled = useBn3Round2Dummy() || useBn3LeanTobRound2();
        const dummyFloor = dummyEnabled ? getBn3DummySpendFloor(reserve) : null;
        const ret = (branch, action = null) => ({
            action,
            reserve,
            debug: formatRound2Debug({
                mode: 'bn3',
                branch,
                reserveBranch: 'bn3',
                reserve: formatMoney(reserve),
                funds: formatMoney(c.getCorporation().funds),
                ...getRound2CorpDebugStats(),
                ...getLeanTobaccoDebugStats(),
                best: formatMoney(bestOffer),
                office9: officeBuiltOut ? 'yes' : 'no',
                smart10: upgradeBuiltOut ? 'yes' : 'no',
                wh2k: warehouseBuiltOut ? 'yes' : 'no',
                fill: materialFilled ? 'yes' : 'no',
                fillProfile: useBn3HeadroomFill() ? 'headroom90' : 'classic',
                salesPivot: !postfillSales ? 'off' : (materialFilled ? 'active' : 'armed'),
                salesMode: postfillSalesMode,
                remFill: formatMoney(remainingFillCost),
                dummy: dummyEnabled ? 'on' : 'off',
                dummyFloor: dummyFloor === null ? undefined : formatMoney(dummyFloor),
                stagnant: stagnantChecks,
            }),
        });

        const officeAction = tryBn3Round2OfficeStep(reserve);
        if (officeAction) return ret('bn3-office', officeAction);

        const leanTobAction = tryBn3LeanTobaccoStep(reserve, bestOffer, stagnantChecks);
        if (leanTobAction) return ret('bn3-lean-tobacco', leanTobAction);

        const upgradeAction = tryBn3Round2UpgradeStep(reserve);
        if (upgradeAction) return ret('bn3-upgrade', upgradeAction);

        const warehouseAction = tryBn3Round2WarehouseStep(reserve);
        if (warehouseAction) return ret('bn3-warehouse', warehouseAction);

        const leanTobEarlySupportAction = tryBn3LeanTobaccoEarlySupportStep(reserve, bestOffer, stagnantChecks);
        if (leanTobEarlySupportAction) return ret('bn3-lean-tob-early-support', leanTobEarlySupportAction);

        const materialAction = await tryBn3Round2MaterialStep(reserve);
        if (materialAction) return ret('bn3-material', materialAction);

        const leanTobHQPushAction = tryBn3LeanTobaccoHQPushStep(reserve, bestOffer, materialFilled, stagnantChecks);
        if (leanTobHQPushAction) return ret('bn3-lean-tob-hq-push', leanTobHQPushAction);

        const leanTobSupportAction = tryBn3LeanTobaccoSupportStep(reserve, bestOffer, materialFilled, stagnantChecks);
        if (leanTobSupportAction) return ret('bn3-lean-tob-support', leanTobSupportAction);

        const postfillStorageAction = tryBn3Round2PostfillStorageStep(reserve, materialFilled);
        if (postfillStorageAction) return ret('bn3-postfill-storage', postfillStorageAction);

        const salesBotAction = tryBn3Round2SalesBotStep(reserve, materialFilled);
        if (salesBotAction) return ret('bn3-salesbot', salesBotAction);

        const lateWilsonAction = tryBn3LateWilsonStep(reserve, bestOffer, materialFilled, stagnantChecks);
        if (lateWilsonAction) return ret('bn3-late-wilson', lateWilsonAction);

        const lateAdvertAction = tryBn3LateTobaccoAdvertStep(reserve, bestOffer, materialFilled, stagnantChecks);
        if (lateAdvertAction) return ret('bn3-late-advert', lateAdvertAction);

        const lateDummyAction = tryBn3LateValuationDummyStep(reserve, bestOffer, materialFilled, stagnantChecks);
        if (lateDummyAction) return ret('bn3-late-dummy', lateDummyAction);

        const dummyAction = tryBn3Round2DummyStep(reserve, bestOffer, materialFilled);
        if (dummyAction) return ret('bn3-dummy', dummyAction);

        if (useBn3Round2RealEstatePush()) {
            const rePushAction = await tryBn3Round2RealEstatePush(reserve);
            if (rePushAction) return ret('bn3-re-push', rePushAction);
        }

        return ret('bn3-wait');
    }

    function getClassicRound2Reserve() {
        const funds = c.getCorporation().funds;
        return Math.max(ROUND2_CLASSIC_RESERVE, funds * ROUND2_CLASSIC_RESERVE_PCT);
    }

    function isClassicRound2BuiltOut() {
        if (!isRound2AgriBuiltOut()) return false;
        return ['Smart Factories', 'Smart Storage'].every((upg) => {
            try { return c.getUpgradeLevel(upg) >= ROUND2_GLOBAL_UPGRADE_TARGET_LATE; }
            catch { return false; }
        });
    }

    function tryClassicRound2OfficeStep(reserve) {
        for (const city of CITIES) {
            try {
                const off = c.getOffice(DIV_AGRI, city);
                if (off.size < ROUND2_CLASSIC_AGRI_OFFICE) {
                    const increase = ROUND2_CLASSIC_AGRI_OFFICE - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_AGRI, city, increase);
                    if (canSpend(cost, reserve)) {
                        fillOffice(DIV_AGRI, city, ROUND2_CLASSIC_AGRI_OFFICE, ROUND2_CLASSIC_AGRI_JOBS);
                        return `Agriculture ${city} office -> ${ROUND2_CLASSIC_AGRI_OFFICE}`;
                    }
                }
                if (off.numEmployees < off.size) {
                    fillOffice(DIV_AGRI, city, off.size, getRound2AgriJobs(off.size));
                    return `Agriculture staffed in ${city}`;
                }
            } catch { }
        }
        return null;
    }

    function tryClassicRound2WarehouseStep(reserve) {
        const candidates = [];
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                if (wh.level < ROUND2_CLASSIC_AGRI_WAREHOUSE) {
                    candidates.push({ city, level: wh.level });
                }
            } catch { }
        }
        candidates.sort((a, b) => a.level - b.level || a.city.localeCompare(b.city));
        for (const { city } of candidates) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                const spendCost = estimateWarehouseUpgradeSpend(DIV_AGRI, city);
                if (canSpend(spendCost, reserve)) {
                    c.upgradeWarehouse(DIV_AGRI, city, 1);
                    return `Agriculture ${city} warehouse -> ${wh.level + 1}`;
                }
            } catch { }
        }
        return null;
    }

    function manageClassicRound2Scaling(bestOffer, rpGateCleared, stagnantChecks) {
        const reserve = getClassicRound2Reserve();
        const agriBuiltOut = isRound2AgriBuiltOut();
        const classicBuiltOut = isClassicRound2BuiltOut();
        const chemReady = hasDiv(DIV_CHEM) && (() => {
            try {
                const wh = c.getWarehouse(DIV_CHEM, HQ_CITY);
                const off = c.getOffice(DIV_CHEM, HQ_CITY);
                return wh.level >= 2 && off.size >= ROUND2_CHEM_OFFICE;
            } catch {
                return false;
            }
        })();
        const ret = (branch, action = null) => ({
            action,
            reserve,
            debug: formatRound2Debug({
                mode: 'classic',
                branch,
                reserveBranch: 'classic',
                reserve: formatMoney(reserve),
                funds: formatMoney(c.getCorporation().funds),
                ...getRound2CorpDebugStats(),
                best: formatMoney(bestOffer),
                rpGate: rpGateCleared ? 'yes' : 'no',
                chemReady: chemReady ? 'yes' : 'no',
                agriBuiltOut: agriBuiltOut ? 'yes' : 'no',
                classicBuilt: classicBuiltOut ? 'yes' : 'no',
                stagnant: stagnantChecks,
            }),
        });

        const chemHQAction = tryRound2ChemStep(reserve, 0);
        if (chemHQAction) return ret('chem-hq', chemHQAction);

        const officeAction = tryClassicRound2OfficeStep(reserve);
        if (officeAction) return ret('classic-office', officeAction);

        const upgradeAction = tryRound2UpgradeStep(reserve, ROUND2_GLOBAL_UPGRADE_TARGET_LATE);
        if (upgradeAction) return ret('classic-upgrade', upgradeAction);

        const warehouseAction = tryClassicRound2WarehouseStep(reserve);
        if (warehouseAction) return ret('classic-warehouse', warehouseAction);

        const dummyAction = tryRound2DummyStep(
            bestOffer,
            stagnantChecks,
            reserve,
            classicBuiltOut && (bestOffer >= ROUND2_CLASSIC_DUMMY_TRIGGER || stagnantChecks >= ROUND2_CLASSIC_DUMMY_STAGNATION),
        );
        if (dummyAction) return ret('classic-dummy', dummyAction);

        return ret('classic-wait');
    }

    function manageAggressiveRound2Scaling(bestOffer, rpGateCleared, stagnantChecks) {
        const reserveInfo = getRound2ReserveInfo(bestOffer, rpGateCleared);
        const reserve = reserveInfo.reserve;
        ensureTobaccoProduct(reserve, bestOffer);
        const { highestProgress, finishedProducts } = getTobaccoProductStats();
        const allowWarmupSupportCities =
            finishedProducts > 0 ||
            highestProgress >= ROUND2_AGGR_EARLY_SUPPORT_PROGRESS ||
            bestOffer >= ROUND2_AGGR_EARLY_SUPPORT_TRIGGER ||
            rpGateCleared;
        const ret = (branch, action = null, reserveValue = reserve, reserveLabel = reserveInfo.label) => ({
            action,
            reserve: reserveValue,
            debug: formatRound2Debug({
                mode: 'aggr',
                branch,
                reserveBranch: reserveLabel,
                reserve: formatMoney(reserveValue),
                funds: formatMoney(c.getCorporation().funds),
                ...getRound2CorpDebugStats(),
                best: formatMoney(bestOffer),
                rpGate: rpGateCleared ? 'yes' : 'no',
                progress: highestProgress.toFixed(0),
                finished: finishedProducts,
                stagnant: stagnantChecks,
            }),
        });
        if (!c.hasUnlock(UNLOCKS.smartSupply)) {
            const ssCost = unlockCost(UNLOCKS.smartSupply, 25e9);
            const ssReserve = Math.max(45e9, reserve * 0.75);
            const shouldBuySmartSupply =
                bestOffer >= ROUND2_AGGR_SMART_SUPPLY_TRIGGER ||
                highestProgress >= ROUND2_AGGR_EARLY_SUPPORT_PROGRESS ||
                finishedProducts > 0;
            if (shouldBuySmartSupply && canSpend(ssCost, ssReserve)) {
                buyUnlock(UNLOCKS.smartSupply);
                stopRound1AgriSupply();
                stopChemicalWaterSupply();
                enableSmartSupply(DIV_AGRI);
                enableSmartSupply(DIV_CHEM);
                enableSmartSupply(DIV_TOBACCO);
                return ret('smart-supply', 'Purchased Smart Supply');
            }
        }

        const needsWarmup = !rpGateCleared &&
            finishedProducts === 0 &&
            (highestProgress < ROUND2_AGGR_FREEZE_PROGRESS || bestOffer < ROUND2_AGGR_WARMUP_TARGET);
        if (needsWarmup) {
            const tobWarmupAction = tryRound2TobaccoStep(reserve, false, true);
            if (tobWarmupAction) return ret('warmup-tobacco', tobWarmupAction);
            const warmupAction = tryAggressiveWarmupHQStep(reserve);
            if (warmupAction) return ret('warmup-hq', warmupAction);
        }

        const preserveValuationCarryover = shouldPreserveAggressiveRound2(bestOffer, rpGateCleared, stagnantChecks);
        if (preserveValuationCarryover) {
            if (bestOffer >= ROUND2_AGGR_ACCELERATE_TRIGGER) {
                const warmupAction = tryAggressiveWarmupHQStep(reserve);
                if (warmupAction) return ret('warmup-hq', warmupAction);
            }
            return ret('preserve-carry');
        }

        const allowTobSupportCities = allowWarmupSupportCities || rpGateCleared;
        const tobAction = tryRound2TobaccoStep(reserve, allowTobSupportCities, true);
        if (tobAction) return ret('tobacco', tobAction);

        const bootstrapChemCities = finishedProducts > 0 || highestProgress >= ROUND2_AGGR_EARLY_SUPPORT_PROGRESS || bestOffer >= ROUND2_AGGR_EARLY_SUPPORT_TRIGGER || rpGateCleared
            ? supportCities().length
            : 0;
        const chemBootstrapAction = tryRound2ChemStep(reserve, bootstrapChemCities);
        if (chemBootstrapAction) return ret(`chem-bootstrap-${bootstrapChemCities}`, chemBootstrapAction);

        const freezeForValuation = !rpGateCleared &&
            finishedProducts === 0 &&
            highestProgress >= ROUND2_AGGR_FREEZE_PROGRESS &&
            bestOffer >= ROUND2_AGGR_WARMUP_TARGET;
        if (freezeForValuation) {
            return ret('freeze-for-valuation');
        }

        const aggressiveMature = finishedProducts > 0 || highestProgress >= 100 || bestOffer >= 1.2e12 || rpGateCleared;

        const agriAction = tryRound2AgriStep(reserve, bestOffer >= ROUND2_AGRI_OFFICE_TRIGGER || aggressiveMature);
        if (agriAction) return ret('agri', agriAction);

        const dummyAction = tryRound2DummyStep(
            bestOffer,
            stagnantChecks,
            reserve,
            finishedProducts > 0 && bestOffer >= 1.5e12,
        );
        if (dummyAction) return ret('dummy', dummyAction);

        if (!aggressiveMature) {
            return ret('idle');
        }

        const upgradeAction = tryRound2UpgradeStep(reserve);
        if (upgradeAction) return ret('upgrade', upgradeAction);

        return ret('idle');
    }

    async function manageRound2Scaling(bestOffer, rpGateCleared, stagnantChecks) {
        if (useBn3Round2()) {
            return manageBn3Round2Scaling(bestOffer, stagnantChecks);
        }
        if (opts['classic-round2']) {
            return manageClassicRound2Scaling(bestOffer, rpGateCleared, stagnantChecks);
        }
        if (opts['aggressive-round2']) {
            return manageAggressiveRound2Scaling(bestOffer, rpGateCleared, stagnantChecks);
        }

        const reserveInfo = getRound2ReserveInfo(bestOffer, rpGateCleared);
        const reserve = reserveInfo.reserve;
        ensureTobaccoProduct(reserve, bestOffer);

        const { highestProgress, finishedProducts } = getTobaccoProductStats();
        const freezeGrowth = !rpGateCleared && bestOffer >= ROUND2_FREEZE_BEST_OFFER;
        const agriBuiltOut = isRound2AgriBuiltOut();
        const latePushReserve = Math.min(
            reserve,
            Math.max(ROUND2_LATE_PUSH_RESERVE, c.getCorporation().funds * ROUND2_LATE_PUSH_RESERVE_PCT),
        );
        const latePushCandidate = agriBuiltOut && bestOffer >= ROUND2_LATE_PUSH_TRIGGER;
        const latePushActive = latePushCandidate &&
            (rpGateCleared || bestOffer >= ROUND2_LATE_PUSH_FORCE_TRIGGER || stagnantChecks >= ROUND2_LATE_PUSH_STAGNATION);
        const activeReserve = latePushActive ? latePushReserve : reserve;
        const activeReserveLabel = latePushActive ? 'late-push' : reserveInfo.label;
        const allowTobSupportCities = !DELAY_TOBACCO_UNTIL_POST_ROUND2 &&
            hasDiv(DIV_TOBACCO) &&
            !freezeGrowth &&
            (finishedProducts > 0 || highestProgress >= 90 || bestOffer >= ROUND2_TOB_SUPPORT_TRIGGER || rpGateCleared);
        const allowChemSupportCities = !DELAY_TOBACCO_UNTIL_POST_ROUND2 &&
            agriBuiltOut &&
            (rpGateCleared || bestOffer >= ROUND2_CHEM_FULL_TRIGGER);
        const ret = (branch, action = null, reserveValue = activeReserve, reserveLabel = activeReserveLabel) => ({
            action,
            reserve: reserveValue,
            debug: formatRound2Debug({
                mode: 'default',
                branch,
                reserveBranch: reserveLabel,
                reserve: formatMoney(reserveValue),
                funds: formatMoney(c.getCorporation().funds),
                ...getRound2CorpDebugStats(),
                best: formatMoney(bestOffer),
                rpGate: rpGateCleared ? 'yes' : 'no',
                freeze: freezeGrowth ? 'yes' : 'no',
                agriBuiltOut: agriBuiltOut ? 'yes' : 'no',
                lateCandidate: latePushCandidate ? 'yes' : 'no',
                latePush: latePushActive ? 'yes' : 'no',
                chemSupport: allowChemSupportCities ? 'yes' : 'no',
                tobSupport: allowTobSupportCities ? 'yes' : 'no',
                progress: highestProgress.toFixed(0),
                finished: finishedProducts,
                stagnant: stagnantChecks,
            }),
        });

        const chemHQAction = tryRound2ChemStep(reserve, 0);
        if (chemHQAction) return ret('chem-hq', chemHQAction);

        const agriAction = tryRound2AgriStep(reserve, !freezeGrowth);
        if (agriAction) return ret('agri', agriAction);

        const upgradeAction = tryRound2UpgradeStep(reserve);
        if (upgradeAction) return ret('upgrade', upgradeAction);

        const tobAction = tryRound2TobaccoStep(reserve, allowTobSupportCities, true);
        if (tobAction) return ret('tobacco', tobAction);

        if (latePushActive) {
            const lateAgriAction = tryRound2LateAgriStep(latePushReserve);
            if (lateAgriAction) return ret('late-agri', lateAgriAction, latePushReserve, 'late-push');
            const lateUpgradeAction = tryRound2UpgradeStep(latePushReserve, ROUND2_GLOBAL_UPGRADE_TARGET_LATE);
            if (lateUpgradeAction) return ret('late-upgrade', lateUpgradeAction, latePushReserve, 'late-push');
        }

        if (allowChemSupportCities) {
            const chemAction = tryRound2ChemStep(reserve, supportCities().length);
            if (chemAction) return ret('chem-support', chemAction);
        }

        const dummyReserve = agriBuiltOut && bestOffer >= ROUND2_LATE_DUMMY_TRIGGER ? latePushReserve : reserve;
        const dummyAction = tryRound2DummyStep(
            bestOffer,
            stagnantChecks,
            dummyReserve,
            agriBuiltOut && (bestOffer >= ROUND2_LATE_DUMMY_TRIGGER || finishedProducts > 0 || highestProgress >= 100 || rpGateCleared),
        );
        if (dummyAction) return ret('dummy', dummyAction, dummyReserve, dummyReserve === reserve ? reserveInfo.label : 'late-push');

        if (freezeGrowth) {
            tryFillOffice(DIV_TOBACCO, HQ_CITY, ROUND2_TOB_HQ_OFFICE, ROUND2_TOB_HQ_JOBS);
            tryFillOffice(DIV_CHEM, HQ_CITY, ROUND2_CHEM_OFFICE, ROUND2_CHEM_JOBS);
        }

        return ret(freezeGrowth ? 'freeze-idle' : 'idle');
    }

    function getPostRound2BootstrapReserve() {
        const funds = c.getCorporation().funds;
        return Math.max(ROUND2_POST_ACCEPT_BOOTSTRAP_RESERVE, funds * ROUND2_POST_ACCEPT_BOOTSTRAP_RESERVE_PCT);
    }

    function getPostRound2TobaccoOfficeTarget(city) {
        return city === HQ_CITY ? ROUND2_POST_ACCEPT_TOB_HQ_OFFICE : ROUND2_POST_ACCEPT_TOB_SUPPORT_OFFICE;
    }

    function getPostRound2OfficeJobs(div, city) {
        if (div === DIV_TOBACCO) return city === HQ_CITY ? ROUND2_POST_ACCEPT_TOB_HQ_JOBS : ROUND2_POST_ACCEPT_TOB_SUPPORT_JOBS;
        if (div === DIV_AGRI) return ROUND2_POST_ACCEPT_AGRI_JOBS;
        if (div === DIV_CHEM) return ROUND2_POST_ACCEPT_CHEM_JOBS;
        return {};
    }

    function isPostRound2BootstrapReady() {
        if (!hasDiv(DIV_AGRI) || !hasDiv(DIV_CHEM) || !hasDiv(DIV_TOBACCO)) return false;
        if (!divisionInfraReady(DIV_AGRI) || !divisionInfraReady(DIV_CHEM) || !divisionInfraReady(DIV_TOBACCO)) return false;
        if (!c.hasUnlock(UNLOCKS.export) || !c.hasUnlock(UNLOCKS.smartSupply)) return false;
        try {
            if (c.getUpgradeLevel('Smart Factories') < ROUND2_POST_ACCEPT_SMART_FACTORIES_TARGET) return false;
            if (c.getUpgradeLevel('Smart Storage') < ROUND2_POST_ACCEPT_SMART_STORAGE_TARGET) return false;
            if (c.getUpgradeLevel('Wilson Analytics') < ROUND2_POST_ACCEPT_WILSON_TARGET) return false;
            if (c.getHireAdVertCount(DIV_TOBACCO) < ROUND2_POST_ACCEPT_TOB_ADVERT_TARGET) return false;
        } catch {
            return false;
        }
        for (const city of CITIES) {
            try {
                const agriOffice = c.getOffice(DIV_AGRI, city);
                const tobOffice = c.getOffice(DIV_TOBACCO, city);
                const chemOffice = c.getOffice(DIV_CHEM, city);
                const tobTarget = getPostRound2TobaccoOfficeTarget(city);
                if (agriOffice.size < ROUND2_POST_ACCEPT_AGRI_OFFICE || agriOffice.numEmployees < ROUND2_POST_ACCEPT_AGRI_OFFICE) return false;
                if (tobOffice.size < tobTarget || tobOffice.numEmployees < tobTarget) return false;
                if (chemOffice.size < ROUND2_POST_ACCEPT_CHEM_OFFICE || chemOffice.numEmployees < ROUND2_POST_ACCEPT_CHEM_OFFICE) return false;
                if (c.getWarehouse(DIV_AGRI, city).level < ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL) return false;
                if (c.getWarehouse(DIV_TOBACCO, city).level < ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL) return false;
                if (c.getWarehouse(DIV_CHEM, city).level < ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    function tryPostRound2BootstrapStep(reserve) {
        if (!hasDiv(DIV_CHEM)) {
            const cost = expandIndustryCost(IND_CHEM);
            if (canSpend(cost, reserve)) {
                c.expandIndustry(IND_CHEM, DIV_CHEM);
                return 'Chemical launched';
            }
            return null;
        }
        if (!hasDiv(DIV_TOBACCO)) {
            const cost = expandIndustryCost(IND_TOBACCO);
            if (canSpend(cost, reserve)) {
                c.expandIndustry(IND_TOBACCO, DIV_TOBACCO);
                return 'Tobacco launched';
            }
            return null;
        }

        const officeCost = getCorpOfficeInitialCost();
        const warehouseCost = getCorpWarehouseInitialCost();
        for (const [div, label] of [[DIV_CHEM, 'Chemical'], [DIV_TOBACCO, 'Tobacco']]) {
            for (const city of CITIES) {
                try {
                    const cities = c.getDivision(div).cities;
                    if (!cities.includes(city)) {
                        const floor = reserve + warehouseCost;
                        if (!canSpend(officeCost, floor)) return null;
                        c.expandCity(div, city);
                        return `${label} expanded to ${city}`;
                    }
                    if (!c.hasWarehouse(div, city)) {
                        if (!canSpend(warehouseCost, reserve)) return null;
                        c.purchaseWarehouse(div, city);
                        return `${label} warehouse purchased in ${city}`;
                    }
                } catch {
                    return null;
                }
            }
        }

        if (!c.hasUnlock(UNLOCKS.export)) {
            const cost = unlockCost(UNLOCKS.export, Infinity);
            if (!canSpend(cost, reserve)) return null;
            buyUnlock(UNLOCKS.export);
            return `Unlock ${UNLOCKS.export}`;
        }
        if (!c.hasUnlock(UNLOCKS.smartSupply)) {
            const cost = unlockCost(UNLOCKS.smartSupply, Infinity);
            if (!canSpend(cost, reserve)) return null;
            buyUnlock(UNLOCKS.smartSupply);
            return `Unlock ${UNLOCKS.smartSupply}`;
        }

        for (const [upgrade, target] of [
            ['Smart Factories', ROUND2_POST_ACCEPT_SMART_FACTORIES_TARGET],
            ['Smart Storage', ROUND2_POST_ACCEPT_SMART_STORAGE_TARGET],
            ['Wilson Analytics', ROUND2_POST_ACCEPT_WILSON_TARGET],
        ]) {
            try {
                if (c.getUpgradeLevel(upgrade) >= target) continue;
                const cost = c.getUpgradeLevelCost(upgrade);
                if (!canSpend(cost, reserve)) return null;
                c.levelUpgrade(upgrade);
                return `${upgrade} -> ${c.getUpgradeLevel(upgrade)}`;
            } catch {
                return null;
            }
        }

        try {
            if (c.getHireAdVertCount(DIV_TOBACCO) < ROUND2_POST_ACCEPT_TOB_ADVERT_TARGET) {
                const cost = c.getHireAdVertCost(DIV_TOBACCO);
                if (!canSpend(cost, reserve)) return null;
                c.hireAdVert(DIV_TOBACCO);
                return `Tobacco advert -> ${c.getHireAdVertCount(DIV_TOBACCO)}`;
            }
        } catch {
            return null;
        }

        for (const city of CITIES) {
            try {
                const tobTarget = getPostRound2TobaccoOfficeTarget(city);
                const tobOffice = c.getOffice(DIV_TOBACCO, city);
                if (tobOffice.size < tobTarget) {
                    const increase = tobTarget - tobOffice.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_TOBACCO, city, increase);
                    if (!canSpend(cost, reserve)) return null;
                    fillOffice(DIV_TOBACCO, city, tobTarget, getPostRound2OfficeJobs(DIV_TOBACCO, city));
                    return `Tobacco ${city} office -> ${tobTarget}`;
                }
                if (tobOffice.numEmployees < tobOffice.size) {
                    fillOffice(DIV_TOBACCO, city, tobOffice.size, getPostRound2OfficeJobs(DIV_TOBACCO, city));
                    return `Tobacco staffed in ${city}`;
                }
                assignJobs(DIV_TOBACCO, city, getPostRound2OfficeJobs(DIV_TOBACCO, city));
            } catch {
                return null;
            }
        }

        for (const city of CITIES) {
            try {
                const agriOffice = c.getOffice(DIV_AGRI, city);
                if (agriOffice.size < ROUND2_POST_ACCEPT_AGRI_OFFICE) {
                    const increase = ROUND2_POST_ACCEPT_AGRI_OFFICE - agriOffice.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_AGRI, city, increase);
                    if (!canSpend(cost, reserve)) return null;
                    fillOffice(DIV_AGRI, city, ROUND2_POST_ACCEPT_AGRI_OFFICE, ROUND2_POST_ACCEPT_AGRI_JOBS);
                    return `Agriculture ${city} office -> ${ROUND2_POST_ACCEPT_AGRI_OFFICE}`;
                }
                if (agriOffice.numEmployees < agriOffice.size) {
                    fillOffice(DIV_AGRI, city, agriOffice.size, ROUND2_POST_ACCEPT_AGRI_JOBS);
                    return `Agriculture staffed in ${city}`;
                }
                assignJobs(DIV_AGRI, city, ROUND2_POST_ACCEPT_AGRI_JOBS);
            } catch {
                return null;
            }
        }

        for (const city of CITIES) {
            try {
                const chemOffice = c.getOffice(DIV_CHEM, city);
                if (chemOffice.size < ROUND2_POST_ACCEPT_CHEM_OFFICE) {
                    const increase = ROUND2_POST_ACCEPT_CHEM_OFFICE - chemOffice.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_CHEM, city, increase);
                    if (!canSpend(cost, reserve)) return null;
                    fillOffice(DIV_CHEM, city, ROUND2_POST_ACCEPT_CHEM_OFFICE, ROUND2_POST_ACCEPT_CHEM_JOBS);
                    return `Chemical ${city} office -> ${ROUND2_POST_ACCEPT_CHEM_OFFICE}`;
                }
                if (chemOffice.numEmployees < chemOffice.size) {
                    fillOffice(DIV_CHEM, city, chemOffice.size, ROUND2_POST_ACCEPT_CHEM_JOBS);
                    return `Chemical staffed in ${city}`;
                }
                assignJobs(DIV_CHEM, city, ROUND2_POST_ACCEPT_CHEM_JOBS);
            } catch {
                return null;
            }
        }

        for (const div of [DIV_AGRI, DIV_TOBACCO, DIV_CHEM]) {
            for (const city of CITIES) {
                try {
                    const wh = c.getWarehouse(div, city);
                    if (wh.level >= ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL) continue;
                    const cost = c.getUpgradeWarehouseCost(div, city, 1);
                    if (!canSpend(cost, reserve)) return null;
                    c.upgradeWarehouse(div, city, 1);
                    return `${div} ${city} warehouse -> ${wh.level + 1}`;
                } catch {
                    return null;
                }
            }
        }

        return null;
    }

    function runPostRound2BootstrapBatch(maxActions = 64) {
        const actions = [];
        for (let i = 0; i < maxActions; i++) {
            const reserve = getPostRound2BootstrapReserve();
            const action = tryPostRound2BootstrapStep(reserve);
            if (!action) break;
            actions.push({ action, reserve });
            if (c.hasUnlock(UNLOCKS.smartSupply)) {
                stopRound1AgriSupply();
                stopChemicalWaterSupply();
                enableSmartSupply(DIV_AGRI);
                enableSmartSupply(DIV_CHEM);
                enableSmartSupply(DIV_TOBACCO);
            }
            configureExports();
            if (isPostRound2BootstrapReady()) break;
        }
        return actions;
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
                try {
                    const office = c.getOffice(div, city);
                    if (office.numEmployees < 9) continue;
                    if ((office.avgEnergy ?? 100) < 99.5) c.buyTea(div, city);
                    if ((office.avgMorale ?? 100) < 99.5) c.throwParty(div, city, 500e3);
                } catch { }
            }
    }

    // ── Research (with RP threshold enforcement) ──────────────────────────────
    function tryResearch(div, queue) {
        try {
            let availableRp = c.getDivision(div).researchPoints;
            for (const name of queue) {
                if (c.hasResearched(div, name)) continue;
                const cost = c.getResearchCost(div, name);
                // Production research: 10% pool threshold. Others: 50%.
                const threshold = PRODUCTION_RESEARCH.has(name) ? 10 : 2;
                if (availableRp < cost * threshold) continue;
                try {
                    c.research(div, name);
                    availableRp -= cost;
                    log(ns, `  Researched "${name}" (${div})`, false, 'info');
                } catch { }
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
        if (!hasDiv(DIV_TOBACCO)) return;
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
                        : useBn3LeanTobRound2() ? 'MP' : 'MP*3';
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
        if (opts['round1-only']) {
            log(ns, 'INFO: Round-1-only mode enabled — stopping after round 1 for comparison.', true, 'info');
            return;
        }
    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3 – Launch Chemical (and optionally Tobacco); supply chain; first product
    // ─────────────────────────────────────────────────────────────────────────
    }
    if (phase <= 3) {
        if (opts['round1-only']) {
            writePhase(3); phase = 3;
            log(ns, 'INFO: Round-1-only mode enabled — skipping post-round-1 setup.', true, 'info');
            return;
        }
        if (useBn3LeanTobRound2()) {
            log(ns, 'INFO: Phase 3 – launching a lean Tobacco shell before round 2 while still delaying Chemical.', true, 'info');
        } else {
            log(ns, `INFO: Phase 3 – launching Chemical${delayTobaccoUntilPostRound2() ? '' : ' and Tobacco'} without a cash deadlock...`, true, 'info');
        }
        if (useBn3Round2()) {
            if (useBn3LeanTobRound2()) {
                log(ns, 'INFO: Phase 3 - BN3 lean-Tobacco mode enabled; delaying Chemical but launching Tobacco HQ + Export before round 2.', true, 'info');

                while (!c.hasUnlock(UNLOCKS.export)) {
                    const cost = unlockCost(UNLOCKS.export, 25e9);
                    if (c.getCorporation().funds >= cost + PHASE3_EXPORT_RESERVE) {
                        buyUnlock(UNLOCKS.export);
                        break;
                    }
                    maintainRound1AgriSupply();
                    log(ns, `  Waiting for Export: ${formatMoney(c.getCorporation().funds)} / ${formatMoney(cost)}`, false);
                    await waitCycles(2);
                }

                while (!hasDiv(DIV_TOBACCO)) {
                    const tobCost = expandIndustryCost(IND_TOBACCO);
                    if (c.getCorporation().funds >= tobCost + PHASE3_EXPORT_RESERVE) {
                        c.expandIndustry(IND_TOBACCO, DIV_TOBACCO);
                        log(ns, 'INFO: Tobacco launched.', true, 'success');
                        break;
                    }
                    maintainRound1AgriSupply();
                    log(ns, `  Waiting for Tobacco: ${formatMoney(c.getCorporation().funds)} / ${formatMoney(tobCost)}`, false);
                    await waitCycles(2);
                }

                await waitForDivisionInfrastructure(DIV_TOBACCO, 'Tobacco', PHASE3_TOB_START_CITIES);
                await waitForWarehouseLevel(DIV_TOBACCO, HQ_CITY, 3);
                await waitFillOffice(DIV_TOBACCO, HQ_CITY, PHASE3_TOB_INITIAL_HQ_OFFICE, { ops: 1, eng: 3, biz: 1, mgmt: 1 });
                configureExports();
                boostMorale(DIV_AGRI, DIV_TOBACCO);
                ensureTobaccoProduct(ROUND2_BN3_LEAN_TOB_PRODUCT_RESERVE);

                writePhase(4); phase = 4;
            } else {
                log(ns, 'INFO: Phase 3 - BN3 round-2 mode enabled; delaying Chemical, Tobacco, and Export until after round 2.', true, 'info');
                writePhase(4); phase = 4;
            }
        } else {
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

        if (!delayTobaccoUntilPostRound2()) {
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
        } else {
            log(ns, 'INFO: Delaying Tobacco until after round 2 to follow the docs path.', true, 'info');
        }

        boostMorale(DIV_CHEM, ...(hasDiv(DIV_TOBACCO) ? [DIV_TOBACCO] : []));
        configureExports();

        for (const city of PHASE3_CHEM_START_CITIES) await waitForWarehouseLevel(DIV_CHEM, city, 3);
        if (hasDiv(DIV_TOBACCO)) for (const city of PHASE3_TOB_START_CITIES) await waitForWarehouseLevel(DIV_TOBACCO, city, 3);
        for (const city of CITIES) await waitForWarehouseLevel(DIV_AGRI, city, 3);

        if (hasDiv(DIV_TOBACCO) && !c.getDivision(DIV_TOBACCO).products.includes('Tobac-v1')) {
            const investPct = opts['aggressive-round2'] ? ROUND2_AGGR_PRODUCT_INVEST_PCT : 0.01;
            const investCap = opts['aggressive-round2'] ? ROUND2_PRODUCT_MAX_INVEST_AGGR : 2e9;
            const invest = Math.max(1e8, Math.min(c.getCorporation().funds * investPct, investCap));
            try {
                c.makeProduct(DIV_TOBACCO, HQ_CITY, 'Tobac-v1', invest / 2, invest / 2);
                log(ns, `INFO: Started product Tobac-v1 with ${formatMoney(invest)} investment.`, true, 'info');
            } catch { }
        }

        // Stay lean between round 1 and round 2. Early corp-wide upgrades help less
        // than preserving funds for valuation while Tobacco/Chemical ramp up.

        writePhase(4); phase = 4;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 4 — Wait for and accept investment round 2
    // ─────────────────────────────────────────────────────────────────────────
    if (phase <= 4) {
        log(ns, `INFO: Waiting for round-2 offer ≥ ${formatMoney(MIN_ROUND2)}...`, true);
        if (opts['classic-round2']) {
            log(ns, 'INFO: Classic round-2 mode enabled — pushing Agriculture office/upgrade/warehouse scaling before waiting.', true, 'info');
        } else if (opts['aggressive-round2']) {
            log(ns, 'INFO: Aggressive round-2 mode enabled — using early Tobacco and product warmup to push valuation.', true, 'info');
        }

        if (useBn3Round2()) {
            log(ns, 'INFO: BN3 round-2 mode enabled - matching the old Agriculture 9/10/10/2k/material-fill path before accepting round 2.', true, 'info');
            if (useBn3LeanTobRound2()) {
                log(ns, 'INFO: BN3 lean-Tobacco route enabled - running a Tobacco HQ shell and product warmup before round 2.', true, 'info');
                if (useBn3Hard5tGoal()) {
                    log(ns, 'INFO: BN3 hard 5t goal enabled - pragmatic accept is disabled and round 2 will wait for 5.000t.', true, 'info');
                } else if (!opts['bn3-soft-accept']) {
                    log(ns, 'INFO: BN3 pragmatic accept enabled automatically for the lean-Tobacco path.', true, 'info');
                }
                if (useBn3LeanTobSupport()) {
                    log(ns, 'INFO: BN3 lean-Tobacco support mode enabled - expanding Tobacco to support cities after the Agriculture fill is complete.', true, 'info');
                }
                if (useBn3LeanTobHQPush()) {
                    log(ns, 'INFO: BN3 lean-Tobacco HQ push enabled - scaling Tobacco HQ only after fill and only on stronger runs.', true, 'info');
                }
            }
            if (useBn3Round2Dummy()) {
                log(ns, 'INFO: BN3 dummy route enabled - spending only protected surplus on a Restaurant valuation dummy.', true, 'info');
            }
            if (useBn3PostfillSales()) {
                log(ns, 'INFO: BN3 post-fill sales mode enabled - shifting Agriculture into a balanced sales-heavy office mix after the 2k material fill completes.', true, 'info');
            }
            if (useBn3Round2SalesBots()) {
                log(ns, 'INFO: BN3 SalesBots mode enabled - using protected post-fill surplus on a small ABC SalesBots bump.', true, 'info');
            }
            if (useBn3PostfillStorage()) {
                log(ns, 'INFO: BN3 post-fill storage mode enabled - using protected post-fill surplus on extra Smart Storage when warehouses stay pinned.', true, 'info');
            }
            if (useBn3HeadroomFill()) {
                log(ns, 'INFO: BN3 headroom-fill mode enabled - trimming the classic 2k material stack to a 90% profile to leave more permanent warehouse room.', true, 'info');
            }
        }

        // Initialise warehouse tracking for boost refresh.
        for (const div of useBn3Round2() ? [DIV_AGRI] : [DIV_AGRI, DIV_CHEM])
            for (const city of CITIES)
                try { prevWHCapacity[`${div}|${city}`] = c.getWarehouse(div, city).size; } catch { }

        let rpGateCleared = false;
        let bestRound2Offer = 0;
        let lastMeaningfulRound2Offer = 0;
        let stagnantRound2Checks = 0;
        let lastRound2Debug = '';
        latestRound2Offer = 0;
        lastRound2AssetProxy = null;

        while (true) {
            await waitCycles(1);
            boostMorale(DIV_TOBACCO, DIV_AGRI, DIV_CHEM);
            maintainPreRound2SupplyState();
            configureExports();
            maintainRound2DivisionState(shouldPreserveAggressiveRound2(bestRound2Offer, rpGateCleared, stagnantRound2Checks));

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
            if (!useBn3Round2()) {
                await refreshBoosts(DIV_AGRI, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);
                await refreshBoosts(DIV_CHEM, CHEM_BOOST.factors, CHEM_BOOST.sizes, CHEM_BOOST.mats);
            }

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
            if (!useBn3Round2() && !rpGateCleared) {
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
            }
            latestRound2Offer = offer.funds;
            const meaningfulGain = Math.max(
                ROUND2_STAGNATION_ABS,
                lastMeaningfulRound2Offer * ROUND2_STAGNATION_PCT,
            );
            if (offer.funds >= lastMeaningfulRound2Offer + meaningfulGain) {
                lastMeaningfulRound2Offer = offer.funds;
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
            const bn3AcceptReason = offer.round === 2
                ? getBn3Round2AcceptReason(offer.funds, bestRound2Offer, stagnantRound2Checks)
                : null;
            if (bn3AcceptReason) {
                c.acceptInvestmentOffer();
                log(
                    ns,
                    `INFO: Accepted Round 2 BN3 ${bn3AcceptReason} - received ${formatMoney(offer.funds)} (best ${formatMoney(bestRound2Offer)}).`,
                    true,
                    'success',
                );
                break;
            }
            const scaling = await manageRound2Scaling(bestRound2Offer, rpGateCleared, stagnantRound2Checks);
            if (scaling.debug && (scaling.debug !== lastRound2Debug || scaling.action)) {
                log(ns, `  Round 2 debug: ${scaling.debug}`, false);
                lastRound2Debug = scaling.debug;
            }
            if (scaling.action) {
                log(ns, `  Round 2 scaling: ${scaling.action} (reserve ${formatMoney(scaling.reserve)})`, false);
            }
            if (!useBn3Round2()) {
                await refreshBoosts(DIV_AGRI, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);
                await refreshBoosts(DIV_CHEM, CHEM_BOOST.factors, CHEM_BOOST.sizes, CHEM_BOOST.mats);
            }
        }
        await waitCycles(1);
        writePhase(5); phase = 5;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5 — Final scaling before autopilot handoff
    // ─────────────────────────────────────────────────────────────────────────
    if (phase <= 5) {
        log(ns, 'INFO: Phase 5 - post-round-2 ramp...', true);

        let idleRampChecks = 0;
        while (!isPostRound2BootstrapReady()) {
            await waitCycles(1);
            boostMorale(DIV_TOBACCO, DIV_AGRI, DIV_CHEM);
            if (c.hasUnlock(UNLOCKS.smartSupply)) {
                stopRound1AgriSupply();
                stopChemicalWaterSupply();
                enableSmartSupply(DIV_AGRI);
                enableSmartSupply(DIV_CHEM);
                enableSmartSupply(DIV_TOBACCO);
            }
            configureExports();
            const actions = runPostRound2BootstrapBatch();
            if (actions.length > 0) {
                idleRampChecks = 0;
                for (const { action, reserve } of actions) {
                    log(ns, `  Post-round-2 ramp: ${action} (reserve ${formatMoney(reserve)})`, false);
                }
            } else {
                idleRampChecks++;
                if (idleRampChecks % 5 === 0) {
                    log(ns, `  Post-round-2 ramp: waiting (reserve ${formatMoney(getPostRound2BootstrapReserve())})`, false);
                }
            }
        }

        await waitCycles(1);
        writePhase(6); phase = 6;
    }

    if (phase <= 6) {
        log(ns, 'INFO: Phase 6 – final scaling pass...', true);

        if (!hasDiv(DIV_CHEM)) {
            while (!hasDiv(DIV_CHEM)) {
                const chemCost = expandIndustryCost(IND_CHEM);
                if (c.getCorporation().funds >= chemCost) {
                    c.expandIndustry(IND_CHEM, DIV_CHEM);
                    log(ns, 'INFO: Chemical launched.', true, 'success');
                    break;
                }
                log(ns, `  Waiting for Chemical: ${formatMoney(c.getCorporation().funds)} / ${formatMoney(chemCost)}`, false);
                await waitCycles(2);
            }
        }
        await waitForDivisionInfrastructure(DIV_CHEM, 'Chemical');
        if (!hasDiv(DIV_TOBACCO)) {
            while (!hasDiv(DIV_TOBACCO)) {
                const tobCost = expandIndustryCost(IND_TOBACCO);
                if (c.getCorporation().funds >= tobCost) {
                    c.expandIndustry(IND_TOBACCO, DIV_TOBACCO);
                    log(ns, 'INFO: Tobacco launched.', true, 'success');
                    break;
                }
                log(ns, `  Waiting for Tobacco: ${formatMoney(c.getCorporation().funds)} / ${formatMoney(tobCost)}`, false);
                await waitCycles(2);
            }
        }
        await waitForDivisionInfrastructure(DIV_TOBACCO, 'Tobacco');
        if (!c.hasUnlock(UNLOCKS.export)) buyUnlock(UNLOCKS.export);
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
            await applyBoostMaterials(DIV_TOBACCO, city,
                getBoostTargets(DIV_TOBACCO, city, TOB_BOOST.factors, TOB_BOOST.sizes, TOB_BOOST.mats));
            await applyBoostMaterials(DIV_AGRI, city,
                getBoostTargets(DIV_AGRI, city, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats));
            await applyBoostMaterials(DIV_CHEM, city,
                getBoostTargets(DIV_CHEM, city, CHEM_BOOST.factors, CHEM_BOOST.sizes, CHEM_BOOST.mats));
        }

        writePhase(7); phase = 7;
    }

    // ── Handoff ───────────────────────────────────────────────────────────────
    ns.write(SETUP_DONE_FLAG, 'true', 'w');
    log(ns, '═══════════════════════════════════════════════════════', true);
    log(ns, 'INFO: Setup complete! Handing off to corp-autopilot.js.', true, 'success');
    if (useIncomeMode()) log(ns, 'INFO: Income mode enabled for corp-autopilot handoff.', true);
    log(ns, '═══════════════════════════════════════════════════════', true);

    const PILOT = resolvePath('corp-autopilot', 'corp-autopilot.js');
    const pilotArgs = useIncomeMode() ? ['--income-mode'] : [];
    try { if (!ns.ps('home').some(p => p.filename === PILOT)) ns.run(PILOT, 1, ...pilotArgs); }
    catch { ns.run(PILOT, 1, ...pilotArgs); }
}
