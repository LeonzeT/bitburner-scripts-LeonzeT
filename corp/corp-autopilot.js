/** @param {NS} ns **/
export async function main(ns) {
    const flags = ns.flags([
        ["no-tail",   false],
        ["self-fund", false],
        ["debug",     false],
    ]);

    ns.disableLog("ALL");
    if (!flags["no-tail"]) { try { ns.tail(); } catch {} }
    try { ns.clearLog(); } catch {}

    const api = ns.corporation;

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

    // ── State ─────────────────────────────────────────────────────────────────
    const state = {
        readyToIPO:       false,
        lastDividendRate: -1,
        nextProductSeq:   1,
        exportsSetUp:     false,
        agriRpReady:      false,     // true once Agri RP >= 55 in round 1
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

    function log(msg) { ns.print(msg); }

    function money(n) {
        const abs = Math.abs(n);
        if (abs >= 1e15) return `$${(n/1e15).toFixed(3)}q`;
        if (abs >= 1e12) return `$${(n/1e12).toFixed(3)}T`;
        if (abs >= 1e9)  return `$${(n/1e9).toFixed(3)}B`;
        if (abs >= 1e6)  return `$${(n/1e6).toFixed(3)}M`;
        return `$${n.toFixed(0)}`;
    }

    function recoveryMode(corp) { return (corp?.funds ?? 0) < 0; }

    function isPublic(corp) { return !!(corp?.public); }

    // ─────────────────────────────────────────────────────────────────────────
    // Corporation creation
    // ─────────────────────────────────────────────────────────────────────────

    function createCorpIfPossible() {
        if (api.hasCorporation()) return true;
        const player    = safe(() => ns.getPlayer(), { money: 0 });
        const canSeed   = safe(() => api.canCreateCorporation(false), false);
        const canSelf   = safe(() => api.canCreateCorporation(true), false);

        // Outside BN3 selfFund is mandatory; inside BN3 seed money is free equity.
        if (flags["self-fund"] || (canSelf && (player.money ?? 0) >= 150e9)) {
            if (safe(() => api.createCorporation("Nite-Corp", true), false)) {
                log("Created corporation (self-funded)."); return true;
            }
        }
        if (canSeed) {
            if (safe(() => api.createCorporation("Nite-Corp", false), false)) {
                log("Created corporation (seed money)."); return true;
            }
        }
        return false;
    }

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
        if (recoveryMode(corp)) return;
        const funds = corp.funds ?? 0;
        for (const upg of NORMAL_UPGRADES) {
            const level = safe(() => api.getUpgradeLevel(upg.name), 0);
            if (level >= upg.maxLevel) continue;
            const cost = safe(() => api.getUpgradeLevelCost(upg.name), Infinity);
            if (!Number.isFinite(cost)) continue;
            if (funds > cost * upg.spendMult) safe(() => api.levelUpgrade(upg.name));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wilson Analytics + Advert
    // Wilson must be bought BEFORE Advert (not retroactive — multiplies future Advert benefit).
    // Docs: "In round 3+, buy Wilson if you can afford it, then use ≥20% of funds on Advert."
    // ─────────────────────────────────────────────────────────────────────────

    function manageWilsonAndAdverts(divName, corp) {
        if (recoveryMode(corp)) return;
        const funds    = corp.funds ?? 0;
        const revenue  = corp.revenue ?? 0;
        const inRound3 = (safe(() => api.getInvestmentOffer(), null)?.round ?? 0) >= 3
                      || isPublic(corp);

        // Wilson: only worth buying aggressively in round 3+ when we have budget.
        // Its price doubles every level (priceMult=2), so check carefully.
        if (inRound3 || revenue > 1e10) {
            const wilsonCost = safe(() => api.getUpgradeLevelCost(U.wilson), Infinity);
            if (Number.isFinite(wilsonCost) && funds > wilsonCost * 2) {
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

        // Chemical is a support division — keep it small to avoid wasting funds.
        // Docs: "Don't invest much funds on [Chemical's] Office upgrades."
        if (divName === CHEM) return 9;

        if (divName === AGRI) {
            if (rev < 1e8)  return 3;
            if (rev < 1e9)  return city === HQ_CITY ? 9  : 3;
            if (rev < 1e10) return city === HQ_CITY ? 15 : 9;
            if (rev < 1e12) return city === HQ_CITY ? 30 : 15;
            if (rev < 1e14) return city === HQ_CITY ? 45 : 30;
            return city === HQ_CITY ? 60 : 45;
        }

        if (divName === TOB) {
            if (rev < 1e9)  return city === HQ_CITY ? 9  : 3;
            if (rev < 1e10) return city === HQ_CITY ? 18 : 9;
            if (rev < 1e12) return city === HQ_CITY ? 30 : 18;
            if (rev < 1e14) return city === HQ_CITY ? 60 : 30;
            return city === HQ_CITY ? 90 : 45;
        }

        return 9;
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

        for (const city of div.cities ?? []) {
            const office = getOffice(divName, city);
            if (!office) continue;

            const target      = cityTargetSize(divName, city, corp);
            const currentSize = office.size ?? 0;
            const employees   = office.numEmployees ?? 0;

            // Upgrade office size if below target.
            // BUG FIX: getOfficeSizeUpgradeCost takes the INCREASE amount, not the target size.
            if (currentSize < target && !recoveryMode(corp)) {
                const increase = target - currentSize;
                const cost = safe(() => api.getOfficeSizeUpgradeCost(divName, city, increase), Infinity);
                if (Number.isFinite(cost) && (corp.funds ?? 0) > cost * 2) {
                    safe(() => api.upgradeOfficeSize(divName, city, increase));
                }
            }

            // Hire all available slots (no arbitrary cap).
            const afterSize = getOffice(divName, city)?.size ?? currentSize;
            if (employees < afterSize && !recoveryMode(corp)) {
                for (let i = employees; i < afterSize; i++) {
                    safe(() => api.hireEmployee(divName, city, JOBS.unassigned));
                }
            }

            // Buy tea and throw party every cycle to keep energy/morale at max.
            // Docs: "Don't be a cheapskate when it comes to tea/party. Try to maintain
            //        maximum energy/morale at all times."
            safe(() => api.buyTea(divName, city));
            safe(() => api.throwParty(divName, city, 500e3));

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
        const div = getDivision(divName);
        if (!div) return;

        for (const city of div.cities ?? []) {
            const wh = getWarehouse(divName, city);
            if (!wh) {
                // No warehouse yet — buy one.
                if ((corp?.funds ?? 0) > 5e9 && !recoveryMode(corp)) {
                    safe(() => api.purchaseWarehouse(divName, city));
                }
                continue;
            }
            // Upgrade if over 80% full to avoid production stalls.
            const size = wh.size ?? 0;
            if (size > 0 && (wh.sizeUsed ?? 0) / size > 0.80
                    && (corp?.funds ?? 0) > 1e9 && !recoveryMode(corp)) {
                safe(() => api.upgradeWarehouse(divName, city, 1));
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // City / division expansion
    // ─────────────────────────────────────────────────────────────────────────

    function ensureDivision(industry, name, corp, minFunds = 0) {
        if (getDivision(name)) return true;
        if (recoveryMode(corp) || (corp?.funds ?? 0) < minFunds) return false;
        safe(() => api.expandIndustry(industry, name));
        return !!getDivision(name);
    }

    function ensureAllCities(divName, corp, minFunds) {
        const div = getDivision(divName);
        if (!div) return;
        for (const city of CITIES) {
            if (div.cities?.includes(city)) continue;
            if ((corp?.funds ?? 0) < minFunds || recoveryMode(corp)) continue;
            safe(() => api.expandCity(divName, city));
            safe(() => api.purchaseWarehouse(divName, city));
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

        for (const city of CITIES) {
            // Agri → Tobacco (FIRST for FIFO priority): Plants supply for products.
            safe(() => api.exportMaterial(AGRI, city, TOB, city, "Plants", "PROD"));
            // Agri → Chemical: Plants supply for Chemicals production.
            safe(() => api.exportMaterial(AGRI, city, CHEM, city, "Plants", "PROD"));
            // Chemical → Agri: Chemicals supply for Agriculture quality loop.
            safe(() => api.exportMaterial(CHEM, city, AGRI, city, "Chemicals", "PROD"));
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
            safe(() => api.sellProduct(TOB, HQ_CITY, pName, "MAX", "MP", true));
        }

        if (recoveryMode(corp)) return;

        // Design and marketing investment.
        // Docs: "It's fine to spend 1% of your current funds for them. Their exponent is 0.1."
        const invest = Math.max(
            1e8, // $100M minimum so product quality isn't trivially bad
            Math.min((corp.funds ?? 0) * 0.01, 5e9)  // 1% capped at $5B
        );

        const cap = maxProducts(TOB);

        // Start a product if we have a free slot and nothing developing.
        if (names.length < cap && developing.length === 0 && invest >= 1e8) {
            safe(() => api.makeProduct(TOB, HQ_CITY, nextProductName(TOB), invest/2, invest/2));
            return;
        }

        // At cap and nothing developing: cycle — discontinue oldest, start fresh.
        // Docs: "We need to continuously develop new products. New products are almost
        //        always better than the old ones and generate much more profit."
        // No flatProfitTicks gate — always cycle for maximum product improvement.
        if (names.length >= cap && developing.length === 0 && finished.length > 0) {
            let oldest = null, oldestSeq = Infinity;
            for (const pName of finished) {
                const seq = parseInt(pName.slice(7), 10);
                if (Number.isFinite(seq) && seq < oldestSeq) { oldestSeq = seq; oldest = pName; }
            }
            if (oldest && invest >= 1e8) {
                safe(() => api.discontinueProduct(TOB, oldest));
                safe(() => api.makeProduct(TOB, HQ_CITY, nextProductName(TOB), invest/2, invest/2));
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Investment + IPO + Dividends
    // ─────────────────────────────────────────────────────────────────────────

    function shouldAcceptInvestment(offer, corp) {
        const round      = offer?.round ?? 0;
        const funds      = corp?.funds ?? 0;
        const revenue    = corp?.revenue ?? 0;
        const offerFunds = offer?.funds ?? 0;

        if (funds < 0)                  return true;  // Emergency: always accept if in debt
        if (round <= 0 || round > 4)    return false;

        // Hard floors per round — accept as soon as we hit them.
        const floors = { 1: 10e9, 2: 50e9, 3: 250e9, 4: 1e12 };
        if (offerFunds >= (floors[round] ?? Infinity)) return true;

        // Accept if offer beats our cash on hand by the round-dependent multiplier.
        const mults = { 1: 1.8, 2: 1.6, 3: 1.4, 4: 1.2 };
        if (offerFunds >= Math.max(10e9, funds * (mults[round] ?? 1.5))) return true;

        // Accept if offer is worth several hours of revenue.
        const hrs = { 1: 4, 2: 8, 3: 12, 4: 24 };
        if (offerFunds >= revenue * 3600 * (hrs[round] ?? 8)) return true;

        return false;
    }

    function manageInvestments(corp) {
        if (isPublic(corp)) return;
        const offer = safe(() => api.getInvestmentOffer(), null);
        if (!offer) return;

        if (shouldAcceptInvestment(offer, corp)) {
            const ok = safe(() => api.acceptInvestmentOffer(), false);
            if (ok) {
                log(`Accepted round ${offer.round} for ${money(offer.funds ?? 0)}.`);
                if ((offer.round ?? 0) >= 4) state.readyToIPO = true;
            }
        }

        if (state.readyToIPO && !isPublic(corp)) {
            // Docs FAQ: "How many shares should I issue? 0"
            if (safe(() => api.goPublic(0), false)) {
                state.readyToIPO = false;
                state.lastDividendRate = -1;
                log("Went public.");
            }
        }
    }

    function targetDividendRate(corp) {
        if (!isPublic(corp)) return 0;
        const profit = (corp.revenue ?? 0) - (corp.expenses ?? 0);
        const margin = (corp.revenue ?? 0) > 0 ? profit / corp.revenue : 0;
        if (recoveryMode(corp))                                   return 0;
        if (margin > 0.55 && (corp.funds ?? 0) > 1e12)           return 0.25;
        if (margin > 0.30 && (corp.funds ?? 0) > 1e10)           return 0.10;
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
        // Chemical: sell excess Chemicals on market.
        manageMaterialSales(CHEM);
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
            dividendRate: corp?.dividendRate ?? 0,
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

    // ─────────────────────────────────────────────────────────────────────────
    // Main loop
    // ─────────────────────────────────────────────────────────────────────────

    log(`Corp manager started | BN=${safe(() => ns.getResetInfo().currentNode, "?")} | ` +
        `SF10.1=${safe(() => ns.singularity?.getOwnedSourceFiles?.()?.some(s => s.n===10), false)}`);

    ns.atExit(() => { try { ns.write(SNAPSHOT_FILE, "", "w"); } catch {} });

    while (true) {
        if (!api.hasCorporation()) {
            createCorpIfPossible();
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

        // Core management — always runs.
        manageUnlocks(corp);
        manageInvestments(corp);

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

        // Global upgrades after divisions are alive.
        if (!recoveryMode(corp)) {
            manageGlobalUpgrades(corp);
        }

        manageDividends(corp);
        writeSnapshot(corp);
        await ns.sleep(UPDATE_MS);
    }
}