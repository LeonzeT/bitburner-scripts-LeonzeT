// Shared warehouse overflow relief for Chemical and Agriculture divisions.
//
// Both corp-round2-wait.js (R2 main loop) and corp-round3.js (private stage)
// need to prevent warehouse fill-up from halting production.  This module
// provides a factory that closes over the per-script context so the logic
// lives in one place.
//
// Usage:
//   import { makeWarehouseReliefFunctions } from '/corp/corp-warehouse-relief.js';
//   // inside main(), after `const c = ns.corporation`:
//   const { maintainChemTobPlantRelief, maintainChemicalsRelief } =
//       makeWarehouseReliefFunctions({ c, hasDiv, CITIES, DIV_CHEM, DIV_AGRI, DIV_TOBACCO });
//   // R2 high-budget path:
//   if (useBn3HighBudgetRound2()) { maintainChemTobPlantRelief(); maintainChemicalsRelief(); }
//   // R3 private stage (always active):
//   maintainChemTobPlantRelief(); maintainChemicalsRelief();

// ── Plant relief constants ────────────────────────────────────────────────────
export const WR_PLANT_CHEM_TRIGGER_PCT = 0.82;
export const WR_PLANT_CHEM_TRIGGER_PCT_PRESSURE = 0.80;
export const WR_PLANT_CHEM_TRIGGER_PCT_WATER_PROTECT = 0.78;
export const WR_PLANT_CHEM_BUFFER = 1000;          // Plants to keep in Chem for next production cycle
export const WR_PLANT_CHEM_DRAIN_CYCLES = 12;
export const WR_PLANT_CHEM_DRAIN_CYCLES_PRESSURE = 8;
export const WR_PLANT_CHEM_DRAIN_CYCLES_WATER_PROTECT = 4;
export const WR_PLANT_CHEM_WATER_PROTECT_FREE_PCT = 0.10;
export const WR_PLANT_CHEM_WATER_BUFFER = 250;
export const WR_PLANT_TOB_TRIGGER_PCT = 0.85;
export const WR_PLANT_TOB_BUFFER = 2000;           // larger buffer for Tobacco — product speed is sensitive
export const WR_PLANT_TOB_DRAIN_CYCLES = 20;

// ── Chemicals relief constants ────────────────────────────────────────────────
export const WR_CHEM_TRIGGER_PCT = 0.82;
export const WR_CHEM_DRAIN_CYCLES = 8;
export const WR_CHEM_CHEM_BUFFER_MIN = 500;
export const WR_CHEM_CHEM_BUFFER_PROD_CYCLES = 3;  // keep 3 cycles' worth for the Agri export
export const WR_CHEM_AGRI_BUFFER = 500;            // Chemicals to keep in Agri for production

/**
 * Build the two relief functions bound to the given per-script context.
 *
 * @param {object} ctx
 * @param {object}   ctx.c              - ns.corporation API handle
 * @param {Function} ctx.hasDiv         - (divName: string) => boolean
 * @param {string[]} ctx.CITIES         - all city names
 * @param {string}   ctx.DIV_CHEM
 * @param {string}   ctx.DIV_AGRI
 * @param {string}   ctx.DIV_TOBACCO
 * @param {Function} [ctx.getAgriPressure] - () => { moderate: boolean }
 *                                           omit / pass null to always use non-pressure path
 *                                           (correct for the private stage where agri
 *                                            pressure is no longer tracked)
 * @returns {{ maintainChemTobPlantRelief: Function, maintainChemicalsRelief: Function }}
 */
export function makeWarehouseReliefFunctions({ c, hasDiv, CITIES, DIV_CHEM, DIV_AGRI, DIV_TOBACCO, getAgriPressure = null }) {
    const _getAgriPressure = getAgriPressure ?? (() => ({ moderate: false }));

    /**
     * Sell excess Plants from Chemical and Tobacco warehouses when they are
     * near-full.  Keeps a per-division buffer so next cycle's production isn't
     * starved.  Chemical additionally protects Water headroom via a tighter
     * trigger when free-space or Water stock is low.
     *
     * Call AFTER configureExports() each tick so the sell-order is applied.
     */
    function maintainChemTobPlantRelief() {
        const agriPressure = hasDiv(DIV_AGRI) ? _getAgriPressure() : { moderate: false };
        const divConfigs = [
            {
                div: DIV_CHEM,
                buffer: WR_PLANT_CHEM_BUFFER,
                triggerPct: agriPressure.moderate ? WR_PLANT_CHEM_TRIGGER_PCT_PRESSURE : WR_PLANT_CHEM_TRIGGER_PCT,
                drainCycles: agriPressure.moderate ? WR_PLANT_CHEM_DRAIN_CYCLES_PRESSURE : WR_PLANT_CHEM_DRAIN_CYCLES,
            },
            {
                div: DIV_TOBACCO,
                buffer: WR_PLANT_TOB_BUFFER,
                triggerPct: WR_PLANT_TOB_TRIGGER_PCT,
                drainCycles: WR_PLANT_TOB_DRAIN_CYCLES,
            },
        ];
        for (const { div, buffer, triggerPct, drainCycles } of divConfigs) {
            if (!hasDiv(div)) continue;
            try {
                const cities = c.getDivision(div).cities;
                for (const city of cities) {
                    if (!c.hasWarehouse(div, city)) continue;
                    try {
                        const wh = c.getWarehouse(div, city);
                        const usage = Number(wh.sizeUsed ?? 0) / Math.max(Number(wh.size ?? 1), 1);
                        const freePct = Math.max(0, 1 - usage);
                        const stored = Number(c.getMaterial(div, city, 'Plants').stored ?? 0);
                        const waterStored = div === DIV_CHEM
                            ? Number(c.getMaterial(div, city, 'Water').stored ?? 0)
                            : 0;
                        const excess = stored - buffer;
                        const waterProtect = div === DIV_CHEM &&
                            (freePct <= WR_PLANT_CHEM_WATER_PROTECT_FREE_PCT ||
                                waterStored < WR_PLANT_CHEM_WATER_BUFFER);
                        const effectiveTriggerPct = waterProtect
                            ? Math.min(triggerPct, WR_PLANT_CHEM_TRIGGER_PCT_WATER_PROTECT)
                            : triggerPct;
                        const effectiveDrainCycles = waterProtect
                            ? WR_PLANT_CHEM_DRAIN_CYCLES_WATER_PROTECT
                            : drainCycles;
                        if (usage >= effectiveTriggerPct && excess > 0) {
                            c.sellMaterial(div, city, 'Plants', Math.ceil(excess / Math.max(1, effectiveDrainCycles)), 'MP');
                        } else {
                            c.sellMaterial(div, city, 'Plants', 0, 'MP');
                        }
                    } catch { }
                }
            } catch { }
        }
    }

    /**
     * Sell excess Chemicals from Chemical and Agriculture warehouses when they
     * are near-full.
     *
     * configureExports() zeroes the Chem Chemicals market sell-order every tick
     * to avoid undercutting the export route to Agri.  With high employee counts
     * Chem can produce far more Chemicals than Agri absorbs, filling the warehouse
     * and leaving no room for Water (halting all production).  This function must
     * be called AFTER configureExports() so its sell-orders take effect for the
     * current tick.
     *
     * Agri is also guarded: Chem→Agri export can push more Chemicals into Agri
     * than production consumes, and excess accumulates there if not sold.
     */
    function maintainChemicalsRelief() {
        // Chem: sell excess Chemicals output when warehouse is getting full.
        if (hasDiv(DIV_CHEM)) {
            for (const city of CITIES) {
                try {
                    if (!c.hasWarehouse(DIV_CHEM, city)) continue;
                    const wh = c.getWarehouse(DIV_CHEM, city);
                    const usage = Number(wh.sizeUsed ?? 0) / Math.max(Number(wh.size ?? 1), 1);
                    const stored = Number(c.getMaterial(DIV_CHEM, city, 'Chemicals').stored ?? 0);
                    const prodRate = Number(c.getMaterial(DIV_CHEM, city, 'Chemicals').productionAmount ?? 0);
                    // Keep enough for the export to Agri to drain over a few cycles.
                    const buffer = Math.max(WR_CHEM_CHEM_BUFFER_MIN, prodRate * WR_CHEM_CHEM_BUFFER_PROD_CYCLES);
                    const excess = stored - buffer;
                    if (usage >= WR_CHEM_TRIGGER_PCT && excess > 0) {
                        c.sellMaterial(DIV_CHEM, city, 'Chemicals', Math.ceil(excess / WR_CHEM_DRAIN_CYCLES), 'MP');
                    }
                    // When usage is below the trigger, leave the sell order at 0
                    // (configureExports already set it; only override on real overflow).
                } catch { }
            }
        }

        // Agri: sell excess Chemicals received from Chem export.
        if (hasDiv(DIV_AGRI)) {
            for (const city of CITIES) {
                try {
                    if (!c.hasWarehouse(DIV_AGRI, city)) continue;
                    const wh = c.getWarehouse(DIV_AGRI, city);
                    const usage = Number(wh.sizeUsed ?? 0) / Math.max(Number(wh.size ?? 1), 1);
                    const stored = Number(c.getMaterial(DIV_AGRI, city, 'Chemicals').stored ?? 0);
                    const excess = stored - WR_CHEM_AGRI_BUFFER;
                    if (usage >= WR_CHEM_TRIGGER_PCT && excess > 0) {
                        c.sellMaterial(DIV_AGRI, city, 'Chemicals', Math.ceil(excess / WR_CHEM_DRAIN_CYCLES), 'MP');
                    } else {
                        c.sellMaterial(DIV_AGRI, city, 'Chemicals', 0, 'MP');
                    }
                } catch { }
            }
        }
    }

    return { maintainChemTobPlantRelief, maintainChemicalsRelief };
}
