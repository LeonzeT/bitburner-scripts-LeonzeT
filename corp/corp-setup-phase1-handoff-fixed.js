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
const CORP_NAME   = 'Nite-Corp';
const DIV_TOBACCO = 'Tobacco';
const DIV_AGRI    = 'Agriculture';
const DIV_CHEM    = 'Chemical';
const IND_TOBACCO = 'Tobacco';
const IND_AGRI    = 'Agriculture';
const IND_CHEM    = 'Chemical';

// ── Geography ─────────────────────────────────────────────────────────────────
const CITIES  = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];
const HQ_CITY = 'Sector-12';

// ── Investment thresholds ─────────────────────────────────────────────────────
// Round 1 (10% dilution, offer = val×0.3): need enough post-acceptance funds
// to cover Chemical ($70B) + Tobacco ($20B) + city expansions (~50B each) + buffer.
// 210B requires ~2M/s profit — achievable ceiling for 4-employee Agri with boosts.
// At 25B we accepted with nothing left to fund Phase 3 → infinite crash loop.
const MIN_ROUND1 = 26e9;
const MIN_ROUND2 = 5e12;

// ── RP targets before the quality loop is strong enough (from docs) ───────────
// "Waiting for 700RP/390RP in Agriculture/Chemical respectively is enough."
const RP_TARGET_AGRI = 700;
const RP_TARGET_CHEM = 390;

// ── Flags / temp files ────────────────────────────────────────────────────────
const SETUP_DONE_FLAG  = '/corp-setup-done.txt';
const SETUP_PHASE_FILE = '/corp-setup-phase.txt';
const SETUP_LOCK       = '/Temp/corp-setup.lock.txt';

// ── Job strings — exact CorpEmployeeJob enum values ───────────────────────────
const JOBS = {
    ops: 'Operations', eng: 'Engineer', biz: 'Business',
    mgmt: 'Management', rnd: 'Research & Development', unassigned: 'Unassigned',
};

// ── Unlock strings ────────────────────────────────────────────────────────────
const UNLOCKS = {
    warehouseAPI: 'Warehouse API', officeAPI: 'Office API',
    smartSupply: 'Smart Supply',   export: 'Export',
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
const AGRI_SIZES   = [0.005, 0.06, 0.5, 0.1];
const AGRI_MATS    = ['Real Estate', 'Hardware', 'Robots', 'AI Cores'];

// Chemical: realEstate=0.25, hardware=0.20, robot=0.25, aiCore=0.20
// scienceFactor=0.75 (highest material industry) — why Chemical is mandatory
const CHEM_FACTORS = [0.25, 0.20, 0.25, 0.20];
const CHEM_SIZES   = [0.005, 0.06, 0.5, 0.1];
const CHEM_MATS    = ['Real Estate', 'Hardware', 'Robots', 'AI Cores'];

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
const CYCLE_MS   = 11000;

const argsSchema = [['self-fund', false]];
export function autocomplete(data) { data.flags(argsSchema); return []; }

// ═════════════════════════════════════════════════════════════════════════════
export async function main(ns) {
    const opts = ns.flags(argsSchema);
    ns.disableLog('ALL');
    ns.ui.openTail();
    const c = ns.corporation;

    function resolvePath(key, fallback) {
        try { const p = JSON.parse(ns.read('/script-paths.json')); return p[key] ?? fallback; }
        catch { return fallback; }
    }

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

    let phase = readPhase();

    if (c.hasCorporation() && phase >= 6) {
        ns.write(SETUP_DONE_FLAG, 'true', 'w');
        const pilot = resolvePath('corp-autopilot', 'corp/corp-autopilot.js');
        if (!ns.ps('home').some(p => p.filename === pilot)) ns.run(pilot);
        return;
    }
    if (!c.hasCorporation() && phase !== 0) { phase = 0; writePhase(0); }

    async function waitCycles(n = 1) { await ns.sleep(CYCLE_MS * n); }

    function finishSetupAndHandoff() {
        writePhase(6);
        phase = 6;
        ns.write(SETUP_DONE_FLAG, 'true', 'w');
        log(ns, '═══════════════════════════════════════════════════════', true);
        log(ns, 'INFO: Phase 1 complete — handing off to corp-autopilot.js for Chemical/Tobacco.', true, 'success');
        log(ns, '═══════════════════════════════════════════════════════', true);

        const PILOT = resolvePath('corp-autopilot', 'corp/corp-autopilot.js');
        try { if (!ns.ps('home').some(p => p.filename === PILOT)) ns.run(PILOT); }
        catch { ns.run(PILOT); }
    }

    // ── Job assignment (two-pass — zero first, then set targets) ─────────────
    // setJobAssignment operates on employeeNextJobs (pending state).
    // Pass 1 zeros all → freed to Unassigned pool. Pass 2 draws from that pool.
    function assignJobs(div, city, { ops=0, eng=0, biz=0, mgmt=0, rnd=0 } = {}) {
        for (const job of [JOBS.ops, JOBS.eng, JOBS.biz, JOBS.mgmt, JOBS.rnd])
            try { c.setJobAssignment(div, city, job, 0); } catch { }
        if (ops  > 0) try { c.setJobAssignment(div, city, JOBS.ops,  ops);  } catch { }
        if (eng  > 0) try { c.setJobAssignment(div, city, JOBS.eng,  eng);  } catch { }
        if (biz  > 0) try { c.setJobAssignment(div, city, JOBS.biz,  biz);  } catch { }
        if (mgmt > 0) try { c.setJobAssignment(div, city, JOBS.mgmt, mgmt); } catch { }
        if (rnd  > 0) try { c.setJobAssignment(div, city, JOBS.rnd,  rnd);  } catch { }
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

    // Re-apply boosts whenever a warehouse level has changed (SmartStorage expanded it).
    const prevWHLevel = {};
    async function refreshBoosts(div, factors, sizes, mats) {
        for (const city of CITIES) {
            try {
                const key = `${div}|${city}`;
                const lvl = c.getWarehouse(div, city).level;
                if (lvl !== prevWHLevel[key]) {
                    prevWHLevel[key] = lvl;
                    await applyBoostMaterials(div, city, getBoostTargets(div, city, factors, sizes, mats));
                }
            } catch { }
        }
    }

    // ── Division helpers ──────────────────────────────────────────────────────
    function expandToAllCities(div) {
        const existing = c.getDivision(div).cities;
        for (const city of CITIES) {
            if (!existing.includes(city)) try { c.expandCity(div, city); } catch { }
        }
        for (const city of CITIES)
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
                            : c.hasResearched(DIV_TOBACCO, 'Market-TA.I')  ? 'MP*2'
                            : 'MP*3';
                c.sellProduct(DIV_TOBACCO, HQ_CITY, pName, 'MAX', price, true);
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
        for (const name of [
            UNLOCKS.warehouseAPI, UNLOCKS.officeAPI,
            UNLOCKS.smartSupply,  UNLOCKS.export,
            UNLOCKS.mktDemand,    UNLOCKS.mktComp,
        ]) buyUnlock(name);
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
        expandToAllCities(DIV_AGRI);
        enableSmartSupply(DIV_AGRI);
        // Docs: "Upgrade from 3 to 4. Set 4 employees to R&D and wait until RP ≥ 55.
        // Switch to Ops(1)+Eng(1)+Biz(1)+Mgmt(1) before buying boost materials."
        // At < 9 employees, energy/morale never drop naturally — no tea/party spending needed.
        for (const city of CITIES)
            fillOffice(DIV_AGRI, city, 4, { rnd: 4 });
        for (const city of CITIES) {
            try { c.sellMaterial(DIV_AGRI, city, 'Food',   'MAX', 'MP'); } catch { }
            try { c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP'); } catch { }
        }
        await waitCycles(1);
        // Wait for RP ≥ 55 before buying boost materials (docs requirement).
        log(ns, 'INFO: Waiting for Agriculture RP ≥ 55 before buying boost materials...', true);
        while (c.getDivision(DIV_AGRI).researchPoints < 55) {
            await ns.sleep(5000);
        }
        log(ns, 'INFO: RP ≥ 55 — switching to production jobs.', true, 'success');
        for (const city of CITIES)
            assignJobs(DIV_AGRI, city, { ops: 1, eng: 1, biz: 1, mgmt: 1 });
        await waitCycles(1);
        log(ns, 'INFO: Applying Phase 1 Agriculture boost materials...', true);
        for (const city of CITIES)
            await applyBoostMaterials(DIV_AGRI, city,
                getBoostTargets(DIV_AGRI, city, AGRI_FACTORS, AGRI_SIZES, AGRI_MATS));
        writePhase(2); phase = 2;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 2 — Wait for and accept investment round 1
    // Docs: "Focus on Smart Storage and warehouse upgrade. Buy 2 Advert levels."
    // ─────────────────────────────────────────────────────────────────────────
    if (phase <= 2) {
        log(ns, `INFO: Waiting for round-1 offer ≥ ${formatMoney(MIN_ROUND1)}...`, true);
        while (true) {
            await waitCycles(2);

            // Keep Agriculture selling and jobs assigned — no office expansion yet,
            // and NO tea/party (< 9 employees, morale doesn't drop; spending kills profit).
            for (const city of CITIES) {
                try { c.sellMaterial(DIV_AGRI, city, 'Food',   'MAX', 'MP'); } catch { }
                try { c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP'); } catch { }
                try { assignJobs(DIV_AGRI, city, { ops: 1, eng: 1, biz: 1, mgmt: 1 }); } catch { }
            }

            const funds = c.getCorporation().funds;
            // Docs: focus on SmartStorage in round 1.
            if (funds > 2e9) try { c.levelUpgrade('Smart Storage'); } catch { }
            // Warehouse upgrades up to level 3.
            if (funds > 1e9)
                for (const city of CITIES)
                    try {
                        if (c.getWarehouse(DIV_AGRI, city).level < 3)
                            c.upgradeWarehouse(DIV_AGRI, city, 1);
                    } catch { }
            // Docs: "Buy 2 Advert levels" in round 1.
            if (funds > 3e9)
                try { if (c.getHireAdVertCount(DIV_AGRI) < 2) c.hireAdVert(DIV_AGRI); } catch { }

            // Re-apply boosts if warehouse capacity has grown.
            await refreshBoosts(DIV_AGRI, AGRI_FACTORS, AGRI_SIZES, AGRI_MATS);

            const offer = c.getInvestmentOffer();
            log(ns, `  Round ${offer.round} offer: ${formatMoney(offer.funds)}`, false);
            if (offer.round > 1) { log(ns, 'INFO: Round 1 already accepted.', true, 'info'); break; }
            if (offer.round === 1 && offer.funds >= MIN_ROUND1) {
                c.acceptInvestmentOffer();
                log(ns, `INFO: Accepted Round 1 — received ${formatMoney(offer.funds)}!`, true, 'success');
                break;
            }
        }
        await waitCycles(1);
        finishSetupAndHandoff();
        return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3 — Launch Chemical + Tobacco; supply chain; first product
    // ─────────────────────────────────────────────────────────────────────────
    if (phase <= 3) {
        log(ns, 'INFO: Phase 3 — launching Chemical and Tobacco divisions...', true);

        // Scale Agriculture to 8 employees (docs: "8 is the optimal size" for round 2).
        for (const city of CITIES)
            fillOffice(DIV_AGRI, city, 8, { ops: 3, eng: 2, biz: 1, mgmt: 1, rnd: 1 });
        boostMorale(DIV_AGRI);  // Now at 8 employees — morale can drop, safe to spend here
        log(ns, 'INFO: Applying Phase 2 Agriculture boost materials...', true);
        for (const city of CITIES)
            await applyBoostMaterials(DIV_AGRI, city,
                getBoostTargets(DIV_AGRI, city, AGRI_FACTORS, AGRI_SIZES, AGRI_MATS));

        // ── Chemical division ─────────────────────────────────────────────────
        // Chemical costs $70B. If MIN_ROUND1 is correct we have 210B+ here.
        // Guard: wait until we can definitely afford it to avoid crashing the script.
        // (Unwrapped expandIndustry throws on insufficient funds — crash = phase loop.)
        if (!c.getCorporation().divisions.includes(DIV_CHEM)) {
            while (c.getCorporation().funds < 75e9) {
                log(ns, `INFO: Waiting for funds ≥ $75B for Chemical (have ${formatMoney(c.getCorporation().funds)})…`, false);
                await waitCycles(3);
                boostMorale(DIV_AGRI);
            }
            log(ns, 'INFO: Expanding into Chemical ($70B)...', true, 'info');
            try {
                c.expandIndustry(IND_CHEM, DIV_CHEM);
            } catch (e) {
                log(ns, `ERROR: expandIndustry Chemical failed: ${e?.message}`, true, 'error');
                return;
            }
        }
        expandToAllCities(DIV_CHEM);
        enableSmartSupply(DIV_CHEM);
        // Docs: "1 warehouse upgrade is enough" for Chemical.
        for (const city of CITIES)
            try { if (c.getWarehouse(DIV_CHEM, city).level < 2) c.upgradeWarehouse(DIV_CHEM, city, 1); } catch { }
        for (const city of CITIES)
            fillOffice(DIV_CHEM, city, 6, { ops: 1, eng: 3, biz: 0, mgmt: 1, rnd: 1 });
        boostMorale(DIV_CHEM);
        for (const city of CITIES)
            try { c.sellMaterial(DIV_CHEM, city, 'Chemicals', 'MAX', 'MP'); } catch { }
        log(ns, 'INFO: Applying Chemical boost materials...', true);
        for (const city of CITIES)
            await applyBoostMaterials(DIV_CHEM, city,
                getBoostTargets(DIV_CHEM, city, CHEM_FACTORS, CHEM_SIZES, CHEM_MATS));

        // ── Tobacco division ──────────────────────────────────────────────────
        if (!c.getCorporation().divisions.includes(DIV_TOBACCO)) {
            while (c.getCorporation().funds < 20e9) {
                log(ns, `INFO: Waiting for funds ≥ $20B for Tobacco (have ${formatMoney(c.getCorporation().funds)})…`, false);
                await waitCycles(3);
                boostMorale(DIV_AGRI);
            }
            log(ns, 'INFO: Expanding into Tobacco ($20B)...', true, 'info');
            try {
                c.expandIndustry(IND_TOBACCO, DIV_TOBACCO);
            } catch (e) {
                log(ns, `ERROR: expandIndustry Tobacco failed: ${e?.message}`, true, 'error');
                return;
            }
        }
        expandToAllCities(DIV_TOBACCO);
        enableSmartSupply(DIV_TOBACCO);
        // HQ: product dev — Engineer + Management heavy.
        // ProductDevelopmentMultiplier = (EngineerProd^0.34 + OpsProd^0.2) × ManagementFactor
        fillOffice(DIV_TOBACCO, HQ_CITY, 18, { ops: 4, eng: 7, biz: 1, mgmt: 5, rnd: 1 });
        // Satellites: R&D-heavy. Docs: "1 main + 5 support offices."
        // RP gain = 0.004 × RnDProduction^0.5 per state (×4 states/cycle).
        for (const city of CITIES.filter(ct => ct !== HQ_CITY))
            fillOffice(DIV_TOBACCO, city, 9, { ops: 1, eng: 1, biz: 0, mgmt: 0, rnd: 7 });
        boostMorale(DIV_TOBACCO);

        // ── Supply chain exports ──────────────────────────────────────────────
        // Optimal export string per docs: (IPROD+IINV/10)*(-1)
        // Drains inventory gradually while covering consumption — prevents starvation and overflow.
        // FIFO order: Agri→Tobacco first so Tobacco's Plants supply takes priority.
        const EXP = '(IPROD+IINV/10)*(-1)';
        log(ns, 'INFO: Setting up supply-chain exports...', true);
        for (const city of CITIES) {
            try { c.exportMaterial(DIV_AGRI, city, DIV_TOBACCO, city, 'Plants',    EXP); } catch { }  // Priority
            try { c.exportMaterial(DIV_AGRI, city, DIV_CHEM,    city, 'Plants',    EXP); } catch { }  // Quality loop
            try { c.exportMaterial(DIV_CHEM, city, DIV_AGRI,    city, 'Chemicals', EXP); } catch { }  // Quality loop
        }
		
		// Prevent Smart Supply from double-buying imported materials.
		// 'leftovers' = only top up what the export route doesn't cover.
		for (const city of CITIES) {
			try { c.setSmartSupplyOption(DIV_AGRI,    city, 'Chemicals', 'leftovers'); } catch { }
			try { c.setSmartSupplyOption(DIV_AGRI,    city, 'Water',     'leftovers'); } catch { }
			try { c.setSmartSupplyOption(DIV_CHEM,    city, 'Plants',    'leftovers'); } catch { }
			try { c.setSmartSupplyOption(DIV_CHEM,    city, 'Water',     'leftovers'); } catch { }
			try { c.setSmartSupplyOption(DIV_TOBACCO, city, 'Plants',    'leftovers'); } catch { }
		}

        // Ensure all divisions have at least level-3 warehouses.
        for (const div of [DIV_TOBACCO, DIV_AGRI, DIV_CHEM])
            for (const city of CITIES)
                try {
                    const wh = c.getWarehouse(div, city);
                    if (wh.level < 3) c.upgradeWarehouse(div, city, 3 - wh.level);
                } catch { }

        // ── First Tobacco product ─────────────────────────────────────────────
        // Docs: "It's fine to spend 1% of current funds" on design/advertising.
        // Their exponents are 0.1 — very low returns; don't over-invest.
        const FIRST_PRODUCT = 'Tobac-v1';
        if (!c.getDivision(DIV_TOBACCO).products.includes(FIRST_PRODUCT)) {
            const invest = Math.max(1e8, Math.min(c.getCorporation().funds * 0.01, 2e9));
            try {
                c.makeProduct(DIV_TOBACCO, HQ_CITY, FIRST_PRODUCT, invest / 2, invest / 2);
                log(ns, `INFO: Started "${FIRST_PRODUCT}" (${formatMoney(invest)} invest)`, true, 'info');
            } catch (e) { log(ns, `WARN: Could not start product: ${e?.message}`, false, 'warning'); }
        }

        buyUpgrades([
            'Smart Factories', 'Smart Storage', 'ABC SalesBots',
            'Nuoptimal Nootropic Injector Implants',
            'Neural Accelerators', 'FocusWires', 'Speech Processor Implants',
        ], 2);

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
                try { prevWHLevel[`${div}|${city}`] = c.getWarehouse(div, city).level; } catch { }

        let rpGateCleared = false;

        while (true) {
            await waitCycles(3);
            boostMorale(DIV_TOBACCO, DIV_AGRI, DIV_CHEM);

            // Price finished products (sellProduct required even when TA2 active).
            priceProducts();

            // Research with RP threshold (50% general, 10% production).
            tryResearch(DIV_TOBACCO, TOB_RESEARCH);
            tryResearch(DIV_AGRI,    MAT_RESEARCH);
            tryResearch(DIV_CHEM,    MAT_RESEARCH);

            // Wilson must be bought BEFORE Advert — it multiplies future Advert benefit (not retroactive).
            // Docs: "Buy Wilson if you can afford it, then use ≥20% of funds on Advert."
            try {
                const wCost = c.getUpgradeLevelCost('Wilson Analytics');
                if (c.getCorporation().funds > wCost * 2) c.levelUpgrade('Wilson Analytics');
            } catch { }

            buyUpgrades([
                'Smart Factories', 'Smart Storage',
                'Nuoptimal Nootropic Injector Implants',  // Correct spacing
                'Neural Accelerators', 'FocusWires', 'Speech Processor Implants',
                'ABC SalesBots',
            ], 1.5);

            // Advert for Tobacco — after Wilson.
            try {
                const funds = c.getCorporation().funds;
                const advCost = c.getHireAdVertCost(DIV_TOBACCO);
                if (funds > advCost && advCost < funds * 0.2) c.hireAdVert(DIV_TOBACCO);
            } catch { }

            // Re-apply boosts if SmartStorage has expanded warehouse capacity.
            await refreshBoosts(DIV_AGRI, AGRI_FACTORS, AGRI_SIZES, AGRI_MATS);
            await refreshBoosts(DIV_CHEM, CHEM_FACTORS, CHEM_SIZES, CHEM_MATS);

            // Dummy Restaurant divisions — each adds 12 office+warehouse pairs,
            // boosting private valuation by ×1.1 (~10% better round-2 offer).
            try {
                for (let i = 1; i <= 5; i++) {
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
            log(ns, `  Round ${offer.round} offer: ${formatMoney(offer.funds)}`, false);
            if (offer.round > 2) { log(ns, 'INFO: Round 2 already accepted.', true, 'info'); break; }
            if (offer.round === 2 && offer.funds >= MIN_ROUND2) {
                c.acceptInvestmentOffer();
                log(ns, `INFO: Accepted Round 2 — received ${formatMoney(offer.funds)}!`, true, 'success');
                break;
            }
        }
        await waitCycles(1);
        writePhase(5); phase = 5;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 5 — Final scaling before autopilot handoff
    // ─────────────────────────────────────────────────────────────────────────
    if (phase <= 5) {
        log(ns, 'INFO: Phase 5 — final scaling pass...', true);

        for (const city of CITIES) {
            const isHQ = city === HQ_CITY;
            // HQ: product dev focus. Satellites: R&D-heavy (80% in R&D).
            fillOffice(DIV_TOBACCO, city,
                isHQ ? 30 : 20,
                isHQ
                    ? { ops: 5, eng: 11, biz: 2, mgmt: 9, rnd: 3 }
                    : { ops: 1, eng: 2,  biz: 0, mgmt: 1, rnd: 16 });
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
                getBoostTargets(DIV_AGRI, city, AGRI_FACTORS, AGRI_SIZES, AGRI_MATS));
            await applyBoostMaterials(DIV_CHEM, city,
                getBoostTargets(DIV_CHEM, city, CHEM_FACTORS, CHEM_SIZES, CHEM_MATS));
        }

        writePhase(6); phase = 6;
    }

    // ── Handoff ───────────────────────────────────────────────────────────────
    ns.write(SETUP_DONE_FLAG, 'true', 'w');
    log(ns, '═══════════════════════════════════════════════════════', true);
    log(ns, 'INFO: Setup complete! Handing off to corp-autopilot.js.', true, 'success');
    log(ns, '═══════════════════════════════════════════════════════', true);

    const PILOT = resolvePath('corp-autopilot', 'corp/corp-autopilot.js');
    try { if (!ns.ps('home').some(p => p.filename === PILOT)) ns.run(PILOT); }
    catch { ns.run(PILOT); }
}