/**
* corp/corp-round3.js   Corporation bootstrapper
*
*
* @param {NS} ns
*/
import { formatMoney } from '/helpers.js';
import { PRIVATE_STAGE_TARGETS, PRIVATE_STAGE_STRETCH_TARGETS, clamp, formatEta, estimateFundsWaitSeconds, combineRelativeGains, getPrivateOfferThreshold, optimalBoosts, parseOptions, getBoostConfig, getRequiredMaterialsConfig, makeMaterialHelpers, makeCorpHelpers, } from '/corp/corp-optimizer-shared.js';
import { makeWarehouseReliefFunctions } from '/corp/corp-warehouse-relief.js';
import { shouldBuyUpgrade } from '/corp/corp-upgrade-advisor.js';
import { COMMON as C, ROUND3_CONSTANTS as R3} from '/corp/corp-constants.js';
//
export async function main(ns) {
    const opts = parseOptions(ns, R3.argsSchema, R3.ARG_ALIASES);
    ns.disableLog('ALL');
    ns.clearLog();
    ns.ui.openTail();
    const c = ns.corporation;
    // getAgriPressure omitted private stage no longer tracks agri pressure,
    // so the factory defaults to { moderate: false } for every tick.
    const { maintainChemTobPlantRelief, maintainChemicalsRelief } = makeWarehouseReliefFunctions({
        c, hasDiv, CITIES: C.CITIES, DIV_CHEM: C.DIV_CHEM, DIV_AGRI: C.DIV_AGRI, DIV_TOBACCO: C.DIV_TOBACCO,
    });
    let bn3HighBudgetRound2Locked = false;
    let bn3HighBudgetRound2StartFunds = 0;
    function log(ns, message, _terminal = false, _level = 'info') {
        ns.print(String(message));
    }
    //  Debug mode 
    // Usage: run corp/corp-setup.js --debug
    // Prints a full corp snapshot every cycle to the tail window.
    const CORP_DEBUG = ns.args.includes('--debug');
    function tryOrWarn(fn, label) {
        try {
            return fn();
        }
        catch (e) {
            if (CORP_DEBUG)
                log(ns, `[CORP WARN] ${label}: ${e?.message ?? e}`);
            return undefined;
        }
    }
    let _dbgCycle = 0;
    function printCorpDebugDump() {
        if (!CORP_DEBUG)
            return;
        _dbgCycle++;
        const out = [];
        const pr = (s) => out.push(s);
        const fm = (n) => { try {
            return formatMoney(Number(n ?? 0));
        }
        catch {
            return String(n);
        } };
        const pct = (u, t) => t > 0 ? `${((u / t) * 100).toFixed(0)}%` : '0%';
        const f2 = (n) => Number.isFinite(n) ? n.toFixed(2) : '?';
        const f0 = (n) => Number.isFinite(n) ? n.toFixed(0) : '?';
        try {
            const corp = c.getCorporation();
            const funds = Number(corp.funds ?? 0);
            const rev = Number(corp.revenue ?? 0);
            const exp = Number(corp.expenses ?? 0);
            let phaseVal = '?';
            try {
                phaseVal = phase;
            }
            catch { }
            let reserveVal = NaN;
            try {
                reserveVal = getBn3Round2Reserve();
            }
            catch { }
            const headroom = Number.isFinite(reserveVal) ? fm(funds - reserveVal) : 'n/a';
            pr(`≫煤CORP DEBUG #${_dbgCycle} ≫煤 phase=${phaseVal}  state=${corp.state}`);
            pr(`  funds=${fm(funds)}  rev=${fm(rev)}/s  exp=${fm(exp)}/s  profit=${fm(rev - exp)}/s`);
            // Investment offer + reserve
            try {
                const offer = c.getInvestmentOffer();
                pr(`  offer=${fm(offer.funds)} (rnd=${offer.round})  target=${fm(C.MIN_ROUND2)}  ` +
                    `reserve=${Number.isFinite(reserveVal) ? fm(reserveVal) : 'n/a'}  headroom=${headroom}`);
            }
            catch { }
            // Corp-level upgrades (compact single line)
            const UPG = [
                ['Wilson Analytics', 'Wilson'], ['Smart Factories', 'SF'], ['Smart Storage', 'SS'],
                ['ABC SalesBots', 'SB'], ['FocusWires', 'FW'], ['Neural Accelerators', 'NA'],
                ['Speech Processor Implants', 'Speech'], ['Nuoptimal Nootropic Injector Implants', 'Nuopt'],
                ['Project Insight', 'Insight'], ['DreamSense', 'Dream'],
            ];
            const upgLine = UPG.map(([n, a]) => { try {
                return `${a}:${c.getUpgradeLevel(n)}`;
            }
            catch {
                return null;
            } })
                .filter(Boolean).join(' ');
            pr(`  upgrades: ${upgLine}`);
            // Morale upkeep last cycle
            const teaStr = latestTeaSpend > 0 ? `tea=${fm(latestTeaSpend)}` : null;
            const partyStr = latestPartySpend > 0 ? `party=${fm(latestPartySpend)}` : null;
            const moraleNote = [teaStr, partyStr].filter(Boolean).join('  ');
            if (moraleNote)
                pr(`  morale spend: ${moraleNote}`);
            // Per-division
            for (const [div, label] of [[C.DIV_AGRI, 'Agri'], [C.DIV_TOBACCO, 'Tob'], [C.DIV_CHEM, 'Chem']]) {
                if (!hasDiv(div)) {
                    pr(`  [${label}] absent`);
                    continue;
                }
                try {
                    const division = c.getDivision(div);
                    const rp = f0(Number(division.researchPoints ?? 0));
                    const adv = (() => { try {
                        return c.getHireAdVertCount(div);
                    }
                    catch {
                        return '?';
                    } })();
                    const aware = f0(Number(division.awareness ?? 0));
                    const pop = f0(Number(division.popularity ?? 0));
                    pr(`   [${label}]  aware=${aware}  pop=${pop}  advert=${adv}  rp=${rp}`);
                    // Researches unlocked
                    const RESEARCHES = ['Hi-Tech R&D Laboratory', 'Market-TA.I', 'Market-TA.II',
                        'Self-Correcting Assemblers', 'Overclock', 'Shady Accounting', 'Government Partnership',
                        'uPgrade: Fulcrum', 'uPgrade: Capacity.I', 'uPgrade: Capacity.II'];
                    const resOn = RESEARCHES.filter(r => { try {
                        return c.hasResearched(div, r);
                    }
                    catch {
                        return false;
                    } })
                        .map(r => r.replace('Market-TA.', 'TA').replace('Hi-Tech R&D Laboratory', 'R&D-Lab')
                        .replace('Self-Correcting Assemblers', 'SCA').replace('uPgrade: ', 'up:')
                        .replace('Shady Accounting', 'Shady').replace('Government Partnership', 'GovPart'));
                    if (resOn.length)
                        pr(`    research: ${resOn.join(', ')}`);
                    for (const city of (division.cities ?? [])) {
                        try {
                            const off = c.getOffice(div, city);
                            const ej = off.employeeJobs ?? {};
                            const ep = off.employeeProductionByJob ?? {};
                            // Job counts: O/E/B/M/R/U
                            const jO = Number(ej['Operations'] ?? 0);
                            const jE = Number(ej['Engineer'] ?? 0);
                            const jB = Number(ej['Business'] ?? 0);
                            const jM = Number(ej['Management'] ?? 0);
                            const jR = Number(ej['Research & Development'] ?? 0);
                            const jU = Number(ej['Unassigned'] ?? 0);
                            const jobStr = `O:${jO} E:${jE} B:${jB} M:${jM} R:${jR}${jU > 0 ? ` U:${jU}` : ''}`;
                            // Employee stats
                            const energy = f0(Number(off.avgEnergy ?? 100));
                            const morale = f0(Number(off.avgMorale ?? 100));
                            const prodTotal = f2(Number(ep['total'] ?? 0));
                            // Warehouse
                            let whStr = 'WH:none';
                            try {
                                const wh = c.getWarehouse(div, city);
                                whStr = `WH:${pct(wh.sizeUsed, wh.size)}(${f0(wh.sizeUsed)}/${f0(wh.size)})`;
                            }
                            catch { }
                            pr(`    ${city.padEnd(12)} sz=${off.size} [${jobStr}]  nrg=${energy} mor=${morale} prod=${prodTotal}  ${whStr}`);
                        }
                        catch {
                            pr(`    ${city}: err`);
                        }
                        // Materials
                        const matList = div === C.DIV_AGRI
                            ? ['Food', 'Plants', 'Chemicals', 'Water', 'Hardware', 'Real Estate', 'AI Cores']
                            : div === C.DIV_TOBACCO
                                ? ['Plants', 'Hardware', 'Chemicals', 'Real Estate', 'AI Cores']
                                : ['Plants', 'Chemicals', 'Water', 'Hardware'];
                        for (const mat of matList) {
                            try {
                                const m = c.getMaterial(div, city, mat);
                                const stored = Number(m.stored ?? 0);
                                const prod = Number(m.productionAmount ?? 0);
                                const sell = Number(m.actualSellAmount ?? 0);
                                const imp = Number(m.importAmount ?? 0);
                                const buy = Number(m.buyAmount ?? 0);
                                // Skip truly empty non-key materials
                                const isCoreInput = (div === C.DIV_AGRI && (mat === 'Chemicals' || mat === 'Water'))
                                    || (div === C.DIV_CHEM && (mat === 'Plants' || mat === 'Water'))
                                    || (div === C.DIV_TOBACCO && mat === 'Plants');
                                if (!isCoreInput && stored < 1 && prod === 0 && imp === 0 && buy === 0)
                                    continue;
                                const parts = [`qty=${f0(stored)}`];
                                if (prod !== 0)
                                    parts.push(`prd=${f2(prod)}/s`);
                                if (sell !== 0)
                                    parts.push(`sll=${f2(sell)}/s`);
                                if (imp !== 0)
                                    parts.push(`imp=${f2(imp)}/s`);
                                if (buy !== 0)
                                    parts.push(`buy=${f2(buy)}/s`);
                                pr(`      ${mat.padEnd(12)} ${parts.join('  ')}`);
                            }
                            catch { }
                        }
                        // Products (Tobacco only)
                        if (div === C.DIV_TOBACCO) {
                            for (const pName of tobaccoProducts()) {
                                try {
                                    const prod = c.getProduct(div, city, pName);
                                    const progress = Number(prod.developmentProgress ?? 0);
                                    const stored = Number(prod.stored ?? 0);
                                    const prdAmt = Number(prod.productionAmount ?? 0);
                                    const sllAmt = Number(prod.actualSellAmount ?? 0);
                                    if (city === C.HQ_CITY) {
                                        // Full product stats once from HQ
                                        const rat = f2(Number(prod.rating ?? 0));
                                        const dmd = f2(Number(prod.demand ?? prod.dmd ?? 0));
                                        const cmp = f2(Number(prod.competition ?? prod.cmp ?? 0));
                                        const mku = f2(Number(prod.markup ?? prod.mku ?? 0));
                                        const pCost = fm(Number(prod.productionCost ?? prod.pCost ?? 0));
                                        const price = prod.desiredSellPrice ?? prod.sellCost ?? prod.sCost ?? '?';
                                        const ta1 = (() => { try {
                                            return c.hasResearched(div, 'Market-TA.I');
                                        }
                                        catch {
                                            return false;
                                        } })();
                                        const ta2 = (() => { try {
                                            return c.hasResearched(div, 'Market-TA.II');
                                        }
                                        catch {
                                            return false;
                                        } })();
                                        const taStr = ta2 ? ' TA2' : ta1 ? ' TA1' : '';
                                        pr(`    [${pName}${progress < 100 ? ` dev=${f0(progress)}%` : ''}]${taStr}  rat=${rat}  dmd=${dmd}  cmp=${cmp}  mku=${mku}  pCost=${pCost}  price=${typeof price === 'number' ? fm(price) : price}`);
                                    }
                                    pr(`      ${city.padEnd(12)} qty=${f0(stored)}  prd=${f2(prdAmt)}/s  sll=${f2(sllAmt)}/s`);
                                }
                                catch { }
                            }
                        }
                    }
                }
                catch (e) {
                    pr(`  [${label}] error: ${e?.message ?? e}`);
                }
            }
        }
        catch (e) {
            out.push(`[CORP DEBUG ERROR] ${e?.message ?? e}`);
        }
        for (const line of out)
            ns.print(line);
    }
    function readSetupRoute() {
        try {
            const parsed = JSON.parse(ns.read(C.SETUP_ROUTE_FILE) || 'null');
            return parsed && typeof parsed === 'object' ? parsed : null;
        }
        catch {
            return null;
        }
    }
    function writeSetupRoute(route = null, startFunds = null) {
        try {
            if (!route) {
                ns.rm(C.SETUP_ROUTE_FILE, 'home');
                return;
            }
            const safeFunds = Number(startFunds ?? 0);
            ns.write(C.SETUP_ROUTE_FILE, JSON.stringify({
                bn3Round2: String(route),
                startFunds: Number.isFinite(safeFunds) ? safeFunds : 0,
            }), 'w');
        }
        catch { }
    }
    function getPersistedBn3Round2Route() {
        if (!useBn3Round2())
            return null;
        const route = String(readSetupRoute()?.bn3Round2 ?? '').toLowerCase();
        return ['high', 'lean', 'classic'].includes(route) ? route : null;
    }
    function restorePersistedBn3Round2State() {
        const savedRoute = readSetupRoute();
        const route = String(savedRoute?.bn3Round2 ?? '').toLowerCase();
        if (route !== 'high')
            return;
        const persistedStartFunds = Number(savedRoute?.startFunds ?? 0);
        bn3HighBudgetRound2Locked = true;
        bn3HighBudgetRound2StartFunds = Math.max(bn3HighBudgetRound2StartFunds, Number.isFinite(persistedStartFunds) ? persistedStartFunds : 0, C.ROUND2_BN3_HIGH_BUDGET_FUNDS_TRIGGER);
    }
    function useBn3Round2() {
        return opts['bn3-round2'] || opts['legacy-round2'];
    }
    function useBn3Round2RealEstatePush() {
        return useBn3Round2() && opts['bn3-re-push'];
    }
    function useBn3Round2Dummy() {
        return useBn3Round2() && opts['bn3-dummy-round2'];
    }
    function useBn3PostfillSales() {
        return useBn3Round2() && (opts['bn3-postfill-sales'] || useBn3ExpandedTobaccoRound2());
    }
    function useBn3Round2SalesBots() {
        return useBn3Round2() && opts['bn3-salesbots'];
    }
    function useBn3PostfillStorage() {
        return useBn3Round2() && opts['bn3-postfill-storage'];
    }
    function useBn3HeadroomFill() {
        return useBn3Round2() && opts['bn3-headroom-fill'];
    }
    function useBn3HighBudgetRound2() {
        if (!useBn3Round2())
            return false;
        if (opts['bn3-lean-tob-round2'])
            return false;
        if (opts['bn3-no-lean-tob-round2'])
            return true;
        const persistedRoute = getPersistedBn3Round2Route();
        if (persistedRoute === 'high')
            return true;
        if (persistedRoute === 'lean' || persistedRoute === 'classic')
            return false;
        if (bn3HighBudgetRound2Locked)
            return true;
        try {
            const corp = c.getCorporation();
            if (!corp || corp.public)
                return false;
            return Number(corp.funds ?? 0) >= C.ROUND2_BN3_HIGH_BUDGET_FUNDS_TRIGGER;
        }
        catch {
            return false;
        }
    }
    function useBn3LeanTobRound2() {
        if (!useBn3Round2())
            return false;
        if (opts['bn3-lean-tob-round2'])
            return true;
        if (opts['bn3-no-lean-tob-round2'])
            return false;
        const persistedRoute = getPersistedBn3Round2Route();
        if (persistedRoute === 'lean')
            return true;
        if (persistedRoute === 'high' || persistedRoute === 'classic')
            return false;
        return !useBn3HighBudgetRound2();
    }
    function useBn3ExpandedTobaccoRound2() {
        return useBn3LeanTobRound2() || useBn3HighBudgetRound2();
    }
    function useAggressiveRound2Targets() {
        return opts['aggressive-round2'] || useBn3HighBudgetRound2();
    }
    function useBn3LeanTobSupport() {
        return useBn3LeanTobRound2();
    }
    function useBn3LeanTobHQPush() {
        return useBn3LeanTobRound2();
    }
    function useBn3Hard5tGoal() {
        return useBn3Round2() && opts['bn3-hard-5t-goal'];
    }
    function useBn3SoftAccept() {
        if (useBn3Hard5tGoal())
            return false;
        return opts['bn3-soft-accept'] || useBn3LeanTobRound2();
    }
    function useIncomeMode() {
        return opts['income-mode'];
    }
    function useRound4Path() {
        return opts['round4'];
    }
    function canInferBn3HighBudgetShell() {
        if (!useBn3Round2() || opts['bn3-lean-tob-round2'])
            return false;
        try {
            if (!c.hasCorporation())
                return false;
            const corp = c.getCorporation();
            if (!corp || corp.public)
                return false;
            if (!hasDiv(C.DIV_CHEM) || !hasDiv(C.DIV_TOBACCO) || !c.hasUnlock(C.UNLOCKS.export))
                return false;
            return c.getDivision(C.DIV_CHEM).cities.includes(C.HQ_CITY) && c.getDivision(C.DIV_TOBACCO).cities.includes(C.HQ_CITY);
        }
        catch {
            return false;
        }
    }
    function lockBn3HighBudgetRound2Profile(baselineFunds = null) {
        if (!useBn3Round2() || opts['bn3-lean-tob-round2'])
            return false;
        if (bn3HighBudgetRound2Locked)
            return true;
        const inferred = canInferBn3HighBudgetShell();
        let funds = Number(baselineFunds ?? 0);
        if (!Number.isFinite(funds) || funds <= 0) {
            try {
                funds = Number(c.getCorporation().funds ?? 0);
            }
            catch {
                funds = 0;
            }
        }
        if (!(opts['bn3-no-lean-tob-round2'] || funds >= C.ROUND2_BN3_HIGH_BUDGET_FUNDS_TRIGGER || inferred))
            return false;
        bn3HighBudgetRound2Locked = true;
        bn3HighBudgetRound2StartFunds = Math.max(bn3HighBudgetRound2StartFunds, funds, inferred ? C.ROUND2_BN3_HIGH_BUDGET_FUNDS_TRIGGER : 0);
        writeSetupRoute('high', bn3HighBudgetRound2StartFunds);
        return true;
    }
    function getRound1Target() {
        return R3.ROUND1_EXPERIMENTAL_TARGET;
    }
    function getRound1SoftFloor() {
        return R3.ROUND1_EXPERIMENTAL_SOFT_FLOOR;
    }
    function getRound1StagnationLimit() {
        return R3.ROUND1_EXPERIMENTAL_STAGNATION_LIMIT;
    }
    function getRound1SmartStorageTarget() {
        return R3.ROUND1_EXPERIMENTAL_SMART_STORAGE_TARGET;
    }
    function getRound1WarehouseTarget() {
        return R3.ROUND1_EXPERIMENTAL_WAREHOUSE_TARGET;
    }
    function getRound1AdvertTarget() {
        return R3.ROUND1_EXPERIMENTAL_ADVERT_TARGET;
    }
    function getRound1FreezeRatio() {
        return R3.ROUND1_EXPERIMENTAL_FREEZE_RATIO;
    }
    function estimateSmartStorageSeriesCost(targetLevel) {
        try {
            let level = Number(c.getUpgradeLevel('Smart Storage') ?? 0);
            let cost = Number(c.getUpgradeLevelCost('Smart Storage') ?? 0);
            if (!Number.isFinite(level) || !Number.isFinite(cost) || cost < 0)
                return 0;
            let total = 0;
            while (level < targetLevel) {
                total += cost;
                cost *= C.ROUND1_SMART_STORAGE_COST_MULT;
                level++;
            }
            return total;
        }
        catch {
            return 0;
        }
    }
    function estimateAdvertSeriesCost(div, targetCount) {
        try {
            let count = Number(c.getHireAdVertCount(div) ?? 0);
            let cost = Number(c.getHireAdVertCost(div) ?? 0);
            if (!Number.isFinite(count) || !Number.isFinite(cost) || cost < 0)
                return 0;
            let total = 0;
            while (count < targetCount) {
                total += cost;
                cost *= C.ROUND1_ADVERT_COST_MULT;
                count++;
            }
            return total;
        }
        catch {
            return 0;
        }
    }
    function getBn3BaseMaterialTargets() {
        return useBn3HeadroomFill() ? C.ROUND2_BN3_HEADROOM_MATERIAL_TARGETS : C.ROUND2_BN3_MATERIAL_TARGETS;
    }
    function getRound2FinanceSnapshot() {
        try {
            const corp = c.getCorporation();
            const funds = Math.max(0, Number(corp.funds ?? 0));
            const revenue = Math.max(0, Number(corp.revenue ?? 0));
            const expenses = Math.max(0, Number(corp.expenses ?? 0));
            const profit = revenue - expenses;
            const margin = revenue > 0 ? profit / revenue : 0;
            return { funds, revenue, expenses, profit, margin };
        }
        catch {
            return { funds: 0, revenue: 0, expenses: 0, profit: 0, margin: 0 };
        }
    }
    function getBn3HighBudgetTrueProfit() {
        // Returns a "true" operational profit that strips out the temporary revenue
        // from liquidating Round-1 boost materials (Real Estate, AI Cores).
        // During buildout-zero, those sales inflate the apparent profit figure;
        // using it raw causes over-staffing before the corp can self-sustain.
        const finance = getRound2FinanceSnapshot();
        if (!isBn3HighBudgetBuildoutMode())
            return finance.profit;
        // Once products exist, trust the revenue boost mats exhausted or
        // product revenue now dominates the income picture.
        if (getTobaccoProductStats().finishedProducts > 0)
            return finance.profit;
        // Check if any Agri city still holds Real Estate (the primary boost mat).
        try {
            for (const city of C.CITIES) {
                if (!hasDiv(C.DIV_AGRI) || !c.hasWarehouse(C.DIV_AGRI, city))
                    continue;
                if (Number(c.getMaterial(C.DIV_AGRI, city, 'Real Estate').stored ?? 0) > 0) {
                    // Still liquidating: cap at a conservative multiple of expenses
                    // so scaling decisions are based on base operational capacity.
                    return Math.min(finance.profit, finance.expenses * C.ROUND2_BN3_HIGH_BUDGET_BOOST_MAT_SAFETY_MULT);
                }
            }
        }
        catch { }
        return finance.profit; // boost mats exhausted, profit is genuine
    }
    function getBn3HighBudgetQualifyingOfficeCount() {
        // Count offices at >= 9 employees across all divisions.
        // Used to estimate total ongoing morale maintenance cost (tea + party)
        // when deciding whether the corp can afford pushing another city to 9+.
        let count = 0;
        for (const div of [C.DIV_AGRI, C.DIV_TOBACCO, C.DIV_CHEM]) {
            if (!hasDiv(div))
                continue;
            try {
                for (const city of C.CITIES) {
                    try {
                        if (c.getOffice(div, city).numEmployees >= 9)
                            count++;
                    }
                    catch { }
                }
            }
            catch { }
        }
        return count;
    }
    function getEffectiveBn3BestOffer(bestOffer = 0) {
        return Math.max(0, Number(bestOffer ?? 0), Number(latestMeaningfulRound2Offer ?? 0), Number(latestRound2Offer ?? 0));
    }
    function isBn3HighBudgetBuildoutHealthy(bestOffer = 0) {
        if (!useBn3HighBudgetRound2())
            return true;
        const offer = getEffectiveBn3BestOffer(bestOffer);
        const finance = getRound2FinanceSnapshot();
        if (offer >= C.ROUND2_BN3_HIGH_BUDGET_BUILDOUT_HEALTHY_OFFER)
            return true;
        return finance.funds >= C.ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_FUNDS &&
            finance.profit >= C.ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_PROFIT &&
            finance.margin >= C.ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_MARGIN;
    }
    function getBn3HighBudgetBootstrapActionLimit(bestOffer = 0) {
        if (!useBn3HighBudgetRound2())
            return 32;
        const offer = getEffectiveBn3BestOffer(bestOffer);
        const finance = getRound2FinanceSnapshot();
        if (!isBn3HighBudgetPostfillUnlocked()) {
            return finance.funds >= C.ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_FUNDS
                ? C.ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_STABLE
                : C.ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_WEAK;
        }
        if (!isBn3HighBudgetBuildoutMode()) {
            return finance.funds >= C.ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_FUNDS || offer >= C.ROUND2_BN3_HIGH_BUDGET_BUILDOUT_HEALTHY_OFFER
                ? C.ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_STABLE
                : C.ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_WEAK;
        }
        if (offer >= 1e12 ||
            (finance.funds >= 20e9 && finance.profit >= 25e6 && finance.margin >= 0.40)) {
            return C.ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_HEALTHY;
        }
        return isBn3HighBudgetBuildoutHealthy(offer)
            ? C.ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_STABLE
            : C.ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_WEAK;
    }
    function isBn3HighBudgetProductCycleReady(bestOffer = 0, stagnantChecks = 0) {
        if (!useBn3HighBudgetRound2() || !hasDiv(C.DIV_TOBACCO))
            return true;
        if (!isBn3HighBudgetPostfillUnlocked())
            return true;
        const { finishedProducts } = getTobaccoProductStats();
        if (finishedProducts <= 0)
            return true;
        if (isBn3HighBudgetLateSpikeReady())
            return true;
        const offer = getEffectiveBn3BestOffer(bestOffer);
        const finance = getRound2FinanceSnapshot();
        if (offer >= C.ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_TRIGGER)
            return true;
        if (stagnantChecks >= C.ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_STAGNATION &&
            finance.funds >= C.ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_FUNDS &&
            finance.profit >= C.ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_PROFIT) {
            return true;
        }
        return finance.funds >= C.ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_FUNDS &&
            finance.profit >= C.ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_PROFIT &&
            finance.margin >= C.ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_MARGIN;
    }
    function getMoraleUpkeepFloor() {
        const finance = getRound2FinanceSnapshot();
        const raw = Math.max(C.CORP_MORALE_UPKEEP_MIN_FUNDS, finance.expenses * C.CORP_MORALE_UPKEEP_RESERVE_SECS);
        // Cap so morale spending stays net-positive each cycle.
        // funds*0.9 was too permissive: 10 offices ($500k tea + $250k party)
        // every 30s = $15M/min vs only ~$8.7M/min profit rapid fund drain.
        // Instead, keep at least one cycle's worth of profit as a spending buffer,
        // so the most we spend on morale in any cycle is bounded by what we earn.
        const profitBudget = finance.profit > 0
            ? Math.max(C.CORP_TEA_COST * 2, finance.profit * C.CYCLE_SECS)
            : C.CORP_TEA_COST * 2;
        return Math.min(raw, Math.max(0, finance.funds - profitBudget));
    }
    function getOfficeSpendKey(div, city) {
        return `${div}|${city}`;
    }
    function isBn3HighBudgetChemBuildoutReady() {
        if (!useBn3HighBudgetRound2() || !hasDiv(C.DIV_CHEM))
            return false;
        try {
            const division = c.getDivision(C.DIV_CHEM);
            if ((division.cities?.length ?? 0) < C.CITIES.length)
                return false;
            for (const city of C.CITIES) {
                if (!division.cities.includes(city))
                    return false;
                if (!c.hasWarehouse(C.DIV_CHEM, city))
                    return false;
                const wh = c.getWarehouse(C.DIV_CHEM, city);
                const office = c.getOffice(C.DIV_CHEM, city);
                const target = city === C.HQ_CITY
                    ? C.ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_BUILDOUT
                    : C.ROUND2_BN3_HIGH_BUDGET_CHEM_OFFICE_BUILDOUT;
                const warehouseTarget = city === C.HQ_CITY
                    ? C.ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_WAREHOUSE_BUILDOUT
                    : C.ROUND2_BN3_HIGH_BUDGET_CHEM_WAREHOUSE_BUILDOUT;
                if (wh.level < warehouseTarget)
                    return false;
                if (office.size < target || office.numEmployees < office.size)
                    return false;
            }
            return true;
        }
        catch {
            return false;
        }
    }
    function isBn3HighBudgetLateSpikeReady() {
        if (!useBn3HighBudgetRound2() || !hasDiv(C.DIV_AGRI) || !isBn3HighBudgetPostfillUnlocked())
            return false;
        if (!hasDiv(C.DIV_CHEM) || !hasDiv(C.DIV_TOBACCO))
            return false;
        if (!isBn3HighBudgetChemBuildoutReady())
            return false;
        if (getHighestTobaccoProductVersion() < C.ROUND2_BN3_HIGH_BUDGET_SPIKE_PRODUCT_VERSION)
            return false;
        try {
            const { finishedProducts } = getTobaccoProductStats();
            if (finishedProducts <= 0)
                return false;
            if (c.getDivision(C.DIV_TOBACCO).cities.length < C.CITIES.length)
                return false;
            if (c.getHireAdVertCount(C.DIV_TOBACCO) < C.ROUND2_BN3_HIGH_BUDGET_TOB_ADVERT)
                return false;
            if (c.getUpgradeLevel('Smart Storage') < C.ROUND2_BN3_POSTFILL_SMART_STORAGE_TARGET)
                return false;
            if (c.getUpgradeLevel('ABC SalesBots') < C.ROUND2_BN3_SALESBOT_TARGET)
                return false;
        }
        catch {
            return false;
        }
        return true;
    }
    function isBn3HighBudgetBuildoutMode() {
        return useBn3HighBudgetRound2() &&
            isBn3HighBudgetPostfillUnlocked() &&
            !isBn3HighBudgetLateSpikeReady();
    }
    function shouldDeferBn3HighBudgetGenericUpgradesForChem() {
        return useBn3HighBudgetRound2() &&
            isBn3HighBudgetPostfillUnlocked() &&
            !isBn3HighBudgetChemBuildoutReady();
    }
    function getBn3ActiveMaterialProfile() {
        const baseProfile = useBn3HeadroomFill() ? 'headroom90' : 'classic';
        const baseTargets = getBn3BaseMaterialTargets();
        if (!useBn3HighBudgetRound2() || !hasDiv(C.DIV_AGRI) || !isBn3HighBudgetPostfillUnlocked()) {
            // Lean-tob spike: once maturity + spike SS target are met, switch to the
            // late-spike targets and allow debt fill. Uses the same target set as the
            // high-budget late spike since those are calibrated to fit in the warehouse.
            if (useBn3LeanTobRound2() && isLeanTobSpikeUnlocked()) {
                return { profile: 'lean-tob-spike', targets: C.ROUND2_BN3_LATE_SPIKE_MATERIAL_TARGETS };
            }
            bn3HighBudgetMaterialProfileState = '';
            return { profile: baseProfile, targets: baseTargets };
        }
        const nextProfile = isBn3HighBudgetLateSpikeReady() ? 'late-spike' : 'buildout-zero';
        bn3HighBudgetMaterialProfileState = nextProfile;
        return {
            profile: nextProfile,
            targets: nextProfile === 'late-spike'
                ? C.ROUND2_BN3_LATE_SPIKE_MATERIAL_TARGETS
                : baseTargets,
        };
    }
    function getBn3MaterialTargetProfileLabel() {
        return getBn3ActiveMaterialProfile().profile;
    }
    function getBn3MaterialTargets() {
        return getBn3ActiveMaterialProfile().targets;
    }
    function delayChemicalUntilPostRound2() {
        return useBn3Round2() && !useBn3HighBudgetRound2();
    }
    function delayTobaccoUntilPostRound2() {
        if (useBn3LeanTobRound2())
            return false;
        if (useBn3HighBudgetRound2())
            return false;
        if (useBn3Round2())
            return true;
        return C.DELAY_TOBACCO_UNTIL_POST_ROUND2 && !opts['aggressive-round2'];
    }
    function resolvePath(key, fallbackFile) {
        try {
            const p = JSON.parse(ns.read('/script-paths.json') || '{}');
            if (typeof p[key] === 'string' && p[key].length > 0)
                return p[key];
        }
        catch { }
        const script = ns.getScriptName();
        const slash = script.lastIndexOf('/');
        return slash === -1 ? fallbackFile : `${script.slice(0, slash)}/${fallbackFile}`;
    }
    const AGRI_BOOST = getBoostConfig(c, C.IND_AGRI, C.AGRI_FACTORS, C.AGRI_SIZES, C.AGRI_MATS);
    const CHEM_BOOST = getBoostConfig(c, C.IND_CHEM, C.CHEM_FACTORS, C.CHEM_SIZES, C.CHEM_MATS);
    const TOB_BOOST = getBoostConfig(c, C.IND_TOBACCO, C.TOB_FACTORS, C.TOB_SIZES, C.TOB_MATS);
    const ROUND1_AGRI_REQUIRED = getRequiredMaterialsConfig(c, C.IND_AGRI, { Water: 0.5, Chemicals: 0.2 });
    const ROUND1_AGRI_MAT_SIZES = Object.fromEntries(Object.keys(ROUND1_AGRI_REQUIRED).map((mat) => [mat, c.getMaterialData(mat)?.size ?? 0.05]));
    const ROUND1_AGRI_PRODUCT_MAT_SIZES = Object.freeze({
        Food: c.getMaterialData('Food')?.size ?? 0.03,
        Plants: c.getMaterialData('Plants')?.size ?? 0.05,
    });
    const { getDivisionBoostConfig, getMaterialSize, getPhysicalMaterialSize, estimateBoostTargetsForSize, getMaterialBuyPrice, estimateBoostTopUpCost, estimateMaterialTargetSpend, scaleMaterialTargets, scaleMaterialTargetsFromStored, getProjectedMaterialTargetAddedSpace, fitMaterialTargetsToBudget, getCorpOfficeInitialCost, getCorpWarehouseInitialCost, estimateWarehouseUpgradeSpend, estimateSmartStorageUpgradeSpend, } = makeMaterialHelpers({ c, boostMap: { [C.DIV_AGRI]: AGRI_BOOST, [C.DIV_CHEM]: CHEM_BOOST, [C.DIV_TOBACCO]: TOB_BOOST }, matSizeFallbacks: ROUND1_AGRI_MAT_SIZES, CITIES: C.CITIES, DIV_AGRI: C.DIV_AGRI, DIV_CHEM: C.DIV_CHEM });
    const agriSupplyProdHints = {};
    const DEBUG_ASSET_MATS = ['Water', 'Chemicals', 'Food', 'Plants', 'Real Estate', 'Hardware', 'Robots', 'AI Cores'];
    let latestRound2Offer = 0;
    let latestMeaningfulRound2Offer = 0;
    let latestRound2StagnantNeed = 0;
    let latestBn3PragmaticFloorChecks = 0;
    let lastRound2AssetProxy = null;
    let lastTobaccoProductError = '';
    let lastExportRouteError = '';
    let lastBn3SalesPivotState = '';
    let bn3HighBudgetPostfillUnlocked = false;
    let bn3HighBudgetSupportTurn = 0;
    let bn3HighBudgetMaterialProfileState = '';
    let bn3LeanTobSpikeUnlocked = false;
    let bn3LeanTobPreSpikeDummySettleCounter = 0;
    // Tracks whether the one-shot spike fill has fired for each private stage.
    const privateStageSpikeFired = {};
    let bn3DynamicLateCheckCounter = 0;
    let bn3DynamicLateSettleChecks = 0;
    let bn3DynamicLateRecoveryBasis = 0;
    let bn3DynamicLateRecoveryLabel = '';
    let latestTeaSpend = 0;
    let latestPartySpend = 0;
    const lastBn3GateNotes = {};
    const lastRound1GateNotes = {};
    const round1ExperimentalBoostTrimActive = {};
    const round1ExperimentalBoostTrimMode = {};
    const round1ExperimentalBoostTrimSellRates = {};
    const teaCooldownByOffice = {};
    const partyCooldownByOffice = {};
    //  Lock
    const { readLock, lockValid, acquireLock, readPhase, writePhase, readDoneFlag, corpIsPublic, hasRes } = makeCorpHelpers(ns, c, { lockFile: C.SETUP_LOCK, phaseFile: C.SETUP_PHASE_FILE, doneFlagFile: C.SETUP_DONE_FLAG });
    if (!acquireLock()) {
        log(ns, 'corp-setup is already running.', true, 'warning');
        return;
    }
    ns.atExit(() => { try {
        ns.rm(C.SETUP_LOCK, 'home');
    }
    catch { } });
    function isPilotRunning() {
        const pilot = resolvePath('corp-autopilot', 'corp-autopilot.js');
        try {
            return ns.ps('home').some(p => p.filename === pilot);
        }
        catch {
            return false;
        }
    }
    function isPhase6ScalingReady() {
        if (!hasDiv(C.DIV_AGRI) || !hasDiv(C.DIV_CHEM) || !hasDiv(C.DIV_TOBACCO))
            return false;
        if (!divisionInfraReady(C.DIV_CHEM) || !divisionInfraReady(C.DIV_TOBACCO))
            return false;
        if (!c.hasUnlock(C.UNLOCKS.export) || !c.hasUnlock(C.UNLOCKS.smartSupply))
            return false;
        for (const city of C.CITIES) {
            try {
                const agriOffice = c.getOffice(C.DIV_AGRI, city);
                const chemOffice = c.getOffice(C.DIV_CHEM, city);
                const tobOffice = c.getOffice(C.DIV_TOBACCO, city);
                const tobTarget = city === C.HQ_CITY ? 30 : 20;
                if ((agriOffice.size ?? 0) < 20 || (agriOffice.numEmployees ?? 0) < 20)
                    return false;
                if ((chemOffice.size ?? 0) < 9 || (chemOffice.numEmployees ?? 0) < 9)
                    return false;
                if ((tobOffice.size ?? 0) < tobTarget || (tobOffice.numEmployees ?? 0) < tobTarget)
                    return false;
            }
            catch {
                return false;
            }
            for (const div of [C.DIV_AGRI, C.DIV_CHEM, C.DIV_TOBACCO]) {
                try {
                    if ((c.getWarehouse(div, city).level ?? 0) < 6)
                        return false;
                }
                catch {
                    return false;
                }
            }
        }
        return true;
    }
    function isAgriRound1FoundationReady() {
        if (!hasDiv(C.DIV_AGRI) || !divisionInfraReady(C.DIV_AGRI))
            return false;
        try {
            if (Number(c.getDivision(C.DIV_AGRI).researchPoints ?? 0) < 55)
                return false;
        }
        catch {
            return false;
        }
        return C.CITIES.every((city) => {
            try {
                const office = c.getOffice(C.DIV_AGRI, city);
                return Number(office.size ?? 0) >= 4 && Number(office.numEmployees ?? 0) >= 4;
            }
            catch {
                return false;
            }
        });
    }
    function isAgriCurrentlyBoosted() {
        return C.CITIES.every((city) => {
            try {
                return AGRI_BOOST.mats.some((mat) => Number(c.getMaterial(C.DIV_AGRI, city, mat).stored ?? 0) > 0);
            }
            catch {
                return false;
            }
        });
    }
    function isBn3HighBudgetRound2ShellReady() {
        if (!c.hasUnlock(C.UNLOCKS.export) || !hasDiv(C.DIV_CHEM) || !hasDiv(C.DIV_TOBACCO))
            return false;
        try {
            for (const city of C.PHASE3_CHEM_START_CITIES) {
                const wh = c.getWarehouse(C.DIV_CHEM, city);
                const off = c.getOffice(C.DIV_CHEM, city);
                if ((wh.level ?? 0) < C.PHASE3_CHEM_INITIAL_WAREHOUSE)
                    return false;
                if ((off.size ?? 0) < C.PHASE3_CHEM_INITIAL_OFFICE || (off.numEmployees ?? 0) < C.PHASE3_CHEM_INITIAL_OFFICE)
                    return false;
            }
            for (const city of C.PHASE3_TOB_START_CITIES) {
                if (!c.hasWarehouse(C.DIV_TOBACCO, city))
                    return false;
                const off = c.getOffice(C.DIV_TOBACCO, city);
                if ((off.size ?? 0) < C.PHASE3_TOB_INITIAL_HQ_OFFICE || (off.numEmployees ?? 0) < C.PHASE3_TOB_INITIAL_HQ_OFFICE)
                    return false;
            }
        }
        catch {
            return false;
        }
        return tobaccoProducts().length > 0;
    }
    function isBn3LeanRound2ShellReady() {
        if (!useBn3Round2() || !useBn3LeanTobRound2())
            return false;
        if (!c.hasUnlock(C.UNLOCKS.export) || !hasDiv(C.DIV_TOBACCO))
            return false;
        if (!divisionInfraReady(C.DIV_TOBACCO, C.PHASE3_TOB_START_CITIES))
            return false;
        try {
            if ((c.getWarehouse(C.DIV_TOBACCO, C.HQ_CITY).level ?? 0) < 3)
                return false;
            const office = c.getOffice(C.DIV_TOBACCO, C.HQ_CITY);
            if ((office.size ?? 0) < C.PHASE3_TOB_INITIAL_HQ_OFFICE)
                return false;
            if ((office.numEmployees ?? 0) < C.PHASE3_TOB_INITIAL_HQ_OFFICE)
                return false;
        }
        catch {
            return false;
        }
        return tobaccoProducts().length > 0;
    }
    function inferPhase(saved = 0) {
        if (!c.hasCorporation())
            return 0;
        const corp = c.getCorporation();
        if (corpIsPublic(corp))
            return 10;
        const divs = new Set(corp.divisions);
        const requireTobaccoBeforeRound2 = !delayTobaccoUntilPostRound2();
        const requireChemicalBeforeRound2 = !delayChemicalUntilPostRound2();
        const needsPreRound2Bootstrap = requireChemicalBeforeRound2 || requireTobaccoBeforeRound2;
        const hasCoreUnlocks = c.hasUnlock(C.UNLOCKS.warehouseAPI) && c.hasUnlock(C.UNLOCKS.officeAPI);
        if (!hasCoreUnlocks)
            return 0;
        if (!divs.has(C.DIV_AGRI))
            return 1;
        const round = c.getInvestmentOffer().round;
        if (round <= 1)
            return (saved >= 2 || isAgriCurrentlyBoosted()) ? 2 : 1;
        if (!needsPreRound2Bootstrap && round <= 2)
            return 4;
        if (useBn3HighBudgetRound2() && !isBn3HighBudgetRound2ShellReady())
            return 3;
        if (useBn3LeanTobRound2() && !isBn3LeanRound2ShellReady())
            return 3;
        if ((requireChemicalBeforeRound2 && !divs.has(C.DIV_CHEM))
            || (requireTobaccoBeforeRound2 && !divs.has(C.DIV_TOBACCO))
            || (needsPreRound2Bootstrap && !c.hasUnlock(C.UNLOCKS.export)))
            return 3;
        if (round <= 2)
            return 4;
        if (!isPostRound2BootstrapReady())
            return 5;
        if (!isPhase6ScalingReady())
            return 6;
        if (round <= 3)
            return Math.max(saved, 7);
        if (round === 4)
            return Math.max(saved, 8);
        return Math.max(saved, 9);
    }
    function reconcilePhase() {
        const saved = readPhase();
        const inferred = inferPhase(saved);
        if (saved !== inferred) {
            log(ns, `INFO: Reconciled setup phase ${saved} -> ${inferred} from corporation state.`, true, 'info');
            writePhase(inferred);
        }
        return inferred;
    }
    if (!c.hasCorporation())
        writeSetupRoute(null);
    else
        restorePersistedBn3Round2State();
    let phase = reconcilePhase();
    clearLingeringMaterialBuys();
    let round1HighReinvestDebtSettleChecks = 0;
    if (phase >= 10) {
        ns.write(C.SETUP_DONE_FLAG, 'true', 'w');
        const pilot = resolvePath('corp-autopilot', 'corp-autopilot.js');
        if (!ns.ps('home').some(p => p.filename === pilot))
            ns.run(pilot, 1, ...(useIncomeMode() ? ['--income-mode'] : []));
        return;
    }
    if (!c.hasCorporation() && phase !== 0) {
        phase = 0;
        writePhase(0);
        writeSetupRoute(null);
        try {
            ns.rm(C.SETUP_DONE_FLAG, 'home');
        }
        catch { }
    }
    if (phase <= 4) {
        log(ns, `INFO: Reconciled to phase ${phase}; /corp/corp-round3.js handles phases 5-9 only, so control is returning to /corp/corp-setup.js.`, true, 'info');
        const pid = ns.run(resolvePath('corp-setup', 'corp-setup.js'), 1, ...ns.args);
        if (pid === 0) {
            log(ns, 'ERROR: Failed to launch /corp/corp-setup.js during corporation handoff.', true, 'warning');
            ns.tprint('ERROR: Failed to launch /corp/corp-setup.js during corporation handoff.');
        }
        return;
    }
    if (phase >= 3) {
        lockBn3HighBudgetRound2Profile();
    }
    async function waitCycles(n = 1) {
        printCorpDebugDump();
        await ns.sleep(C.CYCLE_MS * n);
    }
    function getCorpStateName() {
        try {
            return String(c.getCorporation().state ?? '');
        }
        catch {
            return '';
        }
    }
    async function waitForFreshPurchasePass(timeoutMs = C.CYCLE_MS + 5000) {
        const initialState = getCorpStateName();
        let lastState = initialState;
        let sawStateChange = false;
        let enteredFreshPurchase = false;
        const deadline = Date.now() + Math.max(2000, Number(timeoutMs ?? 0) || 0);
        while (Date.now() < deadline) {
            await ns.sleep(200);
            const state = getCorpStateName();
            if (state !== initialState)
                sawStateChange = true;
            if (sawStateChange && state === 'PURCHASE')
                enteredFreshPurchase = true;
            if (enteredFreshPurchase && lastState === 'PURCHASE' && state !== 'PURCHASE')
                return true;
            lastState = state;
        }
        return false;
    }
    async function waitUntilNotPurchase(timeoutMs = C.CYCLE_MS + 5000) {
        const deadline = Date.now() + Math.max(2000, Number(timeoutMs ?? 0) || 0);
        while (Date.now() < deadline) {
            if (getCorpStateName() !== 'PURCHASE')
                return true;
            await ns.sleep(100);
        }
        return getCorpStateName() !== 'PURCHASE';
    }
    function noteBn3Gate(key, message, level = 'info') {
        if (!message)
            return;
        if (lastBn3GateNotes[key] === message)
            return;
        lastBn3GateNotes[key] = message;
        log(ns, `INFO: ${message}`, true, level);
    }
    //  Job assignment (two-pass zero first, then set targets) 
    // setJobAssignment operates on employeeNextJobs (pending state).
    // Pass 1 zeros all freed to Unassigned pool. Pass 2 draws from that pool.
    function getDivisionJobFillOrder(div, city, jobCounts = {}) {
        if (div === C.DIV_CHEM)
            return ['eng', 'ops', 'mgmt', 'rnd', 'biz'];
        if (div === C.DIV_TOBACCO) {
            if (city === C.HQ_CITY && hasActiveTobaccoDevelopment())
                return ['eng', 'mgmt', 'ops', 'biz', 'rnd'];
            return ['biz', 'eng', 'mgmt', 'ops', 'rnd'];
        }
        if (div === C.DIV_AGRI) {
            if (Number(jobCounts.biz ?? 0) >= 3)
                return ['biz', 'eng', 'mgmt', 'ops', 'rnd'];
            if (Number(jobCounts.rnd ?? 0) >= 3 && sumJobCounts(jobCounts) <= 6)
                return ['rnd', 'eng', 'ops', 'mgmt', 'biz'];
            return ['eng', 'ops', 'mgmt', 'biz', 'rnd'];
        }
        return ['eng', 'ops', 'mgmt', 'biz', 'rnd'];
    }
    function normalizeJobCountsForOffice(div, city, jobCounts = {}, targetSize = null) {
        const normalized = {
            ops: Math.max(0, Math.floor(Number(jobCounts.ops ?? 0) || 0)),
            eng: Math.max(0, Math.floor(Number(jobCounts.eng ?? 0) || 0)),
            biz: Math.max(0, Math.floor(Number(jobCounts.biz ?? 0) || 0)),
            mgmt: Math.max(0, Math.floor(Number(jobCounts.mgmt ?? 0) || 0)),
            rnd: Math.max(0, Math.floor(Number(jobCounts.rnd ?? 0) || 0)),
        };
        let totalEmployees = 0;
        try {
            const office = c.getOffice(div, city);
            totalEmployees = Math.max(0, Math.floor(Number(targetSize ?? office.numEmployees ?? office.size ?? 0) || 0));
        }
        catch {
            totalEmployees = Math.max(0, Math.floor(Number(targetSize ?? 0) || 0));
        }
        if (totalEmployees <= 0)
            return normalized;
        const fillOrder = getDivisionJobFillOrder(div, city, normalized);
        const requestedOrder = Object.entries(normalized)
            .filter(([, count]) => count > 0)
            .sort((a, b) => {
            if (b[1] !== a[1])
                return b[1] - a[1];
            return fillOrder.indexOf(a[0]) - fillOrder.indexOf(b[0]);
        })
            .map(([job]) => job);
        const cycleOrder = requestedOrder.length > 0 ? requestedOrder : fillOrder;
        const capped = { ops: 0, eng: 0, biz: 0, mgmt: 0, rnd: 0 };
        let assigned = 0;
        for (const job of requestedOrder) {
            const wanted = normalized[job];
            const take = Math.min(wanted, Math.max(0, totalEmployees - assigned));
            capped[job] = take;
            assigned += take;
            if (assigned >= totalEmployees)
                return capped;
        }
        for (let i = 0; assigned < totalEmployees; i++, assigned++) {
            const job = cycleOrder[i % cycleOrder.length];
            capped[job] = Number(capped[job] ?? 0) + 1;
        }
        return capped;
    }
    function assignJobs(div, city, { ops = 0, eng = 0, biz = 0, mgmt = 0, rnd = 0 } = {}) {
        const jobCounts = normalizeJobCountsForOffice(div, city, { ops, eng, biz, mgmt, rnd });
        for (const job of [C.JOBS.ops, C.JOBS.eng, C.JOBS.biz, C.JOBS.mgmt, C.JOBS.rnd])
            try {
                c.setJobAssignment(div, city, job, 0);
            }
            catch { }
        if (jobCounts.ops > 0)
            try {
                c.setJobAssignment(div, city, C.JOBS.ops, jobCounts.ops);
            }
            catch { }
        if (jobCounts.eng > 0)
            try {
                c.setJobAssignment(div, city, C.JOBS.eng, jobCounts.eng);
            }
            catch { }
        if (jobCounts.biz > 0)
            try {
                c.setJobAssignment(div, city, C.JOBS.biz, jobCounts.biz);
            }
            catch { }
        if (jobCounts.mgmt > 0)
            try {
                c.setJobAssignment(div, city, C.JOBS.mgmt, jobCounts.mgmt);
            }
            catch { }
        if (jobCounts.rnd > 0)
            try {
                c.setJobAssignment(div, city, C.JOBS.rnd, jobCounts.rnd);
            }
            catch { }
    }
    function fillOffice(div, city, targetSize, jobCounts) {
        const off = c.getOffice(div, city);
        if (off.size < targetSize)
            c.upgradeOfficeSize(div, city, targetSize - off.size);
        const n = c.getOffice(div, city).numEmployees;
        for (let i = n; i < targetSize; i++)
            c.hireEmployee(div, city, C.JOBS.unassigned);
        assignJobs(div, city, normalizeJobCountsForOffice(div, city, jobCounts, targetSize));
    }
    //  Boost materials 
    // Uses 70% of warehouse capacity for boosts (30% reserved for production stock).
    // Warehouse size = level 100 SmartStorageMult DivResearchMult.
    function getBoostTargets(div, city, factors, sizes, mats, usagePct = 0.70) {
        try {
            const wh = c.getWarehouse(div, city);
            return optimalBoosts(wh.size * usagePct, [...factors], [...sizes], [...mats]);
        }
        catch {
            return {};
        }
    }
    function getDivisionCityBoostContribution(div, city, targets = null) {
        try {
            const config = getDivisionBoostConfig(div);
            if (!config || !c.hasWarehouse(div, city))
                return 1;
            let cityMult = 1;
            for (let i = 0; i < config.mats.length; i++) {
                const mat = config.mats[i];
                const factor = Math.max(0, Number(config.factors[i] ?? 0));
                if (factor <= 0)
                    continue;
                const qty = Math.max(0, Number(targets?.[mat] ?? c.getMaterial(div, city, mat).stored ?? 0));
                cityMult *= Math.pow(1 + 0.002 * qty, factor);
            }
            return Math.max(1, Math.pow(cityMult, 0.73));
        }
        catch {
            return 1;
        }
    }
    async function applyBoostMaterials(div, city, targets, reserve = 0) {
        let scale = 1;
        if (Number.isFinite(reserve) && reserve !== 0) {
            const spend = estimateMaterialTargetSpend(div, city, targets);
            const budget = Math.max(0, Number(c.getCorporation().funds ?? 0) - reserve);
            if (!Number.isFinite(spend) || spend <= 0 || budget <= 0)
                return;
            if (spend > budget)
                scale = budget / spend;
        }
        try {
            if (c.hasWarehouse(div, city)) {
                prevWHCapacity[`${div}|${city}`] = Number(c.getWarehouse(div, city).size ?? 0);
            }
        }
        catch { }
        let anyNeeded = false;
        await waitUntilNotPurchase();
        for (const [mat, target] of Object.entries(targets)) {
            const stored = c.getMaterial(div, city, mat).stored;
            const needed = Math.max(0, target - stored) * scale;
            if (needed > 0) {
                c.buyMaterial(div, city, mat, needed / C.CYCLE_SECS);
                anyNeeded = true;
            }
        }
        if (anyNeeded) {
            await waitForFreshPurchasePass();
            for (const mat of Object.keys(targets))
                c.buyMaterial(div, city, mat, 0);
        }
    }
    async function applyBoostMaterialsBatch(div, cityTargets, reserve = 0) {
        const targetsByCity = Object.fromEntries(Object.entries(cityTargets ?? {}).filter(([, targets]) => targets && Object.keys(targets).length > 0));
        const cities = Object.keys(targetsByCity);
        if (!cities.length)
            return 0;
        let scale = 1;
        if (Number.isFinite(reserve) && reserve !== 0) {
            const spend = cities.reduce((total, city) => total + estimateMaterialTargetSpend(div, city, targetsByCity[city]), 0);
            const budget = Math.max(0, Number(c.getCorporation().funds ?? 0) - reserve);
            if (!Number.isFinite(spend) || spend <= 0 || budget <= 0)
                return 0;
            if (spend > budget)
                scale = budget / spend;
        }
        let anyNeeded = false;
        const activeBuys = [];
        await waitUntilNotPurchase();
        for (const city of cities) {
            try {
                if (c.hasWarehouse(div, city)) {
                    prevWHCapacity[`${div}|${city}`] = Number(c.getWarehouse(div, city).size ?? 0);
                }
            }
            catch { }
            for (const [mat, target] of Object.entries(targetsByCity[city])) {
                const stored = c.getMaterial(div, city, mat).stored;
                const needed = Math.max(0, target - stored) * scale;
                if (needed <= 0)
                    continue;
                c.buyMaterial(div, city, mat, needed / C.CYCLE_SECS);
                activeBuys.push([city, mat]);
                anyNeeded = true;
            }
        }
        if (anyNeeded) {
            await waitForFreshPurchasePass();
            for (const [city, mat] of activeBuys)
                c.buyMaterial(div, city, mat, 0);
        }
        return scale;
    }
    async function applyBoostMaterialsBatchChunked(div, cityTargets, reserve = 0, chunkFraction = 1, maxPasses = 1) {
        const finalTargetsByCity = Object.fromEntries(Object.entries(cityTargets ?? {}).filter(([, targets]) => targets && Object.keys(targets).length > 0));
        const cities = Object.keys(finalTargetsByCity);
        if (!cities.length)
            return { passes: 0 };
        const clampedChunkFraction = clamp(chunkFraction, 0.05, 1);
        const cappedPasses = Math.max(1, Math.floor(Number(maxPasses ?? 1) || 1));
        let passes = 0;
        for (let pass = 0; pass < cappedPasses; pass++) {
            const chunkTargetsByCity = {};
            let hasRemainingNeed = false;
            for (const city of cities) {
                const chunkTargets = {};
                for (const [mat, finalTarget] of Object.entries(finalTargetsByCity[city])) {
                    const stored = Math.max(0, Number(c.getMaterial(div, city, mat).stored ?? 0));
                    const deficit = Math.max(0, Number(finalTarget ?? 0) - stored);
                    if (deficit <= 0.5)
                        continue;
                    chunkTargets[mat] = stored + deficit * clampedChunkFraction;
                    hasRemainingNeed = true;
                }
                if (Object.keys(chunkTargets).length > 0) {
                    chunkTargetsByCity[city] = chunkTargets;
                }
            }
            if (!hasRemainingNeed)
                break;
            await applyBoostMaterialsBatch(div, chunkTargetsByCity, reserve);
            passes++;
        }
        return { passes };
    }
    // Re-apply boosts whenever warehouse capacity changes from level, Smart Storage, or research.
    const prevWHCapacity = {};
    async function refreshBoosts(div, factors, sizes, mats) {
        for (const city of C.CITIES) {
            try {
                const key = `${div}|${city}`;
                const cap = c.getWarehouse(div, city).size;
                if (cap !== prevWHCapacity[key]) {
                    prevWHCapacity[key] = cap;
                    await applyBoostMaterials(div, city, getBoostTargets(div, city, factors, sizes, mats));
                }
            }
            catch { }
        }
    }
    // Force-refresh boost mats for one division across all cities, bypassing the
    // capacity-change gate. Used for the one-shot private-stage spike fill.
    async function forceRefreshBoosts(div, factors, sizes, mats, reserve = 0) {
        for (const city of C.CITIES) {
            try {
                if (!c.hasWarehouse(div, city))
                    continue;
                await applyBoostMaterials(div, city, getBoostTargets(div, city, factors, sizes, mats), reserve);
            }
            catch { }
        }
    }
    // One-shot spike fill: top up all boost mats the moment a private stage is
    // ready. Uses a revenue-based debt allowance so fills happen even if cash is
    // temporarily tight. Fires once per stage (tracked by privateStageSpikeFired).
    async function tryPrivateStageSpikeRefresh(stageName) {
        if (privateStageSpikeFired[stageName])
            return false;
        privateStageSpikeFired[stageName] = true;
        let revenue = 0;
        try {
            revenue = Math.max(0, Number(c.getCorporation().revenue ?? 0));
        }
        catch { }
        const debtAllowance = Math.min(R3.PRIVATE_STAGE_SPIKE_DEBT_MAX, revenue * R3.PRIVATE_STAGE_SPIKE_RECOVERY_SECS);
        const reserve = debtAllowance > 0 ? -debtAllowance : 0;
        log(ns, `INFO: Private stage spike fill (${stageName}) debt allowance ${formatMoney(debtAllowance)}`, true, 'info');
        await forceRefreshBoosts(C.DIV_AGRI, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats, reserve);
        await forceRefreshBoosts(C.DIV_CHEM, CHEM_BOOST.factors, CHEM_BOOST.sizes, CHEM_BOOST.mats, reserve);
        await forceRefreshBoosts(C.DIV_TOBACCO, TOB_BOOST.factors, TOB_BOOST.sizes, TOB_BOOST.mats, reserve);
        return true;
    }
    //  Division helpers 
    function hasDiv(div) {
        try {
            return c.getCorporation().divisions.includes(div);
        }
        catch {
            return false;
        }
    }
    function stopManagedMaterialBuys(div, materials, cities = C.CITIES) {
        for (const city of cities) {
            for (const mat of materials) {
                try {
                    c.buyMaterial(div, city, mat, 0);
                }
                catch { }
            }
        }
    }
    function clearLingeringMaterialBuys() {
        stopManagedMaterialBuys(C.DIV_AGRI, [...new Set([...Object.keys(ROUND1_AGRI_REQUIRED), ...C.AGRI_MATS, ...Object.keys(C.ROUND2_BN3_MATERIAL_TARGETS)])]);
        stopManagedMaterialBuys(C.DIV_CHEM, [...new Set(['Water', ...C.CHEM_MATS])]);
        stopManagedMaterialBuys(C.DIV_TOBACCO, [...new Set(['Plants', ...C.TOB_MATS])]);
    }
    function expandIndustryCost(industry) {
        try {
            return c.getIndustryData(industry).startingCost;
        }
        catch {
            return Infinity;
        }
    }
    function expandToCities(div, targetCities = C.CITIES) {
        const existing = c.getDivision(div).cities;
        for (const city of targetCities) {
            if (!existing.includes(city))
                try {
                    c.expandCity(div, city);
                }
                catch { }
        }
        for (const city of targetCities)
            if (!c.hasWarehouse(div, city))
                try {
                    c.purchaseWarehouse(div, city);
                }
                catch { }
    }
    function buyUnlock(name) {
        try {
            if (!c.hasUnlock(name)) {
                c.purchaseUnlock(name);
                log(ns, `  Purchased: ${name}`, false, 'info');
            }
        }
        catch (e) {
            log(ns, `  WARN: Could not buy "${name}": ${e?.message}`, false, 'warning');
        }
    }
    function enableSmartSupply(div, cities = C.CITIES) {
        if (!c.hasUnlock(C.UNLOCKS.smartSupply))
            return;
        for (const city of cities)
            try {
                if (c.hasWarehouse(div, city))
                    c.setSmartSupply(div, city, true);
            }
            catch { }
    }
    function disableSmartSupply(div, cities = C.CITIES) {
        if (!c.hasUnlock(C.UNLOCKS.smartSupply))
            return;
        for (const city of cities)
            try {
                if (c.hasWarehouse(div, city))
                    c.setSmartSupply(div, city, false);
            }
            catch { }
    }
    function setLeftovers(div, city, materials) {
        if (!c.hasUnlock(C.UNLOCKS.smartSupply))
            return;
        for (const material of materials) {
            try {
                c.setSmartSupplyOption(div, city, material, 'leftovers');
            }
            catch { }
        }
    }
    function divisionInfraReady(div, targetCities = C.CITIES) {
        try {
            const cities = c.getDivision(div).cities;
            return targetCities.every(city => cities.includes(city) && c.hasWarehouse(div, city));
        }
        catch {
            return false;
        }
    }
    async function waitForDivisionInfrastructure(div, label, targetCities = C.CITIES) {
        while (!divisionInfraReady(div, targetCities)) {
            expandToCities(div, targetCities);
            if (!divisionInfraReady(div, targetCities)) {
                log(ns, `  Waiting for ${label} city/warehouse expansion...`, false);
                await waitCycles(2);
            }
        }
    }
    async function waitForWarehouseLevel(div, city, targetLevel) {
        while (true) {
            try {
                const wh = c.getWarehouse(div, city);
                if (wh.level >= targetLevel)
                    return;
                c.upgradeWarehouse(div, city, 1);
            }
            catch { }
            await waitCycles(1);
        }
    }
    function bulkUpgradeWarehousesToLevel(div, targetLevel, reserve = 0, targetCities = C.CITIES) {
        let complete = true;
        for (const city of targetCities) {
            try {
                while (true) {
                    const wh = c.getWarehouse(div, city);
                    if (wh.level >= targetLevel)
                        break;
                    const cost = c.getUpgradeWarehouseCost(div, city, 1);
                    const funds = Number(c.getCorporation().funds ?? 0);
                    if (!Number.isFinite(cost) || funds - cost < reserve) {
                        complete = false;
                        break;
                    }
                    c.upgradeWarehouse(div, city, 1);
                }
                if (c.getWarehouse(div, city).level < targetLevel)
                    complete = false;
            }
            catch {
                complete = false;
            }
        }
        return complete;
    }
    async function waitFillOffice(div, city, targetSize, jobCounts) {
        while (true) {
            try {
                fillOffice(div, city, targetSize, jobCounts);
                return;
            }
            catch { }
            await waitCycles(1);
        }
    }
    function getBn3HighBudgetPhase3Reserve() {
        const liveFunds = Math.max(0, Number(c.getCorporation().funds ?? 0));
        const baseline = Math.max(0, Number(bn3HighBudgetRound2StartFunds ?? 0)) || liveFunds;
        return Math.max(C.ROUND2_BN3_HIGH_BUDGET_RESERVE, baseline * C.ROUND2_BN3_HIGH_BUDGET_RESERVE_PCT);
    }
    function maintainAgriSalesAndJobs(jobCounts = { ops: 1, eng: 1, biz: 1, mgmt: 1 }) {
        for (const city of C.CITIES) {
            try {
                c.sellMaterial(C.DIV_AGRI, city, 'Food', 'MAX', 'MP');
            }
            catch { }
            try {
                c.sellMaterial(C.DIV_AGRI, city, 'Plants', 'MAX', 'MP');
            }
            catch { }
            try {
                assignJobs(C.DIV_AGRI, city, jobCounts);
            }
            catch { }
        }
    }
    function stopRound1AgriSupply(cities = C.CITIES) {
        if (!C.ROUND1_USE_CUSTOM_SUPPLY)
            return;
        for (const city of cities) {
            for (const mat of Object.keys(ROUND1_AGRI_REQUIRED)) {
                try {
                    c.buyMaterial(C.DIV_AGRI, city, mat, 0);
                }
                catch { }
            }
        }
    }
    function stopChemicalWaterSupply(cities = C.CITIES) {
        for (const city of cities) {
            try {
                c.buyMaterial(C.DIV_CHEM, city, 'Water', 0);
            }
            catch { }
        }
    }
    function unlockCost(name, fallback = Infinity) {
        try {
            return c.getUnlockCost(name);
        }
        catch {
            return fallback;
        }
    }
    function canConfigureMaterialExport(sourceDiv, sourceCity, targetDiv, targetCity, material) {
        try {
            if (!hasDiv(sourceDiv) || !hasDiv(targetDiv))
                return false;
            if (!c.getDivision(sourceDiv).cities.includes(sourceCity))
                return false;
            if (!c.getDivision(targetDiv).cities.includes(targetCity))
                return false;
            if (!c.hasWarehouse(sourceDiv, sourceCity))
                return false;
            if (!c.hasWarehouse(targetDiv, targetCity))
                return false;
            c.getMaterial(sourceDiv, sourceCity, material);
            c.getMaterial(targetDiv, targetCity, material);
            return true;
        }
        catch {
            return false;
        }
    }
    function getWarehouseMaterialCapacity(div, city, material) {
        try {
            if (!c.hasWarehouse(div, city))
                return 0;
            const wh = c.getWarehouse(div, city);
            return Math.max(0, Number(wh.size ?? 0)) / getMaterialSize(material);
        }
        catch {
            return 0;
        }
    }
    function getExportRateStep(rate) {
        if (rate >= 1000)
            return 25;
        if (rate >= 250)
            return 5;
        if (rate >= 50)
            return 1;
        if (rate >= 10)
            return 0.5;
        return 0.1;
    }
    function formatExportRate(rate) {
        const safeRate = Math.max(0, Number(rate ?? 0));
        if (!Number.isFinite(safeRate) || safeRate <= 0.01)
            return '0';
        const step = getExportRateStep(safeRate);
        const quantized = Math.max(0, Math.round(safeRate / step) * step);
        return step >= 1 ? quantized.toFixed(0) : quantized.toFixed(1);
    }
    function parseExportRate(rate) {
        const parsed = Number.parseFloat(String(rate ?? '0'));
        return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }
    function scaleByMaturity(base, mature, maturity) {
        return base + (mature - base) * clamp(Number(maturity ?? 0), 0, 1);
    }
    function getDivisionCityCoverageRatio(div) {
        try {
            return clamp((Number(c.getDivision(div).cities?.length ?? 0) - 1) / Math.max(C.CITIES.length - 1, 1), 0, 1);
        }
        catch {
            return 0;
        }
    }
    function getOfficeGrowthRatio(div, city, baseSize = 3, matureSize = 18) {
        try {
            const size = Number(c.getOffice(div, city).size ?? 0);
            return clamp((size - baseSize) / Math.max(matureSize - baseSize, 1), 0, 1);
        }
        catch {
            return 0;
        }
    }
    function getWarehouseGrowthRatio(div, city, baseLevel = 1, matureLevel = 10) {
        try {
            const level = Number(c.getWarehouse(div, city).level ?? 0);
            return clamp((level - baseLevel) / Math.max(matureLevel - baseLevel, 1), 0, 1);
        }
        catch {
            return 0;
        }
    }
    function getTobaccoDemandMaturity(city) {
        if (!hasDiv(C.DIV_TOBACCO))
            return 0;
        try {
            const { finishedProducts, highestProgress } = getTobaccoProductStats();
            const progressRatio = clamp(Number(highestProgress ?? 0) / 100, 0, 1);
            const finishedRatio = clamp(Number(finishedProducts ?? 0) / 3, 0, 1);
            const cityRatio = getDivisionCityCoverageRatio(C.DIV_TOBACCO);
            const officeRatio = getOfficeGrowthRatio(C.DIV_TOBACCO, city, 3, C.ROUND2_BN3_LEAN_TOB_SPEED_HQ_OFFICE);
            const warehouseRatio = getWarehouseGrowthRatio(C.DIV_TOBACCO, city, 1, 12);
            return clamp(progressRatio * 0.30 +
                finishedRatio * 0.30 +
                cityRatio * 0.15 +
                officeRatio * 0.15 +
                warehouseRatio * 0.10, 0, 1);
        }
        catch {
            return 0;
        }
    }
    function getChemicalDemandMaturity(city) {
        if (!hasDiv(C.DIV_CHEM))
            return 0;
        try {
            const chemProd = Math.max(0, Number(c.getMaterial(C.DIV_CHEM, city, 'Chemicals').productionAmount ?? 0));
            const prodRatio = clamp(chemProd / 80, 0, 1); // ceiling lowered from 250 to 80: a size-6 Chem office peaks around 60-90 u/s, 250 kept maturity permanently depressed
            const cityRatio = getDivisionCityCoverageRatio(C.DIV_CHEM);
            const officeRatio = getOfficeGrowthRatio(C.DIV_CHEM, city, C.PHASE3_CHEM_INITIAL_OFFICE, C.ROUND2_CHEM_OFFICE_AGGR);
            const warehouseRatio = getWarehouseGrowthRatio(C.DIV_CHEM, city, C.PHASE3_CHEM_INITIAL_WAREHOUSE, Math.max(city === C.HQ_CITY ? C.ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_WAREHOUSE_BUILDOUT : C.ROUND2_BN3_HIGH_BUDGET_CHEM_WAREHOUSE_BUILDOUT, C.PHASE3_CHEM_INITIAL_WAREHOUSE + 1));
            return clamp(prodRatio * 0.35 +
                cityRatio * 0.20 +
                officeRatio * 0.20 +
                warehouseRatio * 0.25, 0, 1);
        }
        catch {
            return 0;
        }
    }
    function getChemicalPlantDemandFloor(city) {
        if (!hasDiv(C.DIV_CHEM))
            return 0;
        try {
            const office = c.getOffice(C.DIV_CHEM, city);
            const jobs = office.employeeJobs ?? {};
            const throughputStaff = Number(jobs[C.JOBS.ops] ?? 0) +
                Number(jobs[C.JOBS.eng] ?? 0) +
                Number(jobs[C.JOBS.mgmt] ?? 0);
            const officeSize = Math.max(0, Number(office.size ?? 0));
            const chemProd = Math.max(0, Number(c.getMaterial(C.DIV_CHEM, city, 'Chemicals').productionAmount ?? 0));
            const plantStored = Math.max(0, Number(c.getMaterial(C.DIV_CHEM, city, 'Plants').stored ?? 0));
            const chemStored = Math.max(0, Number(c.getMaterial(C.DIV_CHEM, city, 'Chemicals').stored ?? 0));
            const wh = c.getWarehouse(C.DIV_CHEM, city);
            const freePct = Number(wh.size ?? 0) > 0
                ? Math.max(0, Number(wh.size ?? 0) - Number(wh.sizeUsed ?? 0)) / Number(wh.size ?? 1)
                : 0;
            const buildoutPhase = useBn3HighBudgetRound2() &&
                (!isBn3HighBudgetPostfillUnlocked() || getTobaccoProductStats().finishedProducts === 0);
            let floor = Math.max(C.EXPORT_DYNAMIC_CHEM_PLANT_MIN_DEMAND, throughputStaff * C.EXPORT_DYNAMIC_CHEM_PLANT_MIN_DEMAND_PER_THROUGHPUT_EMPLOYEE, officeSize * C.EXPORT_DYNAMIC_CHEM_PLANT_MIN_DEMAND_PER_OFFICE_EMPLOYEE, chemProd * 0.9);
            if (buildoutPhase)
                floor *= C.EXPORT_DYNAMIC_CHEM_PLANT_BUILDOUT_DEMAND_MULT;
            if (freePct < 0.10 && plantStored > C.EXPORT_DYNAMIC_CHEM_PLANT_SEED)
                floor *= 0.6;
            if (freePct < 0.18 && chemStored > Math.max(250, chemProd * C.CYCLE_SECS * 2.5))
                floor *= 0.55;
            return Math.max(0, floor);
        }
        catch {
            return 0;
        }
    }
    // Tobacco reqMats: Plants:1 1 Plant consumed per unit of product produced.
    // Like getChemicalPlantDemandFloor, this breaks the consumption=0 export=seed production=0
    // circular lock that occurs when support cities first switch to production jobs post-v1.
    function getTobaccoPlantDemandFloor(city) {
        if (!hasDiv(C.DIV_TOBACCO))
            return 0;
        try {
            const { finishedProducts } = getTobaccoProductStats();
            if (finishedProducts === 0)
                return 0; // pre-v1: support cities don't produce, no floor needed
            const hasWH = city === C.HQ_CITY
                ? true
                : (c.getDivision(C.DIV_TOBACCO).cities.includes(city) && c.hasWarehouse(C.DIV_TOBACCO, city));
            if (!hasWH)
                return 0;
            const office = c.getOffice(C.DIV_TOBACCO, city);
            const jobs = office.employeeJobs ?? {};
            const throughputStaff = Number(jobs[C.JOBS.ops] ?? 0) +
                Number(jobs[C.JOBS.eng] ?? 0) +
                Number(jobs[C.JOBS.mgmt] ?? 0);
            // Use observed product production if available (1:1 Plants per product unit).
            let observed = 0;
            for (const pName of tobaccoProducts()) {
                try {
                    const info = c.getProduct(C.DIV_TOBACCO, city, pName);
                    if (Number(info.developmentProgress ?? 0) < 100)
                        continue;
                    observed += Math.max(0, Number(info.productionAmount ?? 0));
                }
                catch { }
            }
            return Math.max(observed * 0.9, // 90% of observed production (Plants:1 ratio)
            throughputStaff * 0.8, // staffing-based fallback when production hasn't started
            Number(office.size ?? 0) * 0.25);
        }
        catch {
            return 0;
        }
    }
    // Agriculture reqMats: Water:0.5, Chemicals:0.2 Plants + Food.
    // Chemicals is a required input if Agri has none it produces zero Plants, which means
    // consumption reads 0, the export formula falls to just the seed refill, which then reaches
    // the seed cap and drops to '0'. This floor breaks that circular stall.
    function getAgriChemDemandFloor(city) {
        if (!hasDiv(C.DIV_AGRI))
            return 0;
        try {
            const office = c.getOffice(C.DIV_AGRI, city);
            const jobs = office.employeeJobs ?? {};
            const throughputStaff = Number(jobs[C.JOBS.ops] ?? 0) +
                Number(jobs[C.JOBS.eng] ?? 0) +
                Number(jobs[C.JOBS.mgmt] ?? 0);
            // Agri Chemicals ratio: 0.2 per Plants/Food unit produced.
            // Use observed Plants/Food production scaled by 0.2 as the primary signal.
            const plantsRate = Math.max(0, Number(c.getMaterial(C.DIV_AGRI, city, 'Plants').productionAmount ?? 0));
            const foodRate = Math.max(0, Number(c.getMaterial(C.DIV_AGRI, city, 'Food').productionAmount ?? 0));
            const observedChemRate = (plantsRate + foodRate) * 0.2;
            // Staffing fallback: rough throughput estimate when observed production is near 0.
            const staffFloor = throughputStaff * 0.2;
            const officeFloor = Number(office.size ?? 0) * 0.05;
            return Math.max(observedChemRate, staffFloor, officeFloor, 0.5);
        }
        catch {
            return 0;
        }
    }
    function getAgricultureDemandMaturity(city) {
        if (!hasDiv(C.DIV_AGRI))
            return 0;
        try {
            const plants = Math.max(0, Number(c.getMaterial(C.DIV_AGRI, city, 'Plants').productionAmount ?? 0));
            const food = Math.max(0, Number(c.getMaterial(C.DIV_AGRI, city, 'Food').productionAmount ?? 0));
            const prodRatio = clamp(Math.max(plants, food) / 4000, 0, 1);
            const officeRatio = getOfficeGrowthRatio(C.DIV_AGRI, city, C.PHASE3_AGRI_TARGET_OFFICE, C.ROUND2_CLASSIC_AGRI_OFFICE);
            const warehouseRatio = getWarehouseGrowthRatio(C.DIV_AGRI, city, R3.ROUND1_WAREHOUSE_TARGET, C.ROUND2_AGRI_WAREHOUSE_LATE);
            return clamp(prodRatio * 0.40 +
                officeRatio * 0.25 +
                warehouseRatio * 0.25 +
                getDivisionCityCoverageRatio(C.DIV_AGRI) * 0.10, 0, 1);
        }
        catch {
            return 0;
        }
    }
    function getDynamicMaterialExportAmount({ targetDiv, city, material, seed = 0, minDemandRate = 0, maturity = 0, baseBufferCycles = 2, matureBufferCycles = 4, baseWarehousePct = 0.10, matureWarehousePct = 0.18, refillCycles = C.EXPORT_DYNAMIC_REFILL_CYCLES, headroomMult = C.EXPORT_DYNAMIC_HEADROOM_MULT, }) {
        try {
            const targetMat = c.getMaterial(targetDiv, city, material);
            const stored = Math.max(0, Number(targetMat.stored ?? 0));
            const consumption = Math.max(0, -Number(targetMat.productionAmount ?? 0));
            const effectiveDemand = Math.max(consumption, Math.max(0, Number(minDemandRate ?? 0)));
            const bufferCycles = scaleByMaturity(baseBufferCycles, matureBufferCycles, maturity);
            const warehousePct = scaleByMaturity(baseWarehousePct, matureWarehousePct, maturity);
            const warehouseCap = getWarehouseMaterialCapacity(targetDiv, city, material) * warehousePct;
            const bufferedDemand = effectiveDemand * headroomMult;
            const uncappedTarget = Math.max(seed, bufferedDemand * C.CYCLE_SECS * bufferCycles);
            const targetStock = warehouseCap > 0
                ? Math.min(uncappedTarget, warehouseCap)
                : uncappedTarget;
            const deficit = Math.max(0, targetStock - stored);
            const refillRate = deficit / Math.max(C.CYCLE_SECS * refillCycles, 1);
            return formatExportRate(bufferedDemand + refillRate);
        }
        catch {
            return '0';
        }
    }
    function refreshMaterialExport(sourceDiv, sourceCity, targetDiv, targetCity, material, amount) {
        if (!canConfigureMaterialExport(sourceDiv, sourceCity, targetDiv, targetCity, material))
            return false;
        const routeLabel = `${sourceDiv}/${sourceCity} ${material} -> ${targetDiv}/${targetCity}`;
        try {
            const sourceMat = c.getMaterial(sourceDiv, sourceCity, material);
            const existing = Array.isArray(sourceMat.exports)
                ? sourceMat.exports.find((exp) => exp.division === targetDiv && exp.city === targetCity)
                : null;
            if (existing?.amount === amount)
                return true;
            // Only rewrite the route when the formula changed; constantly
            // cancel/re-adding the same export makes debugging harder and gains nothing.
            if (existing) {
                try {
                    c.cancelExportMaterial(sourceDiv, sourceCity, targetDiv, targetCity, material);
                }
                catch { }
            }
            c.exportMaterial(sourceDiv, sourceCity, targetDiv, targetCity, material, amount);
            lastExportRouteError = '';
            return true;
        }
        catch (e) {
            const msg = `${routeLabel}: ${e?.message ?? String(e)}`;
            if (msg !== lastExportRouteError) {
                lastExportRouteError = msg;
                log(ns, `WARN: Could not configure export route ${msg}`, true, 'warning');
            }
            return false;
        }
    }
    function configureExports() {
        if (!c.hasUnlock(C.UNLOCKS.export))
            return;
        const { finishedProducts: finishedTobaccoProducts } = getTobaccoProductStats();
        for (const city of C.CITIES) {
            const chemPlantsDesired = getDynamicMaterialExportAmount({
                targetDiv: C.DIV_CHEM,
                city,
                material: 'Plants',
                seed: C.EXPORT_DYNAMIC_CHEM_PLANT_SEED,
                minDemandRate: getChemicalPlantDemandFloor(city),
                maturity: getChemicalDemandMaturity(city),
                baseBufferCycles: C.EXPORT_DYNAMIC_CHEM_PLANT_BUFFER_CYCLES,
                matureBufferCycles: C.EXPORT_DYNAMIC_CHEM_PLANT_BUFFER_CYCLES_MATURE,
                baseWarehousePct: C.EXPORT_DYNAMIC_CHEM_PLANT_WAREHOUSE_PCT,
                matureWarehousePct: C.EXPORT_DYNAMIC_CHEM_PLANT_WAREHOUSE_PCT_MATURE,
            });
            const tobPlantsDesired = finishedTobaccoProducts > 0
                ? getDynamicMaterialExportAmount({
                    targetDiv: C.DIV_TOBACCO,
                    city,
                    material: 'Plants',
                    seed: C.ROUND2_TOB_PLANT_EXPORT_SEED,
                    minDemandRate: getTobaccoPlantDemandFloor(city),
                    maturity: getTobaccoDemandMaturity(city),
                    baseBufferCycles: C.EXPORT_DYNAMIC_TOB_PLANT_BUFFER_CYCLES,
                    matureBufferCycles: C.EXPORT_DYNAMIC_TOB_PLANT_BUFFER_CYCLES_MATURE,
                    baseWarehousePct: C.EXPORT_DYNAMIC_TOB_PLANT_WAREHOUSE_PCT,
                    matureWarehousePct: C.EXPORT_DYNAMIC_TOB_PLANT_WAREHOUSE_PCT_MATURE,
                })
                : '0';
            const agriPlantBudget = (() => {
                try {
                    return Math.max(0, Number(c.getMaterial(C.DIV_AGRI, city, 'Plants').productionAmount ?? 0)) * 0.98;
                }
                catch {
                    return 0;
                }
            })();
            // Allocate proportionally so neither div starves when the budget is tight.
            // If both fit in the budget, each gets exactly what it asked for.
            const chemDesired = parseExportRate(chemPlantsDesired);
            const tobDesired = parseExportRate(tobPlantsDesired);
            const totalDesired = chemDesired + tobDesired;
            let chemPlantsRate, tobPlantsRate;
            if (totalDesired <= agriPlantBudget || totalDesired <= 0) {
                chemPlantsRate = chemDesired;
                tobPlantsRate = tobDesired;
            }
            else {
                chemPlantsRate = agriPlantBudget * (chemDesired / totalDesired);
                tobPlantsRate = agriPlantBudget * (tobDesired / totalDesired);
            }
            const chemPlantsExp = formatExportRate(chemPlantsRate);
            const tobPlantsExp = formatExportRate(tobPlantsRate);
            const agriChemExp = getDynamicMaterialExportAmount({
                targetDiv: C.DIV_AGRI,
                city,
                material: 'Chemicals',
                seed: C.EXPORT_DYNAMIC_AGRI_CHEM_SEED,
                minDemandRate: getAgriChemDemandFloor(city),
                maturity: getAgricultureDemandMaturity(city),
                baseBufferCycles: C.EXPORT_DYNAMIC_AGRI_CHEM_BUFFER_CYCLES,
                matureBufferCycles: C.EXPORT_DYNAMIC_AGRI_CHEM_BUFFER_CYCLES_MATURE,
                baseWarehousePct: C.EXPORT_DYNAMIC_AGRI_CHEM_WAREHOUSE_PCT,
                matureWarehousePct: C.EXPORT_DYNAMIC_AGRI_CHEM_WAREHOUSE_PCT_MATURE,
            });
            refreshMaterialExport(C.DIV_AGRI, city, C.DIV_CHEM, city, 'Plants', chemPlantsExp);
            refreshMaterialExport(C.DIV_AGRI, city, C.DIV_TOBACCO, city, 'Plants', tobPlantsExp);
            refreshMaterialExport(C.DIV_CHEM, city, C.DIV_AGRI, city, 'Chemicals', agriChemExp);
        }
        for (const city of C.CITIES) {
            setLeftovers(C.DIV_AGRI, city, ['Chemicals', 'Water']);
            setLeftovers(C.DIV_CHEM, city, ['Plants', 'Water']);
            setLeftovers(C.DIV_TOBACCO, city, ['Plants']);
        }
        // Stop selling Chem Chemicals to market they must flow to Agri via export.
        // tryRound2ChemStep calls sellMaterial('MAX','MP') for HQ every cycle, which
        // takes priority over the export route and causes imp=0 at Agri HQ while
        // Agri buys from market instead.  Zero-out the sell order here so the export
        // configured above actually delivers.
        if (hasDiv(C.DIV_CHEM)) {
            for (const city of C.CITIES) {
                try {
                    if (c.hasWarehouse(C.DIV_CHEM, city)) {
                        c.sellMaterial(C.DIV_CHEM, city, 'Chemicals', 0, 'MP');
                    }
                }
                catch { }
            }
        }
    }
    function tryUpgradeWarehouseTo(div, city, targetLevel) {
        try {
            while (c.getWarehouse(div, city).level < targetLevel) {
                const cost = c.getUpgradeWarehouseCost(div, city, 1);
                if (c.getCorporation().funds < cost)
                    break;
                c.upgradeWarehouse(div, city, 1);
            }
        }
        catch { }
    }
    function tryFillOffice(div, city, targetSize, jobs) {
        try {
            fillOffice(div, city, targetSize, jobs);
        }
        catch { }
    }
    function tobaccoProducts() {
        try {
            return [...c.getDivision(C.DIV_TOBACCO).products];
        }
        catch {
            return [];
        }
    }
    function hasActiveTobaccoDevelopment() {
        for (const name of tobaccoProducts()) {
            try {
                if (c.getProduct(C.DIV_TOBACCO, C.HQ_CITY, name).developmentProgress < 100)
                    return true;
            }
            catch { }
        }
        return false;
    }
    function nextTobaccoProductName() {
        let max = 0;
        for (const name of tobaccoProducts()) {
            const m = /^Tobac-v(\d+)$/.exec(name);
            if (!m)
                continue;
            const n = Number(m[1]);
            if (Number.isFinite(n))
                max = Math.max(max, n);
        }
        return `Tobac-v${max + 1}`;
    }
    function tobaccoProductVersion(name) {
        const m = /^Tobac-v(\d+)$/.exec(name);
        const n = m ? Number(m[1]) : NaN;
        return Number.isFinite(n) ? n : 0;
    }
    function getHighestTobaccoProductVersion() {
        let maxVersion = 0;
        for (const name of tobaccoProducts()) {
            maxVersion = Math.max(maxVersion, tobaccoProductVersion(name));
        }
        return maxVersion;
    }
    function getTobaccoProductCapacity() {
        if (!hasDiv(C.DIV_TOBACCO))
            return 0;
        let capacity = 3;
        try {
            if (c.hasResearched(C.DIV_TOBACCO, 'uPgrade: Capacity.I'))
                capacity++;
        }
        catch { }
        try {
            if (c.hasResearched(C.DIV_TOBACCO, 'uPgrade: Capacity.II'))
                capacity++;
        }
        catch { }
        return capacity;
    }
    function getTobaccoRetirementCandidate() {
        const finished = [];
        for (const name of tobaccoProducts()) {
            try {
                const product = c.getProduct(C.DIV_TOBACCO, C.HQ_CITY, name);
                const progress = Number(product.developmentProgress ?? 0);
                if (progress < 100)
                    continue;
                const rating = Number(product.rating ?? 0);
                const version = tobaccoProductVersion(name);
                finished.push({ name, rating, version });
            }
            catch { }
        }
        if (finished.length === 0)
            return null;
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
    function getTobaccoProductStats() {
        let highestProgress = 0;
        let activeProgress = 0;
        let activeProducts = 0;
        let finishedProducts = 0;
        for (const name of tobaccoProducts()) {
            try {
                const progress = c.getProduct(C.DIV_TOBACCO, C.HQ_CITY, name).developmentProgress || 0;
                if (progress > highestProgress)
                    highestProgress = progress;
                if (progress >= 100) {
                    finishedProducts++;
                }
                else {
                    activeProducts++;
                    if (progress > activeProgress)
                        activeProgress = progress;
                }
            }
            catch { }
        }
        return { highestProgress, activeProgress, activeProducts, finishedProducts };
    }
    function isBn3Round2MaterialTargetSetFilled(targets) {
        for (const city of C.CITIES) {
            try {
                for (const [mat, target] of Object.entries(targets)) {
                    if ((c.getMaterial(C.DIV_AGRI, city, mat).stored ?? 0) + 0.5 < target)
                        return false;
                }
            }
            catch {
                return false;
            }
        }
        return true;
    }
    function isBn3HighBudgetPostfillUnlocked() {
        if (!useBn3HighBudgetRound2() || !hasDiv(C.DIV_AGRI))
            return false;
        if (bn3HighBudgetPostfillUnlocked)
            return true;
        if (isBn3Round2MaterialTargetSetFilled(getBn3BaseMaterialTargets())) {
            bn3HighBudgetPostfillUnlocked = true;
            return true;
        }
        try {
            const { finishedProducts } = getTobaccoProductStats();
            if (finishedProducts > 0 ||
                c.getUpgradeLevel('Smart Storage') > C.ROUND2_BN3_SMART_TARGET ||
                c.getUpgradeLevel('ABC SalesBots') > C.ROUND2_BN3_SALESBOT_TARGET) {
                bn3HighBudgetPostfillUnlocked = true;
                return true;
            }
        }
        catch { }
        return false;
    }
    // One-way latch: set once the corp is mature enough to enter the debt-spike phase.
    // Checks base (pre-spike) maturity so there's no circular dep with isBn3Round2MaterialFilled.
    function isLeanTobSpikeUnlocked() {
        if (!useBn3LeanTobRound2() || !hasDiv(C.DIV_AGRI) || !hasDiv(C.DIV_TOBACCO))
            return false;
        if (bn3LeanTobSpikeUnlocked)
            return true;
        // Base targets must be filled first once spike activates these targets switch to spike levels.
        if (!isBn3Round2MaterialTargetSetFilled(getBn3BaseMaterialTargets()))
            return false;
        if (!isBn3LateThroughputReady())
            return false;
        if (getHighestTobaccoProductVersion() < 5)
            return false;
        try {
            const { finishedProducts } = getTobaccoProductStats();
            if (finishedProducts <= 0)
                return false;
            if (c.getUpgradeLevel('Wilson Analytics') < C.ROUND2_BN3_LATE_WILSON_TARGET)
                return false;
            if (c.getHireAdVertCount(C.DIV_TOBACCO) < C.ROUND2_BN3_LATE_TOB_ADVERT_TARGET)
                return false;
            if (c.getUpgradeLevel('Smart Storage') < C.ROUND2_BN3_LEAN_TOB_SPIKE_SMART_STORAGE)
                return false;
            // All pre-spike dummy divisions must exist and settle period must be complete.
            const divNames = c.getCorporation().divisions;
            for (let i = 1; i <= C.ROUND2_BN3_LEAN_TOB_SPIKE_DUMMY_TARGET; i++) {
                if (!divNames.includes(`Dummy-${i}`))
                    return false;
            }
        }
        catch {
            return false;
        }
        // Settle period: wait for the offer to absorb the cash dip from dummy creation.
        if (bn3LeanTobPreSpikeDummySettleCounter > 0)
            return false;
        bn3LeanTobSpikeUnlocked = true;
        log(ns, `INFO: Lean-tob spike unlocked ${C.ROUND2_BN3_LEAN_TOB_SPIKE_DUMMY_TARGET} dummies settled, switching to spike targets with debt fill up to ${formatMoney(C.ROUND2_BN3_LEAN_TOB_SPIKE_DEBT_MAX)}.`, true, 'info');
        return true;
    }
    function sumJobCounts({ ops = 0, eng = 0, biz = 0, mgmt = 0, rnd = 0 } = {}) {
        return ops + eng + biz + mgmt + rnd;
    }
    function fillJobRemainder(jobCounts, targetSize, order) {
        const filled = { ...jobCounts };
        let assigned = sumJobCounts(filled);
        for (let i = 0; assigned < targetSize; i++, assigned++) {
            const job = order[i % order.length];
            filled[job] = Number(filled[job] ?? 0) + 1;
        }
        return filled;
    }
    function getRound2TobaccoHQCompletedJobs(size) {
        if (size >= C.ROUND2_TOB_HQ_OFFICE) {
            return fillJobRemainder(C.ROUND2_TOB_HQ_JOBS, size, ['eng', 'mgmt', 'ops']);
        }
        if (size >= 9) {
            return fillJobRemainder(C.ROUND2_TOB_HQ_MID_JOBS, size, ['eng', 'mgmt', 'eng', 'ops', 'mgmt', 'eng']);
        }
        return fillJobRemainder(C.ROUND2_TOB_HQ_SMALL_JOBS, size, ['eng', 'mgmt', 'ops']);
    }
    function getTobaccoFlowStats() {
        if (!hasDiv(C.DIV_TOBACCO))
            return {};
        try {
            const flow = getTobaccoFlowNumbers();
            return {
                tobActive: flow.activeProducts,
                tobRev: formatMoney(flow.revenue),
                tobExp: formatMoney(flow.expenses),
                tobProfit: formatMoney(flow.revenue - flow.expenses),
                tobStore: flow.stored.toFixed(0),
                tobMake: `${flow.production.toFixed(1)}/s`,
                tobSell: `${flow.sell.toFixed(1)}/s`,
                tobPlants: flow.plants.toFixed(0),
                tobImp: `${flow.imports.toFixed(1)}/s`,
                tobBuy: `${flow.buy.toFixed(1)}/s`,
                tobIdle: flow.idle,
            };
        }
        catch {
            return {};
        }
    }
    function getTobaccoFlowNumbers() {
        if (!hasDiv(C.DIV_TOBACCO)) {
            return {
                activeProducts: 0, revenue: 0, expenses: 0, stored: 0, production: 0, sell: 0,
                imports: 0, buy: 0, plants: 0, idle: 0,
            };
        }
        try {
            const division = c.getDivision(C.DIV_TOBACCO);
            const revenue = Number(division.lastCycleRevenue ?? 0);
            const expenses = Number(division.lastCycleExpenses ?? 0);
            let activeProducts = 0;
            let stored = 0;
            let production = 0;
            let sell = 0;
            let imports = 0;
            let buy = 0;
            for (const name of division.products) {
                let progress = 0;
                try {
                    progress = Number(c.getProduct(C.DIV_TOBACCO, C.HQ_CITY, name).developmentProgress ?? 0);
                }
                catch { }
                if (progress < 100) {
                    activeProducts++;
                    continue;
                }
                for (const city of division.cities) {
                    try {
                        const info = c.getProduct(C.DIV_TOBACCO, city, name);
                        stored += Number(info.stored ?? 0);
                        production += Number(info.productionAmount ?? 0);
                        sell += Number(info.actualSellAmount ?? 0);
                    }
                    catch { }
                }
            }
            let plants = 0;
            for (const city of division.cities) {
                try {
                    const plant = c.getMaterial(C.DIV_TOBACCO, city, 'Plants');
                    plants += Number(plant.stored ?? 0);
                    imports += Number(plant.importAmount ?? 0);
                    buy += Number(plant.buyAmount ?? 0);
                }
                catch { }
            }
            const office = c.getOffice(C.DIV_TOBACCO, C.HQ_CITY);
            const jobs = office.employeeJobs ?? {};
            const assigned = Number(jobs[C.JOBS.ops] ?? 0) +
                Number(jobs[C.JOBS.eng] ?? 0) +
                Number(jobs[C.JOBS.biz] ?? 0) +
                Number(jobs[C.JOBS.mgmt] ?? 0) +
                Number(jobs[C.JOBS.rnd] ?? 0);
            return {
                activeProducts,
                revenue,
                expenses,
                stored,
                production,
                sell,
                imports,
                buy,
                plants,
                idle: Math.max(0, Number(office.size ?? 0) - assigned),
            };
        }
        catch {
            return {
                activeProducts: 0, revenue: 0, expenses: 0, stored: 0, production: 0, sell: 0,
                imports: 0, buy: 0, plants: 0, idle: 0,
            };
        }
    }
    function getTobaccoExportRouteStats() {
        if (!hasDiv(C.DIV_AGRI) || !hasDiv(C.DIV_TOBACCO) || !c.hasUnlock(C.UNLOCKS.export))
            return {};
        try {
            const exports = c.getMaterial(C.DIV_AGRI, C.HQ_CITY, 'Plants').exports ?? [];
            const route = exports.find((exp) => exp.division === C.DIV_TOBACCO && exp.city === C.HQ_CITY);
            return {
                tobRoute: route ? 'yes' : 'no',
                tobRouteAmt: route?.amount ?? 'none',
            };
        }
        catch {
            return {};
        }
    }
    function getTobaccoProductInvestment(bestOffer = 0) {
        const funds = c.getCorporation().funds;
        const { finishedProducts, highestProgress } = getTobaccoProductStats();
        let investPct = useBn3HighBudgetRound2()
            ? R3.ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT
            : opts['aggressive-round2']
                ? C.ROUND2_AGGR_PRODUCT_INVEST_PCT
                : useBn3LeanTobRound2()
                    ? C.ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT
                    : 0.01;
        let investCap = useBn3HighBudgetRound2()
            ? R3.ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP
            : opts['aggressive-round2']
                ? C.ROUND2_PRODUCT_MAX_INVEST_AGGR
                : useBn3LeanTobRound2()
                    ? C.ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP
                    : C.ROUND2_PRODUCT_MAX_INVEST;
        let investMin = useBn3HighBudgetRound2() ? R3.ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN : C.ROUND2_PRODUCT_MIN_INVEST;
        if (useBn3HighBudgetRound2() && finishedProducts > 0) {
            const late = bestOffer >= C.ROUND2_BN3_LATE_VALUATION_TRIGGER;
            investPct = late
                ? R3.ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT_LATE
                : R3.ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT_POSTDONE;
            investCap = late
                ? R3.ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP_LATE
                : R3.ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP_POSTDONE;
            investMin = late
                ? R3.ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN_LATE
                : R3.ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN_POSTDONE;
        }
        else if (useBn3LeanTobRound2() && finishedProducts > 0) {
            const late = bestOffer >= C.ROUND2_BN3_LEAN_TOB_SUPPORT_TRIGGER;
            investPct = late
                ? C.ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_LATE
                : C.ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_POSTDONE;
            investCap = late
                ? C.ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_LATE
                : C.ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_POSTDONE;
            investMin = late
                ? C.ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_LATE
                : C.ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_POSTDONE;
        }
        const desired = Math.max(investMin, Math.min(funds * investPct, investCap));
        return desired;
    }
    function isLeanTobaccoProductCycleReady(bestOffer = 0, stagnantChecks = 0) {
        if (!useBn3LeanTobRound2())
            return true;
        if (bestOffer + C.ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_TOLERANCE >= C.ROUND2_BN3_LEAN_TOB_PREFILL_HQ_TRIGGER)
            return true;
        return stagnantChecks >= C.ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_STAGNATION;
    }
    function shouldFreezeBn3LeanTobaccoProductCycle(bestOffer = 0) {
        if (!useBn3LeanTobRound2() || !hasDiv(C.DIV_TOBACCO))
            return false;
        if (bestOffer < C.ROUND2_BN3_LATE_VALUATION_TRIGGER)
            return false;
        if (!isBn3Round2MaterialFilled())
            return false;
        const { finishedProducts, highestProgress } = getTobaccoProductStats();
        if (finishedProducts < 2)
            return false;
        return getHighestTobaccoProductVersion() >= C.ROUND2_BN3_LEAN_TOB_PRODUCT_FREEZE_VERSION;
    }
    function getBn3HighBudgetProductQualityHoldReason() {
        if (!useBn3HighBudgetRound2() || !hasDiv(C.DIV_TOBACCO))
            return null;
        const { finishedProducts } = getTobaccoProductStats();
        if (finishedProducts <= 0)
            return null;
        const hqTarget = C.ROUND2_BN3_HIGH_BUDGET_TOB_HQ_FULL;
        const supportTarget = C.ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_FULL;
        try {
            const hqOffice = c.getOffice(C.DIV_TOBACCO, C.HQ_CITY);
            const hqSize = Number(hqOffice?.size ?? 0);
            const hqEmployees = Number(hqOffice?.numEmployees ?? 0);
            if (hqSize < hqTarget || hqEmployees < hqTarget) {
                return `HQ ${Math.min(hqSize, hqEmployees)}/${hqTarget}`;
            }
        }
        catch {
            return `HQ 0/${hqTarget}`;
        }
        for (const city of C.CITIES) {
            if (city === C.HQ_CITY)
                continue;
            try {
                const office = c.getOffice(C.DIV_TOBACCO, city);
                const size = Number(office?.size ?? 0);
                const employees = Number(office?.numEmployees ?? 0);
                if (size < supportTarget || employees < supportTarget) {
                    return `${city} ${Math.min(size, employees)}/${supportTarget}`;
                }
            }
            catch {
                return `${city} 0/${supportTarget}`;
            }
        }
        return null;
    }
    function isBn3HighBudgetProductQualityReady() {
        return getBn3HighBudgetProductQualityHoldReason() == null;
    }
    function ensureTobaccoProduct(reserve = 0, bestOffer = 0, stagnantChecks = 0) {
        if (!hasDiv(C.DIV_TOBACCO) || hasActiveTobaccoDevelopment())
            return;
        if (shouldFreezeBn3LeanTobaccoProductCycle(bestOffer))
            return;
        const productQualityHold = getBn3HighBudgetProductQualityHoldReason();
        if (productQualityHold) {
            noteBn3Gate('product-quality', `BN3 high-budget product quality hold active - delaying the next Tobacco product until offices catch up (${productQualityHold}).`);
            return;
        }
        if (!isBn3HighBudgetProductCycleReady(bestOffer, stagnantChecks)) {
            noteBn3Gate('product-cycle', 'BN3 high-budget product cycle hold active - pausing new Tobacco product spending until cashflow and valuation recover.');
            return;
        }
        try {
            const invest = getTobaccoProductInvestment(bestOffer);
            const funds = c.getCorporation().funds;
            if (funds - invest < reserve)
                return;
            const capacity = getTobaccoProductCapacity();
            const products = tobaccoProducts();
            const name = nextTobaccoProductName();
            if (products.length >= capacity) {
                const cycleReady = isLeanTobaccoProductCycleReady(bestOffer, stagnantChecks);
                if (!cycleReady)
                    return;
                const retired = getTobaccoRetirementCandidate();
                if (!retired)
                    return;
                c.discontinueProduct(C.DIV_TOBACCO, retired);
                log(ns, `INFO: Retired ${retired} to free a Tobacco product slot.`, true, 'info');
            }
            c.makeProduct(C.DIV_TOBACCO, C.HQ_CITY, name, invest / 2, invest / 2);
            lastTobaccoProductError = '';
            log(ns, `INFO: Started product ${name} with ${formatMoney(invest)} investment [route ${useBn3HighBudgetRound2() ? 'high' : (useBn3LeanTobRound2() ? 'lean' : 'classic')}].`, true, 'info');
        }
        catch (e) {
            const msg = e?.message ?? String(e);
            if (msg !== lastTobaccoProductError) {
                lastTobaccoProductError = msg;
                log(ns, `WARN: Could not start Tobacco product: ${msg}`, true, 'warning');
            }
        }
    }
    function getBn3LeanTobaccoProductReserve(baseReserve) {
        if (!useBn3ExpandedTobaccoRound2() || !hasDiv(C.DIV_TOBACCO))
            return baseReserve;
        const { finishedProducts } = getTobaccoProductStats();
        if (finishedProducts > 0)
            return baseReserve;
        const preFinishReserve = useBn3HighBudgetRound2()
            ? C.ROUND2_BN3_HIGH_BUDGET_PRODUCT_RESERVE
            : C.ROUND2_BN3_LEAN_TOB_PRODUCT_RESERVE;
        return Math.max(baseReserve, preFinishReserve);
    }
    function canSpend(cost, reserve = 0) {
        return Number.isFinite(cost) && cost >= 0 && c.getCorporation().funds - cost >= reserve;
    }
    function formatRound2Debug(parts) {
        return Object.entries(parts)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
    }
    function getAgriWarehouseUsageSummary() {
        try {
            if (!hasDiv(C.DIV_AGRI))
                return { avg: 0, peak: 0 };
            let totalUse = 0;
            let totalSize = 0;
            let peakUse = 0;
            for (const city of C.CITIES) {
                try {
                    const wh = c.getWarehouse(C.DIV_AGRI, city);
                    const size = Number(wh.size ?? 0);
                    const used = Number(wh.sizeUsed ?? 0);
                    if (size <= 0)
                        continue;
                    totalUse += used;
                    totalSize += size;
                    peakUse = Math.max(peakUse, used / size);
                }
                catch { }
            }
            if (totalSize <= 0)
                return { avg: 0, peak: 0 };
            return {
                avg: totalUse / totalSize,
                peak: peakUse,
            };
        }
        catch {
            return { avg: 0, peak: 0 };
        }
    }
    function getAgriWarehouseUseStats() {
        const usage = getAgriWarehouseUsageSummary();
        const stats = {
            whAvg: `${(usage.avg * 100).toFixed(1)}%`,
            whPeak: `${(usage.peak * 100).toFixed(1)}%`,
        };
        // Per-city breakdown: only shown when at least one city is 竕 85% full,
        // so it's silent in normal operation and visible when a city is pinned.
        try {
            if (hasDiv(C.DIV_AGRI)) {
                const parts = [];
                for (const city of C.CITIES) {
                    try {
                        const wh = c.getWarehouse(C.DIV_AGRI, city);
                        const pct = Number(wh.sizeUsed ?? 0) / Number(wh.size ?? 1);
                        if (pct >= 0.85)
                            parts.push(`${getAgriCityDebugLabel(city)}:${(pct * 100).toFixed(0)}%`);
                    }
                    catch { }
                }
                if (parts.length > 0)
                    stats.whCities = parts.join(',');
            }
        }
        catch { }
        return stats;
    }
    function getAgriFlowNumbers() {
        try {
            let production = 0;
            let sell = 0;
            let stored = 0;
            let water = 0;
            let chemicals = 0;
            let foodStock = 0;
            let plantsStock = 0;
            for (const city of C.CITIES) {
                try {
                    const food = c.getMaterial(C.DIV_AGRI, city, 'Food');
                    const plants = c.getMaterial(C.DIV_AGRI, city, 'Plants');
                    const waterMat = c.getMaterial(C.DIV_AGRI, city, 'Water');
                    const chemMat = c.getMaterial(C.DIV_AGRI, city, 'Chemicals');
                    production += Number(food.productionAmount ?? 0) + Number(plants.productionAmount ?? 0);
                    sell += Number(food.actualSellAmount ?? 0) + Number(plants.actualSellAmount ?? 0);
                    foodStock += Number(food.stored ?? 0);
                    plantsStock += Number(plants.stored ?? 0);
                    stored += Number(food.stored ?? 0) + Number(plants.stored ?? 0);
                    water += Number(waterMat.stored ?? 0);
                    chemicals += Number(chemMat.stored ?? 0);
                }
                catch { }
            }
            return { production, sell, stored, water, chemicals, foodStock, plantsStock };
        }
        catch {
            return { production: 0, sell: 0, stored: 0, water: 0, chemicals: 0, foodStock: 0, plantsStock: 0 };
        }
    }
    function getAgriCityFlowNumbers(city) {
        try {
            const food = c.getMaterial(C.DIV_AGRI, city, 'Food');
            const plants = c.getMaterial(C.DIV_AGRI, city, 'Plants');
            const waterMat = c.getMaterial(C.DIV_AGRI, city, 'Water');
            const chemMat = c.getMaterial(C.DIV_AGRI, city, 'Chemicals');
            return {
                foodProduction: Math.max(0, Number(food.productionAmount ?? 0)),
                plantsProduction: Math.max(0, Number(plants.productionAmount ?? 0)),
                foodStored: Math.max(0, Number(food.stored ?? 0)),
                plantsStored: Math.max(0, Number(plants.stored ?? 0)),
                waterStored: Math.max(0, Number(waterMat.stored ?? 0)),
                chemicalsStored: Math.max(0, Number(chemMat.stored ?? 0)),
            };
        }
        catch {
            return {
                foodProduction: 0,
                plantsProduction: 0,
                foodStored: 0,
                plantsStored: 0,
                waterStored: 0,
                chemicalsStored: 0,
            };
        }
    }
    function getAgriCityDebugLabel(city) {
        switch (city) {
            case 'Aevum': return 'Aev';
            case 'Chongqing': return 'Cho';
            case 'Sector-12': return 'S12';
            case 'New Tokyo': return 'NT';
            case 'Ishima': return 'Ish';
            case 'Volhaven': return 'Vol';
            default: return city.slice(0, 3);
        }
    }
    function getAgriCityWarehouseCompositionDebug() {
        try {
            return C.CITIES.map((city) => {
                try {
                    if (!c.hasWarehouse(C.DIV_AGRI, city))
                        return `${getAgriCityDebugLabel(city)}:na`;
                    const wh = c.getWarehouse(C.DIV_AGRI, city);
                    const size = Math.max(0, Number(wh.size ?? 0));
                    const used = Math.max(0, Number(wh.sizeUsed ?? 0));
                    const flow = getAgriCityFlowNumbers(city);
                    const wcSpace = (flow.waterStored * getPhysicalMaterialSize('Water', getMaterialSize('Water'))) +
                        (flow.chemicalsStored * getPhysicalMaterialSize('Chemicals', getMaterialSize('Chemicals')));
                    const fpSpace = (flow.foodStored * ROUND1_AGRI_PRODUCT_MAT_SIZES.Food) +
                        (flow.plantsStored * ROUND1_AGRI_PRODUCT_MAT_SIZES.Plants);
                    let boostSpace = 0;
                    for (const mat of C.AGRI_MATS) {
                        try {
                            const stored = Math.max(0, Number(c.getMaterial(C.DIV_AGRI, city, mat).stored ?? 0));
                            boostSpace += stored * getPhysicalMaterialSize(mat);
                        }
                        catch { }
                    }
                    const knownSpace = wcSpace + fpSpace + boostSpace;
                    const otherSpace = Math.max(0, used - knownSpace);
                    const freeSpace = Math.max(0, size - used);
                    const pct = (value) => size > 0 ? Math.round((value / size) * 100) : 0;
                    return (`${getAgriCityDebugLabel(city)}:${pct(used)}` +
                        `(wc${pct(wcSpace)},fp${pct(fpSpace)},b${pct(boostSpace)},o${pct(otherSpace)},f${pct(freeSpace)})`);
                }
                catch {
                    return `${getAgriCityDebugLabel(city)}:err`;
                }
            }).join('|');
        }
        catch {
            return 'na';
        }
    }
    function getAgriCityInputsDebug() {
        try {
            return C.CITIES.map((city) => {
                try {
                    const flow = getAgriCityFlowNumbers(city);
                    return `${getAgriCityDebugLabel(city)}:${flow.waterStored.toFixed(0)}/${flow.chemicalsStored.toFixed(0)}`;
                }
                catch {
                    return `${getAgriCityDebugLabel(city)}:err`;
                }
            }).join('|');
        }
        catch {
            return 'na';
        }
    }
    function getStableCorpCycleStats() {
        try {
            const corp = c.getCorporation();
            let revenue = 0;
            let expenses = 0;
            for (const div of corp.divisions ?? []) {
                try {
                    const info = c.getDivision(div);
                    revenue += Number(info.lastCycleRevenue ?? 0);
                    expenses += Number(info.lastCycleExpenses ?? 0);
                }
                catch { }
            }
            return {
                revenue,
                expenses,
                liveRevenue: Number(corp.revenue ?? 0),
                nextState: corp.nextState ?? '?',
                prevState: corp.prevState ?? '?',
            };
        }
        catch {
            return { revenue: 0, expenses: 0, liveRevenue: 0, nextState: '?', prevState: '?' };
        }
    }
    // Generic profit-gated office size selector used by all high-budget divisions.
    // trueProfit (boost-mat revenue excluded during liquidation) must comfortably
    // cover total overhead before each size step is unlocked:
    //   minSz  returned when profit < SCALE_RATIO_MID baseOverhead
    //   midSz  returned when profit >= SCALE_RATIO_MID baseOverhead
    //   maxSz  returned when profit >= SCALE_RATIO_FULL (baseOverhead + one morale unit)
    // The extra morale unit in the maxSz gate prices in the new tea/party obligation
    // that comes with expanding a city to 竕9 employees.
    function shouldPreserveAggressiveRound2(bestOffer, rpGateCleared, stagnantChecks) {
        if (!opts['aggressive-round2'])
            return false;
        const { highestProgress, finishedProducts } = getTobaccoProductStats();
        return !rpGateCleared &&
            finishedProducts === 0 &&
            highestProgress >= C.ROUND2_AGGR_FREEZE_PROGRESS &&
            bestOffer >= C.ROUND2_AGGR_WARMUP_TARGET &&
            stagnantChecks < C.ROUND2_AGGR_WARMUP_STAGNATION;
    }
    function getPostRound2BootstrapReserve() {
        const funds = c.getCorporation().funds;
        return Math.max(C.ROUND2_POST_ACCEPT_BOOTSTRAP_RESERVE, funds * C.ROUND2_POST_ACCEPT_BOOTSTRAP_RESERVE_PCT);
    }
    function getPostRound2TobaccoOfficeTarget(city) {
        return city === C.HQ_CITY ? C.ROUND2_POST_ACCEPT_TOB_HQ_OFFICE : C.ROUND2_POST_ACCEPT_TOB_SUPPORT_OFFICE;
    }
    function getPostRound2OfficeJobs(div, city) {
        if (div === C.DIV_TOBACCO)
            return city === C.HQ_CITY ? C.ROUND2_POST_ACCEPT_TOB_HQ_JOBS : C.ROUND2_POST_ACCEPT_TOB_SUPPORT_JOBS;
        if (div === C.DIV_AGRI)
            return C.ROUND2_POST_ACCEPT_AGRI_JOBS;
        if (div === C.DIV_CHEM)
            return C.ROUND2_POST_ACCEPT_CHEM_JOBS;
        return {};
    }
    function isPostRound2BootstrapReady() {
        if (!hasDiv(C.DIV_AGRI) || !hasDiv(C.DIV_CHEM) || !hasDiv(C.DIV_TOBACCO))
            return false;
        if (!divisionInfraReady(C.DIV_AGRI) || !divisionInfraReady(C.DIV_CHEM) || !divisionInfraReady(C.DIV_TOBACCO))
            return false;
        if (!c.hasUnlock(C.UNLOCKS.export) || !c.hasUnlock(C.UNLOCKS.smartSupply))
            return false;
        try {
            if (c.getUpgradeLevel('Smart Factories') < C.ROUND2_POST_ACCEPT_SMART_FACTORIES_TARGET)
                return false;
            if (c.getUpgradeLevel('Smart Storage') < C.ROUND2_POST_ACCEPT_SMART_STORAGE_TARGET)
                return false;
            if (c.getUpgradeLevel('Wilson Analytics') < C.ROUND2_POST_ACCEPT_WILSON_TARGET)
                return false;
            if (c.getHireAdVertCount(C.DIV_TOBACCO) < C.ROUND2_POST_ACCEPT_TOB_ADVERT_TARGET)
                return false;
        }
        catch {
            return false;
        }
        for (const city of C.CITIES) {
            try {
                const agriOffice = c.getOffice(C.DIV_AGRI, city);
                const tobOffice = c.getOffice(C.DIV_TOBACCO, city);
                const chemOffice = c.getOffice(C.DIV_CHEM, city);
                const tobTarget = getPostRound2TobaccoOfficeTarget(city);
                if (agriOffice.size < C.ROUND2_POST_ACCEPT_AGRI_OFFICE || agriOffice.numEmployees < C.ROUND2_POST_ACCEPT_AGRI_OFFICE)
                    return false;
                if (tobOffice.size < tobTarget || tobOffice.numEmployees < tobTarget)
                    return false;
                if (chemOffice.size < C.ROUND2_POST_ACCEPT_CHEM_OFFICE || chemOffice.numEmployees < C.ROUND2_POST_ACCEPT_CHEM_OFFICE)
                    return false;
                if (c.getWarehouse(C.DIV_AGRI, city).level < C.ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL)
                    return false;
                if (c.getWarehouse(C.DIV_TOBACCO, city).level < C.ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL)
                    return false;
                if (c.getWarehouse(C.DIV_CHEM, city).level < C.ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL)
                    return false;
            }
            catch {
                return false;
            }
        }
        return true;
    }
    function tryPostRound2BootstrapStep(reserve) {
        if (!hasDiv(C.DIV_CHEM)) {
            const cost = expandIndustryCost(C.IND_CHEM);
            if (canSpend(cost, reserve)) {
                c.expandIndustry(C.IND_CHEM, C.DIV_CHEM);
                return 'Chemical launched';
            }
            return null;
        }
        if (!hasDiv(C.DIV_TOBACCO)) {
            const cost = expandIndustryCost(C.IND_TOBACCO);
            if (canSpend(cost, reserve)) {
                c.expandIndustry(C.IND_TOBACCO, C.DIV_TOBACCO);
                return 'Tobacco launched';
            }
            return null;
        }
        const officeCost = getCorpOfficeInitialCost();
        const warehouseCost = getCorpWarehouseInitialCost();
        for (const [div, label] of [[C.DIV_CHEM, 'Chemical'], [C.DIV_TOBACCO, 'Tobacco']]) {
            for (const city of C.CITIES) {
                try {
                    const cities = c.getDivision(div).cities;
                    if (!cities.includes(city)) {
                        const floor = reserve + warehouseCost;
                        if (!canSpend(officeCost, floor))
                            return null;
                        c.expandCity(div, city);
                        return `${label} expanded to ${city}`;
                    }
                    if (!c.hasWarehouse(div, city)) {
                        if (!canSpend(warehouseCost, reserve))
                            return null;
                        c.purchaseWarehouse(div, city);
                        return `${label} warehouse purchased in ${city}`;
                    }
                }
                catch {
                    return null;
                }
            }
        }
        if (!c.hasUnlock(C.UNLOCKS.export)) {
            const cost = unlockCost(C.UNLOCKS.export, Infinity);
            if (!canSpend(cost, reserve))
                return null;
            buyUnlock(C.UNLOCKS.export);
            return `Unlock ${C.UNLOCKS.export}`;
        }
        if (!c.hasUnlock(C.UNLOCKS.smartSupply)) {
            const cost = unlockCost(C.UNLOCKS.smartSupply, Infinity);
            if (!canSpend(cost, reserve))
                return null;
            buyUnlock(C.UNLOCKS.smartSupply);
            return `Unlock ${C.UNLOCKS.smartSupply}`;
        }
        for (const [upgrade, target] of [
            ['Smart Factories', C.ROUND2_POST_ACCEPT_SMART_FACTORIES_TARGET],
            ['Smart Storage', C.ROUND2_POST_ACCEPT_SMART_STORAGE_TARGET],
            ['Wilson Analytics', C.ROUND2_POST_ACCEPT_WILSON_TARGET],
        ]) {
            try {
                if (c.getUpgradeLevel(upgrade) >= target)
                    continue;
                const cost = c.getUpgradeLevelCost(upgrade);
                if (!canSpend(cost, reserve))
                    return null;
                c.levelUpgrade(upgrade);
                return `${upgrade} -> ${c.getUpgradeLevel(upgrade)}`;
            }
            catch {
                return null;
            }
        }
        try {
            if (c.getHireAdVertCount(C.DIV_TOBACCO) < C.ROUND2_POST_ACCEPT_TOB_ADVERT_TARGET) {
                const cost = c.getHireAdVertCost(C.DIV_TOBACCO);
                if (!canSpend(cost, reserve))
                    return null;
                c.hireAdVert(C.DIV_TOBACCO);
                return `Tobacco advert -> ${c.getHireAdVertCount(C.DIV_TOBACCO)}`;
            }
        }
        catch {
            return null;
        }
        for (const city of C.CITIES) {
            try {
                const tobTarget = getPostRound2TobaccoOfficeTarget(city);
                const tobOffice = c.getOffice(C.DIV_TOBACCO, city);
                if (tobOffice.size < tobTarget) {
                    const increase = tobTarget - tobOffice.size;
                    const cost = c.getOfficeSizeUpgradeCost(C.DIV_TOBACCO, city, increase);
                    if (!canSpend(cost, reserve))
                        return null;
                    fillOffice(C.DIV_TOBACCO, city, tobTarget, getPostRound2OfficeJobs(C.DIV_TOBACCO, city));
                    return `Tobacco ${city} office -> ${tobTarget}`;
                }
                if (tobOffice.numEmployees < tobOffice.size) {
                    fillOffice(C.DIV_TOBACCO, city, tobOffice.size, getPostRound2OfficeJobs(C.DIV_TOBACCO, city));
                    return `Tobacco staffed in ${city}`;
                }
                assignJobs(C.DIV_TOBACCO, city, getPostRound2OfficeJobs(C.DIV_TOBACCO, city));
            }
            catch {
                return null;
            }
        }
        for (const city of C.CITIES) {
            try {
                const agriOffice = c.getOffice(C.DIV_AGRI, city);
                if (agriOffice.size < C.ROUND2_POST_ACCEPT_AGRI_OFFICE) {
                    const increase = C.ROUND2_POST_ACCEPT_AGRI_OFFICE - agriOffice.size;
                    const cost = c.getOfficeSizeUpgradeCost(C.DIV_AGRI, city, increase);
                    if (!canSpend(cost, reserve))
                        return null;
                    fillOffice(C.DIV_AGRI, city, C.ROUND2_POST_ACCEPT_AGRI_OFFICE, C.ROUND2_POST_ACCEPT_AGRI_JOBS);
                    return `Agriculture ${city} office -> ${C.ROUND2_POST_ACCEPT_AGRI_OFFICE}`;
                }
                if (agriOffice.numEmployees < agriOffice.size) {
                    fillOffice(C.DIV_AGRI, city, agriOffice.size, C.ROUND2_POST_ACCEPT_AGRI_JOBS);
                    return `Agriculture staffed in ${city}`;
                }
                assignJobs(C.DIV_AGRI, city, C.ROUND2_POST_ACCEPT_AGRI_JOBS);
            }
            catch {
                return null;
            }
        }
        for (const city of C.CITIES) {
            try {
                const chemOffice = c.getOffice(C.DIV_CHEM, city);
                if (chemOffice.size < C.ROUND2_POST_ACCEPT_CHEM_OFFICE) {
                    const increase = C.ROUND2_POST_ACCEPT_CHEM_OFFICE - chemOffice.size;
                    const cost = c.getOfficeSizeUpgradeCost(C.DIV_CHEM, city, increase);
                    if (!canSpend(cost, reserve))
                        return null;
                    fillOffice(C.DIV_CHEM, city, C.ROUND2_POST_ACCEPT_CHEM_OFFICE, C.ROUND2_POST_ACCEPT_CHEM_JOBS);
                    return `Chemical ${city} office -> ${C.ROUND2_POST_ACCEPT_CHEM_OFFICE}`;
                }
                if (chemOffice.numEmployees < chemOffice.size) {
                    fillOffice(C.DIV_CHEM, city, chemOffice.size, C.ROUND2_POST_ACCEPT_CHEM_JOBS);
                    return `Chemical staffed in ${city}`;
                }
                assignJobs(C.DIV_CHEM, city, C.ROUND2_POST_ACCEPT_CHEM_JOBS);
            }
            catch {
                return null;
            }
        }
        for (const div of [C.DIV_AGRI, C.DIV_TOBACCO, C.DIV_CHEM]) {
            for (const city of C.CITIES) {
                try {
                    const wh = c.getWarehouse(div, city);
                    if (wh.level >= C.ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL)
                        continue;
                    const cost = c.getUpgradeWarehouseCost(div, city, 1);
                    if (!canSpend(cost, reserve))
                        return null;
                    c.upgradeWarehouse(div, city, 1);
                    return `${div} ${city} warehouse -> ${wh.level + 1}`;
                }
                catch {
                    return null;
                }
            }
        }
        return null;
    }
    function runPostRound2BootstrapBatch(maxActions = 64) {
        const actions = [];
        for (let i = 0; i < maxActions; i++) {
            const reserve = getPostRound2BootstrapReserve();
            const action = tryPostRound2BootstrapStep(reserve);
            if (!action)
                break;
            actions.push({ action, reserve });
            if (c.hasUnlock(C.UNLOCKS.smartSupply)) {
                stopRound1AgriSupply();
                stopChemicalWaterSupply();
                enableSmartSupply(C.DIV_AGRI);
                enableSmartSupply(C.DIV_CHEM);
                enableSmartSupply(C.DIV_TOBACCO);
            }
            configureExports();
            if (isPostRound2BootstrapReady())
                break;
        }
        return actions;
    }
    // Docs: "Buy tea / throw party every cycle. Maintain maximum energy/morale."
    function boostMorale(...divs) {
        latestTeaSpend = 0;
        latestPartySpend = 0;
        const upkeepFloor = getMoraleUpkeepFloor();
        const now = Date.now();
        for (const div of divs)
            for (const city of C.CITIES) {
                try {
                    const office = c.getOffice(div, city);
                    if (office.numEmployees < 9)
                        continue;
                    const key = getOfficeSpendKey(div, city);
                    if ((office.avgEnergy ?? 100) < C.CORP_ENERGY_THRESHOLD &&
                        now >= Number(teaCooldownByOffice[key] ?? 0) &&
                        c.getCorporation().funds - C.CORP_TEA_COST >= upkeepFloor) {
                        c.buyTea(div, city);
                        teaCooldownByOffice[key] = now + C.CORP_MORALE_ACTION_COOLDOWN_MS;
                        latestTeaSpend += C.CORP_TEA_COST;
                    }
                    const moraleGap = Math.max(0, C.CORP_MORALE_THRESHOLD - Number(office.avgMorale ?? 100));
                    if (moraleGap <= 0)
                        continue;
                    if (now < Number(partyCooldownByOffice[key] ?? 0))
                        continue;
                    const partySpend = clamp(Math.round(office.numEmployees * moraleGap * 15e3), C.CORP_MORALE_PARTY_SPEND_MIN, C.CORP_MORALE_PARTY_SPEND_MAX);
                    if (c.getCorporation().funds - partySpend < upkeepFloor)
                        continue;
                    c.throwParty(div, city, partySpend);
                    partyCooldownByOffice[key] = now + C.CORP_MORALE_ACTION_COOLDOWN_MS;
                    latestPartySpend += partySpend;
                }
                catch { }
            }
    }
    // Spike-mode morale management: bypasses the upkeep floor check entirely.
    // During debt-spike, funds are deeply negative but tea ($500k) and minimum
    // parties ($100k) are rounding error vs. $400B material debt safe to spend.
    // Only triggers at crisis thresholds, not the normal 98% maintenance level.
    function boostMoraleSpike(...divs) {
        const now = Date.now();
        for (const div of divs)
            for (const city of C.CITIES) {
                try {
                    const office = c.getOffice(div, city);
                    if (office.numEmployees < 9)
                        continue;
                    const key = getOfficeSpendKey(div, city);
                    if ((office.avgEnergy ?? 100) < C.CORP_SPIKE_ENERGY_THRESHOLD &&
                        now >= Number(teaCooldownByOffice[key] ?? 0)) {
                        try {
                            c.buyTea(div, city);
                            teaCooldownByOffice[key] = now + C.CORP_MORALE_ACTION_COOLDOWN_MS;
                            latestTeaSpend += C.CORP_TEA_COST;
                        }
                        catch { }
                    }
                    const moraleGap = Math.max(0, C.CORP_SPIKE_MORALE_THRESHOLD - Number(office.avgMorale ?? 100));
                    if (moraleGap > 0 && now >= Number(partyCooldownByOffice[key] ?? 0)) {
                        try {
                            c.throwParty(div, city, C.CORP_MORALE_PARTY_SPEND_MIN);
                            partyCooldownByOffice[key] = now + C.CORP_MORALE_ACTION_COOLDOWN_MS;
                            latestPartySpend += C.CORP_MORALE_PARTY_SPEND_MIN;
                        }
                        catch { }
                    }
                }
                catch { }
            }
    }
    //  Research (with RP threshold enforcement) 
    function getResearchSpendThreshold(div, name) {
        if (C.PRODUCTION_RESEARCH.has(name))
            return 10;
        // After round-3 setup, TA2 is no longer a product-quality tradeoff.
        // Research it as soon as its RP cost is available instead of waiting for
        // a full 2x-cost buffer.
        if (phase >= 7 && div === C.DIV_TOBACCO && (name === 'Market-TA.I' || name === 'Market-TA.II'))
            return 1;
        return 2;
    }
    function tryResearch(div, queue) {
        try {
            let availableRp = c.getDivision(div).researchPoints;
            for (const name of queue) {
                if (c.hasResearched(div, name))
                    continue;
                const cost = c.getResearchCost(div, name);
                // Production research: 10% pool threshold. General research: 50%.
                const threshold = getResearchSpendThreshold(div, name);
                if (availableRp < cost * threshold)
                    continue;
                try {
                    c.research(div, name);
                    availableRp -= cost;
                    log(ns, `  Researched "${name}" (${div})`, false, 'info');
                }
                catch { }
            }
        }
        catch { }
    }
    //  Upgrades 
    // All names are exact CorpUpgradeName enum VALUES (not keys).
    function buyUpgrades(upgs, mult) {
        const funds = c.getCorporation().funds;
        for (const upg of upgs)
            try {
                if (funds > c.getUpgradeLevelCost(upg) * mult)
                    c.levelUpgrade(upg);
            }
            catch { }
    }
    //  Product pricing 
    // setProductMarketTA2 sets auto-pricing only.
    // sellProduct must ALSO be called to configure the sell AMOUNT (MAX).
    // Without this the product sells 0 units if the amount was never set.
    function priceProducts() {
        if (!hasDiv(C.DIV_TOBACCO))
            return;
        for (const pName of c.getDivision(C.DIV_TOBACCO).products) {
            try {
                const prod = c.getProduct(C.DIV_TOBACCO, C.HQ_CITY, pName);
                if (prod.developmentProgress < 100)
                    continue;
                if (c.hasResearched(C.DIV_TOBACCO, 'Market-TA.II'))
                    c.setProductMarketTA2(C.DIV_TOBACCO, pName, true);
                else if (c.hasResearched(C.DIV_TOBACCO, 'Market-TA.I'))
                    c.setProductMarketTA1(C.DIV_TOBACCO, pName, true);
                const price = 'MP';
                for (const city of c.getDivision(C.DIV_TOBACCO).cities)
                    c.sellProduct(C.DIV_TOBACCO, city, pName, 'MAX', price, true);
            }
            catch { }
        }
    }
    function getPrivateStageReserve(stageName) {
        const corp = c.getCorporation();
        const funds = Math.max(0, Number(corp.funds ?? 0));
        const revenue = Math.max(0, Number(corp.revenue ?? 0));
        const expenses = Math.max(0, Number(corp.expenses ?? 0));
        const profit = revenue - expenses;
        const margin = revenue > 0 ? profit / revenue : (profit > 0 ? 1 : 0);
        const minReserve = stageName === C.PRIVATE_STAGE_PRE_IPO
            ? C.PRIVATE_STAGE_PRE_IPO_RESERVE_MIN
            : C.PRIVATE_STAGE_POST_R3_RESERVE_MIN;
        let reserve = Math.max(minReserve, funds * (margin < 0.15 ? C.PRIVATE_STAGE_NEGATIVE_MARGIN_RESERVE_PCT : C.PRIVATE_STAGE_RESERVE_PCT));
        if (profit < 0)
            reserve = Math.max(reserve, expenses * 180);
        return reserve;
    }
    function getPrivateStageSpendingThreshold(stageName, threshold) {
        if (!Number.isFinite(threshold) || threshold <= 0)
            return threshold;
        if (stageName !== C.PRIVATE_STAGE_POST_R3)
            return threshold;
        const funds = Math.max(0, Number(c.getCorporation().funds ?? 0));
        const softerFundsGate = Math.max(2e12, funds * 0.60);
        return Math.min(threshold, softerFundsGate);
    }
    function getPrivateStageOfficeTarget(stageName, div, city) {
        const targets = PRIVATE_STAGE_TARGETS[stageName];
        if (!targets)
            return 0;
        if (div === C.DIV_AGRI)
            return targets.agriOffice;
        if (div === C.DIV_CHEM)
            return targets.chemOffice;
        if (div === C.DIV_TOBACCO)
            return city === C.HQ_CITY ? targets.tobHqOffice : targets.tobSupportOffice;
        return 0;
    }
    function getPrivateStageUpgradeTarget(stageName, name) {
        const targets = PRIVATE_STAGE_TARGETS[stageName];
        if (!targets)
            return 0;
        let staticTarget;
        switch (name) {
            case 'Smart Factories': staticTarget = targets.smartFactories; break;
            case 'Smart Storage':   staticTarget = targets.smartStorage;   break;
            case 'ABC SalesBots':   staticTarget = targets.salesBots;      break;
            case 'Wilson Analytics': staticTarget = targets.wilson;        break;
            default: return 0;
        }
        // Below the required floor — buy up to the static target unconditionally.
        try {
            const currentLevel = c.getUpgradeLevel(name);
            if (currentLevel < staticTarget) return staticTarget;
            // Above the floor — buy one more level only if ROI supports it.
            // warehouseCheck covers all production divisions so SF/SS decisions
            // reflect the actual constraint (any div with headroom = SF useful;
            // any div under pressure = SS needed).
            const warehouseCheck = (name === 'Smart Factories' || name === 'Smart Storage')
                ? C.CITIES.flatMap(city => [
                    ...(hasDiv(C.DIV_TOBACCO) ? [[C.DIV_TOBACCO, city]] : []),
                    ...(hasDiv(C.DIV_AGRI)    ? [[C.DIV_AGRI, city]]    : []),
                    ...(hasDiv(C.DIV_CHEM)    ? [[C.DIV_CHEM, city]]    : []),
                ])
                : [];
            return shouldBuyUpgrade(c, name, { paybackHours: 48, warehouseCheck })
                ? currentLevel + 1
                : currentLevel;
        } catch { return staticTarget; }
    }
    function getPrivateStageAdvertTarget(stageName, div) {
        const targets = PRIVATE_STAGE_TARGETS[stageName];
        if (!targets || div !== C.DIV_TOBACCO)
            return 0;
        return targets.tobAdvert;
    }
    function getPrivateStageOfficeJobs(div, city, size) {
        if (size <= 0)
            return { ops: 0, eng: 0, biz: 0, mgmt: 0, rnd: 0 };
        if (div === C.DIV_TOBACCO) {
            if (city === C.HQ_CITY) {
                const eng = Math.max(1, Math.floor(size * 0.40));
                const mgmt = Math.max(1, Math.floor(size * 0.25));
                const ops = Math.max(1, Math.floor(size * 0.15));
                const biz = Math.max(1, Math.floor(size * 0.10));
                const rnd = Math.max(0, size - eng - mgmt - ops - biz);
                return { ops, eng, biz, mgmt, rnd };
            }
            const rnd = Math.max(1, Math.floor(size * 0.80));
            const eng = Math.max(1, Math.floor(size * 0.10));
            const ops = Math.max(0, size - rnd - eng);
            return { ops, eng, biz: 0, mgmt: 0, rnd };
        }
        const eng = Math.max(1, Math.floor(size * 0.40));
        const ops = Math.max(1, Math.floor(size * 0.30));
        const mgmt = Math.max(1, Math.floor(size * 0.15));
        const rnd = Math.max(1, Math.floor(size * 0.10));
        const biz = Math.max(0, size - eng - ops - mgmt - rnd);
        return { ops, eng, biz, mgmt, rnd };
    }
    function keepPrivateStageJobsCurrent(stageName) {
        for (const div of [C.DIV_AGRI, C.DIV_CHEM, C.DIV_TOBACCO]) {
            if (!hasDiv(div))
                continue;
            for (const city of C.CITIES) {
                try {
                    const office = c.getOffice(div, city);
                    const targetSize = Math.max(Number(office.size ?? 0), getPrivateStageOfficeTarget(stageName, div, city));
                    if ((office.numEmployees ?? 0) > 0) {
                        assignJobs(div, city, getPrivateStageOfficeJobs(div, city, Math.max(targetSize, office.numEmployees ?? 0)));
                    }
                }
                catch { }
            }
        }
    }
    function getPrivateStageMissing(stageName, { deferTa2 = false } = {}) {
        const targets = PRIVATE_STAGE_TARGETS[stageName];
        if (!targets)
            return [];
        const missing = [];
        const corp = c.getCorporation();
        if ((corp.revenue ?? 0) - (corp.expenses ?? 0) <= 0)
            missing.push('profit>0');
        const requireTa2 = !(deferTa2 && stageName === C.PRIVATE_STAGE_POST_R3);
        if (requireTa2 && !hasRes(C.DIV_TOBACCO, 'Market-TA.II'))
            missing.push('TA2');
        for (const upg of ['Smart Factories', 'Smart Storage', 'ABC SalesBots', 'Wilson Analytics']) {
            const target = getPrivateStageUpgradeTarget(stageName, upg);
            if (target > 0 && c.getUpgradeLevel(upg) < target) {
                const short = upg === 'Smart Factories' ? 'SF'
                    : upg === 'Smart Storage' ? 'SS'
                        : upg === 'ABC SalesBots' ? 'SalesBots'
                            : 'Wilson';
                missing.push(`${short}${target}`);
            }
        }
        if (c.getHireAdVertCount(C.DIV_TOBACCO) < getPrivateStageAdvertTarget(stageName, C.DIV_TOBACCO)) {
            missing.push(`TobAdv${targets.tobAdvert}`);
        }
        for (const div of [C.DIV_AGRI, C.DIV_CHEM, C.DIV_TOBACCO]) {
            for (const city of C.CITIES) {
                const officeTarget = getPrivateStageOfficeTarget(stageName, div, city);
                const officeLabel = getPrivateStageOfficeMissingLabel(div, city, targets);
                const warehouseLabel = getPrivateStageWarehouseMissingLabel(div, targets);
                try {
                    if ((c.getOffice(div, city).size ?? 0) < officeTarget) {
                        addUniqueMissingLabel(missing, officeLabel);
                    }
                }
                catch {
                    addUniqueMissingLabel(missing, officeLabel);
                }
                try {
                    if ((c.getWarehouse(div, city).level ?? 0) < targets.warehouse) {
                        addUniqueMissingLabel(missing, warehouseLabel);
                    }
                }
                catch {
                    addUniqueMissingLabel(missing, warehouseLabel);
                }
            }
        }
        return missing;
    }
    function addUniqueMissingLabel(missing, label) {
        if (!missing.includes(label))
            missing.push(label);
    }
    function getPrivateStageOfficeMissingLabel(div, city, targets) {
        if (div === C.DIV_AGRI)
            return `AgriOff${targets.agriOffice}`;
        if (div === C.DIV_CHEM)
            return `ChemOff${targets.chemOffice}`;
        return city === C.HQ_CITY ? `TobHQ${targets.tobHqOffice}` : `TobSup${targets.tobSupportOffice}`;
    }
    function getPrivateStageWarehouseMissingLabel(div, targets) {
        if (div === C.DIV_AGRI)
            return `AgriWh${targets.warehouse}`;
        if (div === C.DIV_CHEM)
            return `ChemWh${targets.warehouse}`;
        return `TobWh${targets.warehouse}`;
    }
    function isPrivateStageReady(stageName, options = {}) {
        return getPrivateStageMissing(stageName, options).length === 0;
    }
    function tryPrivateStageUpgrade(stageName, name, reserve) {
        const target = getPrivateStageUpgradeTarget(stageName, name);
        return tryPrivateStageUpgradeToTarget(name, target, reserve);
    }
    function tryPrivateStageUpgradeToTarget(name, target, reserve) {
        if (target <= 0)
            return null;
        const level = c.getUpgradeLevel(name);
        if (level >= target)
            return null;
        const cost = c.getUpgradeLevelCost(name);
        if (!canSpend(cost, reserve))
            return null;
        c.levelUpgrade(name);
        return `${name} -> ${level + 1}`;
    }
    function tryPrivateStageEmployeeUpgrade(stageName, reserve) {
        for (const name of C.ROUND2_BN3_LATE_EMPLOYEE_UPGRADES) {
            if (!shouldBuyUpgrade(c, name, { paybackHours: 48 }))
                continue;
            const level = c.getUpgradeLevel(name);
            const cost = c.getUpgradeLevelCost(name);
            if (!canSpend(cost, reserve))
                continue;
            c.levelUpgrade(name);
            return `${name} -> ${level + 1}`;
        }
        return null;
    }
    function tryPrivateStageAdvert(stageName, reserve) {
        const target = getPrivateStageAdvertTarget(stageName, C.DIV_TOBACCO);
        return tryPrivateStageAdvertToTarget(target, reserve);
    }
    function tryPrivateStageAdvertToTarget(target, reserve) {
        const count = c.getHireAdVertCount(C.DIV_TOBACCO);
        if (count >= target)
            return null;
        const cost = c.getHireAdVertCost(C.DIV_TOBACCO);
        if (!canSpend(cost, reserve))
            return null;
        c.hireAdVert(C.DIV_TOBACCO);
        return `Tobacco advert -> ${count + 1}`;
    }
    function tryPrivateStageWarehouse(div, city, targetLevel, reserve) {
        const wh = c.getWarehouse(div, city);
        if ((wh.level ?? 0) >= targetLevel)
            return null;
        const cost = c.getUpgradeWarehouseCost(div, city, 1);
        if (!canSpend(cost, reserve))
            return null;
        c.upgradeWarehouse(div, city, 1);
        return `${div} ${city} warehouse -> ${(wh.level ?? 0) + 1}`;
    }
    function hirePrivateStageOfficeEmployees(div, city, currentEmployees, targetSize) {
        for (let i = currentEmployees; i < targetSize; i++)
            c.hireEmployee(div, city, C.JOBS.unassigned);
        assignJobs(div, city, getPrivateStageOfficeJobs(div, city, targetSize));
    }
    function tryPrivateStageOffice(stageName, div, city, reserve) {
        const office = c.getOffice(div, city);
        const target = getPrivateStageOfficeTarget(stageName, div, city);
        return tryPrivateStageOfficeToTarget(div, city, target, reserve, office);
    }
    function tryPrivateStageOfficeToTarget(div, city, target, reserve, officeOverride = null) {
        const office = officeOverride ?? c.getOffice(div, city);
        const officeSize = office.size ?? 0;
        const employeeCount = office.numEmployees ?? 0;
        if (officeSize < target) {
            const increase = Math.min(C.PRIVATE_STAGE_OFFICE_STEP, target - officeSize);
            const cost = c.getOfficeSizeUpgradeCost(div, city, increase);
            if (!canSpend(cost, reserve))
                return null;
            c.upgradeOfficeSize(div, city, increase);
            const nextSize = officeSize + increase;
            hirePrivateStageOfficeEmployees(div, city, employeeCount, nextSize);
            return `${div} ${city} office -> ${nextSize}`;
        }
        if (employeeCount < officeSize) {
            hirePrivateStageOfficeEmployees(div, city, employeeCount, officeSize);
            return `${div} ${city} hired to ${officeSize}`;
        }
        assignJobs(div, city, getPrivateStageOfficeJobs(div, city, officeSize));
        return null;
    }
    function getPrivateStageSpareFunds(reserve) {
        return Math.max(0, Number(c.getCorporation().funds ?? 0) - Number(reserve ?? 0));
    }
    function getPrivateStageEarlyBurstLimit(stageName, reserve, offerFunds, threshold, missing, readyChecks = 0) {
        const maxActions = C.PRIVATE_STAGE_EARLY_BURST_ACTIONS[stageName] ?? 1;
        if (maxActions <= 1)
            return 1;
        if ((missing?.length ?? 0) <= 0)
            return 1;
        if ((readyChecks ?? 0) > 0)
            return 1;
        const spareFunds = getPrivateStageSpareFunds(reserve);
        const spareTrigger = C.PRIVATE_STAGE_EARLY_BURST_SPARE_FUNDS[stageName] ?? Infinity;
        if (spareFunds >= spareTrigger)
            return maxActions;
        const offer = Math.max(0, Number(offerFunds ?? 0));
        if (!Number.isFinite(threshold) || threshold <= 0)
            return 1;
        if (offer < threshold * C.PRIVATE_STAGE_EARLY_BURST_THRESHOLD_RATIO)
            return maxActions;
        return 1;
    }
    function shouldUsePrivateStageSurplusPush(stageName, reserve, offerFunds, bestOffer, threshold) {
        if (stageName !== C.PRIVATE_STAGE_POST_R3)
            return false;
        if (!isPrivateStageReady(stageName, { deferTa2: true }))
            return false;
        if (getPrivateStageSpareFunds(reserve) >= R3.PRIVATE_STAGE_POST_R3_OVERFLOW_SURPLUS_FUNDS)
            return true;
        const offer = Math.max(0, Number(offerFunds ?? 0));
        const bestSeen = Math.max(0, Number(bestOffer ?? 0), offer);
        if (bestSeen <= 0)
            return false;
        const spendThreshold = getPrivateStageSpendingThreshold(stageName, threshold);
        if (!Number.isFinite(spendThreshold) || spendThreshold <= 0)
            return false;
        if (offer < spendThreshold * C.PRIVATE_STAGE_SURPLUS_PUSH_THRESHOLD_RATIO)
            return false;
        if (offer < bestSeen * C.PRIVATE_STAGE_SURPLUS_PUSH_NEAR_BEST_RATIO)
            return false;
        return getPrivateStageSpareFunds(reserve) >= C.PRIVATE_STAGE_SURPLUS_PUSH_FUNDS_TRIGGER;
    }
    function shouldUsePrivateStageStretch(stageName, offerFunds, bestOffer, threshold, stagnantChecks) {
        const stretch = PRIVATE_STAGE_STRETCH_TARGETS[stageName];
        if (!stretch)
            return false;
        if (!isPrivateStageReady(stageName, { deferTa2: stageName === C.PRIVATE_STAGE_POST_R3 }))
            return false;
        if (stageName === C.PRIVATE_STAGE_POST_R3 &&
            getPrivateStageSpareFunds(getPrivateStageReserve(stageName)) >= R3.PRIVATE_STAGE_POST_R3_OVERFLOW_STRETCH_FUNDS) {
            return true;
        }
        const offer = Math.max(0, Number(offerFunds ?? 0));
        if (stagnantChecks >= C.PRIVATE_STAGE_STRETCH_MAX_STAGNATION)
            return false;
        const bestSeen = Math.max(0, Number(bestOffer ?? 0), offer);
        if (bestSeen <= 0)
            return false;
        const spendThreshold = getPrivateStageSpendingThreshold(stageName, threshold);
        if (Number.isFinite(spendThreshold) && spendThreshold > 0) {
            const thresholdGate = spendThreshold * C.PRIVATE_STAGE_STRETCH_THRESHOLD_RATIO;
            if (bestSeen < thresholdGate && offer < thresholdGate)
                return false;
        }
        return offer >= bestSeen * C.PRIVATE_STAGE_STRETCH_NEAR_BEST_RATIO;
    }
    function tryPrivateStageStretchStep(stageName, reserve, offerFunds, bestOffer, threshold, stagnantChecks) {
        const stretch = PRIVATE_STAGE_STRETCH_TARGETS[stageName];
        if (!stretch)
            return null;
        if (!shouldUsePrivateStageStretch(stageName, offerFunds, bestOffer, threshold, stagnantChecks))
            return null;
        // Follows the BN3 guide's late private priorities in bounded form:
        // Wilson when in reach, employee upgrades, then HQ office +15 or AdVert,
        // whichever is cheaper.
        const wilsonLevel = c.getUpgradeLevel('Wilson Analytics');
        if (wilsonLevel < (stretch.wilson ?? 0)) {
            const cost = c.getUpgradeLevelCost('Wilson Analytics');
            if (canSpend(cost, reserve)) {
                c.levelUpgrade('Wilson Analytics');
                return `Stretch Wilson Analytics -> ${wilsonLevel + 1}`;
            }
        }
        const employeeTarget = Math.max(0, Number(stretch.employeeUpgrades ?? 0));
        if (employeeTarget > 0) {
            for (const name of C.ROUND2_BN3_LATE_EMPLOYEE_UPGRADES) {
                const level = c.getUpgradeLevel(name);
                if (level >= employeeTarget)
                    continue;
                const cost = c.getUpgradeLevelCost(name);
                if (!canSpend(cost, reserve))
                    continue;
                c.levelUpgrade(name);
                return `Stretch ${name} -> ${level + 1}`;
            }
        }
        let advertOption = null;
        const advertTarget = Math.max(0, Number(stretch.tobAdvert ?? 0));
        const advertCount = c.getHireAdVertCount(C.DIV_TOBACCO);
        if (advertCount < advertTarget) {
            const cost = c.getHireAdVertCost(C.DIV_TOBACCO);
            if (canSpend(cost, reserve)) {
                advertOption = {
                    cost,
                    perform: () => {
                        c.hireAdVert(C.DIV_TOBACCO);
                        return `Stretch Tobacco advert -> ${advertCount + 1}`;
                    },
                };
            }
        }
        let hqOption = null;
        const hqTarget = Math.max(0, Number(stretch.tobHqOffice ?? 0));
        try {
            const office = c.getOffice(C.DIV_TOBACCO, C.HQ_CITY);
            const officeSize = Number(office.size ?? 0);
            const employeeCount = Number(office.numEmployees ?? 0);
            // Beyond the fixed stretch target: keep expanding one step at a time as long
            // as Tobacco warehouse has headroom (< 70% full) and profit is >= $50m/s.
            // The existing stretch gate (spare >= $150b) still applies as the financial guard.
            let effectiveTarget = hqTarget;
            if (officeSize >= hqTarget) {
                const corp = c.getCorporation();
                const profit = Number(corp.revenue ?? 0) - Number(corp.expenses ?? 0);
                let maxWhUsage = 0;
                for (const city of C.CITIES) {
                    try {
                        if (!c.hasWarehouse(C.DIV_TOBACCO, city)) continue;
                        const wh = c.getWarehouse(C.DIV_TOBACCO, city);
                        maxWhUsage = Math.max(maxWhUsage, Number(wh.sizeUsed ?? 0) / Math.max(Number(wh.size ?? 1), 1));
                    } catch { }
                }
                if (profit >= 50e6 && maxWhUsage < 0.70)
                    effectiveTarget = officeSize + C.PRIVATE_STAGE_STRETCH_HQ_STEP;
            }
            if (officeSize < effectiveTarget) {
                const nextSize = Math.min(effectiveTarget, officeSize + C.PRIVATE_STAGE_STRETCH_HQ_STEP);
                const cost = c.getOfficeSizeUpgradeCost(C.DIV_TOBACCO, C.HQ_CITY, nextSize - officeSize);
                if (canSpend(cost, reserve)) {
                    hqOption = {
                        cost,
                        perform: () => {
                            c.upgradeOfficeSize(C.DIV_TOBACCO, C.HQ_CITY, nextSize - officeSize);
                            hirePrivateStageOfficeEmployees(C.DIV_TOBACCO, C.HQ_CITY, employeeCount, nextSize);
                            return `Stretch ${C.DIV_TOBACCO} ${C.HQ_CITY} office -> ${nextSize}`;
                        },
                    };
                }
            }
        }
        catch { }
        if (hqOption && advertOption) {
            return hqOption.cost <= advertOption.cost ? hqOption.perform() : advertOption.perform();
        }
        if (hqOption)
            return hqOption.perform();
        if (advertOption)
            return advertOption.perform();
        // Scale support cities in stretch same budget gate as the HQ expansion.
        const supportTarget = Math.max(0, Number(stretch.tobSupportOffice ?? 0));
        if (supportTarget > 0) {
            for (const city of C.CITIES.filter((city) => city !== C.HQ_CITY)) {
                const action = tryPrivateStageOfficeToTarget(C.DIV_TOBACCO, city, supportTarget, reserve);
                if (action)
                    return `Stretch ${action}`;
            }
        }
        const agriStretchTarget = Math.max(0, Number(stretch.agriOffice ?? 0));
        if (agriStretchTarget > 0) {
            for (const city of C.CITIES) {
                const action = tryPrivateStageOfficeToTarget(C.DIV_AGRI, city, agriStretchTarget, reserve);
                if (action)
                    return `Stretch ${action}`;
            }
        }
        const chemStretchTarget = Math.max(0, Number(stretch.chemOffice ?? 0));
        if (chemStretchTarget > 0) {
            for (const city of C.CITIES) {
                const action = tryPrivateStageOfficeToTarget(C.DIV_CHEM, city, chemStretchTarget, reserve);
                if (action)
                    return `Stretch ${action}`;
            }
        }
        return null;
    }
    function tryPrivateStageSurplusPushStep(stageName, reserve, offerFunds, bestOffer, threshold) {
        if (!shouldUsePrivateStageSurplusPush(stageName, reserve, offerFunds, bestOffer, threshold))
            return null;
        const nextStageTargets = PRIVATE_STAGE_TARGETS[C.PRIVATE_STAGE_PRE_IPO];
        const nextStageStretch = PRIVATE_STAGE_STRETCH_TARGETS[C.PRIVATE_STAGE_PRE_IPO] ?? {};
        if (!nextStageTargets)
            return null;
        const wilsonTarget = Math.max(Number(nextStageTargets.wilson ?? 0), Number(nextStageStretch.wilson ?? 0));
        const wilsonAction = tryPrivateStageUpgradeToTarget('Wilson Analytics', wilsonTarget, reserve);
        if (wilsonAction)
            return `Surplus ${wilsonAction}`;
        const employeeTarget = Math.max(0, Number(nextStageStretch.employeeUpgrades ?? 0));
        if (employeeTarget > 0) {
            for (const name of C.ROUND2_BN3_LATE_EMPLOYEE_UPGRADES) {
                const action = tryPrivateStageUpgradeToTarget(name, employeeTarget, reserve);
                if (action)
                    return `Surplus ${action}`;
            }
        }
        let advertOption = null;
        const advertTarget = Math.max(Number(nextStageTargets.tobAdvert ?? 0), Number(nextStageStretch.tobAdvert ?? 0));
        const advertCount = c.getHireAdVertCount(C.DIV_TOBACCO);
        if (advertCount < advertTarget) {
            const cost = c.getHireAdVertCost(C.DIV_TOBACCO);
            if (canSpend(cost, reserve)) {
                advertOption = {
                    cost,
                    perform: () => {
                        c.hireAdVert(C.DIV_TOBACCO);
                        return `Surplus Tobacco advert -> ${advertCount + 1}`;
                    },
                };
            }
        }
        let hqOption = null;
        const hqTarget = Math.max(Number(nextStageTargets.tobHqOffice ?? 0), Number(nextStageStretch.tobHqOffice ?? 0));
        try {
            const office = c.getOffice(C.DIV_TOBACCO, C.HQ_CITY);
            const officeSize = Number(office.size ?? 0);
            const employeeCount = Number(office.numEmployees ?? 0);
            if (officeSize < hqTarget) {
                const nextSize = Math.min(hqTarget, officeSize + C.PRIVATE_STAGE_STRETCH_HQ_STEP);
                const cost = c.getOfficeSizeUpgradeCost(C.DIV_TOBACCO, C.HQ_CITY, nextSize - officeSize);
                if (canSpend(cost, reserve)) {
                    hqOption = {
                        cost,
                        perform: () => {
                            c.upgradeOfficeSize(C.DIV_TOBACCO, C.HQ_CITY, nextSize - officeSize);
                            hirePrivateStageOfficeEmployees(C.DIV_TOBACCO, C.HQ_CITY, employeeCount, nextSize);
                            return `Surplus ${C.DIV_TOBACCO} ${C.HQ_CITY} office -> ${nextSize}`;
                        },
                    };
                }
            }
        }
        catch { }
        if (hqOption && advertOption) {
            return hqOption.cost <= advertOption.cost ? hqOption.perform() : advertOption.perform();
        }
        if (hqOption)
            return hqOption.perform();
        if (advertOption)
            return advertOption.perform();
        for (const name of C.PRIVATE_STAGE_POST_ADVERT_UPGRADES) {
            const target = name === 'Smart Factories' ? nextStageTargets.smartFactories
                : name === 'Smart Storage' ? nextStageTargets.smartStorage
                    : nextStageTargets.salesBots;
            const action = tryPrivateStageUpgradeToTarget(name, target, reserve);
            if (action)
                return `Surplus ${action}`;
        }
        for (const div of [C.DIV_AGRI, C.DIV_CHEM, C.DIV_TOBACCO]) {
            for (const city of C.CITIES) {
                const action = tryPrivateStageWarehouse(div, city, nextStageTargets.warehouse, reserve);
                if (action)
                    return `Surplus ${action}`;
            }
        }
        const supportTarget = Math.max(Number(nextStageTargets.tobSupportOffice ?? 0), Number(nextStageStretch.tobSupportOffice ?? 0));
        const agriSurplusTarget = Math.max(Number(nextStageTargets.agriOffice ?? 0), Number(nextStageStretch.agriOffice ?? 0));
        const chemSurplusTarget = Math.max(Number(nextStageTargets.chemOffice ?? 0), Number(nextStageStretch.chemOffice ?? 0));
        const officePlans = [
            { div: C.DIV_TOBACCO, cities: [C.HQ_CITY], target: hqTarget },
            { div: C.DIV_TOBACCO, cities: C.CITIES.filter((city) => city !== C.HQ_CITY), target: supportTarget },
            { div: C.DIV_AGRI, cities: C.CITIES, target: agriSurplusTarget },
            { div: C.DIV_CHEM, cities: C.CITIES, target: chemSurplusTarget },
        ];
        for (const { div, cities, target } of officePlans) {
            for (const city of cities) {
                const action = tryPrivateStageOfficeToTarget(div, city, target, reserve);
                if (action)
                    return `Surplus ${action}`;
            }
        }
        return null;
    }
    function getMinOfficeSize(div, cities) {
        let minSize = Infinity;
        for (const city of cities) {
            try {
                minSize = Math.min(minSize, Number(c.getOffice(div, city).size ?? 0));
            }
            catch {
                return 0;
            }
        }
        return Number.isFinite(minSize) ? minSize : 0;
    }
    function getMinWarehouseLevel(div) {
        let minLevel = Infinity;
        for (const city of C.CITIES) {
            try {
                minLevel = Math.min(minLevel, Number(c.getWarehouse(div, city).level ?? 0));
            }
            catch {
                return 0;
            }
        }
        return Number.isFinite(minLevel) ? minLevel : 0;
    }
    function getPrivateStageStagnantNeed(currentOffer, bestOffer) {
        const offer = Math.max(0, Number(currentOffer ?? 0));
        const best = Math.max(0, Number(bestOffer ?? 0));
        const floor = Math.max(1e9, best * 0.0025);
        return Math.max(0, (best + floor) - offer);
    }
    function getPrivateStageDebugTargets(stageName, surplusPush = false) {
        if (surplusPush && stageName === C.PRIVATE_STAGE_POST_R3) {
            return {
                stage: PRIVATE_STAGE_TARGETS[C.PRIVATE_STAGE_PRE_IPO],
                stretch: PRIVATE_STAGE_STRETCH_TARGETS[C.PRIVATE_STAGE_PRE_IPO] ?? {},
                label: 'pre-ipo-surplus',
            };
        }
        return {
            stage: PRIVATE_STAGE_TARGETS[stageName],
            stretch: PRIVATE_STAGE_STRETCH_TARGETS[stageName] ?? {},
            label: stageName,
        };
    }
    function formatPrivateStageDebug(stageName, corp, offerFunds, bestOffer, bestReadyOffer, threshold, reserve, missing, readyChecks, stagnantChecks, options = {}) {
        const deferTa2 = !!options.deferTa2;
        const stretchReady = shouldUsePrivateStageStretch(stageName, offerFunds, bestOffer, threshold, stagnantChecks);
        const surplusPush = shouldUsePrivateStageSurplusPush(stageName, reserve, offerFunds, bestOffer, threshold);
        const burstLimit = getPrivateStageEarlyBurstLimit(stageName, reserve, offerFunds, threshold, missing, readyChecks);
        const targets = getPrivateStageDebugTargets(stageName, surplusPush);
        const stageTargets = targets.stage ?? {};
        const stretchTargets = targets.stretch ?? {};
        const activeWilsonTarget = Math.max(Number(stageTargets.wilson ?? 0), Number(stretchTargets.wilson ?? 0));
        const activeAdvertTarget = Math.max(Number(stageTargets.tobAdvert ?? 0), Number(stretchTargets.tobAdvert ?? 0));
        const activeHqTarget = Math.max(Number(stageTargets.tobHqOffice ?? 0), Number(stretchTargets.tobHqOffice ?? 0));
        const shortfall = Math.max(0, Number(threshold ?? 0) - Number(offerFunds ?? 0));
        const profit = Number(corp.revenue ?? 0) - Number(corp.expenses ?? 0);
        return formatRound2Debug({
            stage: targets.label,
            reserve: formatMoney(reserve),
            funds: formatMoney(corp.funds ?? 0),
            rev: formatMoney(corp.revenue ?? 0),
            exp: formatMoney(corp.expenses ?? 0),
            profit: formatMoney(profit),
            offer: formatMoney(offerFunds ?? 0),
            best: formatMoney(bestOffer ?? 0),
            readyBest: formatMoney(bestReadyOffer ?? 0),
            threshold: formatMoney(threshold ?? 0),
            short: formatMoney(shortfall),
            ready: `${readyChecks}/${C.PRIVATE_STAGE_ACCEPT_READY_CHECKS}`,
            missing: missing?.join(',') || 'none',
            ta2: hasRes(C.DIV_TOBACCO, 'Market-TA.II') ? 'yes' : 'no',
            deferTA2: deferTa2 ? 'yes' : 'no',
            stagnant: stagnantChecks,
            stagnantNeed: formatMoney(getPrivateStageStagnantNeed(offerFunds, bestOffer)),
            spare: formatMoney(getPrivateStageSpareFunds(reserve)),
            stretch: stretchReady ? 'on' : 'off',
            surplusPush: surplusPush ? 'on' : 'off',
            burst: `${burstLimit}x`,
            sf: `${c.getUpgradeLevel('Smart Factories')}/${stageTargets.smartFactories ?? 0}`,
            ss: `${c.getUpgradeLevel('Smart Storage')}/${stageTargets.smartStorage ?? 0}`,
            salesBots: `${c.getUpgradeLevel('ABC SalesBots')}/${stageTargets.salesBots ?? 0}`,
            wilson: `${c.getUpgradeLevel('Wilson Analytics')}/${activeWilsonTarget}`,
            tobAdv: `${c.getHireAdVertCount(C.DIV_TOBACCO)}/${activeAdvertTarget}`,
            tobHQ: `${getMinOfficeSize(C.DIV_TOBACCO, [C.HQ_CITY])}/${activeHqTarget}`,
            tobSup: `${getMinOfficeSize(C.DIV_TOBACCO, C.CITIES.filter((city) => city !== C.HQ_CITY))}/${stageTargets.tobSupportOffice ?? 0}`,
            agriOff: `${getMinOfficeSize(C.DIV_AGRI, C.CITIES)}/${stageTargets.agriOffice ?? 0}`,
            chemOff: `${getMinOfficeSize(C.DIV_CHEM, C.CITIES)}/${stageTargets.chemOffice ?? 0}`,
            wh: `${Math.min(getMinWarehouseLevel(C.DIV_AGRI), getMinWarehouseLevel(C.DIV_CHEM), getMinWarehouseLevel(C.DIV_TOBACCO))}/${stageTargets.warehouse ?? 0}`,
        });
    }
    async function maintainPrivateInvestmentState(stageName, bestOffer = 0) {
        if (c.hasUnlock(C.UNLOCKS.smartSupply)) {
            stopRound1AgriSupply();
            stopChemicalWaterSupply();
            enableSmartSupply(C.DIV_AGRI);
            enableSmartSupply(C.DIV_CHEM);
            enableSmartSupply(C.DIV_TOBACCO);
        }
        configureExports();
        // Sell Agri output to market — must run every tick or warehouses fill and production halts.
        if (hasDiv(C.DIV_AGRI)) {
            for (const city of C.CITIES) {
                try { c.sellMaterial(C.DIV_AGRI, city, 'Food', 'MAX', 'MP'); } catch { }
                try { c.sellMaterial(C.DIV_AGRI, city, 'Plants', 'MAX', 'MP'); } catch { }
            }
        }
        maintainChemTobPlantRelief();
        maintainChemicalsRelief();
        boostMorale(C.DIV_TOBACCO, C.DIV_AGRI, C.DIV_CHEM);
        tryResearch(C.DIV_TOBACCO, C.TOB_RESEARCH);
        tryResearch(C.DIV_AGRI, C.MAT_RESEARCH);
        tryResearch(C.DIV_CHEM, C.MAT_RESEARCH);
        keepPrivateStageJobsCurrent(stageName);
        priceProducts();
        ensureTobaccoProduct(Math.max(getPrivateStageReserve(stageName), getBn3LeanTobaccoProductReserve(getPrivateStageReserve(stageName))), bestOffer);
        await refreshBoosts(C.DIV_AGRI, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);
        await refreshBoosts(C.DIV_CHEM, CHEM_BOOST.factors, CHEM_BOOST.sizes, CHEM_BOOST.mats);
        await refreshBoosts(C.DIV_TOBACCO, TOB_BOOST.factors, TOB_BOOST.sizes, TOB_BOOST.mats);
    }
    function tryPrivateStageScalingStep(stageName, reserve, stretchState = null) {
        const targets = PRIVATE_STAGE_TARGETS[stageName];
        if (!targets)
            return null;
        const supportCities = C.CITIES.filter((city) => city !== C.HQ_CITY);
        const tobaccoCities = [C.HQ_CITY, ...supportCities];
        const warehousePlans = [
            { div: C.DIV_TOBACCO, cities: tobaccoCities, targetLevel: targets.warehouse },
            { div: C.DIV_AGRI, cities: C.CITIES, targetLevel: targets.warehouse },
            { div: C.DIV_CHEM, cities: C.CITIES, targetLevel: targets.warehouse },
        ];
        const officePlans = [
            { div: C.DIV_TOBACCO, cities: tobaccoCities },
            { div: C.DIV_AGRI, cities: C.CITIES },
            { div: C.DIV_CHEM, cities: C.CITIES },
        ];
        for (const name of C.PRIVATE_STAGE_PRE_ADVERT_UPGRADES) {
            const action = tryPrivateStageUpgrade(stageName, name, reserve);
            if (action)
                return action;
        }
        const advertAction = tryPrivateStageAdvert(stageName, reserve);
        if (advertAction)
            return advertAction;
        for (const name of C.PRIVATE_STAGE_POST_ADVERT_UPGRADES) {
            const action = tryPrivateStageUpgrade(stageName, name, reserve);
            if (action)
                return action;
        }
        const employeeAction = tryPrivateStageEmployeeUpgrade(stageName, reserve);
        if (employeeAction)
            return employeeAction;
        for (const { div, cities, targetLevel } of warehousePlans) {
            for (const city of cities) {
                const action = tryPrivateStageWarehouse(div, city, targetLevel, reserve);
                if (action)
                    return action;
            }
        }
        for (const { div, cities } of officePlans) {
            for (const city of cities) {
                const action = tryPrivateStageOffice(stageName, div, city, reserve);
                if (action)
                    return action;
            }
        }
        if (stretchState) {
            const action = tryPrivateStageStretchStep(stageName, reserve, stretchState.offerFunds, stretchState.bestOffer, stretchState.threshold, stretchState.stagnantChecks);
            if (action)
                return action;
        }
        if (stretchState) {
            const action = tryPrivateStageSurplusPushStep(stageName, reserve, stretchState.offerFunds, stretchState.bestOffer, stretchState.threshold);
            if (action)
                return action;
        }
        return null;
    }
    function runPrivateStageScalingBatch(stageName, stretchState = null, maxActions = 1) {
        const reserve = getPrivateStageReserve(stageName);
        const actions = [];
        const batchLimit = Math.max(1, Math.floor(Number(maxActions ?? 1) || 1));
        for (let i = 0; i < batchLimit; i++) {
            const action = tryPrivateStageScalingStep(stageName, reserve, stretchState);
            if (!action)
                break;
            actions.push(action);
        }
        keepPrivateStageJobsCurrent(stageName);
        return { actions, reserve };
    }
    function logPrivateStageActions(actionLabel, actions, reserve) {
        for (const action of actions) {
            log(ns, `  ${actionLabel}: ${action} (reserve ${formatMoney(reserve)})`, false);
        }
    }
    function maybeLogPrivateFundingWait(round, waitChecks, missing, lastMissing, scaling, threshold, offerFunds, corp) {
        if (waitChecks % C.PRIVATE_STAGE_WAIT_LOG_INTERVAL !== 0)
            return lastMissing;
        const missingSig = missing.join(',') || 'none';
        if (missingSig === lastMissing && scaling.actions.length > 0)
            return lastMissing;
        const profit = (corp.revenue ?? 0) - (corp.expenses ?? 0);
        const shortfall = Math.max(0, (threshold ?? Infinity) - (offerFunds ?? 0));
        const eta = formatEta(estimateFundsWaitSeconds(shortfall, 0, profit));
        log(ns, `  Round ${round} wait: missing=${missingSig} reserve=${formatMoney(scaling.reserve)} ` +
            `threshold=${formatMoney(threshold ?? 0)} short=${formatMoney(shortfall)} ETA=${eta}`, false);
        return missingSig;
    }
    function updatePrivateStageStagnation(currentOffer, previousBest, stagnantChecks) {
        const offer = Math.max(0, Number(currentOffer ?? 0));
        const best = Math.max(0, Number(previousBest ?? 0));
        const improvementFloor = Math.max(1e9, best * 0.0025);
        if (offer > best + improvementFloor)
            return 0;
        return stagnantChecks + 1;
    }
    function shouldAcceptPrivateOffer({ offerFunds, bestOffer, readyBestOffer, threshold, missing, readyChecks, stagnantChecks, actionsTaken }) {
        if (actionsTaken > 0)
            return false;
        if ((missing?.length ?? 0) > 0)
            return false;
        if (!Number.isFinite(threshold) || offerFunds < threshold)
            return false;
        if (readyChecks < C.PRIVATE_STAGE_ACCEPT_READY_CHECKS)
            return false;
        const readyBest = Math.max(0, Number(readyBestOffer ?? 0));
        const baselineBest = readyBest > 0 ? readyBest : Math.max(0, Number(bestOffer ?? 0));
        const bestSeen = Math.max(baselineBest, Number(offerFunds ?? 0));
        if (bestSeen <= 0)
            return true;
        if (offerFunds >= bestSeen * C.PRIVATE_STAGE_ACCEPT_NEAR_BEST_RATIO)
            return true;
        if (stagnantChecks >= C.PRIVATE_STAGE_ACCEPT_STAGNATION && offerFunds >= bestSeen * C.PRIVATE_STAGE_ACCEPT_DECAY_RATIO)
            return true;
        return false;
    }
    async function waitForPrivateFundingRound(round) {
        const config = C.PRIVATE_FUNDING_ROUND_CONFIG[round];
        if (!config)
            throw new Error(`Unsupported private funding round: ${round}`);
        let bestOffer = 0;
        let bestReadyOffer = 0;
        let waitChecks = 0;
        let readyChecks = 0;
        let stagnantChecks = 0;
        let lastMissing = '';
        while (true) {
            await waitCycles(1);
            const offer = c.getInvestmentOffer();
            const previousBestOffer = bestOffer;
            bestOffer = Math.max(bestOffer, offer.funds ?? 0);
            stagnantChecks = updatePrivateStageStagnation(offer.funds, previousBestOffer, stagnantChecks);
            await maintainPrivateInvestmentState(config.stageName, bestOffer);
            const corp = c.getCorporation();
            const threshold = getPrivateOfferThreshold(round, corp.funds ?? 0, corp.revenue ?? 0, useIncomeMode());
            const preScaleMissing = getPrivateStageMissing(config.stageName, { deferTa2: round === 3 });
            const scalingMaxActions = getPrivateStageEarlyBurstLimit(config.stageName, getPrivateStageReserve(config.stageName), offer.funds ?? 0, threshold, preScaleMissing, readyChecks);
            const scaling = runPrivateStageScalingBatch(config.stageName, {
                offerFunds: offer.funds ?? 0,
                bestOffer,
                threshold,
                stagnantChecks,
            }, scalingMaxActions);
            logPrivateStageActions(config.actionLabel, scaling.actions, scaling.reserve);
            const missing = getPrivateStageMissing(config.stageName, { deferTa2: round === 3 });
            const stageReady = missing.length === 0 && scaling.actions.length === 0;
            if (stageReady) {
                readyChecks++;
                bestReadyOffer = Math.max(bestReadyOffer, offer.funds ?? 0);
            }
            else {
                readyChecks = 0;
                bestReadyOffer = 0;
            }
            // One-shot spike fill: fire as soon as the stage is ready to give the
            // offer a cycle to absorb the full boost mats before we accept.
            if (missing.length === 0 && !privateStageSpikeFired[config.stageName]) {
                await tryPrivateStageSpikeRefresh(config.stageName);
            }
            log(ns, `  Round ${offer.round} offer: ${formatMoney(offer.funds)} (best ${formatMoney(bestOffer)})`, false);
            log(ns, `  Round ${offer.round} debug: ${formatPrivateStageDebug(config.stageName, corp, offer.funds ?? 0, bestOffer, bestReadyOffer, threshold, scaling.reserve, missing, readyChecks, stagnantChecks, { deferTa2: round === 3 })}`, false);
            if ((offer.round ?? 0) > round) {
                log(ns, `INFO: ${config.acceptedLabel} already accepted.`, true, 'info');
                break;
            }
            if ((offer.round ?? 0) === round && shouldAcceptPrivateOffer({
                offerFunds: offer.funds ?? 0,
                bestOffer,
                readyBestOffer: bestReadyOffer,
                threshold,
                missing,
                readyChecks,
                stagnantChecks,
                actionsTaken: scaling.actions.length,
            })) {
                c.acceptInvestmentOffer();
                log(ns, `INFO: Accepted ${config.acceptedLabel} - received ${formatMoney(offer.funds)} ` +
                    `(threshold ${formatMoney(threshold)}).`, true, 'success');
                break;
            }
            waitChecks++;
            lastMissing = maybeLogPrivateFundingWait(round, waitChecks, missing, lastMissing, scaling, threshold, offer.funds ?? 0, corp);
        }
    }
    // 
    // PHASE 5 Final scaling before autopilot handoff
    // 
    if (phase <= 5) {
        log(ns, 'INFO: Phase 5 - post-round-2 ramp...', true);
        let idleRampChecks = 0;
        while (!isPostRound2BootstrapReady()) {
            await waitCycles(1);
            boostMorale(C.DIV_TOBACCO, C.DIV_AGRI, C.DIV_CHEM);
            if (c.hasUnlock(C.UNLOCKS.smartSupply)) {
                stopRound1AgriSupply();
                stopChemicalWaterSupply();
                enableSmartSupply(C.DIV_AGRI);
                enableSmartSupply(C.DIV_CHEM);
                enableSmartSupply(C.DIV_TOBACCO);
            }
            configureExports();
            const actions = runPostRound2BootstrapBatch();
            if (actions.length > 0) {
                idleRampChecks = 0;
                for (const { action, reserve } of actions) {
                    log(ns, `  Post-round-2 ramp: ${action} (reserve ${formatMoney(reserve)})`, false);
                }
            }
            else {
                idleRampChecks++;
                if (idleRampChecks % 5 === 0) {
                    log(ns, `  Post-round-2 ramp: waiting (reserve ${formatMoney(getPostRound2BootstrapReserve())})`, false);
                }
            }
        }
        await waitCycles(1);
        writePhase(6);
        phase = 6;
    }
    if (phase <= 6) {
        log(ns, 'INFO: Phase 6 final scaling pass...', true);
        if (!hasDiv(C.DIV_CHEM)) {
            while (!hasDiv(C.DIV_CHEM)) {
                const chemCost = expandIndustryCost(C.IND_CHEM);
                if (c.getCorporation().funds >= chemCost) {
                    c.expandIndustry(C.IND_CHEM, C.DIV_CHEM);
                    log(ns, 'INFO: Chemical launched.', true, 'success');
                    break;
                }
                log(ns, `  Waiting for Chemical: ${formatMoney(c.getCorporation().funds)} / ${formatMoney(chemCost)}`, false);
                await waitCycles(2);
            }
        }
        await waitForDivisionInfrastructure(C.DIV_CHEM, 'Chemical');
        if (!hasDiv(C.DIV_TOBACCO)) {
            while (!hasDiv(C.DIV_TOBACCO)) {
                const tobCost = expandIndustryCost(C.IND_TOBACCO);
                if (c.getCorporation().funds >= tobCost) {
                    c.expandIndustry(C.IND_TOBACCO, C.DIV_TOBACCO);
                    log(ns, 'INFO: Tobacco launched.', true, 'success');
                    break;
                }
                log(ns, `  Waiting for Tobacco: ${formatMoney(c.getCorporation().funds)} / ${formatMoney(tobCost)}`, false);
                await waitCycles(2);
            }
        }
        await waitForDivisionInfrastructure(C.DIV_TOBACCO, 'Tobacco');
        if (!c.hasUnlock(C.UNLOCKS.export))
            buyUnlock(C.UNLOCKS.export);
        if (!c.hasUnlock(C.UNLOCKS.smartSupply))
            buyUnlock(C.UNLOCKS.smartSupply);
        if (c.hasUnlock(C.UNLOCKS.smartSupply)) {
            stopRound1AgriSupply();
            stopChemicalWaterSupply();
            enableSmartSupply(C.DIV_AGRI);
            enableSmartSupply(C.DIV_CHEM);
            enableSmartSupply(C.DIV_TOBACCO);
        }
        configureExports();
        for (const city of C.CITIES) {
            const isHQ = city === C.HQ_CITY;
            // HQ: product dev focus. Satellites: R&D-heavy (80% in R&D).
            fillOffice(C.DIV_TOBACCO, city, isHQ ? 30 : 20, isHQ
                ? { ops: 5, eng: 11, biz: 2, mgmt: 9, rnd: 3 }
                : { ops: 1, eng: 2, biz: 0, mgmt: 1, rnd: 16 });
            // Agriculture: Engineer-heavy for material quality.
            fillOffice(C.DIV_AGRI, city, 20, { ops: 6, eng: 8, biz: 1, mgmt: 3, rnd: 2 });
            // Chemical: small and Engineer-heavy don't over-invest (docs).
            fillOffice(C.DIV_CHEM, city, 9, { ops: 1, eng: 5, biz: 0, mgmt: 1, rnd: 2 });
        }
        for (const div of [C.DIV_TOBACCO, C.DIV_AGRI, C.DIV_CHEM])
            for (const city of C.CITIES)
                try {
                    const wh = c.getWarehouse(div, city);
                    if (wh.level < 6)
                        c.upgradeWarehouse(div, city, 6 - wh.level);
                }
                catch { }
        boostMorale(C.DIV_TOBACCO, C.DIV_AGRI, C.DIV_CHEM);
        // Top up boosts using Lagrange-optimal targets for the post-upgrade warehouse size.
        log(ns, 'INFO: Topping up boost materials...', true);
        for (const city of C.CITIES) {
            await applyBoostMaterials(C.DIV_TOBACCO, city, getBoostTargets(C.DIV_TOBACCO, city, TOB_BOOST.factors, TOB_BOOST.sizes, TOB_BOOST.mats));
            await applyBoostMaterials(C.DIV_AGRI, city, getBoostTargets(C.DIV_AGRI, city, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats));
            await applyBoostMaterials(C.DIV_CHEM, city, getBoostTargets(C.DIV_CHEM, city, CHEM_BOOST.factors, CHEM_BOOST.sizes, CHEM_BOOST.mats));
        }
        writePhase(7);
        phase = 7;
    }
    //  Handoff 
    if (phase <= 7) {
        log(ns, 'INFO: Phase 7 - waiting for round 3...', true);
        await waitForPrivateFundingRound(3);
        await waitCycles(1);
        const nextPrivatePhase = useRound4Path() ? 8 : 9;
        if (useRound4Path()) {
            log(ns, 'INFO: Round-4 route enabled - continuing the private scaling path before IPO.', true, 'info');
        }
        else {
            log(ns, 'INFO: Ownership-max route active - skipping round 4 and preparing to IPO after round 3.', true, 'info');
        }
        writePhase(nextPrivatePhase);
        phase = nextPrivatePhase;
    }
    if (phase <= 8 && useRound4Path()) {
        log(ns, 'INFO: Phase 8 - post-round-3 scaling and round-4 push...', true);
        await waitForPrivateFundingRound(4);
        await waitCycles(1);
        writePhase(9);
        phase = 9;
    }
    if (phase <= 9) {
        const ipoStageName = useRound4Path() ? C.PRIVATE_STAGE_PRE_IPO : C.PRIVATE_STAGE_POST_R3;
        const ipoStageLabel = useRound4Path() ? 'pre-IPO scaling' : 'round-3 IPO prep';
        const ipoActionLabel = useRound4Path() ? 'Pre-IPO scaling' : 'Round-3 IPO prep';
        log(ns, `INFO: Phase 9 - ${ipoStageLabel}...`, true);
        let preIpoChecks = 0;
        let lastPreIpoMissing = '';
        while (!corpIsPublic()) {
            await waitCycles(1);
            const corp = c.getCorporation();
            const offer = c.getInvestmentOffer();
            await maintainPrivateInvestmentState(ipoStageName, offer?.funds ?? 0);
            const scaling = runPrivateStageScalingBatch(ipoStageName);
            for (const action of scaling.actions) {
                log(ns, `  ${ipoActionLabel}: ${action} (reserve ${formatMoney(scaling.reserve)})`, false);
            }
            const missing = getPrivateStageMissing(ipoStageName);
            if (missing.length === 0 && c.goPublic(0)) {
                log(ns, 'INFO: Went public with 0 issued shares.', true, 'success');
                break;
            }
            preIpoChecks++;
            if (preIpoChecks % C.PRIVATE_STAGE_WAIT_LOG_INTERVAL === 0) {
                const missingSig = missing.join(',') || 'none';
                if (missingSig !== lastPreIpoMissing || scaling.actions.length === 0) {
                    lastPreIpoMissing = missingSig;
                    log(ns, `  ${ipoActionLabel} wait: missing=${missingSig} reserve=${formatMoney(scaling.reserve)} profit=${formatMoney((corp.revenue ?? 0) - (corp.expenses ?? 0))}/s`, false);
                }
            }
        }
        await waitCycles(1);
        writePhase(10);
        phase = 10;
    }
    ns.write(C.SETUP_DONE_FLAG, 'true', 'w');
    log(ns, '------------------------------------------------------------', true);
    log(ns, 'INFO: Setup complete! Corporation is public; handing off to corp-autopilot.js.', true, 'success');
    if (useIncomeMode())
        log(ns, 'INFO: Income mode enabled for corp-autopilot handoff.', true);
    log(ns, '------------------------------------------------------------', true);
    const PILOT = resolvePath('corp-autopilot', 'corp-autopilot.js');
    const pilotArgs = useIncomeMode() ? ['--income-mode'] : [];
    try {
        if (!ns.ps('home').some(p => p.filename === PILOT))
            ns.run(PILOT, 1, ...pilotArgs);
    }
    catch {
        ns.run(PILOT, 1, ...pilotArgs);
    }
}
