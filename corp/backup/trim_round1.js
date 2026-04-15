const fs = require('fs');

const FUNCS_TO_REMOVE = new Set([
    'maintainChemicalWaterSupply','shouldLeanOnTobaccoPlantExports','maintainTobaccoPlantSupply',
    'stopTobaccoPlantSupply','stopChemicalWaterSupply','stopChemicalPlantSupply',
    'getDivisionSmartSupplyCounts','maintainPreRound2SupplyState',
    'unlockCost','canConfigureMaterialExport','getWarehouseMaterialCapacity',
    'getExportRateStep','formatExportRate','parseExportRate',
    'scaleByMaturity','getDivisionCityCoverageRatio','getOfficeGrowthRatio','getWarehouseGrowthRatio',
    'getTobaccoDemandMaturity','getChemicalDemandMaturity','getChemicalPlantDemandFloor',
    'getTobaccoPlantDemandFloor','getAgriChemDemandFloor','getAgricultureDemandMaturity',
    'getDynamicMaterialExportAmount','refreshMaterialExport','configureExports',
    'nextTobaccoProductName','getTobaccoProductCapacity','getTobaccoRetirementCandidate',
    'isLeanTobSpikeUnlocked','fillJobRemainder','getRound2TobaccoHQCompletedJobs',
    'getTobaccoFlowStats','getTobaccoFlowNumbers','getTobaccoExportRouteStats',
    'getTobaccoProductInvestment','isLeanTobaccoProductCycleReady',
    'shouldFreezeBn3LeanTobaccoProductCycle','ensureTobaccoProduct','getBn3LeanTobaccoProductReserve',
    'getRound2ReserveInfo','getRound2Reserve','getRound2StagnationDebugStats',
    'estimateRound2AssetProxy','countRound2OfficesAndWarehouses',
    'getBn3AgriPressureSnapshot','getAgriFlowStats','getRound2CorpDebugStats','getExpandedTobaccoDebugStats',
    'supportCities','getRound2AgriOfficeTarget','getRound2AgriWarehouseTarget','getRound2AgriAdvertTarget',
    'getRound2AgriJobs','getRound2AgriPostfillSalesJobs','getBn3AgriPressureReliefJobs',
    'getBn3AgriPostfillReliefJobs','shouldUseBn3AgriPressureRelief','shouldUseBn3AgriPostfillRelief',
    'getBn3PostfillSalesMode','shouldStabilizeBn3Round2Offer','getRound2AgriProductionJobs',
    'getRound2TobaccoHQTargetSize','getRound2TobaccoHQProgressJobs','getRound2TobaccoHQJobs',
    'getRound2TobaccoSupportTargetSize','getRound2TobaccoSupportJobs',
    'getBn3HighBudgetDynamicOfficeTarget','getBn3HighBudgetChemDynamicTarget',
    'getBn3HighBudgetAgriDynamicTarget','getBn3HighBudgetTobHQDynamicTarget','getBn3HighBudgetTobSupportDynamicTarget',
    'getRound2ChemTargetOffice','getRound2ChemHQTargetOffice','getRound2ChemWarehouseTarget','getRound2ChemJobs',
    'tryRound2AgriStep','isRound2AgriBuiltOut','tryRound2UpgradeStep','tryRound2LateAgriStep','tryRound2ChemStep',
    'tryBn3HighBudgetWilsonSeedStep','tryBn3LeanTobWilsonSeedStep','tryBn3LeanTobSpikeStorageStep',
    'tryBn3LeanTobPreSpikeBoostStep','tryBn3LeanTobPreSpikeDummyStep','tryRound2TobaccoStep',
    'tryBn3LeanTobaccoStep','tryBn3LeanTobaccoEarlySupportStep','tryBn3LeanTobaccoPostdoneSupportStep',
    'tryAggressiveWarmupHQStep','tryRound2DummyStep',
    'getBn3HighBudgetMaterialSpendFloor','estimateBn3RemainingMaterialSpend',
    'getBn3DynamicDummyExtraBuffer','getBn3DummySpendFloor','getBn3ValuationCashDragWeight',
    'isBn3LateValuationSpendReady','isBn3LateThroughputReady','shouldUseBn3LatePostdoneBoost',
    'getBn3LateWilsonTarget','getBn3LateTobaccoAdvertTarget',
    'isBn3Round2OfficeBuiltOut','isBn3Round2UpgradeBuiltOut','isBn3Round2WarehouseBuiltOut',
    'isBn3Round2MaterialFilled','isBn3PragmaticAcceptReady','getBn3Round2AcceptReason',
    'tryBn3Round2OfficeStep','tryBn3Round2UpgradeStep','tryBn3Round2WarehouseStep',
    'runBn3Round2BootstrapBatch','tryBn3Round2MaterialStep',
    'tryBn3Round2RealEstatePush','tryBn3DummyExpansion','tryBn3Round2DummyStep',
    'scaleJobPlanToSize','getBn3UpgradeMultiplierEstimate',
    'estimateOfficeProductivityFromJobs','estimateProductDevelopmentScore','estimateBusinessFactorFromProduction',
    'getDivisionRolePerHeadFallback','getProjectedRoleProduction','getProjectedTobaccoOfficeScores',
    'getCurrentTobaccoOfficeScores','safeHasWarehouse','getRound2TobaccoSupportJobsForSize',
    'getBn3LeanSupportOfficeStepTarget','getBn3LateFinanceProfile',
    'calculateBn3AdvertisingSalesFactor','simulateBn3NextTobaccoAdvertFactor','getBn3TobaccoValueShare',
    'simulateBn3TobaccoAdvertFactorAfterPurchases','estimateBn3NextTobaccoAdvertRelativeGain',
    'estimateBn3WilsonRelativeGain','estimateBn3StoredSalesRealization','estimateBn3SalesBotRelativeGain',
    'estimateBn3SmartFactoriesRelativeGain','estimateBn3StorageRelativeGain',
    'estimateBn3EmployeeUpgradeRelativeGain','estimateBn3ProjectInsightRelativeGain',
    'estimateBn3OwRelativeGain','estimateBn3DivisionRelativeGain','estimateBn3DummyCandidate',
    'getBn3PeakStabilizeDummyBypassCandidate','getBn3DynamicTobaccoHQTarget','getBn3DynamicTobaccoSupportTarget',
    'estimateBn3TobaccoOfficeRelativeGain','estimateBn3NewTobaccoSupportCityRelativeGain',
    'buildBn3DynamicLateCandidate','getBn3DynamicAffordablePackage','chooseBn3DynamicLateCandidate',
    'getBn3DynamicLateCandidates','shouldEvaluateBn3DynamicLate','tryBn3DynamicLateSpendStep',
    'hasAgriEarlyPressure','tryBn3Round2SalesBotStep','tryBn3Round2PostfillStorageStep',
    'tryBn3HighBudgetEarlyPressureWarehouseStep','tryBn3Round2PressureWarehouseStep',
    'maintainChemTobPlantRelief','maintainBn3Round2MaterialRelief','getPostRound2TobaccoOfficeTarget',
    'boostMorale','boostMoraleSpike','getResearchSpendThreshold','tryResearch','buyUpgrades','priceProducts',
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

const INPUT = 'E:/OneDrive/BB-Scripts/bitburner-scripts-LeonzeT/corp/corp-round1.js';
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
