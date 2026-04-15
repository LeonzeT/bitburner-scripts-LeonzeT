const DIV_TOBACCO = 'Tobacco';
const HQ_CITY = 'Sector-12';
const CITIES = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];

const ROUND2_PRODUCT_MIN_INVEST = 2e8;
const ROUND2_PRODUCT_MAX_INVEST = 5e9;
const ROUND2_PRODUCT_MAX_INVEST_AGGR = 12e9;
const ROUND2_AGGR_PRODUCT_INVEST_PCT = 0.04;

const ROUND2_BN3_LEAN_TOB_SUPPORT_TRIGGER = 2.6e12;
const ROUND2_BN3_LEAN_TOB_PREFILL_HQ_TRIGGER = 2.0e12;
const ROUND2_BN3_LATE_VALUATION_TRIGGER = 2.4e12;
const ROUND2_BN3_LEAN_TOB_PRODUCT_RESERVE = 5e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT = 0.0075;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_POSTDONE = 0.03;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_LATE = 0.04;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP = 3e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_POSTDONE = 2.5e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_LATE = 5e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_POSTDONE = 5e8;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_LATE = 2.5e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_TOLERANCE = 1e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_STAGNATION = 12;
const ROUND2_BN3_LEAN_TOB_PRODUCT_FREEZE_VERSION = 6;

const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RESERVE = 8e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT = 0.015;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT_POSTDONE = 0.02;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT_LATE = 0.03;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP = 3e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP_POSTDONE = 5e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP_LATE = 10e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN = 1e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN_POSTDONE = 2.5e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN_LATE = 5e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_TRIGGER = 400e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_FUNDS = 12e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_PROFIT = 10e6;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_MARGIN = 0.30;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_STAGNATION = 18;
const ROUND2_BN3_HIGH_BUDGET_TOB_HQ_POST_V1 = 24;
const ROUND2_BN3_HIGH_BUDGET_TOB_HQ_POST_V1_STRETCH = 36;
const ROUND2_BN3_HIGH_BUDGET_TOB_HQ_POST_V1_SURGE = 54;
const ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_POST_V1 = 12;
const ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_POST_V1_STRETCH = 18;
const ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_POST_V1_SURGE = 24;

const LOG_FILE = '/Temp/corp-workers.log.txt';
const SNAPSHOT_FILE = '/Temp/corp-product-last.txt';

function parseOptions(args) {
    const opts = {
        source: '',
        phase: 0,
        reserve: 0,
        bestOffer: 0,
        stagnantChecks: 0,
        route: 'classic',
        aggressive: false,
        postfillUnlocked: false,
        lateSpikeReady: false,
        materialFilled: false,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = String(args[i]);
        if (arg === '--source' && i + 1 < args.length) opts.source = String(args[++i]);
        else if (arg === '--phase' && i + 1 < args.length) opts.phase = Number(args[++i]) || 0;
        else if (arg === '--reserve' && i + 1 < args.length) opts.reserve = Number(args[++i]) || 0;
        else if (arg === '--best-offer' && i + 1 < args.length) opts.bestOffer = Number(args[++i]) || 0;
        else if (arg === '--stagnant' && i + 1 < args.length) opts.stagnantChecks = Number(args[++i]) || 0;
        else if (arg === '--route' && i + 1 < args.length) opts.route = String(args[++i]);
        else if (arg === '--aggressive') opts.aggressive = true;
        else if (arg === '--postfill-unlocked') opts.postfillUnlocked = true;
        else if (arg === '--late-spike-ready') opts.lateSpikeReady = true;
        else if (arg === '--material-filled') opts.materialFilled = true;
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

function tobaccoProducts(c) {
    try { return [...c.getDivision(DIV_TOBACCO).products]; } catch { return []; }
}

function tobaccoProductVersion(name) {
    const m = /^Tobac-v(\d+)$/.exec(name);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : 0;
}

function getHighestTobaccoProductVersion(c) {
    let maxVersion = 0;
    for (const name of tobaccoProducts(c)) {
        maxVersion = Math.max(maxVersion, tobaccoProductVersion(name));
    }
    return maxVersion;
}

function hasActiveTobaccoDevelopment(c) {
    for (const name of tobaccoProducts(c)) {
        try {
            if (Number(c.getProduct(DIV_TOBACCO, HQ_CITY, name).developmentProgress ?? 0) < 100) return true;
        } catch { }
    }
    return false;
}

function nextTobaccoProductName(c) {
    let max = 0;
    for (const name of tobaccoProducts(c)) {
        max = Math.max(max, tobaccoProductVersion(name));
    }
    return `Tobac-v${max + 1}`;
}

function getTobaccoProductCapacity(c) {
    let capacity = 3;
    try { if (c.hasResearched(DIV_TOBACCO, 'uPgrade: Capacity.I')) capacity++; } catch { }
    try { if (c.hasResearched(DIV_TOBACCO, 'uPgrade: Capacity.II')) capacity++; } catch { }
    return capacity;
}

function hasOpenTobaccoProductSlot(c) {
    return tobaccoProducts(c).length < getTobaccoProductCapacity(c);
}

function getTobaccoRetirementCandidate(c) {
    const finished = [];
    for (const name of tobaccoProducts(c)) {
        try {
            const product = c.getProduct(DIV_TOBACCO, HQ_CITY, name);
            const progress = Number(product.developmentProgress ?? 0);
            if (progress < 100) continue;
            const rating = Number(product.rating ?? 0);
            const version = tobaccoProductVersion(name);
            finished.push({ name, rating, version });
        } catch { }
    }
    if (finished.length === 0) return null;
    const highestVersion = finished.reduce((max, product) => Math.max(max, product.version), 0);
    const pool = finished.length > 1
        ? finished.filter((product) => product.version < highestVersion)
        : finished;
    let candidate = null;
    for (const product of pool) {
        if (!candidate ||
            product.rating < candidate.rating - 1e-9 ||
            (Math.abs(product.rating - candidate.rating) <= 1e-9 && product.version < candidate.version)) {
            candidate = product;
        }
    }
    return candidate?.name ?? null;
}

function getTobaccoProductStats(c) {
    let highestProgress = 0;
    let finishedProducts = 0;
    for (const name of tobaccoProducts(c)) {
        try {
            const progress = Number(c.getProduct(DIV_TOBACCO, HQ_CITY, name).developmentProgress ?? 0);
            if (progress > highestProgress) highestProgress = progress;
            if (progress >= 100) finishedProducts++;
        } catch { }
    }
    return { highestProgress, finishedProducts };
}

function useHigh(opts) {
    return opts.route === 'high';
}

function useLean(opts) {
    return opts.route === 'lean';
}

function normalizeRoute(opts, c = null) {
    const route = String(opts?.route ?? 'classic');
    if (route !== 'classic') return route;
    const bestOffer = Math.max(0, Number(opts?.bestOffer ?? 0));
    let hasLatePrivateShape = false;
    try {
        const corp = c?.getCorporation?.();
        const divs = Array.isArray(corp?.divisions) ? corp.divisions : [];
        hasLatePrivateShape =
            Number(opts?.phase ?? 0) >= 4 &&
            divs.includes('Agriculture') &&
            divs.includes('Chemical') &&
            divs.includes('Tobacco');
    } catch { }
    const likelyHighBudget =
        hasLatePrivateShape ||
        Boolean(opts?.postfillUnlocked) ||
        Boolean(opts?.lateSpikeReady) ||
        Boolean(opts?.materialFilled) ||
        bestOffer >= ROUND2_BN3_LATE_VALUATION_TRIGGER;
    return likelyHighBudget ? 'high' : route;
}

function getTobaccoProductInvestment(c, opts) {
    const funds = Number(c.getCorporation().funds ?? 0);
    const { finishedProducts } = getTobaccoProductStats(c);
    let investPct = useHigh(opts)
        ? ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT
        : opts.aggressive
            ? ROUND2_AGGR_PRODUCT_INVEST_PCT
            : useLean(opts)
                ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT
                : 0.01;
    let investCap = useHigh(opts)
        ? ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP
        : opts.aggressive
            ? ROUND2_PRODUCT_MAX_INVEST_AGGR
            : useLean(opts)
                ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP
                : ROUND2_PRODUCT_MAX_INVEST;
    let investMin = useHigh(opts) ? ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN : ROUND2_PRODUCT_MIN_INVEST;
    if (useHigh(opts) && finishedProducts > 0) {
        const late = opts.bestOffer >= ROUND2_BN3_LATE_VALUATION_TRIGGER;
        investPct = late ? ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT_LATE : ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT_POSTDONE;
        investCap = late ? ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP_LATE : ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP_POSTDONE;
        investMin = late ? ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN_LATE : ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN_POSTDONE;
    } else if (useLean(opts) && finishedProducts > 0) {
        const late = opts.bestOffer >= ROUND2_BN3_LEAN_TOB_SUPPORT_TRIGGER;
        investPct = late ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_LATE : ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_POSTDONE;
        investCap = late ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_LATE : ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_POSTDONE;
        investMin = late ? ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_LATE : ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_POSTDONE;
    }
    const desired = Math.max(investMin, Math.min(funds * investPct, investCap));
    if (useHigh(opts) && finishedProducts > 0 && hasOpenTobaccoProductSlot(c)) {
        const reserve = Math.max(0, Number(opts.reserve ?? 0));
        const affordable = Math.max(0, funds - reserve);
        if (affordable >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN) {
            return Math.max(
                ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN,
                Math.min(desired, affordable),
            );
        }
    }
    return desired;
}

function isLeanTobaccoProductCycleReady(opts) {
    if (!useLean(opts)) return true;
    if (opts.bestOffer + ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_TOLERANCE >= ROUND2_BN3_LEAN_TOB_PREFILL_HQ_TRIGGER) return true;
    return opts.stagnantChecks >= ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_STAGNATION;
}

function shouldFreezeLeanTobaccoProductCycle(c, opts) {
    if (!useLean(opts)) return false;
    if (opts.bestOffer < ROUND2_BN3_LATE_VALUATION_TRIGGER) return false;
    if (!opts.materialFilled) return false;
    const { finishedProducts } = getTobaccoProductStats(c);
    if (finishedProducts < 2) return false;
    return getHighestTobaccoProductVersion(c) >= ROUND2_BN3_LEAN_TOB_PRODUCT_FREEZE_VERSION;
}

function getHighBudgetOfficeTargets(c, opts) {
    const { finishedProducts, highestProgress } = getTobaccoProductStats(c);
    if (finishedProducts <= 0) return { hq: 15, support: 9 };
    if (opts.postfillUnlocked || finishedProducts > 2) {
        return {
            hq: ROUND2_BN3_HIGH_BUDGET_TOB_HQ_POST_V1_SURGE,
            support: ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_POST_V1_SURGE,
        };
    }
    if (finishedProducts > 1 || highestProgress >= 80) {
        return {
            hq: ROUND2_BN3_HIGH_BUDGET_TOB_HQ_POST_V1_STRETCH,
            support: ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_POST_V1_STRETCH,
        };
    }
    return {
        hq: ROUND2_BN3_HIGH_BUDGET_TOB_HQ_POST_V1,
        support: ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_POST_V1,
    };
}

function getProductQualityHoldReason(c, opts) {
    if (!useHigh(opts)) return null;
    const { finishedProducts } = getTobaccoProductStats(c);
    if (finishedProducts <= 0) return null;
    const targets = getHighBudgetOfficeTargets(c, opts);
    try {
        const hqOffice = c.getOffice(DIV_TOBACCO, HQ_CITY);
        const hqSize = Number(hqOffice?.size ?? 0);
        const hqEmployees = Number(hqOffice?.numEmployees ?? 0);
        if (hqSize < targets.hq || hqEmployees < targets.hq) {
            return `HQ ${Math.min(hqSize, hqEmployees)}/${targets.hq}`;
        }
    } catch {
        return `HQ 0/${targets.hq}`;
    }
    for (const city of CITIES) {
        if (city === HQ_CITY) continue;
        try {
            const office = c.getOffice(DIV_TOBACCO, city);
            const size = Number(office?.size ?? 0);
            const employees = Number(office?.numEmployees ?? 0);
            if (size < targets.support || employees < targets.support) {
                return `${city} ${Math.min(size, employees)}/${targets.support}`;
            }
        } catch {
            return `${city} 0/${targets.support}`;
        }
    }
    return null;
}

function isHighBudgetProductCycleReady(c, opts) {
    if (!useHigh(opts)) return true;
    if (!opts.postfillUnlocked) return true;
    const { finishedProducts } = getTobaccoProductStats(c);
    if (finishedProducts <= 0) return true;
    if (hasOpenTobaccoProductSlot(c)) return true;
    if (opts.lateSpikeReady) return true;
    if (getProductQualityHoldReason(c, opts)) return false;
    const corp = c.getCorporation();
    const funds = Number(corp?.funds ?? 0);
    const revenue = Number(corp?.revenue ?? 0);
    const expenses = Number(corp?.expenses ?? 0);
    const profit = revenue - expenses;
    const margin = revenue > 0 ? profit / revenue : (profit > 0 ? 1 : 0);
    if (opts.bestOffer >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_TRIGGER) return true;
    if (opts.stagnantChecks >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_STAGNATION &&
        funds >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_FUNDS &&
        profit >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_PROFIT) {
        return true;
    }
    return funds >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_FUNDS &&
        profit >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_PROFIT &&
        margin >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_MARGIN;
}

export async function main(ns) {
    const opts = parseOptions(ns.args);
    const c = ns.corporation;
    opts.route = normalizeRoute(opts, c);
    try {
        if (!c?.hasCorporation?.()) return;
        const corp = c.getCorporation();
        if (!Array.isArray(corp?.divisions) || !corp.divisions.includes(DIV_TOBACCO)) return;
        if (hasActiveTobaccoDevelopment(c)) {
            writeSnapshot(ns, { time: Date.now(), source: opts.source, action: 'noop', reason: 'active-development' });
            return;
        }
        if (shouldFreezeLeanTobaccoProductCycle(c, opts)) {
            writeSnapshot(ns, { time: Date.now(), source: opts.source, action: 'noop', reason: 'lean-freeze' });
            return;
        }
        if (!isHighBudgetProductCycleReady(c, opts)) {
            writeSnapshot(ns, {
                time: Date.now(),
                source: opts.source,
                action: 'noop',
                reason: getProductQualityHoldReason(c, opts) ?? 'high-budget-hold',
            });
            return;
        }
        const invest = getTobaccoProductInvestment(c, opts);
        const funds = Number(corp?.funds ?? 0);
        if (funds - invest < opts.reserve) {
            writeSnapshot(ns, { time: Date.now(), source: opts.source, action: 'noop', reason: 'reserve-hold', invest, reserve: opts.reserve });
            return;
        }
        const capacity = getTobaccoProductCapacity(c);
        const products = tobaccoProducts(c);
        const name = nextTobaccoProductName(c);
        let retired = null;
        if (products.length >= capacity) {
            if (!isLeanTobaccoProductCycleReady(opts)) {
                writeSnapshot(ns, { time: Date.now(), source: opts.source, action: 'noop', reason: 'cycle-not-ready' });
                return;
            }
            retired = getTobaccoRetirementCandidate(c);
            if (!retired) {
                writeSnapshot(ns, { time: Date.now(), source: opts.source, action: 'noop', reason: 'no-retire-candidate' });
                return;
            }
            c.discontinueProduct(DIV_TOBACCO, retired);
        }
        c.makeProduct(DIV_TOBACCO, HQ_CITY, name, invest / 2, invest / 2);
        writeSnapshot(ns, {
            time: Date.now(),
            source: opts.source,
            action: 'started',
            product: name,
            retired,
            invest,
            reserve: opts.reserve,
            route: opts.route,
        });
    } catch (error) {
        appendWorkerLog(ns, 'corp-product-worker', `fatal: ${error?.stack ?? error?.message ?? error}`);
        writeSnapshot(ns, {
            time: Date.now(),
            source: opts.source,
            action: 'error',
            error: String(error?.message ?? error),
        });
    }
}
