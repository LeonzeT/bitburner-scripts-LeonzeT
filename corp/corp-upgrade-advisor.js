// Shared corp upgrade advisor.
//
// Returns ROI-based buy decisions for all corp upgrades without any persistent
// state or temp files.  Import shouldBuyUpgrade / upgradePaybackSecs into any
// round script — R2 and R3 get identical logic and can never conflict.
//
// Modelled per-level fractional revenue gains:
//   Smart Factories                    +3.0 % production multiplier
//   ABC SalesBots                      +1.0 % business factor
//   Wilson Analytics                  ≈+2.0 % advertising effectiveness
//   FocusWires                        ≈+3.0 % ops/eng/mgmt performance
//   Neural Accelerators               ≈+2.5 % ops/eng/rnd performance
//   Speech Processor Implants         ≈+5.0 % biz/mgmt performance
//   Nuoptimal Nootropic Inj. Impl.    ≈+1.5 % ops/rnd performance
//
// Smart Storage uses a warehouse-pressure heuristic instead of the payback
// formula (its benefit is headroom, not a direct revenue multiplier).

/** Per-level fractional revenue gain used by upgradePaybackSecs(). */
export const UPGRADE_GAIN_PER_LEVEL = Object.freeze({
    'Smart Factories':                       0.030,
    'ABC SalesBots':                         0.010,
    'Wilson Analytics':                      0.020,
    'FocusWires':                            0.030,
    'Neural Accelerators':                   0.025,
    'Speech Processor Implants':             0.050,
    'Nuoptimal Nootropic Injector Implants': 0.015,
});

/**
 * Payback time in seconds for buying the next level of a named upgrade.
 * Computed as cost / (gain_per_level × revenue_per_second).
 * Returns Infinity for unknown upgrades, unknown costs, or zero revenue.
 *
 * @param {object} c    - ns.corporation API
 * @param {string} name - upgrade name
 * @returns {number}
 */
export function upgradePaybackSecs(c, name) {
    try {
        const gain = UPGRADE_GAIN_PER_LEVEL[name];
        if (gain == null || gain <= 0) return Infinity;
        const cost = c.getUpgradeLevelCost(name);
        if (!Number.isFinite(cost) || cost <= 0) return Infinity;
        const revenue = Math.max(0, Number(c.getCorporation().revenue ?? 0));
        if (revenue <= 0) return Infinity;
        return cost / (gain * revenue);
    } catch { return Infinity; }
}

/**
 * Decide whether buying the next level of a named upgrade is worthwhile now.
 *
 * Special cases:
 *   Smart Factories — suppressed when all checked warehouses are at or above
 *                     maxWarehouseUsage; extra production would overflow rather
 *                     than increase revenue.
 *   Smart Storage   — uses warehouse pressure instead of the payback formula;
 *                     returns true as soon as any checked warehouse reaches or
 *                     exceeds ssNeedThreshold.
 *
 * All other upgrades use upgradePaybackSecs() ≤ paybackHours × 3600.
 *
 * @param {object} c
 * @param {string} name
 * @param {object} [opts]
 * @param {number}   [opts.paybackHours=48]
 *   Maximum acceptable payback period in hours for ROI-based upgrades.
 * @param {Array}    [opts.warehouseCheck=[]]
 *   Pairs [[divName, cityName], ...] whose warehouses are inspected.
 *   Pass all production-relevant div/city combinations for accurate results.
 * @param {number}   [opts.maxWarehouseUsage=0.80]
 *   If ALL checked warehouses are at or above this fraction, Smart Factories
 *   is suppressed (no production headroom).
 * @param {number}   [opts.ssNeedThreshold=0.75]
 *   If ANY checked warehouse reaches this fraction, Smart Storage is needed.
 * @returns {boolean}
 */
export function shouldBuyUpgrade(c, name, {
    paybackHours = 48,
    warehouseCheck = [],
    maxWarehouseUsage = 0.80,
    ssNeedThreshold = 0.75,
} = {}) {
    if (name === 'Smart Storage') {
        // Buy when any warehouse is under pressure — more space directly prevents
        // production stalls, regardless of current revenue.
        for (const [div, city] of warehouseCheck) {
            try {
                const wh = c.getWarehouse(div, city);
                const usage = Number(wh.sizeUsed ?? 0) / Math.max(Number(wh.size ?? 1), 1);
                if (usage >= ssNeedThreshold) return true;
            } catch { }
        }
        return false;
    }
    if (name === 'Smart Factories' && warehouseCheck.length > 0) {
        // Suppress when every checked warehouse is near-full; production boost
        // provides no benefit when there is nowhere to put the output.
        let anyHeadroom = false;
        for (const [div, city] of warehouseCheck) {
            try {
                const wh = c.getWarehouse(div, city);
                const usage = Number(wh.sizeUsed ?? 0) / Math.max(Number(wh.size ?? 1), 1);
                if (usage < maxWarehouseUsage) { anyHeadroom = true; break; }
            } catch { }
        }
        if (!anyHeadroom) return false;
    }
    return upgradePaybackSecs(c, name) <= paybackHours * 3600;
}
