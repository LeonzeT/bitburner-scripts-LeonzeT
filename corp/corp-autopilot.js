/**
 * corp/corp-autopilot.js  —  Corporation manager (ongoing loop)
 *
 * Takes over after corp-setup.js finishes.  Every ~15 s it:
 *
 *   • Hires and assigns employees as offices grow affordable
 *   • Buys corp-wide upgrades in priority order
 *   • Buys division research in priority order
 *   • Manages Tobacco products — develops new ones, prices finished ones,
 *     discontinues the lowest-rated product when at capacity
 *   • Buys AdVert for Tobacco to grow awareness / popularity
 *   • Upgrades warehouses to prevent production bottlenecks
 *   • Applies boost materials whenever the budget allows
 *   • Takes investment rounds 3 and 4 at the right thresholds
 *   • Goes public after round 4 with an IPO
 *   • Issues dividends after going public
 *
 * Tunable flags
 * ─────────────
 *   --min-round3   Minimum offer to accept for round 3   (default $50 T)
 *   --min-round4   Minimum offer to accept for round 4   (default $500 T)
 *   --ipo-shares   Shares to issue at IPO (default 100 M = 10 % of 1 B total)
 *   --dividend     Dividend rate after IPO, 0–1           (default 0.05)
 *   --interval     Loop sleep in ms                       (default 15 000)
 *
 * @param {NS} ns
 */
import { log, formatMoney } from '/helpers.js';

// ── Division / industry identifiers ──────────────────────────────────────────
const DIV_TOBACCO = 'Tobacco';
const DIV_AGRI    = 'Agriculture';
const DIV_WATER   = 'Water';
const HQ_CITY     = 'Sector-12';
const CITIES      = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];

// ── Exact job / upgrade / research strings from Enums.ts ─────────────────────
const JOBS = {
    ops:        'Operations',
    eng:        'Engineer',
    biz:        'Business',
    mgmt:       'Management',
    rnd:        'Research & Development',
    intern:     'Intern',
    unassigned: 'Unassigned',
};

// Corp-wide upgrades in purchase priority order.
// (source: CorporationUpgrades.ts — basePrice, benefit)
const UPGRADE_PRIORITY = [
    // Directly boosts production across every division
    'Smart Factories',
    // Employee stat augments — all four give equal +10% to a different stat;
    // buy them as a group so the benefit is balanced
    'Nuoptimal Nootropic Injector Implants',   // creativity
    'Neural Accelerators',                      // intelligence
    'FocusWires',                               // efficiency
    'Speech Processor Implants',                // charisma
    // Boosts sales 1% per level — important for high product volume
    'ABC SalesBots',
    // Advertising effectiveness — needed once we start buying many AdVerts
    'Wilson Analytics',
    // Warehouse storage — buy reactively (we check usage; see manageWarehouses)
    'Smart Storage',
    // Research production — lower priority since we buy it in bulk
    'Project Insight',
];

// Max upgrade level per upgrade name before we stop buying automatically.
// Set to Infinity to buy without limit.
const UPGRADE_CAP = {
    'Smart Factories':                         Infinity,
    'Nuoptimal Nootropic Injector Implants':   Infinity,
    'Neural Accelerators':                     Infinity,
    'FocusWires':                              Infinity,
    'Speech Processor Implants':               Infinity,
    'ABC SalesBots':                           Infinity,
    'Wilson Analytics':                        Infinity,
    'Smart Storage':                           Infinity,
    'Project Insight':                         20,
};

// Research queues — Tobacco is a product industry and has extra researches.
const TOBACCO_RESEARCH_QUEUE = [
    'Hi-Tech R&D Laboratory',   // must be first; unlocks all others
    'Market-TA.I',              // show markup info
    'Market-TA.II',             // CRITICAL: auto-optimal pricing
    'uPgrade: Fulcrum',         // +5% product production
    'uPgrade: Capacity.I',      // product slots: 3 → 4
    'uPgrade: Capacity.II',     // product slots: 4 → 5
    'Drones',                   // prerequisite
    'Drones - Assembly',        // +20% material production
    'Self-Correcting Assemblers',// +10% material production
    'Drones - Transport',       // +50% warehouse size
    'Overclock',                // +25% employee int + eff
    'CPH4 Injections',          // +10% all employee stats (needs Automatic Drug Administration)
    'Automatic Drug Administration', // prerequisite for CPH4
    'AutoBrew',                 // keep energy maxed automatically
    'AutoPartyManager',         // keep morale maxed automatically
    'HRBuddy-Recruitment',      // auto-hire
    'HRBuddy-Training',         // auto-train
];

const MAT_RESEARCH_QUEUE = [
    'Hi-Tech R&D Laboratory',
    'Drones',
    'Drones - Assembly',
    'Self-Correcting Assemblers',
    'Drones - Transport',
    'Overclock',
    'Automatic Drug Administration',
    'CPH4 Injections',
    'AutoBrew',
    'AutoPartyManager',
    'HRBuddy-Recruitment',
    'HRBuddy-Training',
];

// Boost material targets per city — keyed by phase.
// Stored permanently in warehouse; boost productionMult via
//   Math.pow(0.002 × stored + 1, factor)
const BOOST_TARGETS = {
    [DIV_AGRI]: [
        // Phase  stored target per material           triggered when office ≥ size
        { size: 15, targets: { 'Real Estate': 5000,  'Hardware': 300, 'Robots': 30,  'AI Cores': 200  } },
        { size: 30, targets: { 'Real Estate': 10000, 'Hardware': 500, 'Robots': 60,  'AI Cores': 400  } },
        { size: 60, targets: { 'Real Estate': 20000, 'Hardware': 800, 'Robots': 150, 'AI Cores': 800  } },
    ],
    [DIV_WATER]: [
        { size: 15, targets: { 'Real Estate': 3000,  'Robots': 50,  'AI Cores': 200 } },
        { size: 30, targets: { 'Real Estate': 8000,  'Robots': 100, 'AI Cores': 500 } },
        { size: 60, targets: { 'Real Estate': 16000, 'Robots': 200, 'AI Cores': 900 } },
    ],
};

// Market cycle duration (source: secondsPerMarketCycle = 50 cycles × 200 ms / 1000)
const CYCLE_SECS = 10;

// Product name prefix — products are named Tobac-v1, Tobac-v2, etc.
const PRODUCT_PREFIX = 'Tobac-v';

// ── Args schema ───────────────────────────────────────────────────────────────
const argsSchema = [
    ['min-round3',  50e12],   // $50 T
    ['min-round4',  500e12],  // $500 T
    ['ipo-shares',  100e6],   // 100 M (10 % of 1 B total shares)
    ['dividend',    0.05],    // 5 % of cycle profit paid as dividends
    ['interval',    15000],   // 15 s loop
    ['no-tail',     false],
];

export function autocomplete(data) { data.flags(argsSchema); return []; }

// ═════════════════════════════════════════════════════════════════════════════
export async function main(ns) {
    const opts = ns.flags(argsSchema);
    ns.disableLog('ALL');
    if (!opts['no-tail']) ns.ui.openTail();

    if (!ns.corporation.hasCorporation()) {
        log(ns, 'ERROR: No corporation found. Run corp.js first.', true, 'error');
        return;
    }

    const c = ns.corporation; // shorthand

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Zero all job assignments then apply the desired distribution.
     * Must zero first to avoid "total exceeds office size" errors.
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
     * Compute the desired job distribution for `n` employees.
     *
     * Tobacco HQ (product design):
     *   Maximises getOfficeProductivity() via (ops^0.4 + eng^0.3) * mgmtFactor.
     *   Management factor = 1 + mgmt / (1.2 * total).  Roughly equal ops/eng/mgmt
     *   with a slice of Business (sales) and R&D (research points).
     *
     * Tobacco satellite and material divisions:
     *   Material production only uses ops + eng + mgmt.  No business needed
     *   beyond a token 1 to avoid zero-sales issues; R&D generates research.
     */
    function computeJobDistribution(div, city, n) {
        if (div === DIV_TOBACCO && city === HQ_CITY) {
            // HQ: product design — balanced with more mgmt for the mgmtFactor bonus
            const rnd  = Math.max(1, Math.round(n * 0.10));
            const biz  = Math.max(1, Math.round(n * 0.12));
            const eng  = Math.max(1, Math.round(n * 0.22));
            const mgmt = Math.max(1, Math.round(n * 0.28));
            const ops  = Math.max(1, n - rnd - biz - eng - mgmt);
            return { ops, eng, biz, mgmt, rnd };
        }
        if (div === DIV_TOBACCO) {
            // Satellite: production focused
            const rnd  = Math.max(1, Math.round(n * 0.10));
            const biz  = Math.max(1, Math.round(n * 0.08));
            const eng  = Math.max(1, Math.round(n * 0.22));
            const mgmt = Math.max(1, Math.round(n * 0.28));
            const ops  = Math.max(1, n - rnd - biz - eng - mgmt);
            return { ops, eng, biz, mgmt, rnd };
        }
        // Material division (Agri / Water): ops-heavy
        const rnd  = Math.max(1, Math.round(n * 0.10));
        const eng  = Math.max(1, Math.round(n * 0.20));
        const mgmt = Math.max(1, Math.round(n * 0.20));
        const ops  = Math.max(1, n - rnd - eng - mgmt);
        return { ops, eng, biz: 0, mgmt, rnd };
    }

    /**
     * Scale an office to `targetSize`, hire up to full, and rebalance jobs.
     * Returns true if any hiring or upgrade happened.
     */
    function scaleOffice(div, city, targetSize) {
        let changed = false;
        const office = c.getOffice(div, city);
        if (office.size < targetSize) {
            c.upgradeOfficeSize(div, city, targetSize - office.size);
            changed = true;
        }
        const numEmployees = c.getOffice(div, city).numEmployees;
        for (let i = numEmployees; i < targetSize; i++) {
            c.hireEmployee(div, city, JOBS.unassigned);
            changed = true;
        }
        if (changed) assignJobs(div, city, computeJobDistribution(div, city, targetSize));
        return changed;
    }

    /**
     * Buy boost materials for one city in one market cycle then stop.
     * Only buys what is still below target; skips materials already topped up.
     * Non-blocking — caller must await a cycle sleep after calling this.
     */
    function scheduleBoostedMaterials(div, city, targets) {
        let needed = false;
        for (const [mat, target] of Object.entries(targets)) {
            const stored = c.getMaterial(div, city, mat).stored;
            const delta  = Math.max(0, target - stored);
            if (delta > 0) {
                c.buyMaterial(div, city, mat, delta / CYCLE_SECS);
                needed = true;
            }
        }
        return needed;
    }

    function stopBuyingBoostMaterials(div, city, targets) {
        for (const mat of Object.keys(targets)) {
            try { c.buyMaterial(div, city, mat, 0); } catch { /* ignore */ }
        }
    }

    /** Boost energy / morale for every city in a division. */
    function boostMorale(div) {
        for (const city of CITIES) {
            try { c.buyCoffee(div, city); } catch { /* not affordable */ }
            try { c.throwParty(div, city, 500e3); } catch { /* not affordable */ }
        }
    }

    /**
     * Buy a corp-wide upgrade if we can afford it comfortably and haven't hit
     * the cap for that upgrade.
     */
    function buyUpgradesIfAffordable(corp) {
        for (const upgName of UPGRADE_PRIORITY) {
            const level = c.getUpgradeLevel(upgName);
            if (level >= (UPGRADE_CAP[upgName] ?? Infinity)) continue;
            const cost = c.getUpgradeLevelCost(upgName);
            // Keep at least 10 % of funds as buffer
            if (corp.funds > cost * 1.25) {
                try { c.levelUpgrade(upgName); } catch { /* ignore */ }
            }
        }
    }

    /**
     * Buy research from the queue for a division, spending up to half of
     * current research points so we don't blow everything on early entries.
     */
    function buyResearch(divName, queue) {
        const div = c.getDivision(divName);
        for (const rName of queue) {
            try {
                if (c.hasResearched(divName, rName)) continue;
                const cost = c.getResearchCost(divName, rName);
                // Hold back 50 % of points as reserve for unlocking prerequisites
                if (div.researchPoints >= cost * 2) {
                    c.research(divName, rName);
                    log(ns, `  Researched "${rName}" (${divName})`, false, 'info');
                }
            } catch { /* not yet in tree, or already researched */ }
        }
    }

    /**
     * Determine the next sequential product name for the Tobacco division.
     * Looks at existing products to find the highest version number.
     */
    function nextProductName() {
        const products = c.getDivision(DIV_TOBACCO).products;
        let max = 0;
        for (const p of products) {
            if (p.startsWith(PRODUCT_PREFIX)) {
                const n = parseInt(p.slice(PRODUCT_PREFIX.length), 10);
                if (!isNaN(n) && n > max) max = n;
            }
        }
        return `${PRODUCT_PREFIX}${max + 1}`;
    }

    /**
     * Returns the maximum number of products Tobacco can currently hold.
     * Base = 3; +1 per Capacity research.
     */
    function maxProducts() {
        let cap = 3;
        if (c.hasResearched(DIV_TOBACCO, 'uPgrade: Capacity.I'))  cap++;
        if (c.hasResearched(DIV_TOBACCO, 'uPgrade: Capacity.II')) cap++;
        return cap;
    }

    /**
     * Manage Tobacco product lifecycle:
     *   1. If a slot is free, start developing a new product.
     *   2. If at max capacity, discontinue the oldest / lowest-rated finished
     *      product to make room for a fresh one.
     *   3. Price all finished products.
     */
    function manageProducts(corp) {
        const div      = c.getDivision(DIV_TOBACCO);
        const products = div.products;
        const cap      = maxProducts();

        // Work out which products are done and which are still developing
        const done = [], developing = [];
        for (const pName of products) {
            try {
                const p = c.getProduct(DIV_TOBACCO, HQ_CITY, pName);
                if (p.developmentProgress >= 100) done.push(pName);
                else developing.push(pName);
            } catch { /* product data not ready yet */ }
        }

        // Price all finished products
        const hasTA2 = c.hasResearched(DIV_TOBACCO, 'Market-TA.II');
        const hasTA1 = c.hasResearched(DIV_TOBACCO, 'Market-TA.I');
        for (const pName of done) {
            try {
                if (hasTA2) {
                    c.setProductMarketTA2(DIV_TOBACCO, pName, true);
                } else if (hasTA1) {
                    c.setProductMarketTA1(DIV_TOBACCO, pName, true);
                    // TA.I shows markup info; set a reasonable manual price
                    c.sellProduct(DIV_TOBACCO, HQ_CITY, pName, 'MAX', 'MP*2', true);
                } else {
                    // No TA yet — use a generous multiplier; autopilot will upgrade
                    c.sellProduct(DIV_TOBACCO, HQ_CITY, pName, 'MAX', 'MP*4', true);
                }
            } catch { /* price already optimal or product mid-develop */ }
        }

        // Start a new product if we have a free slot and no product in development
        if (products.length < cap && developing.length === 0) {
            const invest = Math.min(corp.funds * 0.05, 5e9);
            if (invest >= 1e6) {
                const pName = nextProductName();
                try {
                    c.makeProduct(DIV_TOBACCO, HQ_CITY, pName, invest / 2, invest / 2);
                    log(ns, `  Started developing "${pName}" (${formatMoney(invest)} invest)`, true, 'info');
                } catch(e) {
                    log(ns, `  WARN: Could not start "${pName}": ${e?.message}`, false, 'warning');
                }
            }
            return;
        }

        // At max capacity and no dev slot free — discontinue oldest finished product
        // to free a slot (done products ordered oldest first = lowest version number)
        if (products.length >= cap && developing.length === 0 && done.length >= cap) {
            // Find the lowest-numbered product to discontinue
            let oldest = null, oldestVer = Infinity;
            for (const pName of done) {
                const ver = parseInt(pName.slice(PRODUCT_PREFIX.length), 10);
                if (!isNaN(ver) && ver < oldestVer) { oldestVer = ver; oldest = pName; }
            }
            if (oldest) {
                c.discontinueProduct(DIV_TOBACCO, oldest);
                log(ns, `  Discontinued "${oldest}" to free a product slot.`, true, 'info');
            }
        }
    }

    /**
     * Upgrade warehouse level if used storage exceeds 80 % of capacity.
     * Also buys Smart Storage corp upgrades reactively when warehouses are
     * repeatedly hitting the ceiling.
     */
    function manageWarehouses() {
        for (const div of [DIV_TOBACCO, DIV_AGRI, DIV_WATER]) {
            for (const city of CITIES) {
                try {
                    const wh = c.getWarehouse(div, city);
                    if (wh.sizeUsed / wh.size > 0.80) {
                        c.upgradeWarehouse(div, city, 1);
                    }
                } catch { /* ignore */ }
            }
        }
    }

    /**
     * Determine the correct office scaling tier based on corp revenue.
     * Returns { tobHQ, tobSat, mat } — target office sizes for this tier.
     */
    function officeScaleTier(revenue) {
        // Revenue tiers (per second, from getCorporation().revenue)
        if (revenue < 1e9)   return { tobHQ: 18,  tobSat:  9, mat:  9  };
        if (revenue < 10e9)  return { tobHQ: 30,  tobSat: 20, mat: 15  };
        if (revenue < 100e9) return { tobHQ: 45,  tobSat: 30, mat: 25  };
        if (revenue < 1e12)  return { tobHQ: 60,  tobSat: 45, mat: 35  };
        if (revenue < 10e12) return { tobHQ: 90,  tobSat: 60, mat: 50  };
        if (revenue < 100e12)return { tobHQ: 120, tobSat: 75, mat: 60  };
                              return { tobHQ: 150, tobSat: 90, mat: 75  };
    }

    /**
     * Scale offices across all divisions to match the current revenue tier.
     * Only grows — never shrinks.
     */
    function manageOffices(corp) {
        const tier = officeScaleTier(corp.revenue);
        for (const city of CITIES) {
            scaleOffice(DIV_TOBACCO, city, city === HQ_CITY ? tier.tobHQ : tier.tobSat);
            scaleOffice(DIV_AGRI,  city, tier.mat);
            scaleOffice(DIV_WATER, city, tier.mat);
        }
    }

    /**
     * Apply boost materials for a division if the office has grown into a new
     * tier and the warehouse can accommodate the boost.
     */
    async function manageBoostedMaterials(div) {
        const tiers = BOOST_TARGETS[div];
        if (!tiers) return;
        for (const city of CITIES) {
            const office = c.getOffice(div, city);
            // Find the highest tier this office qualifies for
            let targets = null;
            for (const tier of tiers) {
                if (office.numEmployees >= tier.size) targets = tier.targets;
            }
            if (!targets) continue;
            const needed = scheduleBoostedMaterials(div, city, targets);
            if (needed) {
                await ns.sleep(CYCLE_SECS * 1100); // one cycle
                stopBuyingBoostMaterials(div, city, targets);
            }
        }
    }

    /**
     * Buy AdVerts for Tobacco whenever we have 5× the current advert cost
     * in free funds (keeps growing awareness / popularity).
     */
    function manageAdverts(corp) {
        try {
            const cost = c.getHireAdVertCost(DIV_TOBACCO);
            if (corp.funds > cost * 5) {
                c.hireAdVert(DIV_TOBACCO);
                log(ns, `  Hired AdVert #${c.getHireAdVertCount(DIV_TOBACCO)} for Tobacco`, false, 'info');
            }
        } catch { /* ignore */ }
    }

    /**
     * Handle investment rounds 3 and 4, then IPO.
     * After going public: set dividend rate.
     * Returns true if something was done (so we can log a header line).
     */
    function manageFinancing(corp) {
        if (corp.public) {
            // Already public — ensure dividends are set
            if (corp.dividendRate !== opts.dividend) {
                try { c.issueDividends(opts.dividend); } catch { /* ignore */ }
            }
            return;
        }

        const offer = c.getInvestmentOffer();

        if (offer.round === 3 && offer.funds >= opts['min-round3']) {
            c.acceptInvestmentOffer();
            log(ns, `INFO: Accepted Round 3 — received ${formatMoney(offer.funds)}!`, true, 'success');
            return;
        }

        if (offer.round === 4 && offer.funds >= opts['min-round4']) {
            c.acceptInvestmentOffer();
            log(ns, `INFO: Accepted Round 4 — received ${formatMoney(offer.funds)}!`, true, 'success');
            return;
        }

        // Go public after all 4 investment rounds are done
        if (offer.round > 4) {
            try {
                c.goPublic(opts['ipo-shares']);
                log(ns, `INFO: Went public! Issued ${(opts['ipo-shares'] / 1e6).toFixed(0)} M shares.`, true, 'success');
                c.issueDividends(opts.dividend);
                log(ns, `INFO: Dividends set to ${(opts.dividend * 100).toFixed(0)} % of cycle profit.`, true, 'success');
            } catch(e) {
                log(ns, `WARN: IPO failed: ${e?.message}`, false, 'warning');
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Main loop
    // ─────────────────────────────────────────────────────────────────────────
    log(ns, 'INFO: corp-autopilot running.', true, 'info');

    while (true) {
        await ns.sleep(opts.interval);

        try {
            const corp = c.getCorporation();

            // Status line every iteration
            const offer = corp.public ? null : c.getInvestmentOffer();
            const statusLine = corp.public
                ? `[PUBLIC] Rev: ${formatMoney(corp.revenue)}/s  Profit: ${formatMoney(corp.revenue - corp.expenses)}/s  Dividends: ${(corp.dividendRate * 100).toFixed(0)}%`
                : `[PRIVATE R${offer?.round ?? '?'}] Rev: ${formatMoney(corp.revenue)}/s  Offer: ${formatMoney(offer?.funds ?? 0)}`;
            log(ns, statusLine, false);

            // ── Core management steps ─────────────────────────────────────────
            manageOffices(corp);
            manageWarehouses();
            buyUpgradesIfAffordable(corp);

            // Research all three divisions
            buyResearch(DIV_TOBACCO, TOBACCO_RESEARCH_QUEUE);
            buyResearch(DIV_AGRI,    MAT_RESEARCH_QUEUE);
            buyResearch(DIV_WATER,   MAT_RESEARCH_QUEUE);

            // Products and pricing
            manageProducts(corp);

            // Advertising
            manageAdverts(corp);

            // Morale — skip if AutoBrew/AutoPartyManager are researched
            const autoMorale = c.hasResearched(DIV_TOBACCO, 'AutoBrew') &&
                               c.hasResearched(DIV_TOBACCO, 'AutoPartyManager');
            if (!autoMorale) {
                boostMorale(DIV_TOBACCO);
                boostMorale(DIV_AGRI);
                boostMorale(DIV_WATER);
            }

            // Boost materials — runs async internally but doesn't block the main loop
            // (it schedules a one-cycle buy and stops; any actual sleep is minimal)
            await manageBoostedMaterials(DIV_AGRI);
            await manageBoostedMaterials(DIV_WATER);

            // Financing: investment rounds 3/4 and IPO
            manageFinancing(corp);

        } catch (err) {
            // Never let a transient error kill the loop
            log(ns, `WARN: Loop iteration error: ${err?.message ?? err}`, false, 'warning');
        }
    }
}