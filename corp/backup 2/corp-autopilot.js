import {
    clamp,
    formatEta,
    estimateFundsWaitSeconds,
    combineRelativeGains,
} from "/corp/corp-optimizer-shared.js";

/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["no-tail",   false],
        ["income-mode", false],
        ["debug",     false],
    ]);

    ns.disableLog("ALL");
    if (!flags["no-tail"]) { try { ns.tail(); } catch {} }
    try { ns.clearLog(); } catch {}

    const api = ns.corporation;
    const incomeMode = !!flags["income-mode"];

    const SNAPSHOT_FILE = "/Temp/dashboard-corp.txt";
    const UPDATE_MS     = 5000;

    // ── Division names ────────────────────────────────────────────────────────
    const HQ_CITY = "Sector-12"; // Must match corp-setup.js — Tobacco HQ was created here
    const AGRI    = "Agriculture";
    const CHEM    = "Chemical";    // Support div: Agri↔Chem quality loop
    const TOB     = "Tobacco";
    const CITIES  = ["Aevum","Chongqing","Sector-12","New Tokyo","Ishima","Volhaven"];

    // ── Job names — exact CorpEmployeeJob enum values ─────────────────────────
    const JOBS = {
        ops:        "Operations",
        eng:        "Engineer",
        biz:        "Business",
        mgmt:       "Management",
        rnd:        "Research & Development",
        unassigned: "Unassigned",
    };

    // ── Upgrade names — exact CorpUpgradeName enum VALUES (not keys) ──────────
    // The game's nsGetMember matches on the enum VALUE, e.g. "Smart Storage",
    // not the key "SmartStorage".  Using wrong names silently failed all upgrades.
    const U = {
        smartStorage:   "Smart Storage",
        smartFactories: "Smart Factories",
        salesBots:      "ABC SalesBots",
        nootropic:      "Nuoptimal Nootropic Injector Implants",
        speech:         "Speech Processor Implants",
        neural:         "Neural Accelerators",
        focusWires:     "FocusWires",          // No space — unusual but correct
        wilson:         "Wilson Analytics",
        insight:        "Project Insight",
    };
    const DYNAMIC_ADVERTISING_FACTOR = 0.2;
    const DYNAMIC_DIVISION_WEIGHTS = { [AGRI]: 0.55, [CHEM]: 0.18, [TOB]: 1.0 };
    const DYNAMIC_EMPLOYEE_UPGRADES = [U.focusWires, U.neural, U.speech, U.nootropic];
    const DYNAMIC_WAIT_HORIZON_SEC = 180;
    const DYNAMIC_PACKAGE_MAX = 3;
    const DYNAMIC_WAIT_EDGE = 1.12;
    const AUTO_INCOME_ENTRY_REVENUE = 5e11;
    const AUTO_INCOME_EXIT_REVENUE = 1e11;
    const AUTO_INCOME_ENTRY_FUNDS = 1e11;
    const AUTO_INCOME_EXIT_FUNDS = 2e10;
    const AUTO_INCOME_ENTRY_MARGIN = 0.35;
    const AUTO_INCOME_EXIT_MARGIN = 0.20;
    const AUTO_INCOME_ENTRY_OWNERSHIP = 0.70;
    const AUTO_INCOME_EXIT_OWNERSHIP = 0.55;

    // Wilson is handled separately (must be bought BEFORE Advert; it's not retroactive).
    // Everything else is in the normal table.
    const NORMAL_UPGRADES = [
        { name: U.smartStorage,   maxLevel: Infinity, spendMult: 4 },
        { name: U.smartFactories, maxLevel: Infinity, spendMult: 4 },
        { name: U.salesBots,      maxLevel: Infinity, spendMult: 4 },
        { name: U.nootropic,      maxLevel: Infinity, spendMult: 5 },
        { name: U.neural,         maxLevel: Infinity, spendMult: 5 },
        { name: U.focusWires,     maxLevel: Infinity, spendMult: 5 },
        { name: U.speech,         maxLevel: Infinity, spendMult: 5 },
        { name: U.insight,        maxLevel: 20,       spendMult: 8 },
        // Wilson NOT here — see manageWilsonAndAdverts()
    ];

    // ── Research queues — per official documentation ──────────────────────────
    // NEVER BUY: AutoBrew, AutoPartyManager (docs: "useless — spend RP elsewhere")
    // SKIP:      uPgrade: Capacity.I/II ("not useful in most cases")
    // RULE:      only buy if cost < 50% of RP pool (don't deplete before product finishes)
    // ORDER:     Overclock → Sti.mu → Automatic Drug Administration → Go-Juice → CPH4

    const MAT_RESEARCH = [
        "Hi-Tech R&D Laboratory",        // +10% RP gain; prerequisite for everything
        "Drones",                         // prerequisite for Assembly/Transport
        "Drones - Assembly",              // +20% production  [buy only if < 10% of RP]
        "Self-Correcting Assemblers",     // +10% production  [buy only if < 10% of RP]
        "Drones - Transport",             // +50% storage
        "Overclock",                      // +25% int/eff; prerequisite for Sti.mu
        "Sti.mu",                         // +max morale
        "Automatic Drug Administration",  // prerequisite for Go-Juice + CPH4
        "Go-Juice",                       // +max energy
        "CPH4 Injections",                // +10% all employee stats
    ];

    const TOB_RESEARCH = [
        "Hi-Tech R&D Laboratory",
        "Market-TA.I",                    // Useless alone, required as prerequisite
        "Market-TA.II",                   // Top priority — enables optimal pricing
        "uPgrade: Fulcrum",               // +5% product production
        "Drones",
        "Drones - Assembly",
        "Self-Correcting Assemblers",
        "Drones - Transport",
        "Overclock",
        "Sti.mu",
        "Automatic Drug Administration",
        "Go-Juice",
        "CPH4 Injections",
        // Intentionally excluded: AutoBrew, AutoPartyManager, Capacity.I, Capacity.II
    ];

    // ── Per-research RP thresholds ────────────────────────────────────────────
    // Production researches should not be bought until RP pool is large (10% rule).
    // Other researches use the standard 50% rule.
    const PRODUCTION_RESEARCH = new Set([
        "Drones - Assembly",
        "Self-Correcting Assemblers",
        "uPgrade: Fulcrum",
    ]);

    const DEBUG_STATUS_INTERVAL = 6;
    const BUYBACK_RESERVE = 100e9;
    const BUYBACK_RESERVE_PCT = 0.35;
    const BUYBACK_MIN_SHARES = 1e6;
    const PRE_IPO_SMART_FACTORIES_TARGET = 16;
    const PRE_IPO_SMART_STORAGE_TARGET = 18;
    const PRE_IPO_SALES_BOTS_TARGET = 10;
    const PRE_IPO_WILSON_TARGET = 4;
    const PRE_IPO_TOB_ADVERT_TARGET = 6;
    const PRE_IPO_WAREHOUSE_TARGET = 10;
    const PRE_IPO_AGRI_OFFICE_TARGET = 30;
    const PRE_IPO_TOB_HQ_OFFICE_TARGET = 60;
    const PRE_IPO_TOB_SUPPORT_OFFICE_TARGET = 45;
    const PRE_IPO_CHEM_OFFICE_TARGET = 15;
    const BOOST_MATS = ["Real Estate", "Hardware", "Robots", "AI Cores"];
    const BOOST_SPACE_RATIO = { [AGRI]: 0.70, [CHEM]: 0.70, [TOB]: 0.70 };
    const FALLBACK_BOOST_FACTORS = {
        [AGRI]: [0.72, 0.20, 0.30, 0.30],
        [CHEM]: [0.25, 0.20, 0.25, 0.20],
        [TOB]:  [0.15, 0.15, 0.20, 0.15],
    };
    const FALLBACK_BOOST_SIZES = [0.005, 0.06, 0.5, 0.1];

    // ── State ─────────────────────────────────────────────────────────────────
    const state = {
        lastDividendRate: -1,
        nextProductSeq:   1,
        exportsSetUp:     false,
        agriRpReady:      false,     // true once Agri RP >= 55 in round 1
        loopCount:        0,
        lastStatusSig:    "",
        seenFinishedProducts: {},
        stalledProductSales: {},
        lastOwnershipNotice: "",
        lastDynamicNotice: "",
        lastDynamicStatus: "",
        lastModeNotice:   "",
        economicMode:     "growth",
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    const safe = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

    const getCorp    = ()         => safe(() => api.getCorporation(), null);
    const getDivision= (n)        => safe(() => api.getDivision(n), null);
    const getOffice  = (d,c)      => safe(() => api.getOffice(d,c), null);
    const getWarehouse=(d,c)      => safe(() => api.getWarehouse(d,c), null);
    const hasUnlock  = (n)        => safe(() => api.hasUnlock(n), false);
    const hasRes     = (d,r)      => safe(() => api.hasResearched(d,r), false);
    const resCost    = (d,r)      => safe(() => api.getResearchCost(d,r), Infinity);

    function optimalBoosts(space, factors, sizes, names) {
        const c = [...factors], s = [...sizes], n = [...names];
        while (c.length) {
            const csum = c.reduce((a, b) => a + b, 0);
            const qtys = c.map((ci, j) => {
                const otherCoeff = csum - ci;
                const otherSizes = s.reduce((a, sk, k) => (k !== j ? a + sk : a), 0);
                return (space - 500 * ((s[j] / ci) * otherCoeff - otherSizes)) / (csum / ci) / s[j];
            });
            const negative = qtys.reduce((w, v, i) => (v < 0 && (w === -1 || v < qtys[w]) ? i : w), -1);
            if (negative === -1) return Object.fromEntries(n.map((name, i) => [name, Math.floor(qtys[i])]));
            c.splice(negative, 1);
            s.splice(negative, 1);
            n.splice(negative, 1);
        }
        return {};
    }

    function getBoostConfig(divName) {
        const industry = divName === AGRI
            ? "Agriculture"
            : divName === CHEM
                ? "Chemical"
                : divName === TOB
                    ? "Tobacco"
                    : null;
        if (!industry) return null;

        const data = safe(() => api.getIndustryData(industry), null);
        const fallbackFactors = FALLBACK_BOOST_FACTORS[divName];
        const factors = [
            data?.realEstateFactor ?? fallbackFactors[0],
            data?.hardwareFactor ?? fallbackFactors[1],
            data?.robotFactor ?? fallbackFactors[2],
            data?.aiCoreFactor ?? fallbackFactors[3],
        ];
        const sizes = BOOST_MATS.map((mat, i) => safe(() => api.getMaterialData(mat).size, FALLBACK_BOOST_SIZES[i]));
        return { factors, sizes, mats: [...BOOST_MATS] };
    }

    function getBoostTargets(divName, city) {
        const config = getBoostConfig(divName);
        const wh = getWarehouse(divName, city);
        if (!config || !wh) return {};
        const space = (wh.size ?? 0) * (BOOST_SPACE_RATIO[divName] ?? 0.70);
        return optimalBoosts(space, config.factors, config.sizes, config.mats);
    }

    function applyBoostMaterials(divName, city) {
        const targets = getBoostTargets(divName, city);
        let changed = false;
        for (const [mat, target] of Object.entries(targets)) {
            const stored = safe(() => api.getMaterial(divName, city, mat).stored, 0);
            const needed = Math.max(0, target - stored);
            if (needed > 1) {
                safe(() => api.buyMaterial(divName, city, mat, needed / 10));
                changed = true;
            } else {
                safe(() => api.buyMaterial(divName, city, mat, 0));
            }
        }
        return changed;
    }

    function stopBoostMaterialBuys(divName) {
        const div = getDivision(divName);
        if (!div) return;
        for (const city of div.cities ?? []) {
            for (const mat of BOOST_MATS) {
                safe(() => api.buyMaterial(divName, city, mat, 0));
            }
        }
    }

    function refreshBoostMaterials(divName, corp) {
        const div = getDivision(divName);
        if (!div || !hasUnlock("Warehouse API")) return;
        if (divName === AGRI && !state.agriRpReady) return;
        if (spendingRecoveryMode(corp)) {
            stopBoostMaterialBuys(divName);
            return false;
        }
        let changed = false;
        for (const city of div.cities ?? []) {
            const wh = getWarehouse(divName, city);
            if (!wh) continue;
            changed = applyBoostMaterials(divName, city) || changed;
        }
        return changed;
    }

    function log(msg) { ns.print(msg); }
    function debug(msg) { if (flags["debug"]) log(`[debug] ${msg}`); }

    function money(n) {
        const abs = Math.abs(n);
        if (abs >= 1e15) return `$${(n/1e15).toFixed(3)}q`;
        if (abs >= 1e12) return `$${(n/1e12).toFixed(3)}T`;
        if (abs >= 1e9)  return `$${(n/1e9).toFixed(3)}B`;
        if (abs >= 1e6)  return `$${(n/1e6).toFixed(3)}M`;
        return `$${n.toFixed(0)}`;
    }

    function operatingProfit(corp) { return (corp?.revenue ?? 0) - (corp?.expenses ?? 0); }
    function recoveryMode(corp) { return (corp?.funds ?? 0) < 0; }
    function spendingRecoveryMode(corp) { return recoveryMode(corp) || operatingProfit(corp) < 0; }

    function isPublic(corp) { return !!(corp?.public); }
    function getTotalShares(corp) { return Math.max(0, Number(corp?.totalShares ?? 0)); }
    function getOwnedShares(corp) { return Math.max(0, Number(corp?.numShares ?? 0)); }
    function getIssuedShares(corp) {
        const issued = Number(corp?.issuedShares ?? NaN);
        if (Number.isFinite(issued) && issued >= 0) return issued;
        const total = getTotalShares(corp);
        const owned = getOwnedShares(corp);
        return Math.max(0, total - owned);
    }
    function getOwnershipPct(corp) {
        const total = getTotalShares(corp);
        return total > 0 ? getOwnedShares(corp) / total : 0;
    }
    function buybackSharePrice(corp) {
        const price = Number(corp?.sharePrice ?? 0);
        return price > 0 ? price * 1.1 : Infinity;
    }
    function getBuybackReserve(corp) {
        const funds = corp?.funds ?? 0;
        return Math.max(BUYBACK_RESERVE, funds * BUYBACK_RESERVE_PCT);
    }
    function formatShares(n) {
        return Number.isFinite(n) ? Math.floor(n).toLocaleString("en-US") : "0";
    }
    function getFundingStage(corp) {
        return isPublic(corp) ? "public" : null;
    }

    function getStageTargets(corp) {
        if (!isPublic(corp)) return null;
        const revenue = corp?.revenue ?? 0;
        if (revenue < 1e12) {
            return {
                smartFactories: PRE_IPO_SMART_FACTORIES_TARGET,
                smartStorage: PRE_IPO_SMART_STORAGE_TARGET,
                salesBots: PRE_IPO_SALES_BOTS_TARGET,
                wilson: PRE_IPO_WILSON_TARGET,
                tobAdvert: PRE_IPO_TOB_ADVERT_TARGET,
                warehouse: PRE_IPO_WAREHOUSE_TARGET,
                agriOffice: PRE_IPO_AGRI_OFFICE_TARGET,
                tobHqOffice: PRE_IPO_TOB_HQ_OFFICE_TARGET,
                tobSupportOffice: PRE_IPO_TOB_SUPPORT_OFFICE_TARGET,
                chemOffice: PRE_IPO_CHEM_OFFICE_TARGET,
            };
        }
        if (revenue < 1e13) {
            return {
                smartFactories: 18,
                smartStorage: 20,
                salesBots: 12,
                wilson: 5,
                tobAdvert: 8,
                warehouse: 12,
                agriOffice: 36,
                tobHqOffice: 75,
                tobSupportOffice: 54,
                chemOffice: 18,
            };
        }
        if (revenue < 1e14) {
            return {
                smartFactories: 22,
                smartStorage: 24,
                salesBots: 16,
                wilson: 8,
                tobAdvert: 12,
                warehouse: 16,
                agriOffice: 48,
                tobHqOffice: 120,
                tobSupportOffice: 75,
                chemOffice: 24,
            };
        }
        return {
            smartFactories: 28,
            smartStorage: 30,
            salesBots: 24,
            wilson: 12,
            tobAdvert: 18,
            warehouse: 20,
            agriOffice: 60,
            tobHqOffice: 180,
            tobSupportOffice: 105,
            chemOffice: 30,
        };
    }

    function minOfficeSize(divName) {
        const div = getDivision(divName);
        if (!div) return { hq: 0, support: 0 };
        let hq = 0;
        let support = Infinity;
        for (const city of CITIES) {
            if (!(div.cities ?? []).includes(city)) return { hq, support: 0 };
            const size = getOffice(divName, city)?.size ?? 0;
            if (city === HQ_CITY) hq = size;
            else support = Math.min(support, size);
        }
        return { hq, support: support === Infinity ? 0 : support };
    }

    function minWarehouseLevel(divName) {
        const div = getDivision(divName);
        if (!div) return 0;
        let min = Infinity;
        for (const city of CITIES) {
            if (!(div.cities ?? []).includes(city)) return 0;
            const level = getWarehouse(divName, city)?.level ?? 0;
            min = Math.min(min, level);
        }
        return min === Infinity ? 0 : min;
    }

    function getStageMinOfficeTarget(divName, city, corp) {
        const targets = getStageTargets(corp);
        if (!targets) return 0;
        if (divName === AGRI) return targets.agriOffice;
        if (divName === TOB) return city === HQ_CITY ? targets.tobHqOffice : targets.tobSupportOffice;
        if (divName === CHEM) return targets.chemOffice;
        return 0;
    }

    function getWarehouseTargetLevel(divName, corp) {
        const targets = getStageTargets(corp);
        return targets?.warehouse ?? 1;
    }

    function getStageUpgradeTarget(upgradeName, corp) {
        const targets = getStageTargets(corp);
        if (!targets) return 0;
        if (upgradeName === U.smartFactories) return targets.smartFactories;
        if (upgradeName === U.smartStorage) return targets.smartStorage;
        if (upgradeName === U.salesBots) return targets.salesBots;
        if (upgradeName === U.wilson) return targets.wilson;
        return 0;
    }

    function getStageAdvertTarget(divName, corp) {
        const targets = getStageTargets(corp);
        if (!targets || divName !== TOB) return 0;
        return targets.tobAdvert;
    }

    function getStageMissing(corp, stageName = getFundingStage(corp)) {
        const targets = getStageTargets(corp);
        if (!targets || stageName !== "public") return [];
        const missing = [];
        if (operatingProfit(corp) <= 0) missing.push("profit>0");
        if ((safe(() => api.getUpgradeLevel(U.smartFactories), 0)) < targets.smartFactories) missing.push(`SF${targets.smartFactories}`);
        if ((safe(() => api.getUpgradeLevel(U.smartStorage), 0)) < targets.smartStorage) missing.push(`SS${targets.smartStorage}`);
        if ((safe(() => api.getUpgradeLevel(U.salesBots), 0)) < targets.salesBots) missing.push(`SalesBots${targets.salesBots}`);
        if ((safe(() => api.getUpgradeLevel(U.wilson), 0)) < targets.wilson) missing.push(`Wilson${targets.wilson}`);
        if ((safe(() => api.getHireAdVertCount(TOB), 0)) < targets.tobAdvert) missing.push(`TobAdv${targets.tobAdvert}`);
        if (!hasRes(TOB, "Market-TA.II")) missing.push("TA2");
        if (minWarehouseLevel(AGRI) < targets.warehouse) missing.push(`AgriWh${targets.warehouse}`);
        if (minWarehouseLevel(TOB) < targets.warehouse) missing.push(`TobWh${targets.warehouse}`);
        if (minWarehouseLevel(CHEM) < targets.warehouse) missing.push(`ChemWh${targets.warehouse}`);
        const agri = minOfficeSize(AGRI);
        const tob = minOfficeSize(TOB);
        const chem = minOfficeSize(CHEM);
        if (agri.hq < targets.agriOffice || agri.support < targets.agriOffice) missing.push(`AgriOff${targets.agriOffice}`);
        if (tob.hq < targets.tobHqOffice) missing.push(`TobHQ${targets.tobHqOffice}`);
        if (tob.support < targets.tobSupportOffice) missing.push(`TobSup${targets.tobSupportOffice}`);
        if (chem.hq < targets.chemOffice || chem.support < targets.chemOffice) missing.push(`ChemOff${targets.chemOffice}`);
        return missing;
    }

    function hasIncomeReadinessBaseline() {
        if (!getDivision(TOB)) return false;
        const agri = minOfficeSize(AGRI);
        const tob = minOfficeSize(TOB);
        const chem = minOfficeSize(CHEM);
        return (
            safe(() => api.getUpgradeLevel(U.smartFactories), 0) >= PRE_IPO_SMART_FACTORIES_TARGET &&
            safe(() => api.getUpgradeLevel(U.smartStorage), 0) >= PRE_IPO_SMART_STORAGE_TARGET &&
            safe(() => api.getUpgradeLevel(U.salesBots), 0) >= PRE_IPO_SALES_BOTS_TARGET &&
            safe(() => api.getUpgradeLevel(U.wilson), 0) >= PRE_IPO_WILSON_TARGET &&
            safe(() => api.getHireAdVertCount(TOB), 0) >= PRE_IPO_TOB_ADVERT_TARGET &&
            hasRes(TOB, "Market-TA.II") &&
            minWarehouseLevel(AGRI) >= PRE_IPO_WAREHOUSE_TARGET &&
            minWarehouseLevel(TOB) >= PRE_IPO_WAREHOUSE_TARGET &&
            minWarehouseLevel(CHEM) >= PRE_IPO_WAREHOUSE_TARGET &&
            agri.hq >= PRE_IPO_AGRI_OFFICE_TARGET &&
            agri.support >= PRE_IPO_AGRI_OFFICE_TARGET &&
            tob.hq >= PRE_IPO_TOB_HQ_OFFICE_TARGET &&
            tob.support >= PRE_IPO_TOB_SUPPORT_OFFICE_TARGET &&
            chem.hq >= PRE_IPO_CHEM_OFFICE_TARGET &&
            chem.support >= PRE_IPO_CHEM_OFFICE_TARGET
        );
    }

    function shouldEnterAutoIncome(corp) {
        if (!isPublic(corp) || !hasIncomeReadinessBaseline()) return false;
        const revenue = corp?.revenue ?? 0;
        const profit = operatingProfit(corp);
        const funds = corp?.funds ?? 0;
        const margin = revenue > 0 ? profit / revenue : 0;
        if (profit <= 0) return false;
        if (revenue < AUTO_INCOME_ENTRY_REVENUE) return false;
        if (funds < AUTO_INCOME_ENTRY_FUNDS) return false;
        if (margin < AUTO_INCOME_ENTRY_MARGIN) return false;
        const issuedShares = getIssuedShares(corp);
        const ownership = getOwnershipPct(corp);
        if (issuedShares > 0 && ownership < AUTO_INCOME_ENTRY_OWNERSHIP) return false;
        return true;
    }

    function shouldExitAutoIncome(corp) {
        if (!isPublic(corp)) return true;
        const revenue = corp?.revenue ?? 0;
        const profit = operatingProfit(corp);
        const funds = corp?.funds ?? 0;
        const margin = revenue > 0 ? profit / revenue : 0;
        if (profit <= 0) return true;
        if (revenue < AUTO_INCOME_EXIT_REVENUE) return true;
        if (funds < AUTO_INCOME_EXIT_FUNDS) return true;
        if (margin < AUTO_INCOME_EXIT_MARGIN) return true;
        const issuedShares = getIssuedShares(corp);
        const ownership = getOwnershipPct(corp);
        if (issuedShares > 0 && ownership < AUTO_INCOME_EXIT_OWNERSHIP) return true;
        return false;
    }

    function getEconomicMode() {
        return state.economicMode;
    }

    function isIncomeStrategyActive() {
        return getEconomicMode() !== "growth";
    }

    function updateEconomicMode(corp) {
        let nextMode = "growth";
        if (isPublic(corp)) {
            if (incomeMode) {
                nextMode = "income-forced";
            } else if (state.economicMode === "income-auto") {
                nextMode = shouldExitAutoIncome(corp) ? "growth" : "income-auto";
            } else if (shouldEnterAutoIncome(corp)) {
                nextMode = "income-auto";
            }
        }

        if (nextMode !== state.economicMode) {
            state.economicMode = nextMode;
            if (nextMode === "income-forced") {
                log("Income mode override enabled: prioritizing payouts over additional public-stage growth.");
            } else if (nextMode === "income-auto") {
                log("Auto-income engaged: growth baseline is complete, so autopilot is now prioritizing payouts.");
            } else {
                log("Growth mode re-engaged: autopilot is prioritizing reinvestment again.");
            }
        }
        return state.economicMode;
    }

    function useDynamicOptimizer(corp) {
        if (recoveryMode(corp) || spendingRecoveryMode(corp)) return false;
        return isPublic(corp) && !!getDivision(TOB);
    }

    function getDynamicSpendingProfile(corp) {
        const funds = corp?.funds ?? 0;
        const revenue = corp?.revenue ?? 0;
        const expenses = corp?.expenses ?? 0;
        const profit = operatingProfit(corp);
        const margin = revenue > 0 ? profit / revenue : 0;
        const economicMode = getEconomicMode();
        let reserve = Math.max(5e9, funds * 0.08);

        if (profit < 0) {
            reserve = Math.max(reserve, Math.min(Math.max(expenses * 600, 5e9), Math.max(funds * 0.35, reserve)));
        } else if (margin < 0.20) {
            reserve = Math.max(reserve, Math.min(Math.max(expenses * 300, 3e9), Math.max(funds * 0.20, reserve)));
        } else {
            reserve = Math.max(reserve, Math.min(Math.max(expenses * 180, 2e9), Math.max(funds * 0.10, reserve)));
        }

        if (economicMode === "income-auto") {
            reserve = Math.max(reserve, 15e9, funds * 0.18);
        } else if (economicMode === "income-forced") {
            reserve = Math.max(reserve, 25e9, funds * 0.25);
        }

        const spendable = Math.max(0, funds - reserve);
        return { funds, revenue, expenses, profit, margin, reserve, spendable };
    }

    function getDynamicCashDragWeight(corp, profile = null) {
        const liveProfile = profile ?? getDynamicSpendingProfile(corp);
        return clamp(0.10 + (liveProfile.margin < 0.20 ? 0.05 : 0), 0.10, 0.18);
    }

    function getUpgradeMultiplierEstimate(name, level) {
        if (name === U.smartFactories) return 1 + level * 0.03;
        if (name === U.smartStorage) return 1 + level * 0.10;
        if (name === U.salesBots) return 1 + level * 0.01;
        if (name === U.wilson) return 1 + level * 0.005;
        if (name === U.insight) return 1 + level * 0.05;
        if (DYNAMIC_EMPLOYEE_UPGRADES.includes(name)) return 1 + level * 0.10;
        return 1;
    }

    function estimateOfficeProductivityFromJobs(opProd, engProd, mgmtProd, forProduct = false) {
        const total = opProd + engProd + mgmtProd;
        if (total <= 0) return 0;
        const mgmtFactor = 1 + mgmtProd / (1.2 * total);
        const prod = (Math.pow(Math.max(0, opProd), 0.4) + Math.pow(Math.max(0, engProd), 0.3)) * mgmtFactor;
        return (forProduct ? 0.5 : 1) * 0.05 * prod;
    }

    function calculateAdvertisingSalesFactor(awareness, popularity, advertisingFactor = DYNAMIC_ADVERTISING_FACTOR) {
        const safeAwareness = Math.max(0, awareness);
        const safePopularity = Math.max(0, popularity);
        const awarenessFac = Math.pow(safeAwareness + 1, advertisingFactor);
        const popularityFac = Math.pow(safePopularity + 1, advertisingFactor);
        const ratioFac = safeAwareness <= 0 ? 0.01 : Math.max((safePopularity + 0.001) / safeAwareness, 0.01);
        return Math.pow(awarenessFac * popularityFac * ratioFac, 0.85);
    }

    function simulateTobaccoAdvertFactorAfterPurchases(corp, additionalAdverts = 1, wilsonLevelOffset = 0, popularityRoll = 1.01) {
        const div = getDivision(TOB);
        if (!div) return 0;
        const advMult = getUpgradeMultiplierEstimate(U.wilson, safe(() => api.getUpgradeLevel(U.wilson), 0) + wilsonLevelOffset);
        let awareness = Number(div.awareness ?? 0);
        let popularity = Number(div.popularity ?? 0);
        const count = Math.max(0, Math.floor(Number(additionalAdverts ?? 0)));
        if (count <= 0) return calculateAdvertisingSalesFactor(awareness, popularity);
        for (let i = 0; i < count; i++) {
            awareness = (awareness + 3 * advMult) * (1.005 * advMult);
            popularity = (popularity + 1 * advMult) * (popularityRoll * advMult);
        }
        return calculateAdvertisingSalesFactor(awareness, popularity);
    }

    function estimateNextTobaccoAdvertRelativeGain(corp, wilsonLevelOffset = 0) {
        const current = simulateTobaccoAdvertFactorAfterPurchases(corp, 0, wilsonLevelOffset);
        const next = simulateTobaccoAdvertFactorAfterPurchases(corp, 1, wilsonLevelOffset);
        if (current <= 0) return next > 0 ? 1 : 0;
        return Math.max(0, next / current - 1);
    }

    function estimateWilsonRelativeGain(corp) {
        const remainingAdverts = Math.max(0, getStageAdvertTarget(TOB, corp) - safe(() => api.getHireAdVertCount(TOB), 0));
        if (remainingAdverts <= 0) return 0;
        const currentPlan = simulateTobaccoAdvertFactorAfterPurchases(corp, remainingAdverts, 0);
        const boostedPlan = simulateTobaccoAdvertFactorAfterPurchases(corp, remainingAdverts, 1);
        if (currentPlan <= 0) return boostedPlan > 0 ? 1 : 0;
        return Math.max(0, boostedPlan / currentPlan - 1);
    }

    function estimateStoredSalesRealization(stored, sell, marginalRelGain) {
        const currentSell = Math.max(0, Number(sell ?? 0));
        const marginalGain = Math.max(0, Number(marginalRelGain ?? 0));
        if (currentSell <= 0 || marginalGain <= 0) return 0;
        const availableSellPerSecond = Math.max(0, Number(stored ?? 0)) / 10;
        const extraPossible = Math.max(0, availableSellPerSecond - currentSell);
        const extraFromUpgrade = currentSell * marginalGain;
        if (extraFromUpgrade <= 0) return 0;
        return clamp(extraPossible / extraFromUpgrade, 0, 1);
    }

    function getDynamicAgriSalesFlow() {
        let stored = 0;
        let sell = 0;
        for (const city of CITIES) {
            for (const mat of ["Food", "Plants"]) {
                const info = safe(() => api.getMaterial(AGRI, city, mat), null);
                stored += Number(info?.stored ?? 0);
                sell += Number(info?.actualSellAmount ?? 0);
            }
        }
        return { stored, sell };
    }

    function getDynamicTobaccoSalesFlow() {
        const div = getDivision(TOB);
        if (!div) return { stored: 0, sell: 0 };
        let stored = 0;
        let sell = 0;
        for (const name of div.products ?? []) {
            const hqProduct = safe(() => api.getProduct(TOB, HQ_CITY, name), null);
            if (Number(hqProduct?.developmentProgress ?? 0) < 100) continue;
            for (const city of div.cities ?? []) {
                const info = safe(() => api.getProduct(TOB, city, name), null);
                stored += Number(info?.stored ?? 0);
                sell += Number(info?.actualSellAmount ?? 0);
            }
        }
        return { stored, sell };
    }

    function buildDynamicCandidate({ id, label, cost, relGain, perform, corp, profile = null, floor = null }) {
        if (!Number.isFinite(cost) || cost <= 0) return null;
        if (!Number.isFinite(relGain) || relGain <= 0) return null;
        const liveProfile = profile ?? getDynamicSpendingProfile(corp);
        const reserveFloor = Math.max(0, Number(floor ?? liveProfile?.reserve ?? 0));
        const requiredFunds = reserveFloor + cost;
        const shortfall = Math.max(0, requiredFunds - (liveProfile?.funds ?? 0));
        const waitSeconds = estimateFundsWaitSeconds(requiredFunds, liveProfile?.funds ?? 0, liveProfile?.profit ?? 0);
        const basis = Math.max(
            1,
            (liveProfile?.profit ?? 0) > 0 ? (liveProfile.profit * 300) : 0,
            liveProfile?.revenue ?? 0,
            liveProfile?.funds ?? 0,
        );
        const affordability = clamp(Math.max(liveProfile?.spendable ?? 0, 0) / cost, 0.50, 2.50);
        const grossValueGain = basis * relGain;
        const cashDrag = cost * getDynamicCashDragWeight(corp, liveProfile);
        const dragPenalty = grossValueGain > 0
            ? clamp(1 - cashDrag / grossValueGain, 0.05, 1)
            : 0.05;
        const baseScore = grossValueGain * dragPenalty * affordability / cost;
        const waitPenalty = waitSeconds <= 0
            ? 1
            : (Number.isFinite(waitSeconds) ? 1 / (1 + waitSeconds / DYNAMIC_WAIT_HORIZON_SEC) : 0);
        return {
            id,
            label,
            cost,
            floor: reserveFloor,
            requiredFunds,
            shortfall,
            waitSeconds,
            relGain,
            grossValueGain,
            cashDrag,
            score: baseScore,
            futureScore: baseScore * waitPenalty,
            affordable: shortfall <= 0,
            perform,
        };
    }

    function getDynamicAffordablePackage(candidates, startingFunds) {
        let funds = Math.max(0, Number(startingFunds ?? 0));
        let relGain = 0;
        let spent = 0;
        const picked = [];
        for (const candidate of candidates) {
            if (picked.length >= DYNAMIC_PACKAGE_MAX) break;
            if (funds - candidate.cost < candidate.floor) continue;
            picked.push(candidate);
            relGain = combineRelativeGains(relGain, candidate.relGain);
            spent += candidate.cost;
            funds -= candidate.cost;
        }
        return { picked, relGain, spent };
    }

    function chooseDynamicSpendDecision(candidates, profile) {
        const affordable = candidates
            .filter((candidate) => candidate.affordable)
            .sort((a, b) => b.score - a.score || b.relGain - a.relGain || a.cost - b.cost);
        const blocked = candidates
            .filter((candidate) => !candidate.affordable)
            .sort((a, b) => b.futureScore - a.futureScore || b.relGain - a.relGain || a.requiredFunds - b.requiredFunds);

        const bestAffordable = affordable[0] ?? null;
        const bestBlocked = blocked[0] ?? null;
        const packageNow = getDynamicAffordablePackage(affordable, profile.funds);

        if (!bestAffordable) return { mode: "wait", bestBlocked, packageNow };
        if (!bestBlocked) return { mode: "buy", candidate: bestAffordable, packageNow };

        const blockedSoon = Number.isFinite(bestBlocked.waitSeconds) && bestBlocked.waitSeconds <= DYNAMIC_WAIT_HORIZON_SEC;
        const blockedBeatsSingle = bestBlocked.futureScore > bestAffordable.score * DYNAMIC_WAIT_EDGE;
        const blockedBeatsPackage = bestBlocked.relGain > packageNow.relGain * DYNAMIC_WAIT_EDGE;
        if (blockedSoon && blockedBeatsSingle && blockedBeatsPackage) {
            return { mode: "wait", bestBlocked, packageNow, bestAffordable };
        }
        return { mode: "buy", candidate: bestAffordable, packageNow, bestBlocked };
    }

    function getDynamicSpendCandidates(corp) {
        if (!useDynamicOptimizer(corp)) return [];
        const candidates = [];
        const profile = getDynamicSpendingProfile(corp);
        const { funds, profit, margin } = profile;
        const throughputBias = margin < 0.45 ? 1.15 : 1.0;
        const dummyBias = clamp((margin / 0.35) * 0.9, 0.25, 1.1);

        for (const upg of [U.smartFactories, U.smartStorage, U.salesBots, U.insight, ...DYNAMIC_EMPLOYEE_UPGRADES]) {
            const target = Math.max(1, getStageUpgradeTarget(upg, corp));
            const level = safe(() => api.getUpgradeLevel(upg), 0);
            if (level >= target) continue;
            const cost = safe(() => api.getUpgradeLevelCost(upg), Infinity);
            let relGain = 0;
            if (upg === U.smartFactories) relGain = (0.03 / getUpgradeMultiplierEstimate(upg, level)) * throughputBias;
            else if (upg === U.smartStorage) relGain = (0.10 / getUpgradeMultiplierEstimate(upg, level)) * 0.8 * throughputBias;
            else if (upg === U.salesBots) {
                const marginalRelGain = 0.01 / getUpgradeMultiplierEstimate(upg, level);
                const agriFlow = getDynamicAgriSalesFlow();
                const tobFlow = getDynamicTobaccoSalesFlow();
                const agriWeight = DYNAMIC_DIVISION_WEIGHTS[AGRI] ?? 0;
                const tobWeight = DYNAMIC_DIVISION_WEIGHTS[TOB] ?? 0;
                const totalWeight = Math.max(agriWeight + tobWeight, 1);
                const realized =
                    (agriWeight * estimateStoredSalesRealization(agriFlow.stored, agriFlow.sell, marginalRelGain) +
                        tobWeight * estimateStoredSalesRealization(tobFlow.stored, tobFlow.sell, marginalRelGain)) /
                    totalWeight;
                relGain = marginalRelGain * realized * throughputBias;
            }
            else if (upg === U.insight) relGain = (0.05 / getUpgradeMultiplierEstimate(upg, level)) * 0.08;
            else relGain = (0.10 / getUpgradeMultiplierEstimate(upg, level)) * 0.12 * throughputBias;
            const candidate = buildDynamicCandidate({
                id: `upg-${upg}`,
                label: upg,
                cost,
                relGain,
                corp,
                profile,
                perform: () => safe(() => api.levelUpgrade(upg), false) !== false ? `${upg} -> ${safe(() => api.getUpgradeLevel(upg), level)}` : null,
            });
            if (candidate) candidates.push(candidate);
        }

        const wilsonTarget = Math.max(1, getStageUpgradeTarget(U.wilson, corp));
        const wilsonLevel = safe(() => api.getUpgradeLevel(U.wilson), 0);
        if (wilsonLevel < wilsonTarget) {
            const cost = safe(() => api.getUpgradeLevelCost(U.wilson), Infinity);
            const candidate = buildDynamicCandidate({
                id: 'wilson',
                label: U.wilson,
                cost,
                relGain: estimateWilsonRelativeGain(corp),
                corp,
                profile,
                perform: () => safe(() => api.levelUpgrade(U.wilson), false) !== false ? `${U.wilson} -> ${safe(() => api.getUpgradeLevel(U.wilson), wilsonLevel)}` : null,
            });
            if (candidate) candidates.push(candidate);
        }

        const tobAdvertTarget = getStageAdvertTarget(TOB, corp);
        const tobAdvertLevel = safe(() => api.getHireAdVertCount(TOB), 0);
        if (tobAdvertLevel < tobAdvertTarget) {
            const cost = safe(() => api.getHireAdVertCost(TOB), Infinity);
            const candidate = buildDynamicCandidate({
                id: 'tob-advert',
                label: 'Tobacco advert',
                cost,
                relGain: estimateNextTobaccoAdvertRelativeGain(corp, 0) * 0.55,
                corp,
                profile,
                perform: () => safe(() => api.hireAdVert(TOB), false) !== false ? `Tobacco advert -> ${safe(() => api.getHireAdVertCount(TOB), tobAdvertLevel)}` : null,
            });
            if (candidate) candidates.push(candidate);
        }

        for (const divName of [AGRI, CHEM, TOB]) {
            const div = getDivision(divName);
            if (!div) continue;
            for (const city of CITIES) {
                if (!(div.cities ?? []).includes(city)) {
                    const cityCost = 4e9;
                    const whCost = 5e9;
                    const relGain = (DYNAMIC_DIVISION_WEIGHTS[divName] ?? 0.2) * 0.10;
                    const candidate = buildDynamicCandidate({
                        id: `${divName}-${city}-expand`,
                        label: `${divName} ${city} city+warehouse`,
                        cost: cityCost + whCost,
                        relGain,
                        corp,
                        profile,
                        perform: () => {
                            safe(() => api.expandCity(divName, city));
                            safe(() => api.purchaseWarehouse(divName, city));
                            return `${divName} expanded to ${city}`;
                        },
                    });
                    if (candidate) candidates.push(candidate);
                    continue;
                }

                const wh = getWarehouse(divName, city);
                if (!wh) {
                    const cost = 5e9;
                    const relGain = (DYNAMIC_DIVISION_WEIGHTS[divName] ?? 0.2) * 0.08;
                    const candidate = buildDynamicCandidate({
                        id: `${divName}-${city}-warehouse`,
                        label: `${divName} ${city} warehouse`,
                        cost,
                        relGain,
                        corp,
                        profile,
                        perform: () => safe(() => api.purchaseWarehouse(divName, city), false) !== false ? `${divName} warehouse in ${city}` : null,
                    });
                    if (candidate) candidates.push(candidate);
                    continue;
                }

                const whTarget = getWarehouseTargetLevel(divName, corp);
                const usage = (wh.size ?? 0) > 0 ? (wh.sizeUsed ?? 0) / wh.size : 0;
                if ((wh.level ?? 0) < whTarget || usage > 0.80) {
                    const cost = safe(() => api.getUpgradeWarehouseCost(divName, city, 1), Infinity);
                    const relGain = ((DYNAMIC_DIVISION_WEIGHTS[divName] ?? 0.2) * 0.06) *
                        (((wh.level ?? 0) < whTarget ? 1 : 0.6) + clamp((usage - 0.75) / 0.2, 0, 0.6));
                    const candidate = buildDynamicCandidate({
                        id: `${divName}-${city}-wh-up`,
                        label: `${divName} ${city} warehouse`,
                        cost,
                        relGain,
                        corp,
                        profile,
                        perform: () => safe(() => api.upgradeWarehouse(divName, city, 1), false) !== false ? `${divName} ${city} warehouse -> ${(wh.level ?? 0) + 1}` : null,
                    });
                    if (candidate) candidates.push(candidate);
                }

                const office = getOffice(divName, city);
                if (!office) continue;
                const target = cityTargetSize(divName, city, corp);
                if ((office.size ?? 0) < target) {
                    const increase = target - (office.size ?? 0);
                    const cost = safe(() => api.getOfficeSizeUpgradeCost(divName, city, increase), Infinity);
                    const divWeight = DYNAMIC_DIVISION_WEIGHTS[divName] ?? 0.2;
                    const relGain = divWeight * clamp(increase / Math.max(3, office.size ?? 1), 0.08, 0.6) * 0.25 * throughputBias;
                    const candidate = buildDynamicCandidate({
                        id: `${divName}-${city}-office`,
                        label: `${divName} ${city} office`,
                        cost,
                        relGain,
                        corp,
                        profile,
                        perform: () => safe(() => api.upgradeOfficeSize(divName, city, increase), false) !== false ? `${divName} ${city} office -> ${target}` : null,
                    });
                    if (candidate) candidates.push(candidate);
                }
            }
        }

        if (!isPublic(corp)) {
            const offer = safe(() => api.getInvestmentOffer(), null);
            if (offer?.round === 2) {
                for (let i = 1; i <= 5; i++) {
                    const name = `Dummy-${i}`;
                    if (getDivision(name)) continue;
                    const relGain = 0.10 * dummyBias;
                    const cost = 80e9;
                    const candidate = buildDynamicCandidate({
                        id: `dummy-${i}`,
                        label: name,
                        cost,
                        relGain,
                        corp,
                        profile,
                        perform: () => {
                            if (!ensureDivision("Restaurant", name, corp, 80e9)) return null;
                            const div = getDivision(name);
                            if (!div) return null;
                            for (const city of CITIES) {
                                if (!(div.cities ?? []).includes(city)) safe(() => api.expandCity(name, city));
                                if (!getWarehouse(name, city)) safe(() => api.purchaseWarehouse(name, city));
                            }
                            return `Created ${name}`;
                        },
                    });
                    if (candidate) candidates.push(candidate);
                    break;
                }
            }
        }

        candidates.sort((a, b) => b.score - a.score || b.relGain - a.relGain || a.cost - b.cost);
        return candidates;
    }

    function manageDynamicSpending(corp) {
        if (!useDynamicOptimizer(corp)) {
            state.lastDynamicStatus = "";
            return null;
        }
        const profile = getDynamicSpendingProfile(corp);
        const candidates = getDynamicSpendCandidates(corp);
        if (candidates.length <= 0) {
            state.lastDynamicNotice = "";
            state.lastDynamicStatus = `on:none reserve=${money(profile.reserve)} spend=${money(profile.spendable)}`;
            return null;
        }
        const decision = chooseDynamicSpendDecision(candidates, profile);
        if (decision.mode === "buy" && decision.candidate) {
            const result = decision.candidate.perform();
            if (!result) return null;
            state.lastDynamicNotice = "";
            state.lastDynamicStatus =
                `on:buy ${decision.candidate.label} +${(decision.candidate.relGain * 100).toFixed(1)}% ` +
                `cost=${money(decision.candidate.cost)} reserve=${money(profile.reserve)} spend=${money(profile.spendable)}`;
            return `${result} (dynamic ${decision.candidate.id}, score=${decision.candidate.score.toFixed(3)}, gain=${(decision.candidate.relGain * 100).toFixed(1)}%, cost=${money(decision.candidate.cost)})`;
        }
        const bestBlocked = decision.bestBlocked ?? candidates[0];
        const packageMsg = decision.packageNow?.picked?.length
            ? ` Better affordable bundle now is +${(decision.packageNow.relGain * 100).toFixed(1)}% for ${money(decision.packageNow.spent)} (${decision.packageNow.picked.map((candidate) => candidate.label).join(", ")}).`
            : "";
        const packageDebug = decision.packageNow?.picked?.length
            ? ` now=+${(decision.packageNow.relGain * 100).toFixed(1)}%/${money(decision.packageNow.spent)}`
            : "";
        state.lastDynamicStatus =
            `on:wait ${bestBlocked.label} +${(bestBlocked.relGain * 100).toFixed(1)}% ` +
            `need=${money(bestBlocked.requiredFunds)} short=${money(bestBlocked.shortfall)} ` +
            `eta=${formatEta(bestBlocked.waitSeconds)}${packageDebug}`;
        const notice =
            `Dynamic wait: holding for ${bestBlocked.label} (${(bestBlocked.relGain * 100).toFixed(1)}%) ` +
            `needs total ${money(bestBlocked.requiredFunds)} (${money(bestBlocked.cost)} + floor ${money(bestBlocked.floor)}), ` +
            `short ${money(bestBlocked.shortfall)}, ETA ${formatEta(bestBlocked.waitSeconds)}.${packageMsg}`;
        if (notice !== state.lastDynamicNotice) {
            state.lastDynamicNotice = notice;
            log(notice);
        }
        return null;
    }


    // ─────────────────────────────────────────────────────────────────────────
    // Corporation creation
    // ─────────────────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────────────────
    // Unlocks
    // ─────────────────────────────────────────────────────────────────────────

    function buyUnlock(name, corp, minFunds = 0) {
        if (hasUnlock(name)) return;
        const cost = safe(() => api.getUnlockCost(name), Infinity);
        if (!Number.isFinite(cost)) return;
        const funds = corp?.funds ?? 0;
        if (funds < minFunds || funds < cost * 1.1) return;
        safe(() => api.purchaseUnlock(name));
    }

    function manageUnlocks(corp) {
        // WarehouseAPI and OfficeAPI are free in BN3/SF3-3; buy immediately elsewhere.
        buyUnlock("Warehouse API", corp, 0);
        buyUnlock("Office API",    corp, 0);
        // Growth unlocks — only once corp has breathing room.
        buyUnlock("Export",                   corp, 20e9);
        buyUnlock("Smart Supply",             corp, 25e9);
        buyUnlock("Market Research - Demand", corp, 5e9);
        buyUnlock("Market Data - Competition",corp, 5e9);
        // Late-game dividend tax reducers.
        buyUnlock("Shady Accounting",         corp, 500e12);
        buyUnlock("Government Partnership",   corp, 2e15);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Global upgrades (excluding Wilson — see manageWilsonAndAdverts)
    // ─────────────────────────────────────────────────────────────────────────

    function manageGlobalUpgrades(corp) {
        if (useDynamicOptimizer(corp)) return;
        if (spendingRecoveryMode(corp)) return;
        const funds = corp.funds ?? 0;
        for (const upg of NORMAL_UPGRADES) {
            const level = safe(() => api.getUpgradeLevel(upg.name), 0);
            if (level >= upg.maxLevel) continue;
            const cost = safe(() => api.getUpgradeLevelCost(upg.name), Infinity);
            if (!Number.isFinite(cost)) continue;
            const stageTarget = getStageUpgradeTarget(upg.name, corp);
            if (level < stageTarget) {
                if (funds > cost * 2) safe(() => api.levelUpgrade(upg.name));
                continue;
            }
            if (funds > cost * upg.spendMult) safe(() => api.levelUpgrade(upg.name));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wilson Analytics + Advert
    // Wilson must be bought BEFORE Advert (not retroactive — multiplies future Advert benefit).
    // Docs: "In round 3+, buy Wilson if you can afford it, then use ≥20% of funds on Advert."
    // ─────────────────────────────────────────────────────────────────────────

    function manageWilsonAndAdverts(divName, corp) {
        if (useDynamicOptimizer(corp)) return;
        if (spendingRecoveryMode(corp)) return;
        const funds    = corp.funds ?? 0;
        const revenue  = corp.revenue ?? 0;
        const inRound3 = (safe(() => api.getInvestmentOffer(), null)?.round ?? 0) >= 3
                      || isPublic(corp);

        // Wilson: only worth buying aggressively in round 3+ when we have budget.
        // Its price doubles every level (priceMult=2), so check carefully.
        if (inRound3 || revenue > 1e10) {
            const wilsonCost = safe(() => api.getUpgradeLevelCost(U.wilson), Infinity);
            const wilsonLevel = safe(() => api.getUpgradeLevel(U.wilson), 0);
            const wilsonTarget = getStageUpgradeTarget(U.wilson, corp);
            if (Number.isFinite(wilsonCost) && wilsonLevel < wilsonTarget && funds > wilsonCost * 2) {
                safe(() => api.levelUpgrade(U.wilson));
            } else if (Number.isFinite(wilsonCost) && funds > wilsonCost * 2) {
                safe(() => api.levelUpgrade(U.wilson));
            }
        }

        // Advert — only for product/main divisions (not Chemical support div).
        if (divName === CHEM) return;

        const count    = safe(() => api.getHireAdVertCount(divName), 0);
        const advCost  = safe(() => api.getHireAdVertCost(divName), Infinity);
        if (!Number.isFinite(advCost)) return;

        // Docs: "use at least 20% of current funds to buy Advert" in round 3+.
        // Rounds 1-2: only buy 1-2 levels (budget is tight).
        const offer = safe(() => api.getInvestmentOffer(), null);
        const round = offer?.round ?? (isPublic(corp) ? 5 : 1);

        if (round <= 2) {
            // Round 1-2: buy at most 2 Advert levels; be conservative with funds.
            const target = divName === AGRI ? 2 : 0;
            if (count < target && funds > advCost * 10) {
                safe(() => api.hireAdVert(divName));
            }
        } else {
            const stageTarget = getStageAdvertTarget(divName, corp);
            if (count < stageTarget && funds > advCost * 2.5) {
                safe(() => api.hireAdVert(divName));
                return;
            }
            // Round 3+: buy Advert aggressively with 20% of funds.
            if (funds > advCost && advCost < funds * 0.2) {
                safe(() => api.hireAdVert(divName));
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Research
    // ─────────────────────────────────────────────────────────────────────────

    function manageResearch(divName, researchList) {
        const div = getDivision(divName);
        if (!div) return;
        const rp = div.researchPoints ?? 0;

        for (const research of researchList) {
            if (hasRes(divName, research)) continue;
            const cost = resCost(divName, research);
            if (!Number.isFinite(cost)) continue;

            // Production researches: only buy when cost < 10% of RP pool.
            // All others: only buy when cost < 50% of RP pool.
            // Docs: "Do not deplete entire RP pool to buy research."
            const threshold = PRODUCTION_RESEARCH.has(research) ? 10 : 2;
            if (rp >= cost * threshold) {
                safe(() => api.research(divName, research));
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Office management
    // ─────────────────────────────────────────────────────────────────────────

    // Target office size per division and revenue tier.
    function cityTargetSize(divName, city, corp) {
        const rev = corp?.revenue ?? 0;
        let baseTarget = 9;

        // Chemical is a support division — keep it small to avoid wasting funds.
        // Docs: "Don't invest much funds on [Chemical's] Office upgrades."
        if (divName === CHEM) baseTarget = 9;
        else if (divName === AGRI) {
            if (rev < 1e8)  baseTarget = 3;
            else if (rev < 1e9)  baseTarget = city === HQ_CITY ? 9  : 3;
            else if (rev < 1e10) baseTarget = city === HQ_CITY ? 15 : 9;
            else if (rev < 1e12) baseTarget = city === HQ_CITY ? 30 : 15;
            else if (rev < 1e14) baseTarget = city === HQ_CITY ? 45 : 30;
            else baseTarget = city === HQ_CITY ? 60 : 45;
        } else if (divName === TOB) {
            if (rev < 1e9)  baseTarget = city === HQ_CITY ? 9  : 3;
            else if (rev < 1e10) baseTarget = city === HQ_CITY ? 18 : 9;
            else if (rev < 1e12) baseTarget = city === HQ_CITY ? 30 : 18;
            else if (rev < 1e14) baseTarget = city === HQ_CITY ? 60 : 30;
            else baseTarget = city === HQ_CITY ? 90 : 45;
        }

        return Math.max(baseTarget, getStageMinOfficeTarget(divName, city, corp));
    }

    // Job distribution per division and role.
    //
    // AGRI / CHEM: Engineer-heavy for high material quality.
    //   Docs: "prioritize the 'Engineer' job over other jobs [for material quality]"
    //   Quality formula: MaxOutputQuality = EngineerProd/90 + RP^scienceFactor + aiCoresSummand
    //
    // TOB HQ: Engineer-heavy for product development speed.
    //   ProductDevelopmentMultiplier = (EngineerProd^0.34 + OpsProd^0.2) × ManagementFactor
    //
    // TOB satellite cities: R&D-heavy for RP.
    //   Docs: "Support office is where you assign a large number of employees to R&D job."
    //   RP drives product markup, quality, and rating — don't neglect it.
    function jobPlan(divName, city, n) {
        if (n <= 0) return { ops:0, eng:0, biz:0, mgmt:0, rnd:0 };

        // Round 1 Agri bootstrap: start all-R&D until RP reaches 55.
        // This quickly builds enough RP for high-quality plants before boost materials.
        if (divName === AGRI && !state.agriRpReady) {
            return { ops:0, eng:0, biz:0, mgmt:0, rnd:n };
        }

        if (divName === AGRI || divName === CHEM) {
            // Engineer dominant for quality; Ops for production; some Mgmt and R&D.
            const eng  = Math.max(1, Math.floor(n * 0.40));
            const ops  = Math.max(1, Math.floor(n * 0.30));
            const mgmt = Math.max(1, Math.floor(n * 0.15));
            const rnd  = Math.max(1, Math.floor(n * 0.10));
            const biz  = Math.max(0, n - eng - ops - mgmt - rnd);
            return { ops, eng, biz, mgmt, rnd };
        }

        if (divName === TOB) {
            if (city === HQ_CITY) {
                // HQ: product development focus (Engineer + Management for speed).
                const eng  = Math.max(1, Math.floor(n * 0.40));
                const mgmt = Math.max(1, Math.floor(n * 0.25));
                const ops  = Math.max(1, Math.floor(n * 0.15));
                const biz  = Math.max(1, Math.floor(n * 0.10));
                const rnd  = Math.max(0, n - eng - mgmt - ops - biz);
                return { ops, eng, biz, mgmt, rnd };
            } else {
                // Satellite: R&D-heavy for RP accumulation.
                // RP gain: 0.004 × RnDProduction^0.5 — scales with employee count.
                const rnd  = Math.max(1, Math.floor(n * 0.80));
                const eng  = Math.max(1, Math.floor(n * 0.10));
                const ops  = Math.max(0, n - rnd - eng);
                return { ops, eng, biz:0, mgmt:0, rnd };
            }
        }

        // Fallback
        const eng  = Math.floor(n * 0.30);
        const ops  = Math.floor(n * 0.25);
        const mgmt = Math.floor(n * 0.20);
        const rnd  = Math.floor(n * 0.10);
        const biz  = Math.max(0, n - eng - ops - mgmt - rnd);
        return { ops, eng, biz, mgmt, rnd };
    }

    // Correct two-pass assignment per documentation and source code:
    //   "Use setJobAssignment to set all jobs to 0, then set all jobs to requirements."
    //   setJobAssignment works on employeeNextJobs (pending), not the committed employeeJobs.
    //   Pass 1 zeros all roles → they move to Unassigned pool in nextJobs.
    //   Pass 2 draws from that Unassigned pool.
    //   This is correct regardless of current committed state.
    function assignJobs(divName, city, plan) {
        // Pass 1: zero all — always succeeds (diff is negative → Unassigned grows).
        for (const job of [JOBS.ops, JOBS.eng, JOBS.biz, JOBS.mgmt, JOBS.rnd]) {
            safe(() => api.setJobAssignment(divName, city, job, 0));
        }
        // Pass 2: assign desired — draws from Unassigned freed above.
        if (plan.ops  > 0) safe(() => api.setJobAssignment(divName, city, JOBS.ops,  plan.ops));
        if (plan.eng  > 0) safe(() => api.setJobAssignment(divName, city, JOBS.eng,  plan.eng));
        if (plan.biz  > 0) safe(() => api.setJobAssignment(divName, city, JOBS.biz,  plan.biz));
        if (plan.mgmt > 0) safe(() => api.setJobAssignment(divName, city, JOBS.mgmt, plan.mgmt));
        if (plan.rnd  > 0) safe(() => api.setJobAssignment(divName, city, JOBS.rnd,  plan.rnd));
    }

    function manageOfficeGrowth(divName, corp) {
        const div = getDivision(divName);
        if (!div) return;
        const dynamicMode = useDynamicOptimizer(corp);

        for (const city of div.cities ?? []) {
            const office = getOffice(divName, city);
            if (!office) continue;

            const target      = cityTargetSize(divName, city, corp);
            const currentSize = office.size ?? 0;
            const employees   = office.numEmployees ?? 0;

            // Upgrade office size if below target.
            // BUG FIX: getOfficeSizeUpgradeCost takes the INCREASE amount, not the target size.
            if (!dynamicMode && currentSize < target && !spendingRecoveryMode(corp)) {
                const increase = target - currentSize;
                const cost = safe(() => api.getOfficeSizeUpgradeCost(divName, city, increase), Infinity);
                if (Number.isFinite(cost) && (corp.funds ?? 0) > cost * 2) {
                    safe(() => api.upgradeOfficeSize(divName, city, increase));
                }
            }

            // Hire all available slots (no arbitrary cap).
            const afterSize = getOffice(divName, city)?.size ?? currentSize;
            if (employees < afterSize && !spendingRecoveryMode(corp)) {
                for (let i = employees; i < afterSize; i++) {
                    safe(() => api.hireEmployee(divName, city, JOBS.unassigned));
                }
            }

            // Keep energy/morale capped without paying blindly when an office is already full.
            const liveOffice = getOffice(divName, city) ?? office;
            const avgEnergy = liveOffice?.avgEnergy ?? 0;
            const maxEnergy = liveOffice?.maxEnergy ?? 0;
            const avgMorale = liveOffice?.avgMorale ?? 0;
            const maxMorale = liveOffice?.maxMorale ?? 0;
            if (maxEnergy > 0 && avgEnergy < maxEnergy - 0.05) safe(() => api.buyTea(divName, city));
            if (maxMorale > 0 && avgMorale < maxMorale - 0.05) safe(() => api.throwParty(divName, city, 500e3));

            // Apply job distribution.
            const currentEmployees = getOffice(divName, city)?.numEmployees ?? 0;
            if (currentEmployees > 0) {
                assignJobs(divName, city, jobPlan(divName, city, currentEmployees));
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Warehouse management
    // ─────────────────────────────────────────────────────────────────────────

    function ensureWarehouses(divName, corp) {
        if (useDynamicOptimizer(corp)) return;
        const div = getDivision(divName);
        if (!div) return;
        const stageTarget = getWarehouseTargetLevel(divName, corp);

        for (const city of div.cities ?? []) {
            const wh = getWarehouse(divName, city);
            if (!wh) {
                // No warehouse yet — buy one.
                if ((corp?.funds ?? 0) > 5e9 && !spendingRecoveryMode(corp)) {
                    safe(() => api.purchaseWarehouse(divName, city));
                }
                continue;
            }
            if ((wh.level ?? 0) < stageTarget && (corp?.funds ?? 0) > 1e9 && !spendingRecoveryMode(corp)) {
                safe(() => api.upgradeWarehouse(divName, city, 1));
                continue;
            }
            // Upgrade if over 80% full to avoid production stalls.
            const size = wh.size ?? 0;
            if (size > 0 && (wh.sizeUsed ?? 0) / size > 0.80
                    && (corp?.funds ?? 0) > 1e9 && !spendingRecoveryMode(corp)) {
                safe(() => api.upgradeWarehouse(divName, city, 1));
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // City / division expansion
    // ─────────────────────────────────────────────────────────────────────────

    function ensureDivision(industry, name, corp, minFunds = 0) {
        if (getDivision(name)) return true;
        const startCost = safe(() => api.getIndustryData(industry).startingCost, minFunds);
        if (recoveryMode(corp) || (corp?.funds ?? 0) < Math.max(minFunds, startCost)) return false;
        safe(() => api.expandIndustry(industry, name));
        return !!getDivision(name);
    }

    function ensureAllCities(divName, corp, minFunds) {
        if (useDynamicOptimizer(corp)) return;
        const div = getDivision(divName);
        if (!div) return;
        for (const city of CITIES) {
            if (div.cities?.includes(city)) continue;
            if ((corp?.funds ?? 0) < minFunds || recoveryMode(corp)) continue;
            safe(() => api.expandCity(divName, city));
            safe(() => api.purchaseWarehouse(divName, city));
        }
    }

    function manageValuationDummies(corp) {
        if (useDynamicOptimizer(corp)) return;
        const offer = safe(() => api.getInvestmentOffer(), null);
        if (!offer || offer.round !== 2 || isPublic(corp) || recoveryMode(corp)) return;

        for (let i = 1; i <= 5; i++) {
            const name = `Dummy-${i}`;
            if (getDivision(name)) continue;
            if ((corp?.funds ?? 0) < 80e9) return;
            if (!ensureDivision("Restaurant", name, corp, 80e9)) return;
            ensureAllCities(name, corp, 5e9);
            return;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Smart Supply + Export routes
    //
    // Supply chain: Agri ↔ Chem (quality loop), Agri → Tobacco (Plants)
    //   Agriculture: needs Water (0.5) + Chemicals (0.2) → produces Plants + Food
    //   Chemical:    needs Plants (1) + Water (0.5)     → produces Chemicals
    //   Tobacco:     needs Plants (1)                    → produces Products
    //
    // Export priority (FIFO): Tobacco FIRST — set up Agri→Tob before Agri→Chem.
    // Docs: "Prioritize Tobacco over Chemical when setting up export routes for Plants."
    //
    // Export string: "PROD" = export all production per cycle.
    // Optimal is (IPROD+IINV/10)*(-1) per docs (drains inventory), but "PROD" is
    // correct and simpler for an autopilot.
    // ─────────────────────────────────────────────────────────────────────────

    function enableSmartSupply(divName) {
        const div = getDivision(divName);
        if (!div || !hasUnlock("Smart Supply")) return;
        for (const city of div.cities ?? []) {
            if (!getWarehouse(divName, city)) continue;
            safe(() => api.setSmartSupply(divName, city, true));
            // "Use leftovers" — only buy what exports don't cover.
            for (const mat of ["Plants","Water","Chemicals"]) {
                safe(() => api.setSmartSupplyOption(divName, city, mat, "leftovers"));
            }
        }
    }

    function setupExports() {
    if (state.exportsSetUp) return;
    if (!hasUnlock("Export")) return;
    if (!getDivision(AGRI) || !getDivision(CHEM) || !getDivision(TOB)) return;

    const EXP = "(IPROD+IINV/10)*(-1)";

    for (const city of CITIES) {
        // Agriculture → Tobacco
        safe(() => api.exportMaterial(AGRI, city, TOB, city, "Plants", EXP));

        // Agriculture → Chemical
        safe(() => api.exportMaterial(AGRI, city, CHEM, city, "Plants", EXP));

        // Chemical → Agriculture
        safe(() => api.exportMaterial(CHEM, city, AGRI, city, "Chemicals", EXP));

        // Smart Supply should only top up leftovers
        safe(() => api.setSmartSupplyOption(AGRI, city, "Chemicals", "leftovers"));
        safe(() => api.setSmartSupplyOption(AGRI, city, "Water", "leftovers"));
        safe(() => api.setSmartSupplyOption(CHEM, city, "Plants", "leftovers"));
        safe(() => api.setSmartSupplyOption(CHEM, city, "Water", "leftovers"));
        safe(() => api.setSmartSupplyOption(TOB, city, "Plants", "leftovers"));
    }

    state.exportsSetUp = true;
    log("Export routes configured: Agri→Tob, Agri→Chem, Chem→Agri.");
}
    // ─────────────────────────────────────────────────────────────────────────
    // Material sales
    // ─────────────────────────────────────────────────────────────────────────

    function manageMaterialSales(divName) {
        const div = getDivision(divName);
        if (!div) return;
        for (const city of div.cities ?? []) {
            if (divName === AGRI) {
                // Food: sell it — it's produced as a byproduct and can't be exported usefully.
                // Plants: do NOT sell — export them to Tobacco and Chemical instead.
                safe(() => api.sellMaterial(divName, city, "Food", "MAX", "MP"));
            } else if (divName === CHEM) {
                // Chemical sells Chemicals on the open market only after exporting to Agri.
                // Smart Supply "leftovers" on Agri handles the split.
                safe(() => api.sellMaterial(divName, city, "Chemicals", "MAX", "MP"));
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Products
    // ─────────────────────────────────────────────────────────────────────────

    function productNames(div) {
        const raw = div?.products;
        return Array.isArray(raw) ? raw.filter(x => typeof x === "string" && x.length > 0) : [];
    }

    function nextProductName(divName) {
        const names = productNames(getDivision(divName));
        let max = 0;
        for (const p of names) {
            if (!p.startsWith("Tobac-v")) continue;
            const n = parseInt(p.slice(7), 10);
            if (Number.isFinite(n) && n > max) max = n;
        }
        const seq = Math.max(state.nextProductSeq, max + 1);
        state.nextProductSeq = seq + 1;
        return `Tobac-v${seq}`;
    }

    function tobaccoProductVersion(name) {
        const match = /^Tobac-v(\d+)$/.exec(name);
        const version = match ? Number(match[1]) : NaN;
        return Number.isFinite(version) ? version : 0;
    }

    function getWeakestFinishedProduct(names) {
        let candidate = null;
        let candidateRating = Infinity;
        let candidateVersion = Infinity;
        for (const pName of names) {
            const product = safe(() => api.getProduct(TOB, HQ_CITY, pName), null);
            if (!product || (product.developmentProgress ?? 0) < 100) continue;
            const rating = Number(product.rating ?? Infinity);
            const version = tobaccoProductVersion(pName);
            if (
                rating < candidateRating ||
                (rating === candidateRating && version < candidateVersion)
            ) {
                candidate = pName;
                candidateRating = rating;
                candidateVersion = version;
            }
        }
        return candidate;
    }

    function maxProducts(divName) {
        let cap = 3;
        if (hasRes(divName, "uPgrade: Capacity.I"))  cap++;
        if (hasRes(divName, "uPgrade: Capacity.II")) cap++;
        return cap;
    }

    function manageProducts(corp) {
        const div = getDivision(TOB);
        if (!div) return;

        const names      = productNames(div);
        const finished   = [];
        const developing = [];

        for (const pName of names) {
            const p = safe(() => api.getProduct(TOB, HQ_CITY, pName), null);
            if (!p) continue;
            if ((p.developmentProgress ?? 0) >= 100) finished.push(pName);
            else developing.push(pName);
        }

        // Price all finished products.
        const hasTA2 = hasRes(TOB, "Market-TA.II");
        const hasTA1 = hasRes(TOB, "Market-TA.I");
        for (const pName of finished) {
            if (hasTA2) {
                safe(() => api.setProductMarketTA2(TOB, pName, true));
            } else if (hasTA1) {
                safe(() => api.setProductMarketTA1(TOB, pName, true));
            }
            // Set sell amount MAX. Price: "MP" if no TA active, TA overrides it anyway.
            for (const city of div.cities ?? []) {
                safe(() => api.sellProduct(TOB, city, pName, "MAX", "MP", true));
            }
            if (!state.seenFinishedProducts[pName]) {
                state.seenFinishedProducts[pName] = true;
                log(`Product ${pName} finished; sales enabled in ${(div.cities ?? []).length} Tobacco cities.`);
            }
            let totalStored = 0;
            let totalSell = 0;
            for (const city of div.cities ?? []) {
                const info = safe(() => api.getProduct(TOB, city, pName), null);
                totalStored += Number(info?.stored ?? 0);
                totalSell += Number(info?.actualSellAmount ?? 0);
            }
            if (totalStored >= 1000 && totalSell <= 1) {
                const stallKey = `${pName}:${Math.floor(totalStored / 1000)}`;
                if (state.stalledProductSales[pName] !== stallKey) {
                    state.stalledProductSales[pName] = stallKey;
                    log(`Product ${pName} has stock=${totalStored.toFixed(0)} but sell=${totalSell.toFixed(1)}/s; sell config re-applied.`);
                }
            } else {
                delete state.stalledProductSales[pName];
            }
        }
        for (const pName of Object.keys(state.seenFinishedProducts)) {
            if (!names.includes(pName)) delete state.seenFinishedProducts[pName];
        }
        for (const pName of Object.keys(state.stalledProductSales)) {
            if (!names.includes(pName)) delete state.stalledProductSales[pName];
        }

        if (spendingRecoveryMode(corp)) return;

        // Design and marketing investment.
        // Docs: "It's fine to spend 1% of your current funds for them. Their exponent is 0.1."
        const invest = Math.max(
            1e8, // $100M minimum so product quality isn't trivially bad
            (corp.funds ?? 0) * 0.01
        );

        const cap = maxProducts(TOB);

        // Start a product if we have a free slot and nothing developing.
        if (names.length < cap && developing.length === 0 && invest >= 1e8) {
            const nextName = nextProductName(TOB);
            safe(() => api.makeProduct(TOB, HQ_CITY, nextName, invest/2, invest/2));
            log(`Started product ${nextName} with ${money(invest)} total investment.`);
            return;
        }

        // At cap and nothing developing: cycle — discontinue oldest, start fresh.
        // Docs: "We need to continuously develop new products. New products are almost
        //        always better than the old ones and generate much more profit."
        // No flatProfitTicks gate — always cycle for maximum product improvement.
        if (names.length >= cap && developing.length === 0 && finished.length > 0) {
            const weakest = getWeakestFinishedProduct(finished);
            if (weakest && invest >= 1e8) {
                const nextName = nextProductName(TOB);
                safe(() => api.discontinueProduct(TOB, weakest));
                delete state.seenFinishedProducts[weakest];
                safe(() => api.makeProduct(TOB, HQ_CITY, nextName, invest/2, invest/2));
                log(`Retired ${weakest}; started ${nextName} with ${money(invest)} total investment.`);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Investment + IPO + Dividends
    // ─────────────────────────────────────────────────────────────────────────

    function manageBuybacks(corp) {
        if (!isPublic(corp) || spendingRecoveryMode(corp)) return;
        const issuedShares = getIssuedShares(corp);
        if (issuedShares <= 0) {
            const ownership = getOwnershipPct(corp);
            const noticeKey = `${Math.floor(ownership * 1000)}|0`;
            if (ownership < 0.25 && noticeKey !== state.lastOwnershipNotice) {
                state.lastOwnershipNotice = noticeKey;
                log(`Buybacks unavailable: issuedShares=0 and ownership=${(ownership * 100).toFixed(1)}%. Round-investment dilution cannot be reversed on this corp.`);
            }
            return;
        }
        state.lastOwnershipNotice = "";
        const sharePrice = buybackSharePrice(corp);
        if (!Number.isFinite(sharePrice) || sharePrice <= 0) return;

        const ownership = getOwnershipPct(corp);
        const funds = corp?.funds ?? 0;
        const reserve = getBuybackReserve(corp);
        const spendable = Math.max(0, funds - reserve);
        if (spendable <= sharePrice * BUYBACK_MIN_SHARES) return;

        let spendPct = 0.15;
        if (ownership < 0.25) spendPct = 0.50;
        else if (ownership < 0.50) spendPct = 0.35;
        else if (ownership < 0.75) spendPct = 0.20;

        const budget = spendable * spendPct;
        const shares = Math.min(issuedShares, Math.floor(budget / sharePrice));
        if (shares < BUYBACK_MIN_SHARES) return;

        const ok = safe(() => api.buyBackShares(shares), false);
        if (ok) {
            log(`Bought back ${formatShares(shares)} shares at ~${money(sharePrice)} each (ownership ${(ownership * 100).toFixed(1)}%).`);
        }
    }

    function targetDividendRate(corp) {
        if (!isPublic(corp)) return 0;
        const profit = operatingProfit(corp);
        const margin = (corp.revenue ?? 0) > 0 ? profit / corp.revenue : 0;
        const ownership = getOwnershipPct(corp);
        const issuedShares = getIssuedShares(corp);
        const funds = corp.funds ?? 0;
        const incomeStrategy = isIncomeStrategyActive();
        if (profit <= 0 || recoveryMode(corp))                    return 0;
        if (incomeStrategy) {
            if (issuedShares > 0) {
                if (ownership < 0.25)                             return 0;
                if (ownership < 0.50)                             return (margin > 0.35 && funds > 1e10) ? 0.10 : 0.05;
                if (ownership < 0.75)                             return (margin > 0.40 && funds > 2e10) ? 0.20 : 0.10;
                if (margin > 0.55 && funds > 5e10)               return 0.35;
                if (margin > 0.35 && funds > 2e10)               return 0.20;
                return 0.10;
            }
            if (margin > 0.60 && funds > 5e10)                   return 0.50;
            if (margin > 0.45 && funds > 2e10)                   return 0.35;
            if (margin > 0.30 && funds > 1e10)                   return 0.20;
            return 0.10;
        }
        if (issuedShares <= 0 && ownership <= 0.15) {
            if (margin > 0.55 && funds > 2e10)                   return 0.20;
            if (margin > 0.35 && funds > 1e10)                   return 0.15;
            return 0.10;
        }
        if (issuedShares > 0) {
            if (ownership < 0.25)                                 return 0;
            if (ownership < 0.50)                                 return (margin > 0.45 && funds > 5e12) ? 0.05 : 0;
            if (ownership < 0.75)                                 return margin > 0.35 ? 0.10 : 0.05;
        }
        if (margin > 0.55 && funds > 1e12)                       return 0.25;
        if (margin > 0.30 && funds > 1e10)                       return 0.10;
        return 0.05;
    }

    function manageDividends(corp) {
        if (!isPublic(corp)) return;
        const rate = targetDividendRate(corp);
        if (rate !== state.lastDividendRate) {
            safe(() => api.issueDividends(rate));
            state.lastDividendRate = rate;
        }
    }

    function getDynamicDebugStatus(corp) {
        if (!isPublic(corp)) return "off:not-public";
        if (!getDivision(TOB)) return "off:no-tob";
        if (recoveryMode(corp)) return "off:recovery";
        if (spendingRecoveryMode(corp)) return "off:loss-brake";
        return state.lastDynamicStatus || `on:idle reserve=${money(getDynamicSpendingProfile(corp).reserve)}`;
    }

    function getBuybackDebugStatus(corp) {
        if (!isPublic(corp)) return "off:not-public";
        if (spendingRecoveryMode(corp)) return "off:loss-brake";
        const issuedShares = getIssuedShares(corp);
        const ownership = getOwnershipPct(corp);
        if (issuedShares <= 0) return `hold:no-issued own=${(ownership * 100).toFixed(1)}%`;
        const sharePrice = buybackSharePrice(corp);
        if (!Number.isFinite(sharePrice) || sharePrice <= 0) return "hold:no-price";
        const funds = corp?.funds ?? 0;
        const reserve = getBuybackReserve(corp);
        const spendable = Math.max(0, funds - reserve);
        let spendPct = 0.15;
        if (ownership < 0.25) spendPct = 0.50;
        else if (ownership < 0.50) spendPct = 0.35;
        else if (ownership < 0.75) spendPct = 0.20;
        const budget = spendable * spendPct;
        const shares = Math.min(issuedShares, Math.floor(budget / sharePrice));
        if (spendable <= sharePrice * BUYBACK_MIN_SHARES) return `hold:spend=${money(spendable)} reserve=${money(reserve)}`;
        if (shares < BUYBACK_MIN_SHARES) return `hold:budget=${money(budget)} floor=${formatShares(BUYBACK_MIN_SHARES)}`;
        return `ready:${formatShares(shares)} budget=${money(budget)} reserve=${money(reserve)}`;
    }

    function getDividendDebugStatus(corp) {
        if (!isPublic(corp)) return "off:not-public";
        const profit = operatingProfit(corp);
        const ownership = getOwnershipPct(corp);
        const issuedShares = getIssuedShares(corp);
        const rate = targetDividendRate(corp);
        const mode = getEconomicMode();
        if (profit <= 0) return `0.00:profit<=0 mode=${mode}`;
        if (recoveryMode(corp)) return `0.00:recovery mode=${mode}`;
        if (rate <= 0) {
            if (issuedShares > 0 && ownership < 0.25) return `0.00:own<25% mode=${mode}`;
            return `0.00:policy mode=${mode}`;
        }
        return `${rate.toFixed(2)}:${mode}`;
    }

    function getStageProgressDebug(corp) {
        const targets = getStageTargets(corp);
        if (!targets) return "targets=none";
        const agri = minOfficeSize(AGRI);
        const tob = minOfficeSize(TOB);
        const chem = minOfficeSize(CHEM);
        return [
            `sf=${safe(() => api.getUpgradeLevel(U.smartFactories), 0)}/${targets.smartFactories}`,
            `ss=${safe(() => api.getUpgradeLevel(U.smartStorage), 0)}/${targets.smartStorage}`,
            `sb=${safe(() => api.getUpgradeLevel(U.salesBots), 0)}/${targets.salesBots}`,
            `wil=${safe(() => api.getUpgradeLevel(U.wilson), 0)}/${targets.wilson}`,
            `adv=${safe(() => api.getHireAdVertCount(TOB), 0)}/${targets.tobAdvert}`,
            `ta2=${hasRes(TOB, "Market-TA.II") ? "yes" : "no"}`,
            `wh=${minWarehouseLevel(AGRI)}/${minWarehouseLevel(TOB)}/${minWarehouseLevel(CHEM)}/${targets.warehouse}`,
            `ag=${agri.hq}/${agri.support}/${targets.agriOffice}`,
            `tob=${tob.hq}/${tob.support}/${targets.tobHqOffice}-${targets.tobSupportOffice}`,
            `chem=${chem.hq}/${chem.support}/${targets.chemOffice}`,
        ].join(" ");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Division bootstraps
    // ─────────────────────────────────────────────────────────────────────────

    function bootstrapAgriculture(corp) {
        if (!ensureDivision("Agriculture", AGRI, corp, 1e9)) return false;
        ensureAllCities(AGRI, corp, 1e9);
        ensureWarehouses(AGRI, corp);
        enableSmartSupply(AGRI);
        manageOfficeGrowth(AGRI, corp);
        manageResearch(AGRI, MAT_RESEARCH);
        manageMaterialSales(AGRI);
        manageWilsonAndAdverts(AGRI, corp);

        // Round 1 bootstrap: update agriRpReady flag.
        if (!state.agriRpReady) {
            const div = getDivision(AGRI);
            if ((div?.researchPoints ?? 0) >= 55) {
                state.agriRpReady = true;
                log("Agri RP ≥ 55 — switching from R&D-only to full job distribution.");
                // Re-run job assignment immediately with new distribution.
                for (const city of div?.cities ?? []) {
                    const office = getOffice(AGRI, city);
                    const n = office?.numEmployees ?? 0;
                    if (n > 0) assignJobs(AGRI, city, jobPlan(AGRI, city, n));
                }
            }
        }
        return true;
    }

    function bootstrapChemical(corp) {
        // Chemical division is a support division for Agriculture quality.
        // Docs: "Without Chemical, Agriculture output quality will be too low."
        // But: "Don't invest much funds on Chemical's Office/Advert upgrades."
        if (!getDivision(AGRI)) return false;  // Need Agri first
        const agProfit = (corp?.revenue ?? 0) - (corp?.expenses ?? 0);
        if (!ensureDivision("Chemical", CHEM, corp, 70e9)) return false;
        ensureAllCities(CHEM, corp, 5e9);
        ensureWarehouses(CHEM, corp);
        enableSmartSupply(CHEM);
        manageOfficeGrowth(CHEM, corp);
        manageResearch(CHEM, MAT_RESEARCH);
        // No Advert for Chemical (waste of funds).
        setupExports();
        return true;
    }

    function bootstrapTobacco(corp) {
        if (!getDivision(AGRI)) return false;
        if (!getDivision(TOB)) {
            if (recoveryMode(corp) || (corp?.funds ?? 0) < 20e9) return false;
            ensureDivision("Tobacco", TOB, corp, 20e9);
        }
        if (!getDivision(TOB)) return false;

        ensureAllCities(TOB, corp, 20e9);
        ensureWarehouses(TOB, corp);
        enableSmartSupply(TOB);
        manageOfficeGrowth(TOB, corp);
        manageResearch(TOB, TOB_RESEARCH);
        manageWilsonAndAdverts(TOB, corp);
        manageProducts(corp);
        setupExports();
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Snapshot
    // ─────────────────────────────────────────────────────────────────────────

    function writeSnapshot(corp) {
        const divs = [AGRI, CHEM, TOB].map(n => getDivision(n)).filter(Boolean);
        const snap = {
            corpLoaded: true,
            corpExists: !!corp,
            corpName:   corp?.name ?? "—",
            state:      corp?.state ?? "—",
            funds:      corp?.funds ?? 0,
            revenue:    corp?.revenue ?? 0,
            expenses:   corp?.expenses ?? 0,
            profit:     (corp?.revenue ?? 0) - (corp?.expenses ?? 0),
            public:     isPublic(corp ?? {}),
            ownershipPct: getOwnershipPct(corp),
            ownedShares: getOwnedShares(corp),
            issuedShares: getIssuedShares(corp),
            totalShares: getTotalShares(corp),
            dividendRate: corp?.dividendRate ?? 0,
            economicMode: getEconomicMode(),
            fundingRound: safe(() => api.getInvestmentOffer()?.round, 0),
            wilsonLevel:  safe(() => api.getUpgradeLevel(U.wilson), 0),
            agriRpReady:  state.agriRpReady,
            exportsSetUp: state.exportsSetUp,
            divisions: divs.map(div => ({
                name:      div.name,
                cities:    Array.isArray(div.cities) ? div.cities.length : 0,
                products:  Array.isArray(div.products) ? div.products.length : 0,
                rp:        div.researchPoints ?? 0,
                employees: (div.cities ?? []).reduce((s, c) => s + (getOffice(div.name, c)?.numEmployees ?? 0), 0),
            })),
            _ts: Date.now(),
        };
        safe(() => ns.write(SNAPSHOT_FILE, JSON.stringify(snap), "w"));
    }

    function logDebugStatus(corp, refillFlags = {}) {
        state.loopCount++;
        const lossBrake = spendingRecoveryMode(corp);
        const offer = safe(() => api.getInvestmentOffer(), null);
        const stage = getFundingStage(corp);
        const missing = getStageMissing(corp, stage).join(",");
        const refills = Object.entries(refillFlags)
            .filter(([, active]) => !!active)
            .map(([name]) => name)
            .join(",");
        const ownershipPct = (getOwnershipPct(corp) * 100).toFixed(1);
        const issuedShares = formatShares(getIssuedShares(corp));
        const statusSig = `${stage}|${missing || 'none'}|${lossBrake ? '1' : '0'}|${refills || 'none'}`;
        if (!lossBrake && statusSig === state.lastStatusSig && state.loopCount % DEBUG_STATUS_INTERVAL !== 0) return;
        state.lastStatusSig = statusSig;
        log(
            `Status: funds=${money(corp?.funds ?? 0)} rev=${money(corp?.revenue ?? 0)}/s ` +
            `exp=${money(corp?.expenses ?? 0)}/s profit=${money(operatingProfit(corp))}/s ` +
            `offer=r${offer?.round ?? 0}:${money(offer?.funds ?? 0)} ` +
            `own=${ownershipPct}% issued=${issuedShares} ` +
            `mode=${getEconomicMode()} ` +
            `stage=${stage} missing=${missing || 'none'} ` +
            `lossBrake=${lossBrake ? 'on' : 'off'} boostRefill=${refills || 'none'} ` +
            `div=${(corp?.dividendRate ?? 0).toFixed(2)}`
        );
        log(
            `Status+: ${getStageProgressDebug(corp)} ` +
            `dyn=${getDynamicDebugStatus(corp)} ` +
            `buyback=${getBuybackDebugStatus(corp)} ` +
            `divTarget=${getDividendDebugStatus(corp)}`
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Main loop
    // ─────────────────────────────────────────────────────────────────────────

    log(`Corp manager started | BN=${safe(() => ns.getResetInfo().currentNode, "?")} | ` +
        `SF10.1=${safe(() => ns.singularity?.getOwnedSourceFiles?.()?.some(s => s.n===10), false)} | ` +
        `mode=${incomeMode ? 'income-forced' : 'auto-hybrid'}`);
    if (incomeMode) {
        log("Income mode override enabled: autopilot will prioritize payouts immediately after IPO.");
    } else {
        log("Auto-hybrid mode enabled: autopilot will maximize public growth first, then switch into income mode automatically.");
    }

    ns.atExit(() => { try { ns.write(SNAPSHOT_FILE, "", "w"); } catch {} });

    while (true) {
        if (!api.hasCorporation()) {
            const notice = "Autopilot is waiting for a public corporation from corp-setup.js.";
            if (state.lastModeNotice !== notice) {
                state.lastModeNotice = notice;
                log(notice);
            }
            writeSnapshot(null);
            await ns.sleep(UPDATE_MS);
            continue;
        }

        const corp = getCorp();
        if (!corp) {
            writeSnapshot(null);
            await ns.sleep(UPDATE_MS);
            continue;
        }

        if (!isPublic(corp)) {
            const notice = "Autopilot is now public-only; waiting for corp-setup.js to finish the private rounds.";
            if (state.lastModeNotice !== notice) {
                state.lastModeNotice = notice;
                log(notice);
            }
            writeSnapshot(corp);
            await ns.sleep(UPDATE_MS);
            continue;
        }
        state.lastModeNotice = "";
        updateEconomicMode(corp);

        // Core management - always runs.
        manageUnlocks(corp);

        // Agriculture must exist before anything else can bootstrap.
        if (!bootstrapAgriculture(corp)) {
            writeSnapshot(corp);
            await ns.sleep(UPDATE_MS);
            continue;
        }

        // Chemical: launch once Agri is profitable and we have $70B+ to spend.
        bootstrapChemical(corp);

        // Tobacco: launch once we have $20B+ and Agri is profitable.
        if ((corp.funds ?? 0) > 20e9 && ((corp.revenue ?? 0) - (corp.expenses ?? 0)) > 0) {
            bootstrapTobacco(corp);
        }

        const agriBoostRefill = refreshBoostMaterials(AGRI, corp);
        const chemBoostRefill = refreshBoostMaterials(CHEM, corp);
        const tobBoostRefill = refreshBoostMaterials(TOB, corp);

        manageBuybacks(corp);

        const dynamicMode = useDynamicOptimizer(corp);
        const dynamicSpend = dynamicMode ? manageDynamicSpending(corp) : null;
        if (dynamicSpend) {
            log(`Dynamic spend: ${dynamicSpend}`);
        } else if (!dynamicMode) {
            manageValuationDummies(corp);
            // Global upgrades after divisions are alive.
            if (!recoveryMode(corp)) {
                manageGlobalUpgrades(corp);
            }
        }

        manageDividends(corp);
        logDebugStatus(corp, { agri: agriBoostRefill, chem: chemBoostRefill, tob: tobBoostRefill });
        writeSnapshot(corp);
        await ns.sleep(UPDATE_MS);
    }
}
