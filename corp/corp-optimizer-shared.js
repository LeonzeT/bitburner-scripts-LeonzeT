export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function formatEta(seconds) {
    if (!Number.isFinite(seconds)) return "n/a";
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
    return `${Math.max(1, Math.round(seconds / 3600))}h`;
}

export function estimateFundsWaitSeconds(requiredFunds, funds, profitPerSecond) {
    const needed = Math.max(0, Number(requiredFunds ?? 0) - Number(funds ?? 0));
    if (needed <= 0) return 0;
    if (!Number.isFinite(profitPerSecond) || profitPerSecond <= 0) return Infinity;
    return needed / profitPerSecond;
}

export function combineRelativeGains(totalGain, nextGain) {
    return (1 + Math.max(0, totalGain)) * (1 + Math.max(0, nextGain)) - 1;
}

export const PRIVATE_STAGE_TARGETS = Object.freeze({
    "post-r3": Object.freeze({
        smartFactories: 14,
        smartStorage: 16,
        salesBots: 8,
        wilson: 3,
        tobAdvert: 5,
        warehouse: 8,
        agriOffice: 60,
        tobHqOffice: 90,
        tobSupportOffice: 60,
        chemOffice: 30,
    }),
    "pre-ipo": Object.freeze({
        smartFactories: 16,
        smartStorage: 18,
        salesBots: 10,
        wilson: 4,
        tobAdvert: 6,
        warehouse: 10,
        agriOffice: 90,
        tobHqOffice: 150,
        tobSupportOffice: 90,
        chemOffice: 45,
    }),
});

// Bounded late-stage stretch goals used only after the normal private-stage
// targets are complete. These are intentionally limited, so the setup script
// can keep squeezing later-round offers without turning into an endless spender.
export const PRIVATE_STAGE_STRETCH_TARGETS = Object.freeze({
    "post-r3": Object.freeze({
        wilson: 6,
        tobAdvert: 7,
        tobHqOffice: 250,
        tobSupportOffice: 150,
        agriOffice: 150,
        chemOffice: 75,
        employeeUpgrades: 5,
    }),
    "pre-ipo": Object.freeze({
        wilson: 8,
        tobAdvert: 9,
        tobHqOffice: 350,
        tobSupportOffice: 200,
        agriOffice: 200,
        chemOffice: 120,
        employeeUpgrades: 8,
    }),
});

export function optimalBoosts(S, factors, sizes, names) {
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

export function parseOptions(ns, argsSchema, aliases = {}) {
    const defaults = Object.fromEntries(argsSchema);
    const opts = { ...defaults };
    for (let i = 0; i < ns.args.length; i++) {
        const arg = ns.args[i];
        if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
        const rawKey = arg.slice(2);
        const key = aliases[rawKey] ?? rawKey;
        if (!(key in opts)) continue;
        const defaultValue = defaults[key];
        if (typeof defaultValue === 'boolean') { opts[key] = true; }
        else if (i + 1 < ns.args.length) { opts[key] = ns.args[++i]; }
    }
    return opts;
}

export function getBoostConfig(c, industry, fallbackFactors, fallbackSizes, mats) {
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

export function getRequiredMaterialsConfig(c, industry, fallback) {
    try {
        return { ...(c.getIndustryData(industry).requiredMaterials ?? fallback) };
    } catch {
        return { ...fallback };
    }
}

/**
 * Factory: returns all material estimation helpers bound to the given corp API handle.
 * @param {object} ctx
 * @param {object}   ctx.c                - ns.corporation
 * @param {object}   ctx.boostMap         - { [divName]: { factors, sizes, mats } }
 * @param {object}   ctx.matSizeFallbacks - fallback size map (e.g. ROUND1_AGRI_MAT_SIZES)
 * @param {string[]} ctx.CITIES
 * @param {string}   ctx.DIV_AGRI
 * @param {string}   ctx.DIV_CHEM
 */
export function makeMaterialHelpers({ c, boostMap, matSizeFallbacks, CITIES, DIV_AGRI, DIV_CHEM }) {
    function getDivisionBoostConfig(div) { return boostMap[div] ?? null; }
    function getMaterialSize(material) {
        try { return Math.max(Number(c.getMaterialData(material)?.size ?? matSizeFallbacks[material] ?? 0.05), 1e-9); }
        catch { return Math.max(Number(matSizeFallbacks[material] ?? 0.05), 1e-9); }
    }
    function getPhysicalMaterialSize(material, fallback = 0) {
        const aliases = material === 'AI Cores'
            ? ['AI Cores', 'AICores']
            : (material === 'Real Estate' ? ['Real Estate', 'RealEstate'] : [material]);
        for (const name of aliases) {
            try {
                const size = Number(c.getMaterialData(name)?.size);
                if (Number.isFinite(size) && size >= 0) return size;
            } catch { }
        }
        return Math.max(0, Number(fallback ?? 0));
    }
    function estimateBoostTargetsForSize(div, nextSize) {
        const config = getDivisionBoostConfig(div);
        if (!config || !Number.isFinite(nextSize) || nextSize <= 0) return {};
        return optimalBoosts(nextSize * 0.70, [...config.factors], [...config.sizes], [...config.mats]);
    }
    function getMaterialBuyPrice(div, city, mat) {
        try {
            const info = c.getMaterial(div, city, mat);
            return Math.max(0, Number(info.bCost ?? info.marketPrice ?? info.averagePrice ?? 0));
        } catch { return 0; }
    }
    function estimateBoostTopUpCost(div, city, nextSize) {
        try {
            const targets = estimateBoostTargetsForSize(div, nextSize);
            let total = 0;
            for (const [mat, target] of Object.entries(targets)) {
                const stored = c.getMaterial(div, city, mat).stored;
                total += Math.max(0, target - stored) * getMaterialBuyPrice(div, city, mat);
            }
            return total;
        } catch { return 0; }
    }
    function estimateMaterialTargetSpend(div, city, targets) {
        try {
            let total = 0;
            for (const [mat, target] of Object.entries(targets)) {
                const stored = c.getMaterial(div, city, mat).stored;
                total += Math.max(0, target - stored) * getMaterialBuyPrice(div, city, mat);
            }
            return total;
        } catch { return Infinity; }
    }
    function scaleMaterialTargets(targets, scale = 1) {
        if (!targets || !Number.isFinite(scale)) return { ...(targets ?? {}) };
        const clampedScale = clamp(scale, 0, 1);
        if (clampedScale >= 0.9999) return { ...targets };
        return Object.fromEntries(Object.entries(targets).map(([mat, target]) => [mat, Math.max(0, Number(target ?? 0) * clampedScale)]));
    }
    function scaleMaterialTargetsFromStored(div, city, targets, scale = 1) {
        if (!targets || !Number.isFinite(scale)) return { ...(targets ?? {}) };
        const clampedScale = clamp(scale, 0, 1);
        if (clampedScale >= 0.9999) return { ...targets };
        const scaledTargets = {};
        for (const [mat, target] of Object.entries(targets)) {
            let stored = 0;
            try { stored = Math.max(0, Number(c.getMaterial(div, city, mat).stored ?? 0)); } catch { }
            const safeTarget = Math.max(0, Number(target ?? 0));
            const deficit = Math.max(0, safeTarget - stored);
            if (deficit <= 0) continue;
            scaledTargets[mat] = stored + deficit * clampedScale;
        }
        return scaledTargets;
    }
    function getProjectedMaterialTargetAddedSpace(div, city, targets) {
        try {
            let total = 0;
            for (const [mat, target] of Object.entries(targets ?? {})) {
                const stored = Math.max(0, Number(c.getMaterial(div, city, mat).stored ?? 0));
                const needed = Math.max(0, Number(target ?? 0) - stored);
                if (needed <= 0) continue;
                total += needed * getPhysicalMaterialSize(mat, getMaterialSize(mat));
            }
            return total;
        } catch { return 0; }
    }
    function fitMaterialTargetsToBudget(div, city, targets, budget = Infinity) {
        const cappedBudget = Math.max(0, Number(budget ?? 0));
        if (!targets) return { targets: {}, spend: 0 };
        if (!Number.isFinite(cappedBudget)) return { targets: { ...targets }, spend: estimateMaterialTargetSpend(div, city, targets) };
        if (cappedBudget <= 0) return { targets: scaleMaterialTargets(targets, 0), spend: 0 };
        const spend = estimateMaterialTargetSpend(div, city, targets);
        if (!Number.isFinite(spend) || spend <= 0) return { targets: { ...targets }, spend: 0 };
        if (spend <= cappedBudget) return { targets: { ...targets }, spend };
        const scaledTargets = scaleMaterialTargets(targets, cappedBudget / spend);
        return { targets: scaledTargets, spend: estimateMaterialTargetSpend(div, city, scaledTargets) };
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
        } catch { return Infinity; }
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
        } catch { return Infinity; }
    }
    return {
        getDivisionBoostConfig, getMaterialSize, getPhysicalMaterialSize,
        estimateBoostTargetsForSize, getMaterialBuyPrice, estimateBoostTopUpCost,
        estimateMaterialTargetSpend, scaleMaterialTargets, scaleMaterialTargetsFromStored,
        getProjectedMaterialTargetAddedSpace, fitMaterialTargetsToBudget,
        getCorpOfficeInitialCost, getCorpWarehouseInitialCost,
        estimateWarehouseUpgradeSpend, estimateSmartStorageUpgradeSpend,
    };
}

/**
 * Factory: returns lock, phase, and misc corp file helpers bound to ns/c and the given file paths.
 * @param {NS}     ns
 * @param {object} c            - ns.corporation
 * @param {object} ctx
 * @param {string}   ctx.lockFile     - lock file path
 * @param {string}   ctx.phaseFile    - phase file path (C.SETUP_PHASE_FILE)
 * @param {string}   ctx.doneFlagFile - done-flag file path (C.SETUP_DONE_FLAG)
 */
export function makeCorpHelpers(ns, c, { lockFile, phaseFile, doneFlagFile }) {
    function readLock() {
        try { return JSON.parse(ns.read(lockFile) || 'null'); } catch { return null; }
    }
    function lockValid(lock) {
        if (!lock || typeof lock !== 'object') return false;
        if (lock.host !== ns.getHostname()) return false;
        return ns.ps(lock.host).some(p => p.pid === lock.pid && p.filename === ns.getScriptName());
    }
    function acquireLock() {
        if (lockValid(readLock())) return false;
        ns.write(lockFile, JSON.stringify({ pid: ns.pid, host: ns.getHostname(), file: ns.getScriptName(), started: Date.now() }), 'w');
        return true;
    }
    function readPhase() {
        try {
            const n = parseInt(ns.read(phaseFile).trim(), 10);
            return isFinite(n) && n >= 0 ? n : 0;
        } catch { return 0; }
    }
    function writePhase(n) { try { ns.write(phaseFile, String(n), 'w'); } catch { } }
    function readDoneFlag() {
        try { return ns.read(doneFlagFile).trim() === 'true'; } catch { return false; }
    }
    function corpIsPublic(corp = null) {
        try { return !!(corp ?? c.getCorporation())?.public; } catch { return false; }
    }
    function hasRes(div, name) {
        try { return c.hasResearched(div, name); } catch { return false; }
    }
    return { readLock, lockValid, acquireLock, readPhase, writePhase, readDoneFlag, corpIsPublic, hasRes };
}

export function getPrivateOfferThreshold(round, funds, revenue, incomeMode = false) {
    if (round !== 3 && round !== 4) return null;

    const floors = incomeMode
        ? { 3: 8e12, 4: 20e12 }
        : { 3: 2e12, 4: 5e12 };
    const fundMultipliers = incomeMode
        ? { 3: 3.0, 4: 2.5 }
        : { 3: 2.0, 4: 1.6 };
    const revenueHours = incomeMode
        ? { 3: 72, 4: 120 }
        : { 3: 24, 4: 48 };

    return Math.max(
        floors[round] ?? Infinity,
        Number(funds ?? 0) * (fundMultipliers[round] ?? 2.0),
        Number(revenue ?? 0) * 3600 * (revenueHours[round] ?? 24),
    );
}
