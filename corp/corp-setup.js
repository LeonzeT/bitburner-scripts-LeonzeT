/**
 * corp/corp-setup.js  —  Corporation bootstrapper
 *
 * Runs once to take the corp from nothing through investment rounds 1 and 2,
 * establishing a fully automated Tobacco + Agriculture + Water supply chain.
 * Writes '/Temp/corp-setup-done.txt' = 'true' on completion, then launches
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
 *  3  Launch Tobacco + Water; supply-chain exports; first product
 *  4  Accept investment round 2  (waits until offer ≥ MIN_ROUND2)
 *  5  Final office/warehouse scaling — hand off to corp-autopilot.js
 *
 * Supply chain
 * ────────────
 *  Water division  →  exports Water   →  Agriculture division
 *  Agriculture     →  exports Plants  →  Tobacco division
 *  (Chemicals and Hardware bought from market via Smart Supply)
 *
 * @param {NS} ns
 */
import { log, formatMoney } from '/helpers.js';

// ── Division / industry names ─────────────────────────────────────────────────
const CORP_NAME    = 'Nite-Corp';
const DIV_TOBACCO  = 'Tobacco';
const DIV_AGRI     = 'Agriculture';
const DIV_WATER    = 'Water';
const IND_TOBACCO  = 'Tobacco';          // IndustryType.Tobacco
const IND_AGRI     = 'Agriculture';      // IndustryType.Agriculture
const IND_WATER    = 'Water Utilities';  // IndustryType.Water

// ── Geography ─────────────────────────────────────────────────────────────────
const CITIES   = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];
const HQ_CITY  = 'Sector-12'; // Product design city for Tobacco

// ── Investment thresholds ─────────────────────────────────────────────────────
// Round 1 offer  =  valuation × 3 × 0.10  (investor takes 10 % of shares)
// Round 2 offer  =  valuation × 2 × 0.35  (investor takes 35 % of shares)
const MIN_ROUND1 = 210e9;  // $210 B — conservative; tweakable
const MIN_ROUND2 = 5e12;   // $5 T   — set higher to grow more before diluting

// ── Flags / temp files ────────────────────────────────────────────────────────
const SETUP_DONE_FLAG = '/Temp/corp-setup-done.txt';

// ── Exact strings from Enums.ts ───────────────────────────────────────────────
const JOBS = {
    ops:        'Operations',
    eng:        'Engineer',
    biz:        'Business',
    mgmt:       'Management',
    rnd:        'Research & Development',
    intern:     'Intern',
    unassigned: 'Unassigned',
};

const UNLOCKS = {
    warehouseAPI:  'Warehouse API',
    officeAPI:     'Office API',
    smartSupply:   'Smart Supply',
    export:        'Export',
    mktDemand:     'Market Research - Demand',
    mktComp:       'Market Data - Competition',
};

// ── Boost material targets per warehouse (not consumed — stay in warehouse) ───
// Agri factors: realEstate 0.72, hardware 0.20, robots 0.30, aiCores 0.30
// Stored boost: prod × Math.pow(0.002 × stored + 1, factor)
const AGRI_BOOST_INIT = { 'Real Estate': 2700, 'Hardware': 125, 'Robots': 10, 'AI Cores': 75 };
const AGRI_BOOST_P2   = { 'Real Estate': 5000, 'Hardware': 300, 'Robots': 30, 'AI Cores': 200 };
// Water factors: realEstate 0.50, robots 0.40, aiCores 0.40  (hardware is an *input*, not a boost)
const WATER_BOOST     = { 'Real Estate': 1500, 'Robots': 20,  'AI Cores': 100 };

// ── Market cycle duration (from source: gameCyclesPerMarketCycle=50, MilliPerCycle=200 ms) ──
const CYCLE_SECS = 10;   // secondsPerMarketCycle
const CYCLE_MS   = 11000; // slightly over one full cycle to guarantee a tick

// ═════════════════════════════════════════════════════════════════════════════
export async function main(ns) {
    ns.disableLog('ALL');
    ns.ui.openTail();
    const c = ns.corporation; // shorthand

    /** Resolve a script key via script-paths.json, falling back to the provided default. */
    function resolvePath(key, fallback) {
        try { const p = JSON.parse(ns.read('/script-paths.json')); return p[key] ?? fallback; }
        catch { return fallback; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /** Wait for `n` full market cycles. */
    async function waitCycles(n = 1) { await ns.sleep(CYCLE_MS * n); }

    /**
     * Set auto-job assignment for a full office.
     * Zeros every role first to avoid "total exceeds office size" errors,
     * then applies the desired distribution.
     */
    function assignJobs(div, city, { ops = 0, eng = 0, biz = 0, mgmt = 0, rnd = 0 } = {}) {
        for (const job of Object.values(JOBS)) {
            try { c.setAutoJobAssignment(div, city, job, 0); } catch { /* ignore */ }
        }
        c.setAutoJobAssignment(div, city, JOBS.ops,  ops);
        c.setAutoJobAssignment(div, city, JOBS.eng,  eng);
        c.setAutoJobAssignment(div, city, JOBS.biz,  biz);
        c.setAutoJobAssignment(div, city, JOBS.mgmt, mgmt);
        c.setAutoJobAssignment(div, city, JOBS.rnd,  rnd);
    }

    /**
     * Grow an office to `targetSize` employees and apply the given job distribution.
     * Only upgrades / hires what's missing — idempotent.
     */
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

    /**
     * Buy boost materials for one city in one market cycle, then stop.
     * Uses the buy-per-second mechanism: needed / CYCLE_SECS = units/s for 10 s.
     * Boost materials are stored permanently in the warehouse (not consumed).
     */
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

    /**
     * Expand a division to all 6 cities and purchase warehouses everywhere.
     * Idempotent — skips cities/warehouses that already exist.
     */
    function expandToAllCities(div) {
        const existing = c.getDivision(div).cities;
        for (const city of CITIES) {
            if (!existing.includes(city)) c.expandCity(div, city);
        }
        for (const city of CITIES) {
            if (!c.hasWarehouse(div, city)) c.purchaseWarehouse(div, city);
        }
    }

    /** Buy an unlock if not already owned. */
    function buyUnlock(name) {
        try {
            if (!c.getUnlocks().includes(name)) {
                c.purchaseUnlock(name);
                log(ns, `  Purchased unlock: ${name}`, false, 'info');
            }
        } catch (e) {
            log(ns, `  WARN: Could not buy unlock "${name}": ${e?.message}`, false, 'warning');
        }
    }

    /** Enable Smart Supply on every city of a division that has a warehouse. */
    function enableSmartSupply(div) {
        for (const city of CITIES) {
            if (c.hasWarehouse(div, city)) c.setSmartSupply(div, city, true);
        }
    }

    /** Boost energy and morale for all cities of a division. */
    function boostMorale(div) {
        for (const city of CITIES) {
            try { c.buyCoffee(div, city); } catch { /* ignore if can't afford */ }
            try { c.throwParty(div, city, 500e3); } catch { /* ignore */ }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 0 — Create corp + buy essential unlocks
    // ─────────────────────────────────────────────────────────────────────────
    if (!c.hasCorporation()) {
        log(ns, `INFO: Creating "${CORP_NAME}"...`, true, 'info');
        // selfFund=true  →  free seed money in BN3; costs $150 B from player funds elsewhere
        const ok = c.createCorporation(CORP_NAME, true);
        if (!ok) {
            log(ns, 'ERROR: Could not create corporation. Need SF3 or $150 B player funds.', true, 'error');
            return;
        }
        await waitCycles(1);
    }

    const corp0 = c.getCorporation();
    log(ns, `INFO: "${corp0.name}" active. Funds: ${formatMoney(corp0.funds)}`, true);

    // WarehouseAPI and OfficeAPI must be bought BEFORE any warehouse/office API
    // calls will work. Buy these first, then the rest.
    for (const name of [UNLOCKS.warehouseAPI, UNLOCKS.officeAPI,
                        UNLOCKS.smartSupply,  UNLOCKS.export,
                        UNLOCKS.mktDemand,    UNLOCKS.mktComp]) {
        buyUnlock(name);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1 — Agriculture: all cities, offices, warehouses, boost materials
    // ─────────────────────────────────────────────────────────────────────────
    if (!c.getCorporation().divisions.includes(DIV_AGRI)) {
        log(ns, `INFO: Expanding into Agriculture ($40 B)...`, true, 'info');
        c.expandIndustry(IND_AGRI, DIV_AGRI);
    }
    expandToAllCities(DIV_AGRI);
    enableSmartSupply(DIV_AGRI);

    // Initial offices: 9 employees, Operations-weighted (material division)
    for (const city of CITIES) {
        fillOffice(DIV_AGRI, city, 9, { ops: 4, eng: 2, biz: 1, mgmt: 1, rnd: 1 });
    }
    boostMorale(DIV_AGRI);
    await waitCycles(1); // Let morale / energy settle

    // Agri also produces Food — sell it on the open market
    for (const city of CITIES) {
        c.sellMaterial(DIV_AGRI, city, 'Food', 'MAX', 'MP');
    }

    // Phase 1 boost materials
    log(ns, 'INFO: Applying Phase 1 Agriculture boost materials...', true);
    for (const city of CITIES) {
        await applyBoostMaterials(DIV_AGRI, city, AGRI_BOOST_INIT);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2 — Wait for and accept investment round 1
    // ─────────────────────────────────────────────────────────────────────────
    log(ns, `INFO: Waiting for round-1 offer ≥ ${formatMoney(MIN_ROUND1)}...`, true);
    while (true) {
        await waitCycles(2);
        // Keep morale up and buy cheap warehouse upgrades while waiting
        boostMorale(DIV_AGRI);
        if (c.getCorporation().funds > 5e9) {
            for (const city of CITIES) {
                try {
                    if (c.getWarehouse(DIV_AGRI, city).level < 3) {
                        c.upgradeWarehouse(DIV_AGRI, city, 1);
                    }
                } catch { /* ignore */ }
            }
        }
        const offer = c.getInvestmentOffer();
        log(ns, `  Round ${offer.round} offer: ${formatMoney(offer.funds)}`, false);
        if (offer.round === 1 && offer.funds >= MIN_ROUND1) {
            c.acceptInvestmentOffer();
            log(ns, `INFO: Accepted Round 1 — received ${formatMoney(offer.funds)}!`, true, 'success');
            break;
        }
    }
    await waitCycles(1);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3 — Launch Tobacco + Water; supply chain; first product; scale Agri
    // ─────────────────────────────────────────────────────────────────────────
    log(ns, 'INFO: Phase 3 — launching Tobacco and Water divisions...', true);

    // Scale Agriculture now that we have funds
    for (const city of CITIES) {
        fillOffice(DIV_AGRI, city, 15, { ops: 6, eng: 3, biz: 1, mgmt: 3, rnd: 2 });
    }
    boostMorale(DIV_AGRI);
    log(ns, 'INFO: Applying Phase 2 Agriculture boost materials...', true);
    for (const city of CITIES) {
        await applyBoostMaterials(DIV_AGRI, city, AGRI_BOOST_P2);
    }

    // Water Utilities — provides Water to Agriculture
    if (!c.getCorporation().divisions.includes(DIV_WATER)) {
        log(ns, `INFO: Expanding into Water Utilities ($150 B)...`, true, 'info');
        c.expandIndustry(IND_WATER, DIV_WATER);
    }
    expandToAllCities(DIV_WATER);
    enableSmartSupply(DIV_WATER);
    for (const city of CITIES) {
        fillOffice(DIV_WATER, city, 9, { ops: 5, eng: 2, biz: 0, mgmt: 1, rnd: 1 });
    }
    boostMorale(DIV_WATER);
    // Sell surplus Water (what doesn't get exported)
    for (const city of CITIES) {
        c.sellMaterial(DIV_WATER, city, 'Water', 'MAX', 'MP');
    }
    log(ns, 'INFO: Applying Water boost materials...', true);
    for (const city of CITIES) {
        await applyBoostMaterials(DIV_WATER, city, WATER_BOOST);
    }

    // Tobacco — main product division
    if (!c.getCorporation().divisions.includes(DIV_TOBACCO)) {
        log(ns, `INFO: Expanding into Tobacco ($20 B)...`, true, 'info');
        c.expandIndustry(IND_TOBACCO, DIV_TOBACCO);
    }
    expandToAllCities(DIV_TOBACCO);
    enableSmartSupply(DIV_TOBACCO);

    // HQ gets a larger office (product design quality scales with employee count)
    fillOffice(DIV_TOBACCO, HQ_CITY, 18,
        { ops: 5, eng: 5, biz: 2, mgmt: 4, rnd: 2 });
    for (const city of CITIES.filter(ct => ct !== HQ_CITY)) {
        fillOffice(DIV_TOBACCO, city, 9,
            { ops: 3, eng: 2, biz: 1, mgmt: 2, rnd: 1 });
    }
    boostMorale(DIV_TOBACCO);

    // ── Supply chain: per-city exports ───────────────────────────────────────
    // Water[city] → Agri[city] (Water is needed at 0.5 per Plants unit)
    // Agri[city]  → Tobacco[city] (Plants at 1 per product unit)
    //
    // Using 'PROD' exports all production; Smart Supply with 'leftovers' option
    // on the receiving side avoids double-buying from the market.
    log(ns, 'INFO: Setting up supply-chain exports...', true);
    for (const city of CITIES) {
        try { c.exportMaterial(DIV_WATER, city, DIV_AGRI,    city, 'Water',  'PROD'); } catch { /* already set */ }
        try { c.exportMaterial(DIV_AGRI,  city, DIV_TOBACCO, city, 'Plants', 'PROD'); } catch { /* already set */ }
        // Tell Smart Supply to only top-up what the export doesn't cover
        try { c.setSmartSupplyOption(DIV_AGRI,    city, 'Water',  'leftovers'); } catch { /* API may not support */ }
        try { c.setSmartSupplyOption(DIV_TOBACCO,  city, 'Plants', 'leftovers'); } catch { /* API may not support */ }
    }

    // ── Upgrade warehouses enough to store boost materials + production ────
    for (const div of [DIV_TOBACCO, DIV_AGRI, DIV_WATER]) {
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(div, city);
                if (wh.level < 3) c.upgradeWarehouse(div, city, 3 - wh.level);
            } catch { /* ignore */ }
        }
    }

    // ── Start first Tobacco product ──────────────────────────────────────────
    const FIRST_PRODUCT = 'Tobac-v1';
    const tobDiv = c.getDivision(DIV_TOBACCO);
    if (!tobDiv.products.includes(FIRST_PRODUCT)) {
        const funds = c.getCorporation().funds;
        const invest = Math.min(funds * 0.05, 2e9); // design + marketing split equally
        try {
            c.makeProduct(DIV_TOBACCO, HQ_CITY, FIRST_PRODUCT, invest / 2, invest / 2);
            log(ns, `INFO: Started developing "${FIRST_PRODUCT}" (${formatMoney(invest)} total invest)`, true, 'info');
        } catch (e) {
            log(ns, `WARN: Could not start first product: ${e?.message}`, false, 'warning');
        }
    }

    // Buy first corp-wide upgrades
    for (const upg of ['Smart Factories', 'Smart Storage', 'ABC SalesBots',
                       'Nuoptimal Nootropic Injector Implants', 'Neural Accelerators',
                       'FocusWires', 'Speech Processor Implants']) {
        try {
            if (c.getCorporation().funds > c.getUpgradeLevelCost(upg) * 2) {
                c.levelUpgrade(upg);
            }
        } catch { /* ignore */ }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 4 — Wait for and accept investment round 2
    // ─────────────────────────────────────────────────────────────────────────
    log(ns, `INFO: Waiting for round-2 offer ≥ ${formatMoney(MIN_ROUND2)}...`, true);

    // Research priority list for Tobacco while waiting
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

    // Material-division research (no product-specific entries)
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

        // Ongoing maintenance while waiting
        for (const div of [DIV_TOBACCO, DIV_AGRI, DIV_WATER]) {
            boostMorale(div);
        }

        // Price finished products temporarily (Market-TA.II not available yet)
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
            } catch { /* product not ready or already set */ }
        }

        // Research: Tobacco
        for (const rName of RESEARCH_QUEUE) {
            try {
                if (!c.hasResearched(DIV_TOBACCO, rName)) {
                    const div = c.getDivision(DIV_TOBACCO);
                    if (div.researchPoints >= c.getResearchCost(DIV_TOBACCO, rName)) {
                        c.research(DIV_TOBACCO, rName);
                        log(ns, `INFO: Researched "${rName}" (Tobacco)`, false, 'info');
                    }
                }
            } catch { /* not yet unlocked in tree */ }
        }

        // Research: Agriculture + Water
        for (const [div, queue] of [[DIV_AGRI, MAT_RESEARCH_QUEUE], [DIV_WATER, MAT_RESEARCH_QUEUE]]) {
            for (const rName of queue) {
                try {
                    if (!c.hasResearched(div, rName)) {
                        const d = c.getDivision(div);
                        if (d.researchPoints >= c.getResearchCost(div, rName)) {
                            c.research(div, rName);
                            log(ns, `INFO: Researched "${rName}" (${div})`, false, 'info');
                        }
                    }
                } catch { /* ignore */ }
            }
        }

        // Buy upgrades with available cash
        const funds = c.getCorporation().funds;
        for (const upg of ['Smart Factories', 'Smart Storage',
                           'Nuoptimal Nootropic Injector Implants', 'Neural Accelerators',
                           'FocusWires', 'Speech Processor Implants',
                           'ABC SalesBots', 'Wilson Analytics']) {
            try {
                if (funds > c.getUpgradeLevelCost(upg) * 1.5) c.levelUpgrade(upg);
            } catch { /* ignore */ }
        }

        const offer = c.getInvestmentOffer();
        log(ns, `  Round ${offer.round} offer: ${formatMoney(offer.funds)}`, false);
        if (offer.round === 2 && offer.funds >= MIN_ROUND2) {
            c.acceptInvestmentOffer();
            log(ns, `INFO: Accepted Round 2 — received ${formatMoney(offer.funds)}!`, true, 'success');
            break;
        }
    }
    await waitCycles(1);

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5 — Final setup scaling before handoff
    // ─────────────────────────────────────────────────────────────────────────
    log(ns, 'INFO: Phase 5 — final scaling pass...', true);

    // Scale up all offices significantly with round-2 funds
    for (const city of CITIES) {
        const isHQ = city === HQ_CITY;
        fillOffice(DIV_TOBACCO, city,
            isHQ ? 30 : 20,
            isHQ
                ? { ops: 9, eng: 8, biz: 3, mgmt: 7, rnd: 3 }
                : { ops: 6, eng: 4, biz: 2, mgmt: 5, rnd: 3 });
        fillOffice(DIV_AGRI,  city, 20, { ops: 8, eng: 4, biz: 1, mgmt: 4, rnd: 3 });
        fillOffice(DIV_WATER, city, 15, { ops: 7, eng: 3, biz: 0, mgmt: 3, rnd: 2 });
    }

    // Warehouse upgrades — ensure enough space for boost materials + production
    for (const div of [DIV_TOBACCO, DIV_AGRI, DIV_WATER]) {
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(div, city);
                if (wh.level < 6) c.upgradeWarehouse(div, city, 6 - wh.level);
            } catch { /* ignore */ }
        }
    }

    // Agri: top-up boost materials with round-2 budget
    log(ns, 'INFO: Topping up Agriculture boost materials...', true);
    const AGRI_BOOST_FINAL = { 'Real Estate': 10000, 'Hardware': 500, 'Robots': 60, 'AI Cores': 400 };
    const WATER_BOOST_FINAL = { 'Real Estate': 3000, 'Robots': 50, 'AI Cores': 200 };
    for (const city of CITIES) {
        await applyBoostMaterials(DIV_AGRI,  city, AGRI_BOOST_FINAL);
        await applyBoostMaterials(DIV_WATER, city, WATER_BOOST_FINAL);
    }

    boostMorale(DIV_TOBACCO);
    boostMorale(DIV_AGRI);
    boostMorale(DIV_WATER);

    // Buy an advert for Tobacco to kick-start awareness
    try {
        if (c.getCorporation().funds > c.getHireAdVertCost(DIV_TOBACCO) * 2) {
            c.hireAdVert(DIV_TOBACCO);
            log(ns, 'INFO: Hired AdVert for Tobacco.', false, 'info');
        }
    } catch { /* ignore */ }

    // ─────────────────────────────────────────────────────────────────────────
    // Done — signal autopilot to take over
    // ─────────────────────────────────────────────────────────────────────────
    ns.write(SETUP_DONE_FLAG, 'true', 'w');
    log(ns, '═══════════════════════════════════════════════════════', true);
    log(ns, 'INFO: Setup complete! Handing off to corp-autopilot.js.', true, 'success');
    log(ns, '═══════════════════════════════════════════════════════', true);

    const autopilotScript = resolvePath('corp-autopilot', 'corp/corp-autopilot.js');
    if (!ns.isRunning(autopilotScript)) {
        ns.run(autopilotScript);
    }
}