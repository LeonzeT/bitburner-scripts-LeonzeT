const fs = require('fs');

// Functions to remove from corp-round2.js:
// - Round1-specific experimental/prep functions (only needed in phase 0-2)
// - Private stage functions (only needed in corp-round3.js phase 7-8)
const FUNCS_TO_REMOVE = new Set([
    // Round1 prep/experimental (only used in phase 1-2)
    'noteRound1Gate',
    'getExperimentalRound1PrepCashReserve',
    'getExperimentalRound1AgriBoostTargets',
    'getExperimentalRound1AgriPressureMetrics',
    'getExperimentalRound1AgriExpectedFlow',
    'estimateExperimentalRound1AgriProjectedBoostRatio',
    'getRound1HighReinvestBoostTopUpWarehouseScale',
    'getExperimentalRound1InitialBoostBudget',
    'estimateRound1AgriBoostFillSpend',
    'tryExperimentalRound1PreBoostSurplusSpend',
    'getRound1HighReinvestRealEstatePushPlan',
    'getRound1HighReinvestBoostTopUpPlan',
    'tryRound1HighReinvestRealEstatePush',
    'tryRound1HighReinvestBoostTopUp',
    'stopExperimentalRound1BoostTrim',
    'shouldPreserveExperimentalRound1Offer',
    'manageExperimentalRound1BoostTrim',
    'getExperimentalRound1TrimStats',
    'isRound1PrepBuiltOut',
    'getRound1NextPrepCandidate',
    'shouldUseHighRound1Stretch',
    'getHighRound1ReinvestReserve',
    'advanceRound1Prep',
    'investInAgricultureForHighRound1',
    'formatRound1Debug',
    // Private stage (only called from waitForPrivateFundingRound -> corp-round3.js)
    'getPrivateStageReserve','getPrivateStageOfficeTarget','getPrivateStageUpgradeTarget',
    'getPrivateStageAdvertTarget','getPrivateStageOfficeJobs','keepPrivateStageJobsCurrent',
    'getPrivateStageMissing','addUniqueMissingLabel','getPrivateStageOfficeMissingLabel',
    'getPrivateStageWarehouseMissingLabel','isPrivateStageReady',
    'tryPrivateStageUpgrade','tryPrivateStageUpgradeToTarget','tryPrivateStageEmployeeUpgrade',
    'tryPrivateStageAdvert','tryPrivateStageAdvertToTarget','tryPrivateStageWarehouse',
    'hirePrivateStageOfficeEmployees','tryPrivateStageOffice','tryPrivateStageOfficeToTarget',
    'getPrivateStageSpareFunds','getPrivateStageEarlyBurstLimit',
    'shouldUsePrivateStageSurplusPush','shouldUsePrivateStageStretch',
    'tryPrivateStageStretchStep','tryPrivateStageSurplusPushStep',
    'getMinOfficeSize','getMinWarehouseLevel','getPrivateStageStagnantNeed','getPrivateStageDebugTargets',
    'formatPrivateStageDebug','maintainPrivateInvestmentState','tryPrivateStageScalingStep',
    'runPrivateStageScalingBatch','logPrivateStageActions','maybeLogPrivateFundingWait',
    'updatePrivateStageStagnation','shouldAcceptPrivateOffer','waitForPrivateFundingRound',
]);

const INPUT = 'E:/OneDrive/BB-Scripts/bitburner-scripts-LeonzeT/corp/corp-round2.js';
const lines = fs.readFileSync(INPUT, 'utf8').split('\n');

const removeSet = new Set();
const removedNames = [];
let i = 0;
while (i < lines.length) {
    const m = lines[i].match(/^    (?:async )?function (\w+)\s*\(/);
    if (m && FUNCS_TO_REMOVE.has(m[1])) {
        const funcName = m[1];
        const start = i;
        let depth = 0, j = i, foundEnd = false, endLine = i;
        while (j < lines.length) {
            for (const ch of lines[j]) {
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { foundEnd = true; break; } }
            }
            if (foundEnd) { endLine = j; break; }
            j++;
        }
        if (foundEnd) {
            let end = endLine;
            if (end + 1 < lines.length && lines[end + 1].trim() === '') end++;
            for (let k = start; k <= end; k++) removeSet.add(k);
            removedNames.push(funcName);
            i = end + 1;
            continue;
        }
    }
    i++;
}

const notFound = [...FUNCS_TO_REMOVE].filter(n => !removedNames.includes(n));
if (notFound.length) console.log('NOT FOUND:', notFound.sort().join(', '));

const kept = lines.filter((_, idx) => !removeSet.has(idx));
fs.writeFileSync(INPUT, kept.join('\n'), 'utf8');
console.log('Removed functions:', removedNames.length);
console.log('Lines removed:', removeSet.size);
console.log('Original:', lines.length, '-> Result:', kept.length);
console.log('Done!');
