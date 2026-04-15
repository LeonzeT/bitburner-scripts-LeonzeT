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
        agriOffice: 24,
        tobHqOffice: 45,
        tobSupportOffice: 30,
        chemOffice: 12,
    }),
    "pre-ipo": Object.freeze({
        smartFactories: 16,
        smartStorage: 18,
        salesBots: 10,
        wilson: 4,
        tobAdvert: 6,
        warehouse: 10,
        agriOffice: 30,
        tobHqOffice: 60,
        tobSupportOffice: 45,
        chemOffice: 15,
    }),
});

// Bounded late-stage stretch goals used only after the normal private-stage
// targets are complete. These are intentionally limited, so the setup script
// can keep squeezing later-round offers without turning into an endless spender.
export const PRIVATE_STAGE_STRETCH_TARGETS = Object.freeze({
    "post-r3": Object.freeze({
        wilson: 6,
        tobAdvert: 7,
        tobHqOffice: 60,
        employeeUpgrades: 5,
    }),
    "pre-ipo": Object.freeze({
        wilson: 8,
        tobAdvert: 9,
        tobHqOffice: 75,
        employeeUpgrades: 8,
    }),
});

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
