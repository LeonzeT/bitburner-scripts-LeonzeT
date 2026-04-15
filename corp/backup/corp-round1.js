/**
 * Corporation round-1 bootstrap.
 *
 * Handles phases 0-2 only:
 * - create the corporation
 * - build the Agriculture shell and initial boost setup
 * - wait for and accept the round-1 investment
 *
 * When round 1 is done, this script writes phase 3 and chains back to
 * /corp/corp-setup.js.
 *
 * @param {NS} ns
 */
import { formatMoney } from '/helpers.js';
import {
    PRIVATE_STAGE_TARGETS,
    PRIVATE_STAGE_STRETCH_TARGETS,
    clamp,
    formatEta,
    estimateFundsWaitSeconds,
    combineRelativeGains,
    getPrivateOfferThreshold,
} from '/corp/corp-optimizer-shared.js';

// Names
const CORP_NAME = 'Nite-Corp';
const DIV_TOBACCO = 'Tobacco';
const DIV_AGRI = 'Agriculture';
const DIV_CHEM = 'Chemical';
const IND_TOBACCO = 'Tobacco';
const IND_AGRI = 'Agriculture';
const IND_CHEM = 'Chemical';

// Geography
const CITIES = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];
const HQ_CITY = 'Sector-12';
const PHASE3_CHEM_START_CITIES = [HQ_CITY];
const PHASE3_TOB_START_CITIES = [HQ_CITY];
const DELAY_TOBACCO_UNTIL_POST_ROUND2 = true;

// Investment thresholds
// Emergency fallback floor if the main round-1 route underperforms.
const MIN_ROUND1 = 34e9;
const MIN_ROUND2 = 5e12;
const ROUND2_INVESTMENT_SHARE_PCT = 0.35;
const ROUND2_INVESTMENT_MULTIPLIER = 2;
const ROUND2_EFFECTIVE_OFFER_MULT = ROUND2_INVESTMENT_SHARE_PCT * ROUND2_INVESTMENT_MULTIPLIER;
const ROUND2_OW_MULT_BASE = 1.0079741404289038;
const ROUND1_USE_CUSTOM_SUPPLY = true;
const ROUND1_SUPPLY_BUFFER_CYCLES = 2.5;
const ROUND1_SUPPLY_SEED = { Water: 75, Chemicals: 30 };
const ROUND2_BN3_AGRI_INPUT_CAP_MULT = 1.5;
const ROUND2_BN3_AGRI_INPUT_PRESSURE_PCT = 0.90;
const ROUND1_ROUTE_TARGET = 435e9;
const ROUND1_ROUTE_SOFT_FLOOR = 420e9;
const ROUND1_ROUTE_STAGNATION_LIMIT = 36;
const ROUND1_ROUTE_FREEZE_RATIO = 0.98;
const ROUND1_ROUTE_SMART_STORAGE_TARGET = 4;
const ROUND1_ROUTE_ADVERT_TARGET = 5;
const ROUND1_ROUTE_WAREHOUSE_TARGET = 6;
const ROUND1_ROUTE_PREBOOST_WAREHOUSE = ROUND1_ROUTE_WAREHOUSE_TARGET;
const ROUND1_ROUTE_DYNAMIC_BOOST_MAX_TOTAL_USAGE_PCT = 0.985;
const ROUND1_ROUTE_INITIAL_BOOST_MAX_TOTAL_USAGE_PCT = 0.96;
const ROUND1_ROUTE_INITIAL_BOOST_PROD_CYCLES = 0.55;
const ROUND1_ROUTE_INITIAL_BOOST_INPUT_LEEWAY = 1.15;
const ROUND1_ROUTE_INITIAL_BOOST_SAFETY_PCT = 0.015;
const ROUND1_ROUTE_INITIAL_BOOST_MIN_INPUT_SPACE = 60.48;
const ROUND1_ROUTE_INITIAL_SUPPLY_SPACE = { Water: 54, Chemicals: 21.6 };
const ROUND1_ROUTE_INITIAL_BOOST_EXPECTED_RATIO_CAP = 2.5;
const ROUND1_ROUTE_INITIAL_BOOST_DEBT = 50e9;
const ROUND1_ROUTE_INITIAL_BOOST_SCALE_CAP = 0.90;
const ROUND1_ROUTE_INITIAL_BOOST_CHUNK_FRACTION = 0.45;
const ROUND1_ROUTE_INITIAL_BOOST_MAX_PASSES = 6;
const ROUND1_ROUTE_DYNAMIC_BOOST_PROD_CYCLES = 0.35;
const ROUND1_ROUTE_DYNAMIC_BOOST_PROD_LEEWAY = 1.08;
const ROUND1_ROUTE_DYNAMIC_BOOST_INPUT_LEEWAY = 1.08;
const ROUND1_ROUTE_DYNAMIC_BOOST_SAFETY_PCT = 0.01;
const ROUND1_ROUTE_PREBOOST_SURPLUS_ADVERT_TARGET = 5;
const ROUND1_ROUTE_PREBOOST_SURPLUS_SMART_FACTORIES_TARGET = 1;
const ROUND1_ROUTE_PREBOOST_SURPLUS_SMART_STORAGE_TARGET = ROUND1_ROUTE_SMART_STORAGE_TARGET;
const ROUND1_ROUTE_PREBOOST_SURPLUS_SALES_BOTS_TARGET = 4;
const ROUND1_ROUTE_PREBOOST_SURPLUS_FOCUS_WIRES_TARGET = 1;
const ROUND1_ROUTE_PREBOOST_CASH_FLOOR = 0;
const ROUND1_SMART_STORAGE_COST_MULT = 1.06;
const ROUND1_ADVERT_COST_MULT = 1.06;
const ROUND1_ROUTE_PREP_RESERVE_BUFFER = 0.25e9;
const ROUND1_ROUTE_STARTUP_SUPPLY_BUFFER_CYCLES = 3.0;
const ROUND1_ROUTE_AGRI_SUPPLY_BUFFER_CYCLES = 3.0;
const ROUND1_ROUTE_LATE_WINDOW_SOFT_FLOOR_PCT = 0.90;
const ROUND1_REINVEST_STRETCH_TRIGGER = 235e9;
const ROUND1_REINVEST_STRETCH_STAGNATION = 8;
const ROUND1_REINVEST_OFFICE = 6;
const ROUND1_REINVEST_OFFICE_STRETCH = 8;
const ROUND1_REINVEST_WAREHOUSE = 6;
const ROUND1_REINVEST_ADVERT = 6;
const ROUND1_REINVEST_ADVERT_STRETCH = 7;
const ROUND1_REINVEST_SMART_FACTORIES = 2;
const ROUND1_REINVEST_SMART_FACTORIES_STRETCH = 4;
const ROUND1_REINVEST_SMART_STORAGE = 5;
const ROUND1_REINVEST_RESERVE_MIN = 6e9;
const ROUND1_REINVEST_TRIGGER = 230e9;
const ROUND1_REINVEST_TRIGGER_STAGNATION = 10;
const ROUND1_REINVEST_MAX_ACTIONS = 2;
const ROUND1_REINVEST_MAX_CAPACITY_ACTIONS = 1;
const ROUND1_REINVEST_MATERIAL_DEBT = 24e9;
const ROUND1_REINVEST_MATERIAL_DEBT_STRETCH = 40e9;
const ROUND1_REINVEST_BOOST_TOPUP_TRIGGER = 400e9;
const ROUND1_REINVEST_BOOST_TOPUP_STAGNATION = 24;
const ROUND1_REINVEST_BOOST_TOPUP_STAGNATION_TRIGGER_PCT = 0.995;
const ROUND1_REINVEST_BOOST_TOPUP_MAX_USAGE_PCT = 0.84;
const ROUND1_REINVEST_BOOST_TOPUP_MAX_PEAK_PCT = 0.88;
const ROUND1_REINVEST_BRIDGE_TOPUP_TRIGGER = 384e9;
const ROUND1_REINVEST_BRIDGE_TOPUP_NEAR_BEST_PCT = 0.99;
const ROUND1_REINVEST_BRIDGE_TOPUP_MAX_USAGE_PCT = 0.83;
const ROUND1_REINVEST_BRIDGE_TOPUP_MAX_PEAK_PCT = 0.86;
const ROUND1_REINVEST_BRIDGE_TOPUP_MAX_SPEND = 1.0e9;
const ROUND1_ROUTE_FIXED_INITIAL_BOOST_USAGE_PCT = 0.78;
const ROUND1_RE_PUSH_USAGE_PCT = 0.80;
const ROUND1_RE_PUSH_MIN_SPEND = 1e9;
const ROUND1_RE_PUSH_MAX_SPEND = 1.25e9;
const ROUND1_RE_PUSH_MAX_SPEND_STRETCH = 4e9;
const ROUND1_RE_PUSH_OFFER_PCT = 0.97;
const ROUND1_RE_PUSH_SETTLE_CHECKS = 6;
const ROUND1_ROUTE_BOOST_TRIM_PRESSURE_PCT = 0.985;
const ROUND1_ROUTE_BOOST_TRIM_PREDICTIVE_PCT = 0.965;
const ROUND1_ROUTE_BOOST_TRIM_RELEASE_PCT = 0.93;
const ROUND1_ROUTE_BOOST_TRIM_KEEP_RATIO = 0.85;
const ROUND1_ROUTE_BOOST_TRIM_STAGGER_LIMIT = 2;
const ROUND1_ROUTE_BOOST_FULL_TRIGGER_PREDICTIVE_PCT = 0.999;
const ROUND1_ROUTE_BOOST_FULL_TRIGGER_MIN_USAGE_PCT = 0.90;
const ROUND1_ROUTE_BOOST_PRESSURE_SUPPLY_BUFFER_CYCLES = 2.25;
const ROUND1_ROUTE_BOOST_PRETRIM_TRIGGER_USAGE_PCT = 0.90;
const ROUND1_ROUTE_BOOST_PRETRIM_TRIGGER_PREDICTIVE_PCT = 0.965;
const ROUND1_ROUTE_BOOST_PRETRIM_MIN_USAGE_FOR_PREDICTIVE_PCT = 0.85;
const ROUND1_ROUTE_BOOST_PRETRIM_TARGET_USAGE_PCT = 0.94;
const ROUND1_ROUTE_BOOST_PRETRIM_TARGET_PREDICTIVE_PCT = 0.985;
const ROUND1_ROUTE_BOOST_PRETRIM_RELEASE_PCT = 0.84;
const ROUND1_ROUTE_BOOST_PRETRIM_RELEASE_PREDICTIVE_PCT = 0.94;
const ROUND1_ROUTE_BOOST_PRETRIM_KEEP_RATIO = 0.94;
const ROUND1_ROUTE_BOOST_REFILL_START_PCT = 0.88;
const ROUND1_ROUTE_BOOST_REFILL_USAGE_PCT = 0.975;
const ROUND1_ROUTE_BOOST_REFILL_NEAR_BEST_PCT = 0.97;
const ROUND1_ROUTE_BOOST_REFILL_STAGNATION = 0;
const ROUND1_ROUTE_BOOST_REFILL_PROD_CYCLES = 1.0;
const ROUND1_ROUTE_BOOST_REFILL_PROD_LEEWAY = 1.08;
const ROUND1_ROUTE_BOOST_PRESERVE_SOFT_FLOOR_PCT = 0.85;
const ROUND1_ROUTE_BOOST_PRESERVE_NEAR_BEST_PCT = 0.90;
const ROUND1_ROUTE_BOOST_PRESERVE_MAX_STAGNATION = 6;
const ROUND1_ROUTE_FROZEN_ACCEPT_TARGET_PCT = 0.985;
const ROUND1_ROUTE_FROZEN_ACCEPT_NEAR_BEST_PCT = 0.995;
const ROUND1_ROUTE_FROZEN_ACCEPT_MIN_STAGNATION = 1;
const ROUND1_ROUTE_BOOST_TRIM_ORDER = ['Real Estate', 'AI Cores', 'Hardware'];
const ROUND1_ROUTE_BOOST_TRIM_SIZES = Object.freeze({
    'Real Estate': 0.005,
    'AI Cores': 0.1,
    'Hardware': 0.06,
});
const PHASE3_CHEM_MIN_RESERVE = 18e9;
const PHASE3_CHEM_MID_RESERVE = 30e9;
const PHASE3_CHEM_FREEZE_GAP = 8e9;
const PHASE3_AGRI_TARGET_OFFICE = 8;
const PHASE3_AGRI_TARGET_WAREHOUSE = 8;
const PHASE3_AGRI_TARGET_ADVERT = 8;
const PHASE3_AGRI_GLOBAL_UPGRADE_TARGET = 6;
const PHASE3_CHEM_INITIAL_OFFICE = 3;
const PHASE3_CHEM_INITIAL_WAREHOUSE = 2;
const PHASE3_TOB_INITIAL_HQ_OFFICE = 6;
const PHASE3_EXPORT_RESERVE = 2e9;
const PHASE3_CHEM_WATER_SEED = 120;
const PHASE3_CHEM_WATER_BUFFER_CYCLES = 3;
const ROUND2_AGRI_OFFICE = 8;
const ROUND2_AGRI_WAREHOUSE = 4;
const ROUND2_AGRI_ADVERT = 8;
const ROUND2_AGRI_SMALL_JOBS = { ops: 1, eng: 1, rnd: 2 };
const ROUND2_AGRI_PRODUCTION_JOBS = { ops: 1, eng: 1, biz: 1, mgmt: 1 };
const ROUND2_AGRI_JOBS = { ops: 1, eng: 2, biz: 1, mgmt: 1, rnd: 3 };
const ROUND2_CLASSIC_AGRI_OFFICE = 9;
const ROUND2_CLASSIC_AGRI_WAREHOUSE = 10;
const ROUND2_CLASSIC_AGRI_JOBS = { ops: 2, eng: 2, biz: 1, mgmt: 2, rnd: 2 };
const ROUND2_CLASSIC_AGRI_MID_JOBS = { ops: 2, eng: 2, biz: 1, mgmt: 1, rnd: 2 };
const ROUND2_CLASSIC_AGRI_POSTFILL_SALES_JOBS = { ops: 2, eng: 2, biz: 3, mgmt: 2 };
const ROUND2_CLASSIC_AGRI_POSTFILL_SALES_MID_JOBS = { ops: 2, eng: 2, biz: 2, mgmt: 2 };
const ROUND2_BN3_SALESBOT_TARGET = 5;
const ROUND2_BN3_SALESBOT_BUFFER = 10e9;
const ROUND2_BN3_POSTFILL_SMART_STORAGE_TARGET = 12;
const ROUND2_BN3_POSTFILL_STORAGE_AVG_PCT = 0.90;
const ROUND2_BN3_POSTFILL_STORAGE_PEAK_PCT = 0.98;
const ROUND2_BN3_POSTFILL_STORAGE_BUFFER = 8e9;
const ROUND2_BN3_HIGH_BUDGET_PRESSURE_SUPPORT_PCT = 0.93;
const ROUND2_BN3_HIGH_BUDGET_PRESSURE_FULL_SUPPORT_PCT = 0.985;
const ROUND2_BN3_HIGH_BUDGET_PRESSURE_STOCK_CYCLES = 30;
const ROUND2_BN3_HIGH_BUDGET_PRESSURE_STOCK_CYCLES_FULL = 55;
const ROUND2_BN3_HIGH_BUDGET_PRESSURE_SALESBOT_TARGET = 8;
const ROUND2_BN3_HIGH_BUDGET_PRESSURE_SMART_STORAGE_TARGET = 16;
const ROUND2_BN3_HIGH_BUDGET_PRESSURE_WAREHOUSE_TARGET = 12;
const ROUND2_BN3_HIGH_BUDGET_PRESSURE_WAREHOUSE_TARGET_FULL = 14;
const ROUND2_BN3_HIGH_BUDGET_EARLY_PRESSURE_WH_PCT = 0.88;   // per-city trigger (below 93% aggregate threshold)
const ROUND2_BN3_HIGH_BUDGET_EARLY_PRESSURE_WH_CAP = 13;     // max level before aggregate pressure takes over
const ROUND2_BN3_HIGH_BUDGET_EARLY_PRESSURE_WH_BUFFER = 2e9; // $2B above reserve accumulate before spending
const ROUND2_BN3_HIGH_BUDGET_EARLY_PRESSURE_WH_MIN_PROFIT = 7e6; // $7M/s profit floor don't buy on thin income
const ROUND2_BN3_HIGH_BUDGET_PLANT_RELIEF_PCT = 0.85;        // warehouse threshold to start selling Plants
const ROUND2_BN3_HIGH_BUDGET_CHEM_PLANT_BUFFER = 1000;       // Plants to keep in Chem for next production cycle
const ROUND2_BN3_HIGH_BUDGET_TOB_PLANT_BUFFER = 2000;        // larger buffer for Tobacco product speed is sensitive
const ROUND2_BN3_PRESSURE_RELIEF_MATERIAL_TARGETS = { 'Hardware': 2240, 'Robots': 77, 'AI Cores': 2016, 'Real Estate': 117120 };
const ROUND2_BN3_LATE_SPIKE_MATERIAL_TARGETS = { 'Hardware': 2800, 'Robots': 96, 'AI Cores': 2520, 'Real Estate': 146400 };
const ROUND2_BN3_LATE_SALESBOT_TARGET = 5;
const ROUND2_BN3_LATE_SALESBOT_BUFFER = 4e9;
const ROUND2_BN3_LATE_POSTFILL_SMART_STORAGE_TARGET = 14;
const ROUND2_BN3_LATE_POSTFILL_STORAGE_BUFFER = 1e9;
const ROUND2_TOB_HQ_OFFICE = 15;
const ROUND2_TOB_SUPPORT_OFFICE = 3;
const ROUND2_TOB_ADVERT = 2;
const ROUND2_TOB_HQ_SMALL_JOBS = { ops: 1, eng: 3, biz: 1, mgmt: 1 };
const ROUND2_TOB_HQ_MID_JOBS = { ops: 2, eng: 4, biz: 1, mgmt: 2 };
const ROUND2_CHEM_OFFICE = 3;
const ROUND2_TOB_HQ_JOBS = { ops: 3, eng: 7, biz: 1, mgmt: 4 };
const ROUND2_TOB_SUPPORT_JOBS = { rnd: 3 };
const ROUND2_CHEM_JOBS = { eng: 1, rnd: 2 };
const ROUND2_TOB_HQ_OFFICE_AGGR = 18;
const ROUND2_TOB_HQ_JOBS_AGGR = { ops: 3, eng: 8, biz: 1, mgmt: 4, rnd: 2 };
const ROUND2_TOB_SUPPORT_OFFICE_AGGR = 9;
const ROUND2_TOB_SUPPORT_JOBS_AGGR = { eng: 1, mgmt: 1, rnd: 7 };
const ROUND2_CHEM_OFFICE_AGGR = 6;
const ROUND2_CHEM_JOBS_AGGR = { ops: 1, eng: 2, mgmt: 1, rnd: 2 };
const ROUND2_CHEM_JOBS_SMALL = { ops: 1, eng: 1, rnd: 1 };
const ROUND2_CHEM_JOBS_MID = { ops: 1, eng: 2, rnd: 1 };
const ROUND2_BN3_HIGH_BUDGET_CHEM_JOBS_SMALL = { ops: 1, eng: 1, rnd: 1 };
const ROUND2_BN3_HIGH_BUDGET_CHEM_JOBS_MID = { ops: 1, eng: 1, mgmt: 1, rnd: 1 };
const ROUND2_BN3_HIGH_BUDGET_CHEM_JOBS_BASE = { ops: 1, eng: 2, mgmt: 1, rnd: 1 };
const ROUND2_CHEM_BOOTSTRAP_SUPPORT_CITIES = 2;
const ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_POSTDONE = 9;
const ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_PRESSURE = 12;
const ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_PRESSURE_FULL = 18;
const ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_WAREHOUSE_POSTDONE = 5;
const ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_WAREHOUSE_PRESSURE = 6;
const ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_WAREHOUSE_PRESSURE_FULL = 8;
const ROUND2_BN3_HIGH_BUDGET_CHEM_OFFICE_POSTDONE = 6;
const ROUND2_BN3_HIGH_BUDGET_CHEM_OFFICE_PRESSURE = 9;
const ROUND2_BN3_HIGH_BUDGET_CHEM_OFFICE_PRESSURE_FULL = 12;
const ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_BUILDOUT = 12;
const ROUND2_BN3_HIGH_BUDGET_CHEM_OFFICE_BUILDOUT = 9;
const ROUND2_BN3_HIGH_BUDGET_CHEM_OFFICE_PRELAUNCH = 3;              // minimum viable Chem city size
const ROUND2_BN3_HIGH_BUDGET_BOOST_MAT_SAFETY_MULT = 5;              // during RE/AI liquidation: cap gating profit at 5expenses
const ROUND2_BN3_HIGH_BUDGET_SCALE_RATIO_MID = 5;                    // advance to mid office size when trueProfit > 5total overhead
const ROUND2_BN3_HIGH_BUDGET_SCALE_RATIO_FULL = 10;                  // advance to max office size when trueProfit > 10overhead (includes morale)
const ROUND2_BN3_HIGH_BUDGET_MORALE_COST_PER_OFFICE_S = 22e3;        // estimated tea+party cost per 9+ office per second
// Agri dynamic office sizing (high-budget buildout)
const ROUND2_BN3_HIGH_BUDGET_AGRI_OFFICE_PRELAUNCH = 6;              // min during buildout Agri is revenue engine, needs 2 per role
const ROUND2_BN3_HIGH_BUDGET_AGRI_OFFICE_FULL = 9;                   // classic Agri target (same as ROUND2_CLASSIC_AGRI_OFFICE)
// Tobacco HQ dynamic office sizing (high-budget buildout)
const ROUND2_BN3_HIGH_BUDGET_TOB_HQ_PRELAUNCH = 6;                   // small dev team during early buildout
const ROUND2_BN3_HIGH_BUDGET_TOB_HQ_MID = 9;                         // better dev speed at moderate profit
const ROUND2_BN3_HIGH_BUDGET_TOB_HQ_FULL = 15;                       // full team when profit comfortably covers overhead
// Tobacco support dynamic office sizing (high-budget buildout)
const ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_PRELAUNCH = 3;              // pre-v1 R&D-only city
const ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_MID = 6;                    // moderate production/R&D mix
const ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_FULL = 9;                   // full support once profit is solid
// Aliases kept for backward compat with existing Chem references
const ROUND2_BN3_HIGH_BUDGET_CHEM_SCALE_RATIO_MID  = ROUND2_BN3_HIGH_BUDGET_SCALE_RATIO_MID;
const ROUND2_BN3_HIGH_BUDGET_CHEM_SCALE_RATIO_FULL = ROUND2_BN3_HIGH_BUDGET_SCALE_RATIO_FULL;
const ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_WAREHOUSE_BUILDOUT = 4;
const ROUND2_BN3_HIGH_BUDGET_CHEM_WAREHOUSE_POSTDONE = 4;
const ROUND2_BN3_HIGH_BUDGET_CHEM_WAREHOUSE_PRESSURE = 5;
const ROUND2_BN3_HIGH_BUDGET_CHEM_WAREHOUSE_PRESSURE_FULL = 6;
const ROUND2_BN3_HIGH_BUDGET_CHEM_WAREHOUSE_BUILDOUT = 3;
const ROUND2_RESERVE_MIN = 45e9;
const ROUND2_RESERVE_MID = 75e9;
const ROUND2_RESERVE_HIGH = 105e9;
const ROUND2_RESERVE_PEAK = 130e9;
const ROUND2_FREEZE_BEST_OFFER = 1.25e12;
const ROUND2_TOB_SUPPORT_TRIGGER = 4e11;
const ROUND2_AGRI_OFFICE_TRIGGER = 3.5e11;
const ROUND2_CHEM_FULL_TRIGGER = 8e11;
const ROUND2_DUMMY_TRIGGER = 2.2e11;
const ROUND2_DUMMY_STAGNATION_LIMIT = 2;
const ROUND2_DUMMY_BUFFER = 60e9;
const ROUND2_GLOBAL_UPGRADE_TARGET = 8;
const ROUND2_GLOBAL_UPGRADE_TARGET_LATE = 10;
const ROUND2_AGRI_WAREHOUSE_LATE = 10;
const ROUND2_LATE_PUSH_TRIGGER = 8e11;
const ROUND2_LATE_PUSH_RESERVE = 20e9;
const ROUND2_LATE_PUSH_RESERVE_PCT = 0.30;
const ROUND2_LATE_PUSH_STAGNATION = 6;
const ROUND2_LATE_PUSH_FORCE_TRIGGER = 1.5e12;
const ROUND2_LATE_DUMMY_TRIGGER = 9e11;
const ROUND2_STAGNATION_ABS = 10e9;
const ROUND2_STAGNATION_PCT = 0.01;
const ROUND2_CLASSIC_RESERVE = 2e9;
const ROUND2_CLASSIC_RESERVE_PCT = 0.05;
const ROUND2_CLASSIC_DUMMY_TRIGGER = 2.5e12;
const ROUND2_CLASSIC_DUMMY_STAGNATION = 10;
const ROUND2_BN3_RESERVE = 2e9;
const ROUND2_BN3_RESERVE_PCT = 0.05;
const ROUND2_BN3_SMART_TARGET = 10;
const ROUND2_BN3_MATERIAL_TARGETS = { 'Hardware': 2520, 'Robots': 86, 'AI Cores': 2268, 'Real Estate': 131760 }; // lowered from 2800/96/2520/146400: old classic targets were overshooting warehouse capacity and triggering pressure relief on every refill, causing a repeated ~15-20% offer crash
const ROUND2_BN3_HEADROOM_MATERIAL_TARGETS = { 'Hardware': 2240, 'Robots': 77, 'AI Cores': 2016, 'Real Estate': 117120 }; // lowered from 2520/86/2268/131760: shifted one tier down alongside the classic targets
const ROUND2_BN3_RE_PUSH_USAGE_PCT = 0.85;
const ROUND2_BN3_RE_PUSH_MIN_SPEND = 1e9;
const ROUND2_BN3_DUMMY_TRIGGER = 1.8e12;
const ROUND2_BN3_DUMMY_BUFFER = 5e9;
const ROUND2_BN3_DUMMY_MAX = 1;
const ROUND2_BN3_LEAN_TOB_HQ_OFFICE = 9;
const ROUND2_BN3_LEAN_TOB_ADVERT = 1;
const ROUND2_BN3_HIGH_BUDGET_TOB_ADVERT = 5; // new: high-budget path has the funds to buy more adverts; 2 was leaving Tobacco with near-zero awareness and tobSell=0.0/s
const ROUND2_BN3_LEAN_TOB_PRODUCT_RESERVE = 5e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT = 0.0075;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_POSTDONE = 0.03;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_PCT_LATE = 0.04;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP = 3e9; // raised from 1e9: double-budget runs have ~2-4more funds at product creation time, so a higher cap produces a better v1 quality multiplier
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_POSTDONE = 2.5e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_CAP_LATE = 5e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_POSTDONE = 5e8;
const ROUND2_BN3_LEAN_TOB_PRODUCT_INVEST_MIN_LATE = 2.5e9;
const ROUND2_BN3_HIGH_BUDGET_FUNDS_TRIGGER = 300e9;
const ROUND2_BN3_HIGH_BUDGET_RESERVE = 10e9;
const ROUND2_BN3_HIGH_BUDGET_RESERVE_PCT = 0.08;
const ROUND2_BN3_HIGH_BUDGET_POSTFILL_RESERVE = 0.25e9;
const ROUND2_BN3_HIGH_BUDGET_POSTFILL_RESERVE_PCT = 0.01;
const ROUND2_BN3_HIGH_BUDGET_BUILDOUT_HEALTHY_OFFER = 250e9;
const ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_FUNDS = 5e9;
const ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_PROFIT = 10e6;
const ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_MARGIN = 0.30;
const ROUND2_BN3_HIGH_BUDGET_BUILDOUT_RECOVERY_RESERVE = 1e9;
const ROUND2_BN3_HIGH_BUDGET_BUILDOUT_RECOVERY_RESERVE_PCT = 0.10;
const ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_WEAK = 1;
const ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_STABLE = 2;
const ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_HEALTHY = 4;
// Post-liquidation stagnation baseline reset: the boost-mat sell-off generates a
// temporary revenue spike that inflates lastMeaningfulRound2Offer far above the real
// post-liquidation baseline. Once boost mats are gone and the offer has dropped more
// than 60% below the watermark for 50+ cycles, rebase the watermark to the current
// offer so stagnation reflects the actual trajectory (not the liquidation spike).
const ROUND2_BN3_HIGH_BUDGET_POSTLIQ_RESET_STAGNATION = 50;
const ROUND2_BN3_HIGH_BUDGET_POSTLIQ_RESET_RATIO = 0.40;
const ROUND2_BN3_HIGH_BUDGET_SPIKE_PRODUCT_VERSION = 5;
const ROUND2_BN3_HIGH_BUDGET_SPIKE_DEBT_RECOVERY_SECS = 180;
const ROUND2_BN3_HIGH_BUDGET_SPIKE_DEBT_MIN = 5e9;
const ROUND2_BN3_HIGH_BUDGET_SPIKE_DEBT_MAX = 25e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RESERVE = 8e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT = 0.005;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT_POSTDONE = 0.0125;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_PCT_LATE = 0.02;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP = 1e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP_POSTDONE = 2.5e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_CAP_LATE = 5e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN = 5e8;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN_POSTDONE = 1e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_INVEST_MIN_LATE = 2.5e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_TRIGGER = 400e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_FUNDS = 12e9;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_PROFIT = 10e6;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_MARGIN = 0.30;
const ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_STAGNATION = 18;
const ROUND2_BN3_HIGH_BUDGET_EARLY_WILSON_TARGET = 1;
const ROUND2_BN3_HIGH_BUDGET_TOB_NEAR_COMPLETION_PROGRESS = 85;
const ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_PROGRESS = 80;
const ROUND2_BN3_HIGH_BUDGET_TOB_SUPPORT_TRIGGER = 9e11;
const ROUND2_BN3_HIGH_BUDGET_CHEM_SUPPORT_PROGRESS = 70;
const ROUND2_BN3_HIGH_BUDGET_CHEM_SUPPORT_TRIGGER = 8.5e11;
const ROUND2_BN3_HIGH_BUDGET_FULL_SUPPORT_PROGRESS = 95;
const ROUND2_BN3_HIGH_BUDGET_FULL_SUPPORT_TRIGGER = 2.2e12;
const ROUND2_BN3_HIGH_BUDGET_SMART_SUPPLY_TRIGGER = 7e11;
const ROUND2_BN3_LEAN_TOB_SUPPORT_TRIGGER = 2.6e12;
const ROUND2_BN3_LEAN_TOB_SUPPORT_STAGNATION = 6;
const ROUND2_BN3_LEAN_TOB_SUPPORT_MIN_CASH = 5e8;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_TRIGGER = 2.75e12;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_STAGNATION = 8;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_OFFICE = 12;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_ADVERT = 2;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_BUFFER = 4e9;
const ROUND2_BN3_LEAN_TOB_HQ_PUSH_ADVERT_BUFFER = 8e9;
const CORP_TEA_COST = 500e3;
const CORP_MORALE_PARTY_SPEND_MIN = 100e3;
const CORP_MORALE_PARTY_SPEND_MAX = 250e3;
const CORP_MORALE_UPKEEP_MIN_FUNDS = 50e6;
const CORP_MORALE_UPKEEP_RESERVE_SECS = 60;
const CORP_MORALE_THRESHOLD = 98;
const CORP_ENERGY_THRESHOLD = 98;
const CORP_MORALE_ACTION_COOLDOWN_MS = 30_000;
// Push Smart Storage to this level before the debt-spike phase begins.
// Higher Smart Storage = larger warehouses = more boost mats fit = bigger offer.
const ROUND2_BN3_LEAN_TOB_SPIKE_SMART_STORAGE = 20;
// Allow up to this much debt during the spike fill. Investment received will
// vastly exceed the debt, so 400B is a generous but safe ceiling.
const ROUND2_BN3_LEAN_TOB_SPIKE_DEBT_MAX = 400e9;
// Morale/energy crisis thresholds for spike mode. Normal threshold is 98;
// during the spike we can't afford normal upkeep only prevent collapse.
const CORP_SPIKE_ENERGY_THRESHOLD = 45;
const CORP_SPIKE_MORALE_THRESHOLD = 55;
// Pre-spike dummy divisions: how many total dummies to have before the spike
// begins (1.1^(2+N) divMult each extra dummy is ~10% more on the offer).
const ROUND2_BN3_LEAN_TOB_SPIKE_DUMMY_TARGET = 3;
// Cash buffer above reserve when creating pre-spike dummies.
const ROUND2_BN3_LEAN_TOB_SPIKE_DUMMY_BUFFER = 5e9;
// Cycles to wait after the last dummy is created before unlocking the spike.
// Gives the offer time to absorb the cash dip from dummy creation.
const ROUND2_BN3_LEAN_TOB_SPIKE_DUMMY_SETTLE = 15;
const ROUND2_BN3_LEAN_TOB_PREFILL_HQ_TRIGGER = 2.0e12;
const ROUND2_BN3_LEAN_TOB_PREFILL_HQ_STAGNATION = 4;
const ROUND2_BN3_LEAN_TOB_PREFILL_HQ_BUFFER = 4e9;
const ROUND2_BN3_LEAN_TOB_PREFILL_ADVERT_BUFFER = 8e9;
const ROUND2_BN3_LATE_VALUATION_TRIGGER = 2.4e12;
const ROUND2_BN3_LATE_VALUATION_STAGNATION = 8;
const ROUND2_BN3_LATE_WILSON_TARGET = 1;
const ROUND2_BN3_LATE_WILSON_BOOST_TARGET = 2;
const ROUND2_BN3_LATE_WILSON_BUFFER = 2e9;
const ROUND2_BN3_DYNAMIC_LATE_INTERVAL = 6;
const ROUND2_BN3_DYNAMIC_SETTLE_CHECKS = 10;
const ROUND2_BN3_DYNAMIC_WAIT_HORIZON_SEC = 180;
const ROUND2_BN3_DYNAMIC_PACKAGE_MAX = 3;
const ROUND2_BN3_DYNAMIC_WAIT_EDGE = 1.12;
const ROUND2_BN3_DYNAMIC_NEAR_PEAK_RATIO = 0.985;
const ROUND2_BN3_DYNAMIC_NEAR_PEAK_BIG_SPEND_PCT = 0.55;
const ROUND2_BN3_DYNAMIC_NEAR_PEAK_MIN_REL_GAIN = 0.025;
const ROUND2_BN3_DYNAMIC_RECOVERY_RATIO = 0.985;
const ROUND2_BN3_DYNAMIC_RECOVERY_STAGNATION = 30;
const ROUND2_BN3_PEAK_STABILIZE_RATIO = 0.985;
const ROUND2_BN3_PEAK_STABILIZE_MAX_STAGNATION = 8;
const ROUND2_BN3_PEAK_STABILIZE_DUMMY_TRIGGER = 2.75e12;
const ROUND2_BN3_PEAK_STABILIZE_DUMMY_MAX_SPEND_PCT = 0.45;
const ROUND2_BN3_LATE_EMPLOYEE_UPGRADE_TARGET = 1;
const ROUND2_BN3_LATE_EMPLOYEE_UPGRADES = [
    'FocusWires',
    'Neural Accelerators',
    'Speech Processor Implants',
    'Nuoptimal Nootropic Injector Implants',
];
const ROUND2_BN3_TOB_ADVERTISING_FACTOR = 0.2;
const ROUND2_BN3_TOB_DEV_VALUE_WEIGHT = 0.03;
const ROUND2_BN3_EMPLOYEE_UPGRADE_ROLE_GAINS = {
    FocusWires: { ops: 0.03125, eng: 0.0277777778, biz: 0, mgmt: 0.0179487179, rnd: 0.0131578947 },
    'Neural Accelerators': { ops: 0.01875, eng: 0.0277777778, biz: 0.0210526316, mgmt: 0, rnd: 0.0394736842 },
    'Speech Processor Implants': { ops: 0.003125, eng: 0.0027777778, biz: 0.0526315789, mgmt: 0.0512820513, rnd: 0 },
    'Nuoptimal Nootropic Injector Implants': { ops: 0.015625, eng: 0, biz: 0, mgmt: 0.0051282051, rnd: 0.0263157895 },
};
const ROUND2_BN3_LATE_TOB_ADVERT_TARGET = 3;
const ROUND2_BN3_LATE_TOB_ADVERT_BUFFER = 4e9;
const ROUND2_BN3_LATE_TOB_ADVERT4_TRIGGER = 2.8e12;
const ROUND2_BN3_LATE_TOB_ADVERT4_STAGNATION = 20;
const ROUND2_BN3_LATE_TOB_ADVERT5_TRIGGER = 3.3e12;
const ROUND2_BN3_LATE_TOB_ADVERT5_STAGNATION = 40;
const ROUND2_BN3_LATE_TOB_ADVERT6_TRIGGER = 3.8e12;
const ROUND2_BN3_LATE_TOB_ADVERT6_STAGNATION = 60;
const ROUND2_BN3_LATE_SECOND_DUMMY_TRIGGER = 2.75e12;
const ROUND2_BN3_LATE_SECOND_DUMMY_STAGNATION = 12;
const ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_TOLERANCE = 1e9;
const ROUND2_BN3_LEAN_TOB_PRODUCT_CYCLE_STAGNATION = 12;
const ROUND2_BN3_LEAN_TOB_PRODUCT_FREEZE_VERSION = 6;
const ROUND2_BN3_LEAN_TOB_SPEED_HQ_TRIGGER = 1.0e12;
const ROUND2_BN3_LEAN_TOB_SPEED_HQ_STAGNATION = 6;
const ROUND2_BN3_LEAN_TOB_SPEED_HQ_PROGRESS = 35;
const ROUND2_BN3_LEAN_TOB_SPEED_HQ_OFFICE = 18;
const ROUND2_BN3_LEAN_TOB_SPEED_HQ_BUFFER = 8e9;
const ROUND2_BN3_LEAN_TOB_SPEED_ADVERT_BUFFER = 16e9;
const ROUND2_BN3_LEAN_TOB_EARLY_SUPPORT_TRIGGER = 1.0e12;
const ROUND2_BN3_LEAN_TOB_EARLY_SUPPORT_STAGNATION = 6;
const ROUND2_BN3_LEAN_TOB_EARLY_SUPPORT_PROGRESS = 85;
const ROUND2_BN3_LEAN_TOB_EARLY_SUPPORT_MIN_CASH = 0.5e9;
const ROUND2_BN3_LEAN_TOB_SUPPORT_JOBS_PREFINISHED = { rnd: 3 };
const ROUND2_BN3_LEAN_TOB_POSTDONE_HQ_OFFICE = 18;
const ROUND2_BN3_LEAN_TOB_POSTDONE_HQ_MIN_CASH = 1e9;
const ROUND2_BN3_LEAN_TOB_POSTDONE_ADVERT = 2;
const ROUND2_BN3_LEAN_TOB_POSTDONE_ADVERT_MIN_CASH = 1e9;
const ROUND2_BN3_LEAN_TOB_SUPPORT_OFFICE_POSTDONE = 9;
const ROUND2_BN3_LEAN_TOB_SUPPORT_JOBS_POSTDONE = { ops: 1, eng: 3, biz: 2, mgmt: 3 };
const ROUND2_BN3_LATE_POSTDONE_BOOST_TRIGGER = 2.9e12;
const ROUND2_BN3_LATE_POSTDONE_BOOST_STAGNATION = 18;
const ROUND2_BN3_LATE_POSTDONE_HQ_BOOST_OFFICE = 21;
const ROUND2_BN3_LATE_POSTDONE_SUPPORT_BOOST_OFFICE = 12;
const ROUND2_BN3_LATE_POSTDONE_ADVERT_BOOST_TARGET = 6;
const ROUND2_TOB_PLANT_DIRECT_BUFFER_CYCLES = 25;
// Pre-spike lean-tob: profit-boosting upgrades bought in the bootstrap batch
// with surplus funds, ordered by ROI. Buffers are intentionally high so normal
// Tobacco investment and material fill still have priority.
const ROUND2_BN3_LEAN_TOB_PRSPIKE_INSIGHT_TARGET = 2;     // Project Insight faster TA-I/TA-II
const ROUND2_BN3_LEAN_TOB_PRSPIKE_INSIGHT_BUFFER = 15e9;
const ROUND2_BN3_LEAN_TOB_PRSPIKE_EMPUPG_TARGET = 1;       // FocusWires/NA/Speech/Nuopt to level 1
const ROUND2_BN3_LEAN_TOB_PRSPIKE_EMPUPG_BUFFER = 5e9;
const ROUND2_BN3_LEAN_TOB_PRSPIKE_TOB_ADVERT = 3;          // Tobacco advert (post-v1, meets spike-unlock gate)
const ROUND2_BN3_LEAN_TOB_PRSPIKE_TOB_ADVERT_BUFFER = 10e9;
const ROUND2_BN3_LEAN_TOB_PRSPIKE_WILSON_TARGET = 3;       // Wilson beyond seed (post first advert)
const ROUND2_BN3_LEAN_TOB_PRSPIKE_WILSON_BUFFER = 10e9;
const ROUND2_BN3_LEAN_TOB_PRSPIKE_SALESBOT_TARGET = 8;     // SalesBots beyond the initial 5
const ROUND2_BN3_LEAN_TOB_PRSPIKE_SALESBOT_BUFFER = 20e9;
const ROUND2_TOB_PLANT_EXPORT_BUFFER_CYCLES = 2;
const ROUND2_TOB_PLANT_EXPORT_SEED = 400;
const EXPORT_DYNAMIC_HEADROOM_MULT = 1.10;
const EXPORT_DYNAMIC_REFILL_CYCLES = 4;
const EXPORT_DYNAMIC_CHEM_PLANT_SEED = 600; // raised from 300: larger Plants seed in Chem breaks the low-consumption / low-export circular dependency at phase-3 startup
const EXPORT_DYNAMIC_AGRI_CHEM_SEED = 120;
const EXPORT_DYNAMIC_TOB_PLANT_BUFFER_CYCLES = 2.5;
const EXPORT_DYNAMIC_TOB_PLANT_BUFFER_CYCLES_MATURE = 4.5;
const EXPORT_DYNAMIC_CHEM_PLANT_BUFFER_CYCLES = 3.5; // raised from 2.0: more buffered stock keeps Chem fed through production dips
const EXPORT_DYNAMIC_CHEM_PLANT_BUFFER_CYCLES_MATURE = 5.0; // raised from 3.5
const EXPORT_DYNAMIC_CHEM_PLANT_MIN_DEMAND = 1.5;
const EXPORT_DYNAMIC_CHEM_PLANT_MIN_DEMAND_PER_THROUGHPUT_EMPLOYEE = 0.75;
const EXPORT_DYNAMIC_CHEM_PLANT_MIN_DEMAND_PER_OFFICE_EMPLOYEE = 0.35;
const EXPORT_DYNAMIC_CHEM_PLANT_BUILDOUT_DEMAND_MULT = 1.35;
const EXPORT_DYNAMIC_AGRI_CHEM_BUFFER_CYCLES = 2.5;
const EXPORT_DYNAMIC_AGRI_CHEM_BUFFER_CYCLES_MATURE = 4.5;
const EXPORT_DYNAMIC_TOB_PLANT_WAREHOUSE_PCT = 0.10;
const EXPORT_DYNAMIC_TOB_PLANT_WAREHOUSE_PCT_MATURE = 0.16;
const EXPORT_DYNAMIC_CHEM_PLANT_WAREHOUSE_PCT = 0.14; // raised from 0.08: old cap was too small, Plants buffer headroom was nearly always saturated
const EXPORT_DYNAMIC_CHEM_PLANT_WAREHOUSE_PCT_MATURE = 0.22; // raised from 0.14
const EXPORT_DYNAMIC_AGRI_CHEM_WAREHOUSE_PCT = 0.10;
const EXPORT_DYNAMIC_AGRI_CHEM_WAREHOUSE_PCT_MATURE = 0.18;
const ROUND2_BN3_PRAGMATIC_ACCEPT = 3.6e12;
const ROUND2_BN3_PRAGMATIC_ACCEPT_FLOOR = 3.5e12;
const ROUND2_BN3_PRAGMATIC_ACCEPT_FLOOR_HOLD_CHECKS = 4;
const ROUND2_BN3_PRAGMATIC_ACCEPT_NEAR_BEST_RATIO = 0.97;
const ROUND2_BN3_PRAGMATIC_ACCEPT_NEAR_BEST_STAGNATION = 10;
const ROUND2_BN3_PRAGMATIC_ACCEPT_DECAY_RATIO = 0.95;
const ROUND2_BN3_PRAGMATIC_ACCEPT_DECAY_STAGNATION = 20;
const PRIVATE_STAGE_POST_R3 = 'post-r3';
const PRIVATE_STAGE_PRE_IPO = 'pre-ipo';
const PRIVATE_STAGE_POST_R3_RESERVE_MIN = 15e9;
const PRIVATE_STAGE_PRE_IPO_RESERVE_MIN = 25e9;
const PRIVATE_STAGE_RESERVE_PCT = 0.08;
const PRIVATE_STAGE_NEGATIVE_MARGIN_RESERVE_PCT = 0.18;
const PRIVATE_STAGE_OFFICE_STEP = 3;
const PRIVATE_STAGE_WAIT_LOG_INTERVAL = 6;
const PRIVATE_STAGE_ACCEPT_READY_CHECKS = 2;
const PRIVATE_STAGE_ACCEPT_NEAR_BEST_RATIO = 0.9925;
const PRIVATE_STAGE_ACCEPT_DECAY_RATIO = 0.985;
const PRIVATE_STAGE_ACCEPT_STAGNATION = 6;
const PRIVATE_STAGE_EARLY_BURST_THRESHOLD_RATIO = 0.97;
const PRIVATE_STAGE_EARLY_BURST_ACTIONS = Object.freeze({
    [PRIVATE_STAGE_POST_R3]: 4,
    [PRIVATE_STAGE_PRE_IPO]: 6,
});
const PRIVATE_STAGE_EARLY_BURST_SPARE_FUNDS = Object.freeze({
    [PRIVATE_STAGE_POST_R3]: 75e9,
    [PRIVATE_STAGE_PRE_IPO]: 150e9,
});
const PRIVATE_STAGE_STRETCH_THRESHOLD_RATIO = 0.85;
const PRIVATE_STAGE_STRETCH_NEAR_BEST_RATIO = 0.985;
const PRIVATE_STAGE_STRETCH_MAX_STAGNATION = 18;
const PRIVATE_STAGE_STRETCH_HQ_STEP = 15;
const PRIVATE_STAGE_SURPLUS_PUSH_FUNDS_TRIGGER = 1e12;
const PRIVATE_STAGE_SURPLUS_PUSH_THRESHOLD_RATIO = 1.15;
const PRIVATE_STAGE_SURPLUS_PUSH_NEAR_BEST_RATIO = 0.97;
const PRIVATE_STAGE_EMPLOYEE_UPGRADE_TARGETS = {
    [PRIVATE_STAGE_POST_R3]: 1,
    [PRIVATE_STAGE_PRE_IPO]: 2,
};
const PRIVATE_STAGE_PRE_ADVERT_UPGRADES = Object.freeze(['Wilson Analytics']);
const PRIVATE_STAGE_POST_ADVERT_UPGRADES = Object.freeze(['Smart Factories', 'Smart Storage', 'ABC SalesBots']);
const PRIVATE_FUNDING_ROUND_CONFIG = Object.freeze({
    3: Object.freeze({
        stageName: PRIVATE_STAGE_POST_R3,
        actionLabel: 'Post-round-3 prep',
        acceptedLabel: 'Round 3',
    }),
    4: Object.freeze({
        stageName: PRIVATE_STAGE_PRE_IPO,
        actionLabel: 'Post-round-3 scaling',
        acceptedLabel: 'Round 4',
    }),
});
const ROUND2_POST_ACCEPT_BOOTSTRAP_RESERVE = 25e9;
const ROUND2_POST_ACCEPT_BOOTSTRAP_RESERVE_PCT = 0.02;
const ROUND2_POST_ACCEPT_SMART_FACTORIES_TARGET = 12;
const ROUND2_POST_ACCEPT_SMART_STORAGE_TARGET = 14;
const ROUND2_POST_ACCEPT_WILSON_TARGET = 2;
const ROUND2_POST_ACCEPT_TOB_ADVERT_TARGET = 4;
const ROUND2_POST_ACCEPT_AGRI_OFFICE = 20;
const ROUND2_POST_ACCEPT_TOB_HQ_OFFICE = 30;
const ROUND2_POST_ACCEPT_TOB_SUPPORT_OFFICE = 20;
const ROUND2_POST_ACCEPT_CHEM_OFFICE = 9;
const ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL = 6;
const ROUND2_POST_ACCEPT_TOB_HQ_JOBS = { ops: 5, eng: 11, biz: 2, mgmt: 9, rnd: 3 };
const ROUND2_POST_ACCEPT_TOB_SUPPORT_JOBS = { ops: 1, eng: 2, biz: 0, mgmt: 1, rnd: 16 };
const ROUND2_POST_ACCEPT_AGRI_JOBS = { ops: 6, eng: 8, biz: 1, mgmt: 3, rnd: 2 };
const ROUND2_POST_ACCEPT_CHEM_JOBS = { ops: 1, eng: 5, biz: 0, mgmt: 1, rnd: 2 };
const ROUND2_PRODUCT_MIN_INVEST = 2e8;
const ROUND2_PRODUCT_MAX_INVEST = 5e9;
const ROUND2_PRODUCT_MAX_INVEST_AGGR = 12e9;
const ROUND2_AGGR_PRODUCT_INVEST_PCT = 0.04;
const ROUND2_AGGR_WARMUP_TARGET = 1.25e12;
const ROUND2_AGGR_WARMUP_STAGNATION = 12;
const ROUND2_AGGR_SMART_SUPPLY_TRIGGER = 6e11;
const ROUND2_AGGR_ACCELERATE_TRIGGER = 4.25e11;
const ROUND2_AGGR_TOB_HQ_WARMUP = 9;
const ROUND2_AGGR_TOB_HQ_WARMUP_JOBS = { ops: 2, eng: 5, mgmt: 2 };
const ROUND2_AGGR_CHEM_HQ_WARMUP = 6;
const ROUND2_AGGR_FREEZE_PROGRESS = 45;
const ROUND2_AGGR_EARLY_SUPPORT_PROGRESS = 60;
const ROUND2_AGGR_EARLY_SUPPORT_TRIGGER = 1.1e12;

// "Waiting for 700RP/390RP in Agriculture/Chemical respectively is enough."
const RP_TARGET_AGRI = 700;
const RP_TARGET_CHEM = 390;

const SETUP_DONE_FLAG = '/corp-setup-done.txt';
const SETUP_PHASE_FILE = '/corp-setup-phase.txt';
const SETUP_ROUTE_FILE = '/corp-setup-route.txt';
const SETUP_LOCK = '/Temp/corp-setup.lock.txt';

const JOBS = {
    ops: 'Operations', eng: 'Engineer', biz: 'Business',
    mgmt: 'Management', rnd: 'Research & Development', unassigned: 'Unassigned',
};

const UNLOCKS = {
    warehouseAPI: 'Warehouse API', officeAPI: 'Office API',
    smartSupply: 'Smart Supply', export: 'Export',
    mktDemand: 'Market Research - Demand', mktComp: 'Market Data - Competition',
};

// Maximises division production multiplier subject to warehouse space constraint.
// At small warehouse sizes only Real Estate is worth buying (factor 0.72, size 0.005).
// Hardware enters at S106, AI Cores at S121, Robots never for Agri/Chem.
function optimalBoosts(S, factors, sizes, names) {
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

// Source: IndustryData.ts (realEstateFactor/hardwareFactor/robotFactor/aiCoreFactor)
// Sizes: MaterialInfo.ts
const AGRI_FACTORS = [0.72, 0.20, 0.30, 0.30];
const AGRI_SIZES = [0.005, 0.06, 0.5, 0.1];
const AGRI_MATS = ['Real Estate', 'Hardware', 'Robots', 'AI Cores'];

// Chemical: realEstate=0.25, hardware=0.20, robot=0.25, aiCore=0.20
// Also produces the Chemicals Agriculture directly consumes.
const CHEM_FACTORS = [0.25, 0.20, 0.25, 0.20];
const CHEM_SIZES = [0.005, 0.06, 0.5, 0.1];
const CHEM_MATS = ['Real Estate', 'Hardware', 'Robots', 'AI Cores'];

// Tobacco: realEstate=0.15, hardware=0.15, robot=0.20, aiCore=0.15
const TOB_FACTORS = [0.15, 0.15, 0.20, 0.15];
const TOB_SIZES = [0.005, 0.06, 0.5, 0.1];
const TOB_MATS = ['Real Estate', 'Hardware', 'Robots', 'AI Cores'];

// Excluded (per docs): AutoBrew/AutoPartyManager ("useless"), Capacity.I/II ("not useful").
// CPH4 prerequisite 'Automatic Drug Administration' is included.
const TOB_RESEARCH = [
    'Hi-Tech R&D Laboratory',      // +10% RP; prerequisite for all others
    'Market-TA.I',                 // Prerequisite only
    'Market-TA.II',                // TOP PRIORITY: optimal product pricing
    'uPgrade: Fulcrum',            // +5% product production  [10% RP rule]
    'Drones',                      // Prerequisite
    'Drones - Assembly',           // +20% production  [10% RP rule]
    'Self-Correcting Assemblers',  // +10% production  [10% RP rule]
    'Overclock',                   // +25% int/eff; prereq for Sti.mu
    'Sti.mu',                      // +max morale
    'Automatic Drug Administration', // Prereq for Go-Juice + CPH4
    'Go-Juice',                    // +max energy
    'CPH4 Injections',             // +10% all employee stats
];
const MAT_RESEARCH = [
    'Hi-Tech R&D Laboratory',
    'Drones',
    'Drones - Assembly',           // [10% RP rule]
    'Self-Correcting Assemblers',  // [10% RP rule]
    'Drones - Transport',          // +50% warehouse storage
    'Overclock', 'Sti.mu',
    'Automatic Drug Administration', 'Go-Juice', 'CPH4 Injections',
];

// Production research only buy when cost < 10% of RP pool (not 50%).
// Depleting RP before product completes tanks product quality and markup.
const PRODUCTION_RESEARCH = new Set([
    'Drones - Assembly', 'Self-Correcting Assemblers', 'uPgrade: Fulcrum',
]);

const CYCLE_SECS = 10;
const CYCLE_MS = 11000;

const argsSchema = [['self-fund', false], ['round1-only', false], ['aggressive-round2', false], ['classic-round2', false], ['bn3-round2', false], ['legacy-round2', false], ['bn3-soft-accept', false], ['bn3-hard-5t-goal', false], ['bn3-re-push', false], ['bn3-dummy-round2', false], ['bn3-postfill-sales', false], ['bn3-salesbots', false], ['bn3-postfill-storage', false], ['bn3-headroom-fill', false], ['bn3-lean-tob-round2', false], ['bn3-no-lean-tob-round2', false], ['bn3-lean-tob-support', false], ['bn3-lean-tob-hq-push', false], ['round4', false], ['income-mode', false]];
// autocomplete is only in corp-setup.js
const ARG_ALIASES = Object.freeze({
    'bn3lean-tob-round2': 'bn3-lean-tob-round2',
    'bn3lean-tob-support': 'bn3-lean-tob-support',
    'bn3lean-tob-hq-push': 'bn3-lean-tob-hq-push',
});

function parseOptions(ns) {
    const defaults = Object.fromEntries(argsSchema);
    const opts = { ...defaults };
    for (let i = 0; i < ns.args.length; i++) {
        const arg = ns.args[i];
        if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
        const rawKey = arg.slice(2);
        const key = ARG_ALIASES[rawKey] ?? rawKey;
        if (!(key in opts)) continue;
        const defaultValue = defaults[key];
        if (typeof defaultValue === 'boolean') {
            opts[key] = true;
        } else if (i + 1 < ns.args.length) {
            opts[key] = ns.args[++i];
        }
    }
    return opts;
}

export async function main(ns) {
    const opts = parseOptions(ns);
    ns.disableLog('ALL');
    ns.clearLog();
    ns.ui.openTail();
    ns.tprint(`INFO: Round1 startup - args=${JSON.stringify(ns.args)}`);
    const c = ns.corporation;
    let bn3HighBudgetRound2Locked = false;
    let bn3HighBudgetRound2StartFunds = 0;

    function log(ns, message, _terminal = false, _level = 'info') {
        ns.print(String(message));
    }

    // Debug mode 
    // Usage: run corp/corp-setup.js --debug
    // Prints a full corp snapshot every cycle to the tail window.
    const CORP_DEBUG = ns.args.includes('--debug');
    function tryOrWarn(fn, label) {
        try { return fn(); }
        catch (e) {
            if (CORP_DEBUG) log(ns, `[CORP WARN] ${label}: ${e?.message ?? e}`);
            return undefined;
        }
    }

    let _dbgCycle = 0;
    function printCorpDebugDump() {
        if (!CORP_DEBUG) return;
        _dbgCycle++;
        const out = [];
        const pr  = (s) => out.push(s);
        const fm  = (n) => { try { return formatMoney(Number(n ?? 0)); } catch { return String(n); } };
        const pct = (u, t) => t > 0 ? `${((u / t) * 100).toFixed(0)}%` : '0%';
        const f2  = (n) => Number.isFinite(n) ? n.toFixed(2) : '?';
        const f0  = (n) => Number.isFinite(n) ? n.toFixed(0) : '?';

        try {
            const corp   = c.getCorporation();
            const funds  = Number(corp.funds ?? 0);
            const rev    = Number(corp.revenue ?? 0);
            const exp    = Number(corp.expenses ?? 0);
            let phaseVal = '?'; try { phaseVal = phase; } catch { }
            let reserveVal = NaN; try { reserveVal = getBn3Round2Reserve(); } catch { }
            const headroom = Number.isFinite(reserveVal) ? fm(funds - reserveVal) : 'n/a';

            pr(`≫煤・CORP DEBUG #${_dbgCycle} ≫煤・ phase=${phaseVal}  state=${corp.state}`);
            pr(`  funds=${fm(funds)}  rev=${fm(rev)}/s  exp=${fm(exp)}/s  profit=${fm(rev - exp)}/s`);

            // Investment offer + reserve
            try {
                const offer = c.getInvestmentOffer();
                pr(`  offer=${fm(offer.funds)} (rnd=${offer.round})  target=${fm(MIN_ROUND2)}  ` +
                   `reserve=${Number.isFinite(reserveVal) ? fm(reserveVal) : 'n/a'}  headroom=${headroom}`);
            } catch { }

            // Corp-level upgrades (compact single line)
            const UPG = [
                ['Wilson Analytics','Wilson'], ['Smart Factories','SF'], ['Smart Storage','SS'],
                ['ABC SalesBots','SB'], ['FocusWires','FW'], ['Neural Accelerators','NA'],
                ['Speech Processor Implants','Speech'], ['Nuoptimal Nootropic Injector Implants','Nuopt'],
                ['Project Insight','Insight'], ['DreamSense','Dream'],
            ];
            const upgLine = UPG.map(([n, a]) => { try { return `${a}:${c.getUpgradeLevel(n)}`; } catch { return null; } })
                .filter(Boolean).join(' ');
            pr(`  upgrades: ${upgLine}`);

            // Morale upkeep last cycle
            const teaStr   = latestTeaSpend   > 0 ? `tea=${fm(latestTeaSpend)}`   : null;
            const partyStr = latestPartySpend  > 0 ? `party=${fm(latestPartySpend)}` : null;
            const moraleNote = [teaStr, partyStr].filter(Boolean).join('  ');
            if (moraleNote) pr(`  morale spend: ${moraleNote}`);

            // Per-division
            for (const [div, label] of [[DIV_AGRI,'Agri'], [DIV_TOBACCO,'Tob'], [DIV_CHEM,'Chem']]) {
                if (!hasDiv(div)) { pr(`  [${label}] absent`); continue; }
                try {
                    const division = c.getDivision(div);
                    const rp  = f0(Number(division.researchPoints ?? 0));
                    const adv = (() => { try { return c.getHireAdVertCount(div); } catch { return '?'; } })();
                    const aware = f0(Number(division.awareness ?? 0));
                    const pop   = f0(Number(division.popularity ?? 0));
                    pr(`   [${label}]  aware=${aware}  pop=${pop}  advert=${adv}  rp=${rp}`);

                    // Researches unlocked
                    const RESEARCHES = ['Hi-Tech R&D Laboratory','Market-TA.I','Market-TA.II',
                        'Self-Correcting Assemblers','Overclock','Shady Accounting','Government Partnership',
                        'uPgrade: Fulcrum','uPgrade: Capacity.I','uPgrade: Capacity.II'];
                    const resOn = RESEARCHES.filter(r => { try { return c.hasResearched(div, r); } catch { return false; } })
                        .map(r => r.replace('Market-TA.','TA').replace('Hi-Tech R&D Laboratory','R&D-Lab')
                            .replace('Self-Correcting Assemblers','SCA').replace('uPgrade: ','up:')
                            .replace('Shady Accounting','Shady').replace('Government Partnership','GovPart'));
                    if (resOn.length) pr(`    research: ${resOn.join(', ')}`);

                    for (const city of (division.cities ?? [])) {
                        try {
                            const off = c.getOffice(div, city);
                            const ej  = off.employeeJobs ?? {};
                            const ep  = off.employeeProductionByJob ?? {};

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
                            } catch { }

                            pr(`    ${city.padEnd(12)} sz=${off.size} [${jobStr}]  nrg=${energy} mor=${morale} prod=${prodTotal}  ${whStr}`);
                        } catch { pr(`    ${city}: err`); }

                        // Materials
                        const matList = div === DIV_AGRI
                            ? ['Food','Plants','Chemicals','Water','Hardware','Real Estate','AI Cores']
                            : div === DIV_TOBACCO
                            ? ['Plants','Hardware','Chemicals','Real Estate','AI Cores']
                            : ['Plants','Chemicals','Water','Hardware'];
                        for (const mat of matList) {
                            try {
                                const m   = c.getMaterial(div, city, mat);
                                const stored = Number(m.stored ?? 0);
                                const prod   = Number(m.productionAmount ?? 0);
                                const sell   = Number(m.actualSellAmount ?? 0);
                                const imp    = Number(m.importAmount ?? 0);
                                const buy    = Number(m.buyAmount ?? 0);
                                // Skip truly empty non-key materials
                                const isCoreInput = (div === DIV_AGRI   && (mat === 'Chemicals' || mat === 'Water'))
                                                 || (div === DIV_CHEM    && (mat === 'Plants'    || mat === 'Water'))
                                                 || (div === DIV_TOBACCO && mat === 'Plants');
                                if (!isCoreInput && stored < 1 && prod === 0 && imp === 0 && buy === 0) continue;
                                const parts = [`qty=${f0(stored)}`];
                                if (prod  !== 0) parts.push(`prd=${f2(prod)}/s`);
                                if (sell  !== 0) parts.push(`sll=${f2(sell)}/s`);
                                if (imp   !== 0) parts.push(`imp=${f2(imp)}/s`);
                                if (buy   !== 0) parts.push(`buy=${f2(buy)}/s`);
                                pr(`      ${mat.padEnd(12)} ${parts.join('  ')}`);
                            } catch { }
                        }

                        // Products (Tobacco only)
                        if (div === DIV_TOBACCO) {
                            for (const pName of tobaccoProducts()) {
                                try {
                                    const prod = c.getProduct(div, city, pName);
                                    const progress = Number(prod.developmentProgress ?? 0);
                                    const stored   = Number(prod.stored ?? 0);
                                    const prdAmt   = Number(prod.productionAmount ?? 0);
                                    const sllAmt   = Number(prod.actualSellAmount ?? 0);

                                    if (city === HQ_CITY) {
                                        // Full product stats once from HQ
                                        const rat  = f2(Number(prod.rating ?? 0));
                                        const dmd  = f2(Number(prod.demand ?? prod.dmd ?? 0));
                                        const cmp  = f2(Number(prod.competition ?? prod.cmp ?? 0));
                                        const mku  = f2(Number(prod.markup ?? prod.mku ?? 0));
                                        const pCost = fm(Number(prod.productionCost ?? prod.pCost ?? 0));
                                        const price = prod.desiredSellPrice ?? prod.sellCost ?? prod.sCost ?? '?';
                                        const ta1 = (() => { try { return c.hasResearched(div,'Market-TA.I'); } catch { return false; } })();
                                        const ta2 = (() => { try { return c.hasResearched(div,'Market-TA.II'); } catch { return false; } })();
                                        const taStr = ta2 ? ' TA2' : ta1 ? ' TA1' : '';
                                        pr(`    [${pName}${progress < 100 ? ` dev=${f0(progress)}%` : ''}]${taStr}  rat=${rat}  dmd=${dmd}  cmp=${cmp}  mku=${mku}  pCost=${pCost}  price=${typeof price === 'number' ? fm(price) : price}`);
                                    }
                                    pr(`      ${city.padEnd(12)} qty=${f0(stored)}  prd=${f2(prdAmt)}/s  sll=${f2(sllAmt)}/s`);
                                } catch { }
                            }
                        }
                    }
                } catch (e) { pr(`  [${label}] error: ${e?.message ?? e}`); }
            }
        } catch (e) {
            out.push(`[CORP DEBUG ERROR] ${e?.message ?? e}`);
        }

        for (const line of out) ns.print(line);
    }

    function readSetupRoute() {
        try {
            const parsed = JSON.parse(ns.read(SETUP_ROUTE_FILE) || 'null');
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }

    function writeSetupRoute(route = null, startFunds = null) {
        try {
            if (!route) {
                ns.rm(SETUP_ROUTE_FILE, 'home');
                return;
            }
            const safeFunds = Number(startFunds ?? 0);
            ns.write(
                SETUP_ROUTE_FILE,
                JSON.stringify({
                    bn3Round2: String(route),
                    startFunds: Number.isFinite(safeFunds) ? safeFunds : 0,
                }),
                'w',
            );
        } catch { }
    }

    function getPersistedBn3Round2Route() {
        if (!useBn3Round2()) return null;
        const route = String(readSetupRoute()?.bn3Round2 ?? '').toLowerCase();
        return ['high', 'lean', 'classic'].includes(route) ? route : null;
    }

    function restorePersistedBn3Round2State() {
        const savedRoute = readSetupRoute();
        const route = String(savedRoute?.bn3Round2 ?? '').toLowerCase();
        if (route !== 'high') return;
        const persistedStartFunds = Number(savedRoute?.startFunds ?? 0);
        bn3HighBudgetRound2Locked = true;
        bn3HighBudgetRound2StartFunds = Math.max(
            bn3HighBudgetRound2StartFunds,
            Number.isFinite(persistedStartFunds) ? persistedStartFunds : 0,
            ROUND2_BN3_HIGH_BUDGET_FUNDS_TRIGGER,
        );
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
        if (!useBn3Round2()) return false;
        if (opts['bn3-lean-tob-round2']) return false;
        if (opts['bn3-no-lean-tob-round2']) return true;
        const persistedRoute = getPersistedBn3Round2Route();
        if (persistedRoute === 'high') return true;
        if (persistedRoute === 'lean' || persistedRoute === 'classic') return false;
        if (bn3HighBudgetRound2Locked) return true;
        try {
            const corp = c.getCorporation();
            if (!corp || corp.public) return false;
            return Number(corp.funds ?? 0) >= ROUND2_BN3_HIGH_BUDGET_FUNDS_TRIGGER;
        } catch {
            return false;
        }
    }

    function useBn3LeanTobRound2() {
        if (!useBn3Round2()) return false;
        if (opts['bn3-lean-tob-round2']) return true;
        if (opts['bn3-no-lean-tob-round2']) return false;
        const persistedRoute = getPersistedBn3Round2Route();
        if (persistedRoute === 'lean') return true;
        if (persistedRoute === 'high' || persistedRoute === 'classic') return false;
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
        if (useBn3Hard5tGoal()) return false;
        return opts['bn3-soft-accept'] || useBn3LeanTobRound2();
    }

    function useIncomeMode() {
        return opts['income-mode'];
    }

    function useRound4Path() {
        return opts['round4'];
    }

    function useRound1Route() {
        return true;
    }

    function canInferBn3HighBudgetShell() {
        if (!useBn3Round2() || opts['bn3-lean-tob-round2']) return false;
        try {
            if (!c.hasCorporation()) return false;
            const corp = c.getCorporation();
            if (!corp || corp.public) return false;
            if (!hasDiv(DIV_CHEM) || !hasDiv(DIV_TOBACCO) || !c.hasUnlock(UNLOCKS.export)) return false;
            return c.getDivision(DIV_CHEM).cities.includes(HQ_CITY) && c.getDivision(DIV_TOBACCO).cities.includes(HQ_CITY);
        } catch {
            return false;
        }
    }

    function lockBn3HighBudgetRound2Profile(baselineFunds = null) {
        if (!useBn3Round2() || opts['bn3-lean-tob-round2']) return false;
        if (bn3HighBudgetRound2Locked) return true;
        const inferred = canInferBn3HighBudgetShell();
        let funds = Number(baselineFunds ?? 0);
        if (!Number.isFinite(funds) || funds <= 0) {
            try { funds = Number(c.getCorporation().funds ?? 0); } catch { funds = 0; }
        }
        if (!(opts['bn3-no-lean-tob-round2'] || funds >= ROUND2_BN3_HIGH_BUDGET_FUNDS_TRIGGER || inferred)) return false;
        bn3HighBudgetRound2Locked = true;
        bn3HighBudgetRound2StartFunds = Math.max(
            bn3HighBudgetRound2StartFunds,
            funds,
            inferred ? ROUND2_BN3_HIGH_BUDGET_FUNDS_TRIGGER : 0,
        );
        writeSetupRoute('high', bn3HighBudgetRound2StartFunds);
        return true;
    }

    function getRound1Target() {
        return ROUND1_ROUTE_TARGET;
    }

    function getRound1SoftFloor() {
        return ROUND1_ROUTE_SOFT_FLOOR;
    }

    function getRound1StagnationLimit() {
        return ROUND1_ROUTE_STAGNATION_LIMIT;
    }

    function getRound1SmartStorageTarget() {
        return ROUND1_ROUTE_SMART_STORAGE_TARGET;
    }

    function getRound1WarehouseTarget() {
        return ROUND1_ROUTE_WAREHOUSE_TARGET;
    }

    function getRound1AdvertTarget() {
        return ROUND1_ROUTE_ADVERT_TARGET;
    }

    function getRound1FreezeRatio() {
        return ROUND1_ROUTE_FREEZE_RATIO;
    }

    function estimateSmartStorageSeriesCost(targetLevel) {
        try {
            let level = Number(c.getUpgradeLevel('Smart Storage') ?? 0);
            let cost = Number(c.getUpgradeLevelCost('Smart Storage') ?? 0);
            if (!Number.isFinite(level) || !Number.isFinite(cost) || cost < 0) return 0;
            let total = 0;
            while (level < targetLevel) {
                total += cost;
                cost *= ROUND1_SMART_STORAGE_COST_MULT;
                level++;
            }
            return total;
        } catch {
            return 0;
        }
    }

    function estimateAdvertSeriesCost(div, targetCount) {
        try {
            let count = Number(c.getHireAdVertCount(div) ?? 0);
            let cost = Number(c.getHireAdVertCost(div) ?? 0);
            if (!Number.isFinite(count) || !Number.isFinite(cost) || cost < 0) return 0;
            let total = 0;
            while (count < targetCount) {
                total += cost;
                cost *= ROUND1_ADVERT_COST_MULT;
                count++;
            }
            return total;
        } catch {
            return 0;
        }
    }

    function getExperimentalRound1PrepCashReserve() {
        if (!useRound1Route()) return 0;
        const buffer = ROUND1_ROUTE_PREP_RESERVE_BUFFER;
        try {
            if (c.getUpgradeLevel('Smart Storage') < getRound1SmartStorageTarget()) {
                return buffer + Math.max(0, Number(c.getUpgradeLevelCost('Smart Storage') ?? 0));
            }
        } catch { }
        try {
            if (c.getHireAdVertCount(DIV_AGRI) < getRound1AdvertTarget()) {
                return buffer + Math.max(0, Number(c.getHireAdVertCost(DIV_AGRI) ?? 0));
            }
        } catch { }
        try {
            const warehouseTarget = getRound1WarehouseTarget();
            let cheapestWarehouse = Infinity;
            for (const city of CITIES) {
                const wh = c.getWarehouse(DIV_AGRI, city);
                if (wh.level >= warehouseTarget) continue;
                const cost = Number(c.getUpgradeWarehouseCost(DIV_AGRI, city, 1) ?? Infinity);
                if (Number.isFinite(cost)) cheapestWarehouse = Math.min(cheapestWarehouse, cost);
            }
            if (Number.isFinite(cheapestWarehouse)) {
                return buffer + Math.max(0, cheapestWarehouse);
            }
        } catch { }
        return 0;
    }

    function getBn3BaseMaterialTargets() {
        return useBn3HeadroomFill() ? ROUND2_BN3_HEADROOM_MATERIAL_TARGETS : ROUND2_BN3_MATERIAL_TARGETS;
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
        } catch {
            return { funds: 0, revenue: 0, expenses: 0, profit: 0, margin: 0 };
        }
    }

    function getBn3HighBudgetTrueProfit() {
        // Returns a "true" operational profit that strips out the temporary revenue
        // from liquidating Round-1 boost materials (Real Estate, AI Cores).
        // During buildout-zero, those sales inflate the apparent profit figure;
        // using it raw causes over-staffing before the corp can self-sustain.
        const finance = getRound2FinanceSnapshot();
        if (!isBn3HighBudgetBuildoutMode()) return finance.profit;
        // Once products exist, trust the revenue boost mats exhausted or
        // product revenue now dominates the income picture.
        if (getTobaccoProductStats().finishedProducts > 0) return finance.profit;
        // Check if any Agri city still holds Real Estate (the primary boost mat).
        try {
            for (const city of CITIES) {
                if (!hasDiv(DIV_AGRI) || !c.hasWarehouse(DIV_AGRI, city)) continue;
                if (Number(c.getMaterial(DIV_AGRI, city, 'Real Estate').stored ?? 0) > 0) {
                    // Still liquidating: cap at a conservative multiple of expenses
                    // so scaling decisions are based on base operational capacity.
                    return Math.min(finance.profit, finance.expenses * ROUND2_BN3_HIGH_BUDGET_BOOST_MAT_SAFETY_MULT);
                }
            }
        } catch { }
        return finance.profit; // boost mats exhausted, profit is genuine
    }

    function getBn3HighBudgetQualifyingOfficeCount() {
        // Count offices at >= 9 employees across all divisions.
        // Used to estimate total ongoing morale maintenance cost (tea + party)
        // when deciding whether the corp can afford pushing another city to 9+.
        let count = 0;
        for (const div of [DIV_AGRI, DIV_TOBACCO, DIV_CHEM]) {
            if (!hasDiv(div)) continue;
            try {
                for (const city of CITIES) {
                    try { if (c.getOffice(div, city).numEmployees >= 9) count++; } catch { }
                }
            } catch { }
        }
        return count;
    }

    function getEffectiveBn3BestOffer(bestOffer = 0) {
        return Math.max(
            0,
            Number(bestOffer ?? 0),
            Number(latestMeaningfulRound2Offer ?? 0),
            Number(latestRound2Offer ?? 0),
        );
    }

    function isBn3HighBudgetBuildoutHealthy(bestOffer = 0) {
        if (!useBn3HighBudgetRound2()) return true;
        const offer = getEffectiveBn3BestOffer(bestOffer);
        const finance = getRound2FinanceSnapshot();
        if (offer >= ROUND2_BN3_HIGH_BUDGET_BUILDOUT_HEALTHY_OFFER) return true;
        return finance.funds >= ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_FUNDS &&
            finance.profit >= ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_PROFIT &&
            finance.margin >= ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_MARGIN;
    }

    function getBn3HighBudgetBootstrapActionLimit(bestOffer = 0) {
        if (!useBn3HighBudgetRound2()) return 32;
        const offer = getEffectiveBn3BestOffer(bestOffer);
        const finance = getRound2FinanceSnapshot();
        if (!isBn3HighBudgetPostfillUnlocked()) {
            return finance.funds >= ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_FUNDS
                ? ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_STABLE
                : ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_WEAK;
        }
        if (!isBn3HighBudgetBuildoutMode()) {
            return finance.funds >= ROUND2_BN3_HIGH_BUDGET_BUILDOUT_MIN_FUNDS || offer >= ROUND2_BN3_HIGH_BUDGET_BUILDOUT_HEALTHY_OFFER
                ? ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_STABLE
                : ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_WEAK;
        }
        if (offer >= 1e12 ||
            (finance.funds >= 20e9 && finance.profit >= 25e6 && finance.margin >= 0.40)) {
            return ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_HEALTHY;
        }
        return isBn3HighBudgetBuildoutHealthy(offer)
            ? ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_STABLE
            : ROUND2_BN3_HIGH_BUDGET_BOOTSTRAP_ACTIONS_WEAK;
    }

    function isBn3HighBudgetProductCycleReady(bestOffer = 0, stagnantChecks = 0) {
        if (!useBn3HighBudgetRound2() || !hasDiv(DIV_TOBACCO)) return true;
        if (!isBn3HighBudgetPostfillUnlocked()) return true;
        const { finishedProducts } = getTobaccoProductStats();
        if (finishedProducts <= 0) return true;
        if (isBn3HighBudgetLateSpikeReady()) return true;
        const offer = getEffectiveBn3BestOffer(bestOffer);
        const finance = getRound2FinanceSnapshot();
        if (offer >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_TRIGGER) return true;
        if (stagnantChecks >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_STAGNATION &&
            finance.funds >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_FUNDS &&
            finance.profit >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_PROFIT) {
            return true;
        }
        return finance.funds >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_FUNDS &&
            finance.profit >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_PROFIT &&
            finance.margin >= ROUND2_BN3_HIGH_BUDGET_PRODUCT_RECYCLE_MIN_MARGIN;
    }

    function getMoraleUpkeepFloor() {
        const finance = getRound2FinanceSnapshot();
        const raw = Math.max(
            CORP_MORALE_UPKEEP_MIN_FUNDS,
            finance.expenses * CORP_MORALE_UPKEEP_RESERVE_SECS,
        );
        // Cap so morale spending stays net-positive each cycle.
        // funds*0.9 was too permissive: 10 offices ($500k tea + $250k party)
        // every 30s = $15M/min vs only ~$8.7M/min profit rapid fund drain.
        // Instead, keep at least one cycle's worth of profit as a spending buffer,
        // so the most we spend on morale in any cycle is bounded by what we earn.
        const profitBudget = finance.profit > 0
            ? Math.max(CORP_TEA_COST * 2, finance.profit * CYCLE_SECS)
            : CORP_TEA_COST * 2;
        return Math.min(raw, Math.max(0, finance.funds - profitBudget));
    }

    function getOfficeSpendKey(div, city) {
        return `${div}|${city}`;
    }

    function isBn3HighBudgetChemBuildoutReady() {
        if (!useBn3HighBudgetRound2() || !hasDiv(DIV_CHEM)) return false;
        try {
            const division = c.getDivision(DIV_CHEM);
            if ((division.cities?.length ?? 0) < CITIES.length) return false;
            for (const city of CITIES) {
                if (!division.cities.includes(city)) return false;
                if (!c.hasWarehouse(DIV_CHEM, city)) return false;
                const wh = c.getWarehouse(DIV_CHEM, city);
                const office = c.getOffice(DIV_CHEM, city);
                const target = city === HQ_CITY
                    ? ROUND2_BN3_HIGH_BUDGET_CHEM_HQ_BUILDOUT
                    : ROUND2_BN3_HIGH_BUDGET_CHEM_OFFICE_BUILDOUT;
                const warehouseTarget = getRound2ChemWarehouseTarget(city, true);
                if (wh.level < warehouseTarget) return false;
                if (office.size < target || office.numEmployees < office.size) return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    function isBn3HighBudgetLateSpikeReady() {
        if (!useBn3HighBudgetRound2() || !hasDiv(DIV_AGRI) || !isBn3HighBudgetPostfillUnlocked()) return false;
        if (!hasDiv(DIV_CHEM) || !hasDiv(DIV_TOBACCO)) return false;
        if (!isBn3Round2OfficeBuiltOut()) return false;
        if (!isBn3Round2UpgradeBuiltOut()) return false;
        if (!isBn3Round2WarehouseBuiltOut()) return false;
        if (!isBn3HighBudgetChemBuildoutReady()) return false;
        if (getHighestTobaccoProductVersion() < ROUND2_BN3_HIGH_BUDGET_SPIKE_PRODUCT_VERSION) return false;
        try {
            const { finishedProducts } = getTobaccoProductStats();
            if (finishedProducts <= 0) return false;
            if (c.getDivision(DIV_TOBACCO).cities.length < CITIES.length) return false;
            if (c.getHireAdVertCount(DIV_TOBACCO) < ROUND2_BN3_HIGH_BUDGET_TOB_ADVERT) return false;
            if (c.getUpgradeLevel('Smart Storage') < ROUND2_BN3_POSTFILL_SMART_STORAGE_TARGET) return false;
            if (c.getUpgradeLevel('ABC SalesBots') < ROUND2_BN3_SALESBOT_TARGET) return false;
        } catch {
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
        if (!useBn3HighBudgetRound2() || !hasDiv(DIV_AGRI) || !isBn3HighBudgetPostfillUnlocked()) {
            // Lean-tob spike: once maturity + spike SS target are met, switch to the
            // late-spike targets and allow debt fill. Uses the same target set as the
            // high-budget late spike since those are calibrated to fit in the warehouse.
            if (useBn3LeanTobRound2() && isLeanTobSpikeUnlocked()) {
                return { profile: 'lean-tob-spike', targets: ROUND2_BN3_LATE_SPIKE_MATERIAL_TARGETS };
            }
            bn3HighBudgetMaterialProfileState = '';
            return { profile: baseProfile, targets: baseTargets };
        }

        const nextProfile = isBn3HighBudgetLateSpikeReady() ? 'late-spike' : 'buildout-zero';
        bn3HighBudgetMaterialProfileState = nextProfile;
        return {
            profile: nextProfile,
            targets: nextProfile === 'late-spike'
                ? ROUND2_BN3_LATE_SPIKE_MATERIAL_TARGETS
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
        if (useBn3LeanTobRound2()) return false;
        if (useBn3HighBudgetRound2()) return false;
        if (useBn3Round2()) return true;
        return DELAY_TOBACCO_UNTIL_POST_ROUND2 && !opts['aggressive-round2'];
    }

    function resolvePath(key, fallbackFile) {
        try {
            const p = JSON.parse(ns.read('/script-paths.json') || '{}');
            if (typeof p[key] === 'string' && p[key].length > 0) return p[key];
        } catch { }
        const script = ns.getScriptName();
        const slash = script.lastIndexOf('/');
        return slash === -1 ? fallbackFile : `${script.slice(0, slash)}/${fallbackFile}`;
    }

    function getBoostConfig(industry, fallbackFactors, fallbackSizes, mats) {
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

    const AGRI_BOOST = getBoostConfig(IND_AGRI, AGRI_FACTORS, AGRI_SIZES, AGRI_MATS);
    const CHEM_BOOST = getBoostConfig(IND_CHEM, CHEM_FACTORS, CHEM_SIZES, CHEM_MATS);
    const TOB_BOOST = getBoostConfig(IND_TOBACCO, TOB_FACTORS, TOB_SIZES, TOB_MATS);

    function getRequiredMaterialsConfig(industry, fallback) {
        try { return { ...(c.getIndustryData(industry).requiredMaterials ?? fallback) }; }
        catch { return { ...fallback }; }
    }

const ROUND1_AGRI_REQUIRED = getRequiredMaterialsConfig(IND_AGRI, { Water: 0.5, Chemicals: 0.2 });
const ROUND1_AGRI_MAT_SIZES = Object.fromEntries(
    Object.keys(ROUND1_AGRI_REQUIRED).map((mat) => [mat, c.getMaterialData(mat)?.size ?? 0.05]),
);
const ROUND1_AGRI_PRODUCT_MAT_SIZES = Object.freeze({
    Food: c.getMaterialData('Food')?.size ?? 0.03,
    Plants: c.getMaterialData('Plants')?.size ?? 0.05,
});
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
    const WORKER_LOCK = '/Temp/corp-round1.lock.txt';
    function readLock() {
        try { return JSON.parse(ns.read(WORKER_LOCK) || 'null'); } catch { return null; }
    }
    function lockValid(lock) {
        if (!lock || typeof lock !== 'object') return false;
        if (lock.host !== ns.getHostname()) return false;
        return ns.ps(lock.host).some(p => p.pid === lock.pid && p.filename === ns.getScriptName());
    }
    function acquireLock() {
        if (lockValid(readLock())) return false;
        ns.write(WORKER_LOCK, JSON.stringify({
            pid: ns.pid, host: ns.getHostname(),
            file: ns.getScriptName(), started: Date.now(),
        }), 'w');
        return true;
    }
    if (!acquireLock()) {
        const heldBy = readLock();
        log(ns, `WARNING: Duplicate worker lock detected for ${ns.getScriptName()} - ${JSON.stringify(heldBy)}`, true, 'warning');
        ns.tprint(`WARNING: Round1 duplicate lock - ${JSON.stringify(heldBy)}`);
        return;
    }
    ns.tprint(`INFO: Round1 lock acquired - pid=${ns.pid}`);
    ns.atExit(() => { try { ns.rm(WORKER_LOCK, 'home'); } catch { } });

    //  Phase tracking 
    function readPhase() {
        try { const n = parseInt(ns.read(SETUP_PHASE_FILE).trim(), 10); return isFinite(n) && n >= 0 ? n : 0; }
        catch { return 0; }
    }
    function writePhase(n) { try { ns.write(SETUP_PHASE_FILE, String(n), 'w'); } catch { } }
    function readDoneFlag() {
        try { return ns.read(SETUP_DONE_FLAG).trim() === 'true'; } catch { return false; }
    }
    function corpIsPublic(corp = null) {
        try {
            return !!(corp ?? c.getCorporation())?.public;
        } catch {
            return false;
        }
    }
    function hasRes(div, name) {
        try { return c.hasResearched(div, name); } catch { return false; }
    }
    function isPilotRunning() {
        const pilot = resolvePath('corp-autopilot', 'corp-autopilot.js');
        try { return ns.ps('home').some(p => p.filename === pilot); } catch { return false; }
    }
    function isPhase6ScalingReady() {
        if (!hasDiv(DIV_AGRI) || !hasDiv(DIV_CHEM) || !hasDiv(DIV_TOBACCO)) return false;
        if (!divisionInfraReady(DIV_CHEM) || !divisionInfraReady(DIV_TOBACCO)) return false;
        if (!c.hasUnlock(UNLOCKS.export) || !c.hasUnlock(UNLOCKS.smartSupply)) return false;
        for (const city of CITIES) {
            try {
                const agriOffice = c.getOffice(DIV_AGRI, city);
                const chemOffice = c.getOffice(DIV_CHEM, city);
                const tobOffice = c.getOffice(DIV_TOBACCO, city);
                const tobTarget = city === HQ_CITY ? 30 : 20;
                if ((agriOffice.size ?? 0) < 20 || (agriOffice.numEmployees ?? 0) < 20) return false;
                if ((chemOffice.size ?? 0) < 9 || (chemOffice.numEmployees ?? 0) < 9) return false;
                if ((tobOffice.size ?? 0) < tobTarget || (tobOffice.numEmployees ?? 0) < tobTarget) return false;
            } catch {
                return false;
            }
            for (const div of [DIV_AGRI, DIV_CHEM, DIV_TOBACCO]) {
                try {
                    if ((c.getWarehouse(div, city).level ?? 0) < 6) return false;
                } catch {
                    return false;
                }
            }
        }
        return true;
    }
    function isAgriRound1FoundationReady() {
        if (!hasDiv(DIV_AGRI) || !divisionInfraReady(DIV_AGRI)) return false;
        try {
            if (Number(c.getDivision(DIV_AGRI).researchPoints ?? 0) < 55) return false;
        } catch {
            return false;
        }
        return CITIES.every((city) => {
            try {
                const office = c.getOffice(DIV_AGRI, city);
                return Number(office.size ?? 0) >= 4 && Number(office.numEmployees ?? 0) >= 4;
            } catch {
                return false;
            }
        });
    }
    function isAgriCurrentlyBoosted() {
        return CITIES.every((city) => {
            try {
                return AGRI_BOOST.mats.some((mat) => Number(c.getMaterial(DIV_AGRI, city, mat).stored ?? 0) > 0);
            } catch {
                return false;
            }
        });
    }
    function isRound1WaitStateReady(saved = 0) {
        if (!isAgriRound1FoundationReady()) return false;
        if (saved >= 2) return true;
        if (isAgriCurrentlyBoosted()) return true;
        try {
            return !useRound1Route() && getRound1PrepStatus().complete;
        } catch {
            return false;
        }
    }
    function isBn3LeanRound2ShellReady() {
        if (!useBn3Round2() || !useBn3LeanTobRound2()) return false;
        if (!c.hasUnlock(UNLOCKS.export) || !hasDiv(DIV_TOBACCO)) return false;
        if (!divisionInfraReady(DIV_TOBACCO, PHASE3_TOB_START_CITIES)) return false;
        try {
            if ((c.getWarehouse(DIV_TOBACCO, HQ_CITY).level ?? 0) < 3) return false;
            const office = c.getOffice(DIV_TOBACCO, HQ_CITY);
            if ((office.size ?? 0) < PHASE3_TOB_INITIAL_HQ_OFFICE) return false;
            if ((office.numEmployees ?? 0) < PHASE3_TOB_INITIAL_HQ_OFFICE) return false;
        } catch {
            return false;
        }
        return tobaccoProducts().length > 0;
    }
    function isBn3HighBudgetRound2ShellReady() {
        if (!c.hasUnlock(UNLOCKS.export) || !hasDiv(DIV_CHEM) || !hasDiv(DIV_TOBACCO)) return false;
        try {
            for (const city of PHASE3_CHEM_START_CITIES) {
                const wh = c.getWarehouse(DIV_CHEM, city);
                const off = c.getOffice(DIV_CHEM, city);
                if ((wh.level ?? 0) < PHASE3_CHEM_INITIAL_WAREHOUSE) return false;
                if ((off.size ?? 0) < PHASE3_CHEM_INITIAL_OFFICE || (off.numEmployees ?? 0) < PHASE3_CHEM_INITIAL_OFFICE) return false;
            }
            for (const city of PHASE3_TOB_START_CITIES) {
                if (!c.hasWarehouse(DIV_TOBACCO, city)) return false;
                const off = c.getOffice(DIV_TOBACCO, city);
                if ((off.size ?? 0) < PHASE3_TOB_INITIAL_HQ_OFFICE || (off.numEmployees ?? 0) < PHASE3_TOB_INITIAL_HQ_OFFICE) return false;
            }
        } catch {
            return false;
        }
        return tobaccoProducts().length > 0;
    }
    function getLatePrivateRound2RecoveryPhase(divs = null) {
        const liveDivs = divs ?? new Set(c.getCorporation().divisions);
        const requireTobaccoBeforeRound2 = !delayTobaccoUntilPostRound2();
        const requireChemicalBeforeRound2 = !delayChemicalUntilPostRound2();
        const needsPreRound2Bootstrap = requireChemicalBeforeRound2 || requireTobaccoBeforeRound2;
        const latePrivateSignals =
            liveDivs.has(DIV_CHEM) || liveDivs.has(DIV_TOBACCO) || c.hasUnlock(UNLOCKS.export);
        if (!latePrivateSignals) return null;
        if (!needsPreRound2Bootstrap) return 4;
        if (useBn3HighBudgetRound2() && !isBn3HighBudgetRound2ShellReady()) return 3;
        if (useBn3LeanTobRound2() && !isBn3LeanRound2ShellReady()) return 3;
        if (
            (requireChemicalBeforeRound2 && !liveDivs.has(DIV_CHEM))
            || (requireTobaccoBeforeRound2 && !liveDivs.has(DIV_TOBACCO))
            || !c.hasUnlock(UNLOCKS.export)
        ) return 3;
        return 4;
    }
    function inferPhase(saved = 0) {
        if (!c.hasCorporation()) return 0;
        const corp = c.getCorporation();
        if (corpIsPublic(corp)) return 10;
        const divs = new Set(corp.divisions);
        const requireTobaccoBeforeRound2 = !delayTobaccoUntilPostRound2();
        const requireChemicalBeforeRound2 = !delayChemicalUntilPostRound2();
        const needsPreRound2Bootstrap = requireChemicalBeforeRound2 || requireTobaccoBeforeRound2;
        const hasCoreUnlocks = c.hasUnlock(UNLOCKS.warehouseAPI) && c.hasUnlock(UNLOCKS.officeAPI);
        if (!hasCoreUnlocks) return 0;
        if (!divs.has(DIV_AGRI)) return 1;
        const round = c.getInvestmentOffer().round;
        const recoveredRound2Phase = getLatePrivateRound2RecoveryPhase(divs);
        if (round <= 1 && recoveredRound2Phase != null) return Math.max(recoveredRound2Phase, Math.min(saved, 4));
        if (round <= 1) return isRound1WaitStateReady(saved) ? 2 : 1;
        if (!needsPreRound2Bootstrap && round <= 2) return 4;
        if (useBn3HighBudgetRound2() && !isBn3HighBudgetRound2ShellReady()) return 3;
        if (useBn3LeanTobRound2() && !isBn3LeanRound2ShellReady()) return 3;
        if (
            (requireChemicalBeforeRound2 && !divs.has(DIV_CHEM))
            || (requireTobaccoBeforeRound2 && !divs.has(DIV_TOBACCO))
            || (needsPreRound2Bootstrap && !c.hasUnlock(UNLOCKS.export))
        ) return 3;
        if (round <= 2) return 4;
        if (!isPostRound2BootstrapReady()) return 5;
        if (!isPhase6ScalingReady()) return 6;
        if (round <= 3) return Math.max(saved, 7);
        if (round === 4) return Math.max(saved, 8);
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

    if (!c.hasCorporation()) writeSetupRoute(null);
    else restorePersistedBn3Round2State();
    ns.tprint('INFO: Round1 before reconcile');
    let phase = reconcilePhase();
    ns.tprint(`INFO: Round1 after reconcile - phase=${phase}`);
    try {
        clearLingeringMaterialBuys();
        ns.tprint('INFO: Round1 cleared lingering material buys');
    } catch (error) {
        ns.tprint(`ERROR: Round1 clearLingeringMaterialBuys failed - ${error?.message ?? error}`);
        throw error;
    }
    let round1ReinvestDebtSettleChecks = 0;
    ns.tprint('INFO: Round1 post-cleanup setup complete');

    function handoffToOrchestrator(reason) {
        log(ns, `INFO: ${reason}`, true, 'info');
        ns.tprint(`INFO: ${reason}`);
        const pid = ns.run(resolvePath('corp-setup', 'corp-setup.js'), 1, ...ns.args);
        if (pid === 0) {
            log(ns, 'ERROR: Failed to launch /corp/corp-setup.js during corporation handoff.', true, 'warning');
            ns.tprint('ERROR: Failed to launch /corp/corp-setup.js during corporation handoff.');
        }
    }

    if (phase >= 10) {
        ns.write(SETUP_DONE_FLAG, 'true', 'w');
        const pilot = resolvePath('corp-autopilot', 'corp-autopilot.js');
        if (!ns.ps('home').some(p => p.filename === pilot)) ns.run(pilot, 1, ...(useIncomeMode() ? ['--income-mode'] : []));
        return;
    }
    if (!c.hasCorporation() && phase !== 0) {
        phase = 0;
        writePhase(0);
        writeSetupRoute(null);
        try { ns.rm(SETUP_DONE_FLAG, 'home'); } catch { }
    }
    if (phase >= 3) {
        handoffToOrchestrator(`Reconciled to phase ${phase}; /corp/corp-round1.js handles phases 0-2 only, so control is returning to /corp/corp-setup.js.`);
        return;
    }

    async function waitCycles(n = 1) {
        printCorpDebugDump();
        await ns.sleep(CYCLE_MS * n);
    }

    function getCorpStateName() {
        try { return String(c.getCorporation().state ?? ''); } catch { return ''; }
    }

    async function waitForFreshPurchasePass(timeoutMs = CYCLE_MS + 5000) {
        const initialState = getCorpStateName();
        let lastState = initialState;
        let sawStateChange = false;
        let enteredFreshPurchase = false;
        const deadline = Date.now() + Math.max(2000, Number(timeoutMs ?? 0) || 0);

        while (Date.now() < deadline) {
            await ns.sleep(200);
            const state = getCorpStateName();
            if (state !== initialState) sawStateChange = true;
            if (sawStateChange && state === 'PURCHASE') enteredFreshPurchase = true;
            if (enteredFreshPurchase && lastState === 'PURCHASE' && state !== 'PURCHASE') return true;
            lastState = state;
        }
        return false;
    }

    async function waitUntilNotPurchase(timeoutMs = CYCLE_MS + 5000) {
        const deadline = Date.now() + Math.max(2000, Number(timeoutMs ?? 0) || 0);
        while (Date.now() < deadline) {
            if (getCorpStateName() !== 'PURCHASE') return true;
            await ns.sleep(100);
        }
        return getCorpStateName() !== 'PURCHASE';
    }

    function noteBn3Gate(key, message, level = 'info') {
        if (!message) return;
        if (lastBn3GateNotes[key] === message) return;
        lastBn3GateNotes[key] = message;
        log(ns, `INFO: ${message}`, true, level);
    }

    function noteRound1Gate(key, message, level = 'info') {
        if (!message) return;
        if (lastRound1GateNotes[key] === message) return;
        lastRound1GateNotes[key] = message;
        log(ns, `INFO: ${message}`, true, level);
    }

    // Job assignment (two-pass zero first, then set targets) 
    // setJobAssignment operates on employeeNextJobs (pending state).
    // Pass 1 zeros all freed to Unassigned pool. Pass 2 draws from that pool.
    function getDivisionJobFillOrder(div, city, jobCounts = {}) {
        if (div === DIV_CHEM) return ['eng', 'ops', 'mgmt', 'rnd', 'biz'];
        if (div === DIV_TOBACCO) {
            if (city === HQ_CITY && hasActiveTobaccoDevelopment()) return ['eng', 'mgmt', 'ops', 'biz', 'rnd'];
            return ['biz', 'eng', 'mgmt', 'ops', 'rnd'];
        }
        if (div === DIV_AGRI) {
            if (Number(jobCounts.biz ?? 0) >= 3) return ['biz', 'eng', 'mgmt', 'ops', 'rnd'];
            if (Number(jobCounts.rnd ?? 0) >= 3 && sumJobCounts(jobCounts) <= 6) return ['rnd', 'eng', 'ops', 'mgmt', 'biz'];
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
            totalEmployees = Math.max(
                0,
                Math.floor(Number(targetSize ?? office.numEmployees ?? office.size ?? 0) || 0),
            );
        } catch {
            totalEmployees = Math.max(0, Math.floor(Number(targetSize ?? 0) || 0));
        }
        if (totalEmployees <= 0) return normalized;

        const fillOrder = getDivisionJobFillOrder(div, city, normalized);
        const requestedOrder = Object.entries(normalized)
            .filter(([, count]) => count > 0)
            .sort((a, b) => {
                if (b[1] !== a[1]) return b[1] - a[1];
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
            if (assigned >= totalEmployees) return capped;
        }
        for (let i = 0; assigned < totalEmployees; i++, assigned++) {
            const job = cycleOrder[i % cycleOrder.length];
            capped[job] = Number(capped[job] ?? 0) + 1;
        }
        return capped;
    }

    function assignJobs(div, city, { ops = 0, eng = 0, biz = 0, mgmt = 0, rnd = 0 } = {}) {
        const jobCounts = normalizeJobCountsForOffice(div, city, { ops, eng, biz, mgmt, rnd });
        for (const job of [JOBS.ops, JOBS.eng, JOBS.biz, JOBS.mgmt, JOBS.rnd])
            try { c.setJobAssignment(div, city, job, 0); } catch { }
        if (jobCounts.ops > 0) try { c.setJobAssignment(div, city, JOBS.ops, jobCounts.ops); } catch { }
        if (jobCounts.eng > 0) try { c.setJobAssignment(div, city, JOBS.eng, jobCounts.eng); } catch { }
        if (jobCounts.biz > 0) try { c.setJobAssignment(div, city, JOBS.biz, jobCounts.biz); } catch { }
        if (jobCounts.mgmt > 0) try { c.setJobAssignment(div, city, JOBS.mgmt, jobCounts.mgmt); } catch { }
        if (jobCounts.rnd > 0) try { c.setJobAssignment(div, city, JOBS.rnd, jobCounts.rnd); } catch { }
    }

    function fillOffice(div, city, targetSize, jobCounts) {
        const off = c.getOffice(div, city);
        if (off.size < targetSize) c.upgradeOfficeSize(div, city, targetSize - off.size);
        const n = c.getOffice(div, city).numEmployees;
        for (let i = n; i < targetSize; i++) c.hireEmployee(div, city, JOBS.unassigned);
        assignJobs(div, city, normalizeJobCountsForOffice(div, city, jobCounts, targetSize));
    }

    //  Boost materials 
    // Uses 70% of warehouse capacity for boosts (30% reserved for production stock).
    // Warehouse size = level 100 SmartStorageMult DivResearchMult.
    function getBoostTargets(div, city, factors, sizes, mats, usagePct = 0.70) {
        try {
            const wh = c.getWarehouse(div, city);
            return optimalBoosts(wh.size * usagePct, [...factors], [...sizes], [...mats]);
        } catch { return {}; }
    }

    function getExperimentalRound1AgriBoostTargets(city, profile = 'dynamic') {
        try {
            if (!useRound1Route() || !hasDiv(DIV_AGRI) || !c.hasWarehouse(DIV_AGRI, city)) {
                return getBoostTargets(DIV_AGRI, city, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);
            }
            if (profile === 'initial') {
                const wh = c.getWarehouse(DIV_AGRI, city);
                return optimalBoosts(
                    wh.size * ROUND1_ROUTE_FIXED_INITIAL_BOOST_USAGE_PCT,
                    [...AGRI_BOOST.factors],
                    [...AGRI_BOOST.sizes],
                    [...AGRI_BOOST.mats],
                );
            }
            const metrics = getExperimentalRound1AgriPressureMetrics(city, profile);
            return optimalBoosts(metrics.boostSpace, [...AGRI_BOOST.factors], [...AGRI_BOOST.sizes], [...AGRI_BOOST.mats]);
        } catch {
            return getBoostTargets(DIV_AGRI, city, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);
        }
    }

    function getExperimentalRound1AgriPressureMetrics(city, profile = 'dynamic') {
        try {
            const wh = c.getWarehouse(DIV_AGRI, city);
            const flow = getAgriCityFlowNumbers(city);
            const size = Math.max(0, Number(wh.size ?? 0));
            const used = Math.max(0, Number(wh.sizeUsed ?? 0));
            const productStoredSpace =
                (flow.foodStored * ROUND1_AGRI_PRODUCT_MAT_SIZES.Food) +
                (flow.plantsStored * ROUND1_AGRI_PRODUCT_MAT_SIZES.Plants);
            const currentInputSpace =
                (flow.waterStored * getMaterialSize('Water')) +
                (flow.chemicalsStored * getMaterialSize('Chemicals'));
            const usage = size > 0 ? used / size : 0;
            const baseExpected = getExperimentalRound1AgriExpectedFlow(city);

            const computeMetrics = (expected) => {
                const inputLeeway = profile === 'initial'
                    ? ROUND1_ROUTE_INITIAL_BOOST_INPUT_LEEWAY
                    : ROUND1_ROUTE_DYNAMIC_BOOST_INPUT_LEEWAY;
                const pressureBufferCycles = useRound1Route()
                    ? ROUND1_ROUTE_BOOST_PRESSURE_SUPPLY_BUFFER_CYCLES
                    : ROUND1_SUPPLY_BUFFER_CYCLES;
                const baseTargetInputSpace = Object.entries(ROUND1_AGRI_REQUIRED).reduce((total, [mat, coeff]) => {
                    const sizePerUnit = getMaterialSize(mat);
                    const targetUnits =
                        expected.perProduct *
                        coeff *
                        CYCLE_SECS *
                        pressureBufferCycles *
                        inputLeeway;
                    return total + Math.max(0, targetUnits) * sizePerUnit;
                }, 0);
                const targetInputSpace = profile === 'initial'
                    ? Math.max(ROUND1_ROUTE_INITIAL_BOOST_MIN_INPUT_SPACE, baseTargetInputSpace)
                    : baseTargetInputSpace;
                const prodCycles = profile === 'initial'
                    ? ROUND1_ROUTE_INITIAL_BOOST_PROD_CYCLES
                    : ROUND1_ROUTE_DYNAMIC_BOOST_PROD_CYCLES;
                const productSpikeSpace =
                    ((expected.food * ROUND1_AGRI_PRODUCT_MAT_SIZES.Food) +
                    (expected.plants * ROUND1_AGRI_PRODUCT_MAT_SIZES.Plants)) *
                    CYCLE_SECS *
                    prodCycles *
                    ROUND1_ROUTE_DYNAMIC_BOOST_PROD_LEEWAY;
                const safetyPct = profile === 'initial'
                    ? ROUND1_ROUTE_INITIAL_BOOST_SAFETY_PCT
                    : ROUND1_ROUTE_DYNAMIC_BOOST_SAFETY_PCT;
                const safetySpace = Math.max(1, size * safetyPct);
                const maxTotalUsagePct = profile === 'initial'
                    ? ROUND1_ROUTE_INITIAL_BOOST_MAX_TOTAL_USAGE_PCT
                    : ROUND1_ROUTE_DYNAMIC_BOOST_MAX_TOTAL_USAGE_PCT;
                const nonBoostSpace = productStoredSpace + Math.max(currentInputSpace, targetInputSpace);
                const safeTotalUsageSpace = Math.min(
                    size * maxTotalUsagePct,
                    Math.max(0, size - productSpikeSpace - safetySpace),
                );
                const boostSpace = Math.max(0, safeTotalUsageSpace - nonBoostSpace);
                const inputCatchupSpace = Math.max(0, targetInputSpace - currentInputSpace);
                const predictedUsage = size > 0
                    ? Math.min(1, (used + productSpikeSpace + inputCatchupSpace + safetySpace) / size)
                    : 0;
                return {
                    size,
                    used,
                    usage,
                    predictedUsage,
                    boostSpace,
                    productSpikeSpace,
                    inputCatchupSpace,
                    safetySpace,
                };
            };

            let projectedBoostRatio = 1;
            let metrics = computeMetrics(baseExpected);
            if (profile === 'initial') {
                for (let i = 0; i < 2; i++) {
                    const nextRatio = Math.min(
                        ROUND1_ROUTE_INITIAL_BOOST_EXPECTED_RATIO_CAP,
                        estimateExperimentalRound1AgriProjectedBoostRatio(city, metrics.boostSpace),
                    );
                    if (nextRatio <= projectedBoostRatio + 0.01) break;
                    projectedBoostRatio = nextRatio;
                    metrics = computeMetrics({
                        perProduct: baseExpected.perProduct * projectedBoostRatio,
                        food: baseExpected.food * projectedBoostRatio,
                        plants: baseExpected.plants * projectedBoostRatio,
                    });
                }
            }
            return { ...metrics, projectedBoostRatio };
        } catch {
            return {
                size: 0,
                used: 0,
                usage: 0,
                predictedUsage: 0,
                boostSpace: 0,
                productSpikeSpace: 0,
                inputCatchupSpace: 0,
                safetySpace: 0,
                projectedBoostRatio: 1,
            };
        }
    }

    function getExperimentalRound1AgriExpectedFlow(city) {
        try {
            const flow = getAgriCityFlowNumbers(city);
            const officeSize = Math.max(1, Number(c.getOffice(DIV_AGRI, city).size ?? 0));
            const bootstrapProd = Math.max(8, officeSize * (useBn3Round2() ? 3 : 2));
            const hintedProd = Math.max(Number(agriSupplyProdHints[city] ?? 0) * 0.9, bootstrapProd);
            const perProduct = Math.max(
                Number(flow.foodProduction ?? 0),
                Number(flow.plantsProduction ?? 0),
                hintedProd,
            );
            return {
                perProduct,
                food: Math.max(Number(flow.foodProduction ?? 0), perProduct),
                plants: Math.max(Number(flow.plantsProduction ?? 0), perProduct),
            };
        } catch {
            return { perProduct: 0, food: 0, plants: 0 };
        }
    }

    function getDivisionCityBoostContribution(div, city, targets = null) {
        try {
            const config = getDivisionBoostConfig(div);
            if (!config || !c.hasWarehouse(div, city)) return 1;
            let cityMult = 1;
            for (let i = 0; i < config.mats.length; i++) {
                const mat = config.mats[i];
                const factor = Math.max(0, Number(config.factors[i] ?? 0));
                if (factor <= 0) continue;
                const qty = Math.max(0, Number(targets?.[mat] ?? c.getMaterial(div, city, mat).stored ?? 0));
                cityMult *= Math.pow(1 + 0.002 * qty, factor);
            }
            return Math.max(1, Math.pow(cityMult, 0.73));
        } catch {
            return 1;
        }
    }

    function estimateExperimentalRound1AgriProjectedBoostRatio(city, boostSpace) {
        try {
            const currentContribution = getDivisionCityBoostContribution(DIV_AGRI, city);
            const projectedTargets = optimalBoosts(
                Math.max(0, Number(boostSpace ?? 0)),
                [...AGRI_BOOST.factors],
                [...AGRI_BOOST.sizes],
                [...AGRI_BOOST.mats],
            );
            const projectedContribution = getDivisionCityBoostContribution(DIV_AGRI, city, projectedTargets);
            if (!Number.isFinite(currentContribution) || currentContribution <= 0) return 1;
            return Math.max(1, projectedContribution / currentContribution);
        } catch {
            return 1;
        }
    }

    function getDivisionBoostConfig(div) {
        if (div === DIV_AGRI) return AGRI_BOOST;
        if (div === DIV_CHEM) return CHEM_BOOST;
        if (div === DIV_TOBACCO) return TOB_BOOST;
        return null;
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
        } catch {
            return 0;
        }
    }

    function estimateBoostTopUpCost(div, city, nextSize) {
        try {
            const targets = estimateBoostTargetsForSize(div, nextSize);
            let total = 0;
            for (const [mat, target] of Object.entries(targets)) {
                const stored = c.getMaterial(div, city, mat).stored;
                const needed = Math.max(0, target - stored);
                total += needed * getMaterialBuyPrice(div, city, mat);
            }
            return total;
        } catch {
            return 0;
        }
    }

    function estimateMaterialTargetSpend(div, city, targets) {
        try {
            let total = 0;
            for (const [mat, target] of Object.entries(targets)) {
                const stored = c.getMaterial(div, city, mat).stored;
                total += Math.max(0, target - stored) * getMaterialBuyPrice(div, city, mat);
            }
            return total;
        } catch {
            return Infinity;
        }
    }

    function scaleMaterialTargets(targets, scale = 1) {
        if (!targets || !Number.isFinite(scale)) return { ...(targets ?? {}) };
        const clampedScale = clamp(scale, 0, 1);
        if (clampedScale >= 0.9999) return { ...targets };
        return Object.fromEntries(
            Object.entries(targets).map(([mat, target]) => [mat, Math.max(0, Number(target ?? 0) * clampedScale)]),
        );
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
        } catch {
            return 0;
        }
    }

    function getRound1HighReinvestBoostTopUpWarehouseScale(pending, avgUsageCap, peakUsageCap) {
        try {
            if (!Array.isArray(pending) || pending.length <= 0) return 0;
            const pendingByCity = new Map(pending.map((entry) => [entry.city, entry]));
            let totalUsed = 0;
            let totalSize = 0;
            let totalAddedSpace = 0;
            let scale = 1;
            for (const city of CITIES) {
                try {
                    if (!c.hasWarehouse(DIV_AGRI, city)) continue;
                    const wh = c.getWarehouse(DIV_AGRI, city);
                    const size = Math.max(0, Number(wh.size ?? 0));
                    const used = Math.max(0, Number(wh.sizeUsed ?? 0));
                    if (size <= 0) continue;
                    totalUsed += used;
                    totalSize += size;
                    const entry = pendingByCity.get(city);
                    if (!entry) continue;
                    const addedSpace = getProjectedMaterialTargetAddedSpace(DIV_AGRI, city, entry.targets);
                    if (!Number.isFinite(addedSpace) || addedSpace <= 0) continue;
                    totalAddedSpace += addedSpace;
                    const cityHeadroom = Math.max(0, size * peakUsageCap - used);
                    if (cityHeadroom <= 0) return 0;
                    scale = Math.min(scale, cityHeadroom / addedSpace);
                } catch { }
            }
            if (totalAddedSpace <= 0 || totalSize <= 0) return 0;
            const totalHeadroom = Math.max(0, totalSize * avgUsageCap - totalUsed);
            if (totalHeadroom <= 0) return 0;
            scale = Math.min(scale, totalHeadroom / totalAddedSpace);
            return clamp(scale, 0, 1);
        } catch {
            return 0;
        }
    }

    function fitMaterialTargetsToBudget(div, city, targets, budget = Infinity) {
        const cappedBudget = Math.max(0, Number(budget ?? 0));
        if (!targets) return { targets: {}, spend: 0 };
        if (!Number.isFinite(cappedBudget)) {
            return {
                targets: { ...targets },
                spend: estimateMaterialTargetSpend(div, city, targets),
            };
        }
        if (cappedBudget <= 0) return { targets: scaleMaterialTargets(targets, 0), spend: 0 };

        const spend = estimateMaterialTargetSpend(div, city, targets);
        if (!Number.isFinite(spend) || spend <= 0) return { targets: { ...targets }, spend: 0 };
        if (spend <= cappedBudget) return { targets: { ...targets }, spend };

        const scaledTargets = scaleMaterialTargets(targets, cappedBudget / spend);
        return {
            targets: scaledTargets,
            spend: estimateMaterialTargetSpend(div, city, scaledTargets),
        };
    }

    function getExperimentalRound1InitialBoostBudget(reserve = 0) {
        try {
            if (!useRound1Route()) return Math.max(0, Number(c.getCorporation().funds ?? 0) - reserve);
            return Math.max(0, Number(c.getCorporation().funds ?? 0) - reserve + ROUND1_ROUTE_INITIAL_BOOST_DEBT);
        } catch {
            return 0;
        }
    }

    function estimateRound1AgriBoostFillSpend() {
        try {
            if (!hasDiv(DIV_AGRI)) return Infinity;
            let total = 0;
            for (const city of CITIES) {
                if (!c.hasWarehouse(DIV_AGRI, city)) continue;
                total += estimateMaterialTargetSpend(
                    DIV_AGRI,
                    city,
                    getBoostTargets(DIV_AGRI, city, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats),
                );
            }
            return total;
        } catch {
            return Infinity;
        }
    }

    function tryExperimentalRound1PreBoostSurplusSpend() {
        if (!useRound1Route() || !hasDiv(DIV_AGRI)) return null;
        const prep = getRound1PrepStatus();
        if (!prep.complete) return null;
        const reserve = ROUND1_ROUTE_PREBOOST_CASH_FLOOR;
        const actions = [];

        try {
            while (true) {
                const options = [];
                try {
                    const level = c.getUpgradeLevel('Smart Factories');
                    if (level < ROUND1_ROUTE_PREBOOST_SURPLUS_SMART_FACTORIES_TARGET) {
                        options.push({
                            cost: Number(c.getUpgradeLevelCost('Smart Factories') ?? Infinity),
                            key: 'sf',
                            perform: () => {
                                c.levelUpgrade('Smart Factories');
                                actions.push(`Smart Factories -> ${c.getUpgradeLevel('Smart Factories')}`);
                            },
                        });
                    }
                } catch { }
                try {
                    const level = c.getUpgradeLevel('ABC SalesBots');
                    if (level < ROUND1_ROUTE_PREBOOST_SURPLUS_SALES_BOTS_TARGET) {
                        options.push({
                            cost: Number(c.getUpgradeLevelCost('ABC SalesBots') ?? Infinity),
                            key: 'sb',
                            perform: () => {
                                c.levelUpgrade('ABC SalesBots');
                                actions.push(`ABC SalesBots -> ${c.getUpgradeLevel('ABC SalesBots')}`);
                            },
                        });
                    }
                } catch { }
                try {
                    const count = c.getHireAdVertCount(DIV_AGRI);
                    if (count < ROUND1_ROUTE_PREBOOST_SURPLUS_ADVERT_TARGET) {
                        options.push({
                            cost: Number(c.getHireAdVertCost(DIV_AGRI) ?? Infinity),
                            key: 'adv',
                            perform: () => {
                                c.hireAdVert(DIV_AGRI);
                                actions.push(`Agriculture AdVert -> ${c.getHireAdVertCount(DIV_AGRI)}`);
                            },
                        });
                    }
                } catch { }
                options.sort((a, b) => a.cost - b.cost || a.key.localeCompare(b.key));
                const next = options.find((option) => Number.isFinite(option.cost) && canSpend(option.cost, reserve));
                if (!next) break;
                next.perform();
            }
        } catch { }

        try {
            while (c.getUpgradeLevel('FocusWires') < ROUND1_ROUTE_PREBOOST_SURPLUS_FOCUS_WIRES_TARGET) {
                const cost = c.getUpgradeLevelCost('FocusWires');
                if (!canSpend(cost, reserve)) break;
                c.levelUpgrade('FocusWires');
                actions.push(`FocusWires -> ${c.getUpgradeLevel('FocusWires')}`);
            }
        } catch { }

        try {
            while (c.getUpgradeLevel('Smart Storage') < ROUND1_ROUTE_PREBOOST_SURPLUS_SMART_STORAGE_TARGET) {
                const cost = c.getUpgradeLevelCost('Smart Storage');
                if (!canSpend(cost, reserve)) break;
                c.levelUpgrade('Smart Storage');
                actions.push(`Smart Storage -> ${c.getUpgradeLevel('Smart Storage')}`);
            }
        } catch { }

        if (actions.length <= 0) return null;
        return {
            actions,
            reserve,
            funds: Number(c.getCorporation().funds ?? 0),
        };
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
        } catch {
            return Infinity;
        }
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
        } catch {
            return Infinity;
        }
    }

    async function applyBoostMaterials(div, city, targets, reserve = 0) {
        let scale = 1;
        if (Number.isFinite(reserve) && reserve !== 0) {
            const spend = estimateMaterialTargetSpend(div, city, targets);
            const budget = Math.max(0, Number(c.getCorporation().funds ?? 0) - reserve);
            if (!Number.isFinite(spend) || spend <= 0 || budget <= 0) return;
            if (spend > budget) scale = budget / spend;
        }
        try {
            if (c.hasWarehouse(div, city)) {
                prevWHCapacity[`${div}|${city}`] = Number(c.getWarehouse(div, city).size ?? 0);
            }
        } catch { }
        let anyNeeded = false;
        await waitUntilNotPurchase();
        for (const [mat, target] of Object.entries(targets)) {
            const stored = c.getMaterial(div, city, mat).stored;
            const needed = Math.max(0, target - stored) * scale;
            if (needed > 0) { c.buyMaterial(div, city, mat, needed / CYCLE_SECS); anyNeeded = true; }
        }
        if (anyNeeded) {
            await waitForFreshPurchasePass();
            for (const mat of Object.keys(targets)) c.buyMaterial(div, city, mat, 0);
        }
    }

    async function applyBoostMaterialsBatch(div, cityTargets, reserve = 0) {
        const targetsByCity = Object.fromEntries(
            Object.entries(cityTargets ?? {}).filter(([, targets]) => targets && Object.keys(targets).length > 0),
        );
        const cities = Object.keys(targetsByCity);
        if (!cities.length) return 0;

        let scale = 1;
        if (Number.isFinite(reserve) && reserve !== 0) {
            const spend = cities.reduce(
                (total, city) => total + estimateMaterialTargetSpend(div, city, targetsByCity[city]),
                0,
            );
            const budget = Math.max(0, Number(c.getCorporation().funds ?? 0) - reserve);
            if (!Number.isFinite(spend) || spend <= 0 || budget <= 0) return 0;
            if (spend > budget) scale = budget / spend;
        }

        let anyNeeded = false;
        const activeBuys = [];
        await waitUntilNotPurchase();
        for (const city of cities) {
            try {
                if (c.hasWarehouse(div, city)) {
                    prevWHCapacity[`${div}|${city}`] = Number(c.getWarehouse(div, city).size ?? 0);
                }
            } catch { }
            for (const [mat, target] of Object.entries(targetsByCity[city])) {
                const stored = c.getMaterial(div, city, mat).stored;
                const needed = Math.max(0, target - stored) * scale;
                if (needed <= 0) continue;
                c.buyMaterial(div, city, mat, needed / CYCLE_SECS);
                activeBuys.push([city, mat]);
                anyNeeded = true;
            }
        }
        if (anyNeeded) {
            await waitForFreshPurchasePass();
            for (const [city, mat] of activeBuys) c.buyMaterial(div, city, mat, 0);
        }
        return scale;
    }

    async function applyBoostMaterialsBatchChunked(
        div,
        cityTargets,
        reserve = 0,
        chunkFraction = 1,
        maxPasses = 1,
    ) {
        const finalTargetsByCity = Object.fromEntries(
            Object.entries(cityTargets ?? {}).filter(([, targets]) => targets && Object.keys(targets).length > 0),
        );
        const cities = Object.keys(finalTargetsByCity);
        if (!cities.length) return { passes: 0 };

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
                    if (deficit <= 0.5) continue;
                    chunkTargets[mat] = stored + deficit * clampedChunkFraction;
                    hasRemainingNeed = true;
                }
                if (Object.keys(chunkTargets).length > 0) {
                    chunkTargetsByCity[city] = chunkTargets;
                }
            }

            if (!hasRemainingNeed) break;
            await applyBoostMaterialsBatch(div, chunkTargetsByCity, reserve);
            passes++;
        }

        return { passes };
    }

    // Re-apply boosts whenever warehouse capacity changes from level, Smart Storage, or research.
    const prevWHCapacity = {};
    async function refreshBoosts(div, factors, sizes, mats) {
        for (const city of CITIES) {
            try {
                const key = `${div}|${city}`;
                const cap = c.getWarehouse(div, city).size;
                if (cap !== prevWHCapacity[key]) {
                    prevWHCapacity[key] = cap;
                    const targets = useRound1Route() && div === DIV_AGRI
                        ? getExperimentalRound1AgriBoostTargets(city)
                        : getBoostTargets(div, city, factors, sizes, mats);
                    await applyBoostMaterials(div, city, targets);
                }
            } catch { }
        }
    }

    //  Division helpers 
    function getRound1HighReinvestRealEstatePushPlan(
        materialFloor,
        usagePct = ROUND1_RE_PUSH_USAGE_PCT,
        maxSpendCap = Infinity,
    ) {
        const reSize = AGRI_SIZES[AGRI_MATS.indexOf('Real Estate')];
        if (!Number.isFinite(reSize) || reSize <= 0) return null;

        const funds = Number(c.getCorporation().funds ?? 0);
        const budget = Math.max(0, Math.min(funds - materialFloor, maxSpendCap));
        if (!Number.isFinite(budget) || budget <= 0) return null;

        const candidates = [];
        for (const city of CITIES) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                const targetUsage = wh.size * usagePct;
                const freeHeadroom = Math.max(0, targetUsage - wh.sizeUsed);
                if (freeHeadroom < reSize) continue;

                const price = getMaterialBuyPrice(DIV_AGRI, city, 'Real Estate');
                if (!Number.isFinite(price) || price <= 0) continue;

                const maxUnits = Math.floor(freeHeadroom / reSize);
                if (!Number.isFinite(maxUnits) || maxUnits <= 0) continue;
                candidates.push({ city, price, maxUnits });
            } catch { }
        }

        if (candidates.length <= 0) return null;
        if (candidates.length === 1) {
            const candidate = candidates[0];
            const affordable = Math.floor(budget / candidate.price);
            const needed = Math.min(affordable, candidate.maxUnits);
            const spend = needed * candidate.price;
            if (!Number.isFinite(needed) || needed <= 0) return null;
            if (!Number.isFinite(spend) || spend < ROUND1_RE_PUSH_MIN_SPEND) return null;
            return {
                city: candidate.city,
                pushes: [{ city: candidate.city, needed, spend }],
                spend,
                label: `Agriculture ${candidate.city} extra Real Estate push`,
            };
        }

        const perCityBudget = budget / candidates.length;
        const pushes = [];
        let totalSpend = 0;
        for (const candidate of candidates) {
            const affordable = Math.floor(perCityBudget / candidate.price);
            const needed = Math.min(affordable, candidate.maxUnits);
            const spend = needed * candidate.price;
            if (!Number.isFinite(needed) || needed <= 0) continue;
            if (!Number.isFinite(spend) || spend <= 0) continue;
            pushes.push({ city: candidate.city, needed, spend });
            totalSpend += spend;
        }

        if (pushes.length <= 0) return null;
        if (totalSpend < ROUND1_RE_PUSH_MIN_SPEND) return null;
        return {
            city: pushes.length === 1 ? pushes[0].city : 'balanced',
            pushes,
            spend: totalSpend,
            label: pushes.length === 1
                ? `Agriculture ${pushes[0].city} extra Real Estate push`
                : 'Agriculture balanced Real Estate push',
        };
    }

    function getRound1ReinvestBoostTopUpPlan(
        materialFloor,
        maxSpendCap = Infinity,
        avgUsageCap = ROUND1_REINVEST_BOOST_TOPUP_MAX_USAGE_PCT,
        peakUsageCap = ROUND1_REINVEST_BOOST_TOPUP_MAX_PEAK_PCT,
    ) {
        const funds = Number(c.getCorporation().funds ?? 0);
        const budget = Math.max(0, Math.min(funds - materialFloor, maxSpendCap));
        if (!Number.isFinite(budget) || budget <= 0) return null;
        const usage = getAgriWarehouseUsageSummary();
        if (
            usage.avg > avgUsageCap ||
            usage.peak > peakUsageCap
        ) {
            return null;
        }

        const pending = [];
        let projectedSpend = 0;
        for (const city of CITIES) {
            try {
                const initialTargets = getExperimentalRound1AgriBoostTargets(city, 'initial');
                const dynamicTargets = getExperimentalRound1AgriBoostTargets(city, 'dynamic');
                const targets = {};
                for (const mat of AGRI_MATS) {
                    const cappedTarget = Math.min(
                        Number(initialTargets?.[mat] ?? 0),
                        Number(dynamicTargets?.[mat] ?? 0),
                    );
                    if (cappedTarget > 0) targets[mat] = cappedTarget;
                }
                const spend = estimateMaterialTargetSpend(DIV_AGRI, city, targets);
                if (!Number.isFinite(spend) || spend <= 0) continue;
                pending.push({ city, targets, spend });
                projectedSpend += spend;
            } catch { }
        }
        if (pending.length <= 0 || !Number.isFinite(projectedSpend) || projectedSpend <= 0) return null;

        const budgetScale = Math.min(1, budget / projectedSpend);
        const warehouseScale = getRound1HighReinvestBoostTopUpWarehouseScale(
            pending,
            avgUsageCap,
            peakUsageCap,
        );
        const scale = Math.min(1, budgetScale, warehouseScale);
        if (!Number.isFinite(scale) || scale <= 0) return null;
        const targetsByCity = {};
        let totalSpend = 0;
        for (const entry of pending) {
            const scaledTargets = scaleMaterialTargetsFromStored(DIV_AGRI, entry.city, entry.targets, scale);
            const spend = estimateMaterialTargetSpend(DIV_AGRI, entry.city, scaledTargets);
            if (!Number.isFinite(spend) || spend <= 1e6) continue;
            targetsByCity[entry.city] = scaledTargets;
            totalSpend += spend;
        }
        if (Object.keys(targetsByCity).length <= 0) return null;

        return {
            targetsByCity,
            spend: totalSpend,
            label: Object.keys(targetsByCity).length === 1
                ? `Agriculture ${Object.keys(targetsByCity)[0]} boost top-up`
                : 'Agriculture balanced boost top-up',
        };
    }

    async function tryRound1HighReinvestRealEstatePush(
        materialFloor,
        usagePct = ROUND1_RE_PUSH_USAGE_PCT,
        maxSpendCap = Infinity,
    ) {
        const plan = getRound1HighReinvestRealEstatePushPlan(materialFloor, usagePct, maxSpendCap);
        if (!plan) return null;

        await waitUntilNotPurchase();
        for (const push of plan.pushes) {
            c.buyMaterial(DIV_AGRI, push.city, 'Real Estate', push.needed / CYCLE_SECS);
        }
        try {
            await waitForFreshPurchasePass();
        } finally {
            for (const push of plan.pushes) {
                try { c.buyMaterial(DIV_AGRI, push.city, 'Real Estate', 0); } catch { }
            }
        }
        return plan;
    }

    async function tryRound1ReinvestBoostTopUp(
        materialFloor,
        maxSpendCap = Infinity,
        avgUsageCap = ROUND1_REINVEST_BOOST_TOPUP_MAX_USAGE_PCT,
        peakUsageCap = ROUND1_REINVEST_BOOST_TOPUP_MAX_PEAK_PCT,
    ) {
        const plan = getRound1ReinvestBoostTopUpPlan(
            materialFloor,
            maxSpendCap,
            avgUsageCap,
            peakUsageCap,
        );
        if (!plan) return null;
        await applyBoostMaterialsBatch(DIV_AGRI, plan.targetsByCity, materialFloor);
        return plan;
    }

    function hasDiv(div) {
        try { return c.getCorporation().divisions.includes(div); } catch { return false; }
    }

    function stopManagedMaterialBuys(div, materials, cities = CITIES) {
        if (!hasDiv(div)) return;
        for (const city of cities) {
            for (const mat of materials) {
                try { c.buyMaterial(div, city, mat, 0); } catch { }
            }
        }
    }

    function clearLingeringMaterialBuys() {
        stopManagedMaterialBuys(
            DIV_AGRI,
            [...new Set([...Object.keys(ROUND1_AGRI_REQUIRED), ...AGRI_MATS, ...Object.keys(ROUND2_BN3_MATERIAL_TARGETS)])],
        );
        stopManagedMaterialBuys(
            DIV_CHEM,
            [...new Set(['Water', ...CHEM_MATS])],
        );
        stopManagedMaterialBuys(
            DIV_TOBACCO,
            [...new Set(['Plants', ...TOB_MATS])],
        );
    }

    function stopExperimentalRound1BoostTrim(cities = CITIES) {
        if (!hasDiv(DIV_AGRI)) return;
        for (const city of cities) {
            round1ExperimentalBoostTrimSellRates[city] = {};
            for (const mat of ROUND1_ROUTE_BOOST_TRIM_ORDER) {
                try { c.buyMaterial(DIV_AGRI, city, mat, 0); } catch { }
                try { c.sellMaterial(DIV_AGRI, city, mat, '0', 'MP'); } catch { }
                round1ExperimentalBoostTrimSellRates[city][mat] = 0;
            }
            round1ExperimentalBoostTrimActive[city] = false;
            round1ExperimentalBoostTrimMode[city] = 'off';
        }
    }

    function shouldPreserveExperimentalRound1Offer(bestOffer = 0, currentOffer = 0, stagnantChecks = 0) {
        if (!useRound1Route()) return false;
        const softFloor = Math.max(1, getRound1SoftFloor());
        return Number(bestOffer ?? 0) >= softFloor * ROUND1_ROUTE_BOOST_PRESERVE_SOFT_FLOOR_PCT &&
            Number(currentOffer ?? 0) >= Number(bestOffer ?? 0) * ROUND1_ROUTE_BOOST_PRESERVE_NEAR_BEST_PCT &&
            Number(stagnantChecks ?? 0) <= ROUND1_ROUTE_BOOST_PRESERVE_MAX_STAGNATION;
    }

    function manageExperimentalRound1BoostTrim(bestOffer = 0, currentOffer = 0, stagnantChecks = 0) {
        if (!useRound1Route() || !hasDiv(DIV_AGRI)) {
            stopExperimentalRound1BoostTrim();
            return null;
        }

        const events = [];
        const corpState = String(c.getCorporation().state ?? '');
        const preserveOffer = shouldPreserveExperimentalRound1Offer(bestOffer, currentOffer, stagnantChecks);
        const cityStates = [];
        for (const city of CITIES) {
            try {
                if (!c.hasWarehouse(DIV_AGRI, city)) continue;
                const wh = c.getWarehouse(DIV_AGRI, city);
                const pressure = getExperimentalRound1AgriPressureMetrics(city);
                const usage = pressure.usage;
                const predictedUsage = pressure.predictedUsage;
                const boostTargets = getExperimentalRound1AgriBoostTargets(city, 'initial');
                const savedMode = round1ExperimentalBoostTrimMode[city];
                const wasMode = savedMode === 'pre' || savedMode === 'full'
                    ? savedMode
                    : (round1ExperimentalBoostTrimActive[city] ? 'full' : 'off');
                const wasActive = wasMode !== 'off';
                let hasTrimCapacity = false;

                for (const mat of ROUND1_ROUTE_BOOST_TRIM_ORDER) {
                    const target = Math.max(0, Number(boostTargets[mat] ?? 0));
                    const keepTarget = target * ROUND1_ROUTE_BOOST_PRETRIM_KEEP_RATIO;
                    const stored = Math.max(0, Number(c.getMaterial(DIV_AGRI, city, mat).stored ?? 0));
                    if (stored > keepTarget + 1) {
                        hasTrimCapacity = true;
                        break;
                    }
                }
                const hasRefillNeed = ROUND1_ROUTE_BOOST_TRIM_ORDER.some((mat) => {
                    const target = Math.max(0, Number(boostTargets[mat] ?? 0));
                    const stored = Math.max(0, Number(c.getMaterial(DIV_AGRI, city, mat).stored ?? 0));
                    return stored + 1 < target;
                });
                const nearBest = bestOffer <= 0 || currentOffer >= bestOffer * ROUND1_ROUTE_BOOST_REFILL_NEAR_BEST_PCT;
                const lowUsageWindow = usage <= ROUND1_ROUTE_BOOST_REFILL_START_PCT;
                const stateAllowsRefill = corpState === 'SALE->START' || corpState === 'START->PURCHASE';
                const shouldRefill = !wasActive && hasRefillNeed && lowUsageWindow && nearBest &&
                    stagnantChecks >= ROUND1_ROUTE_BOOST_REFILL_STAGNATION && stateAllowsRefill;
                const wantsPretrim = !preserveOffer && hasTrimCapacity &&
                    (usage >= ROUND1_ROUTE_BOOST_PRETRIM_TRIGGER_USAGE_PCT ||
                        (usage >= ROUND1_ROUTE_BOOST_PRETRIM_MIN_USAGE_FOR_PREDICTIVE_PCT &&
                            predictedUsage >= ROUND1_ROUTE_BOOST_PRETRIM_TRIGGER_PREDICTIVE_PCT));
                const wantsFullTrim = !preserveOffer && hasTrimCapacity &&
                    (usage >= ROUND1_ROUTE_BOOST_TRIM_PRESSURE_PCT ||
                        (usage >= ROUND1_ROUTE_BOOST_FULL_TRIGGER_MIN_USAGE_PCT &&
                            predictedUsage >= ROUND1_ROUTE_BOOST_FULL_TRIGGER_PREDICTIVE_PCT));
                cityStates.push({
                    city,
                    wh,
                    pressure,
                    usage,
                    predictedUsage,
                    boostTargets,
                    wasMode,
                    wasActive,
                    hasTrimCapacity,
                    hasRefillNeed,
                    shouldRefill,
                    wantsPretrim,
                    wantsFullTrim,
                });
            } catch { }
        }

        const allowedActivationModes = new Map();
        for (const state of cityStates
            .filter((entry) => entry.wasMode === 'off' && entry.wantsPretrim)
            .sort((a, b) => (b.predictedUsage - a.predictedUsage) || (b.usage - a.usage) || a.city.localeCompare(b.city))
            .slice(0, ROUND1_ROUTE_BOOST_TRIM_STAGGER_LIMIT)) {
            allowedActivationModes.set(state.city, 'pre');
        }

        for (const state of cityStates) {
            try {
                const {
                    city,
                    wh,
                    pressure,
                    usage,
                    predictedUsage,
                    boostTargets,
                    wasMode,
                    wasActive,
                    hasRefillNeed,
                    shouldRefill,
                    wantsPretrim,
                    wantsFullTrim,
                } = state;
                let mode = wasMode;
                if (preserveOffer) {
                    mode = 'off';
                } else if (mode === 'off') {
                    mode = allowedActivationModes.get(city) ?? 'off';
                } else if (mode === 'pre') {
                    if (wantsFullTrim) {
                        mode = 'full';
                    } else if (
                        usage <= ROUND1_ROUTE_BOOST_PRETRIM_RELEASE_PCT &&
                        predictedUsage < ROUND1_ROUTE_BOOST_PRETRIM_RELEASE_PREDICTIVE_PCT
                    ) {
                        mode = 'off';
                    }
                } else if (mode === 'full') {
                    if (!wantsFullTrim) {
                        if (wantsPretrim ||
                            usage > ROUND1_ROUTE_BOOST_PRETRIM_RELEASE_PCT ||
                            predictedUsage >= ROUND1_ROUTE_BOOST_PRETRIM_RELEASE_PREDICTIVE_PCT) {
                            mode = 'pre';
                        } else {
                            mode = 'off';
                        }
                    }
                }

                const active = mode !== 'off';
                round1ExperimentalBoostTrimActive[city] = active;
                round1ExperimentalBoostTrimMode[city] = mode;
                if (!active && !shouldRefill) {
                    round1ExperimentalBoostTrimSellRates[city] ??= {};
                    for (const mat of ROUND1_ROUTE_BOOST_TRIM_ORDER) {
                        try { c.buyMaterial(DIV_AGRI, city, mat, 0); } catch { }
                        try { c.sellMaterial(DIV_AGRI, city, mat, '0', 'MP'); } catch { }
                        round1ExperimentalBoostTrimSellRates[city][mat] = 0;
                    }
                    if (wasActive) {
                        events.push(
                            `Agriculture ${city} ${wasMode === 'pre' ? 'boost pre-trim' : 'boost trim'} paused ` +
                            `(usage ${(usage * 100).toFixed(1)}%, pred ${(predictedUsage * 100).toFixed(1)}%).`,
                        );
                    }
                    continue;
                }

                if (shouldRefill) {
                    const flow = getAgriCityFlowNumbers(city);
                    const productSpikeSpace =
                        ((flow.foodProduction * ROUND1_AGRI_PRODUCT_MAT_SIZES.Food) +
                        (flow.plantsProduction * ROUND1_AGRI_PRODUCT_MAT_SIZES.Plants)) *
                        CYCLE_SECS *
                        ROUND1_ROUTE_BOOST_REFILL_PROD_CYCLES *
                        ROUND1_ROUTE_BOOST_REFILL_PROD_LEEWAY;
                    const refillCapUsage = Math.min(
                        Number(wh.size ?? 0) * ROUND1_ROUTE_BOOST_REFILL_USAGE_PCT,
                        Math.max(0, Number(wh.size ?? 0) - productSpikeSpace),
                    );
                    let refillSpace = Math.max(0, refillCapUsage - Number(wh.sizeUsed ?? 0));
                    const refillNotes = [];
                    for (const mat of ROUND1_ROUTE_BOOST_TRIM_ORDER) {
                        const target = Math.max(0, Number(boostTargets[mat] ?? 0));
                        const stored = Math.max(0, Number(c.getMaterial(DIV_AGRI, city, mat).stored ?? 0));
                        const size = getPhysicalMaterialSize(mat, ROUND1_ROUTE_BOOST_TRIM_SIZES[mat] ?? 0);
                        const neededUnits = Math.max(0, target - stored);
                        let buyUnits = 0;
                        if (refillSpace > 0 && size > 0 && neededUnits > 0) {
                            buyUnits = Math.min(neededUnits, Math.floor(refillSpace / size));
                            refillSpace = Math.max(0, refillSpace - buyUnits * size);
                        }
                        try { c.sellMaterial(DIV_AGRI, city, mat, '0', 'MP'); } catch { }
                        try { c.buyMaterial(DIV_AGRI, city, mat, buyUnits > 0 ? buyUnits / CYCLE_SECS : 0); } catch { }
                        round1ExperimentalBoostTrimSellRates[city] ??= {};
                        round1ExperimentalBoostTrimSellRates[city][mat] = 0;
                        if (buyUnits > 0) refillNotes.push(`${mat} +${Math.round(buyUnits)}`);
                    }
                    if (refillNotes.length > 0) {
                        events.push(
                            `Agriculture ${city} boost refill active ` +
                            `(usage ${(usage * 100).toFixed(1)}%, pred ${(predictedUsage * 100).toFixed(1)}%, ` +
                            `state ${corpState}, cap ${(refillCapUsage / Math.max(1, Number(wh.size ?? 1)) * 100).toFixed(1)}%, ${refillNotes.join(', ')}).`,
                        );
                    }
                    continue;
                }

                const isPretrim = mode === 'pre';
                const warehouseSize = Math.max(0, Number(wh.size ?? 0));
                const predictiveReservedSpace =
                    Math.max(0, Number(pressure.productSpikeSpace ?? 0)) +
                    Math.max(0, Number(pressure.inputCatchupSpace ?? 0)) +
                    Math.max(0, Number(pressure.safetySpace ?? 0));
                const desiredUsedCap = isPretrim
                    ? Math.max(
                        0,
                        Math.min(
                            warehouseSize * ROUND1_ROUTE_BOOST_PRETRIM_TARGET_USAGE_PCT,
                            warehouseSize * ROUND1_ROUTE_BOOST_PRETRIM_TARGET_PREDICTIVE_PCT - predictiveReservedSpace,
                        ),
                    )
                    : Math.max(
                        0,
                        Math.min(
                            warehouseSize * ROUND1_ROUTE_BOOST_TRIM_RELEASE_PCT,
                            warehouseSize * ROUND1_ROUTE_BOOST_TRIM_PREDICTIVE_PCT - predictiveReservedSpace,
                        ),
                    );
                let remainingSpaceNeeded = Math.max(0, Number(wh.sizeUsed ?? 0) - desiredUsedCap);
                const trimNotes = [];
                const trimEntries = [];
                let totalSellableSpace = 0;
                for (const mat of ROUND1_ROUTE_BOOST_TRIM_ORDER) {
                    const target = Math.max(0, Number(boostTargets[mat] ?? 0));
                    const keepTarget = Math.max(
                        0,
                        target * (isPretrim ? ROUND1_ROUTE_BOOST_PRETRIM_KEEP_RATIO : ROUND1_ROUTE_BOOST_TRIM_KEEP_RATIO),
                    );
                    const stored = Math.max(0, Number(c.getMaterial(DIV_AGRI, city, mat).stored ?? 0));
                    const size = getPhysicalMaterialSize(mat, ROUND1_ROUTE_BOOST_TRIM_SIZES[mat] ?? 0);
                    const sellableUnits = Math.max(0, stored - keepTarget);
                    const sellableSpace = sellableUnits * size;
                    trimEntries.push({ mat, size, sellableUnits, sellableSpace, sellUnits: 0, fractional: 0 });
                    totalSellableSpace += sellableSpace;
                }

                if (remainingSpaceNeeded > 0 && totalSellableSpace > 0) {
                    const trimRatio = Math.min(1, remainingSpaceNeeded / totalSellableSpace);
                    let freedSpace = 0;
                    for (const entry of trimEntries) {
                        if (entry.size <= 0 || entry.sellableUnits <= 0) continue;
                        const exactUnits = entry.sellableUnits * trimRatio;
                        const baseUnits = exactUnits >= 0.5
                            ? Math.min(entry.sellableUnits, Math.floor(exactUnits))
                            : 0;
                        entry.sellUnits = baseUnits;
                        entry.fractional = exactUnits - baseUnits;
                        freedSpace += entry.sellUnits * entry.size;
                    }
                    remainingSpaceNeeded = Math.max(0, remainingSpaceNeeded - freedSpace);
                    if (remainingSpaceNeeded > 0) {
                        for (const entry of [...trimEntries].sort((a, b) => {
                            if (b.fractional !== a.fractional) return b.fractional - a.fractional;
                            if (a.size !== b.size) return a.size - b.size;
                            return a.mat.localeCompare(b.mat);
                        })) {
                            if (remainingSpaceNeeded <= 0) break;
                            if (entry.size <= 0) continue;
                            const remainingUnits = Math.max(0, entry.sellableUnits - entry.sellUnits);
                            if (remainingUnits <= 0) continue;
                            const extraUnits = Math.min(remainingUnits, Math.ceil(remainingSpaceNeeded / entry.size));
                            entry.sellUnits += extraUnits;
                            remainingSpaceNeeded = Math.max(0, remainingSpaceNeeded - extraUnits * entry.size);
                        }
                    }
                }

                for (const entry of trimEntries) {
                    const { mat, sellUnits } = entry;
                    try { c.buyMaterial(DIV_AGRI, city, mat, 0); } catch { }
                    const sellRate = 0;
                    try { c.sellMaterial(DIV_AGRI, city, mat, '0', 'MP'); } catch { }
                    round1ExperimentalBoostTrimSellRates[city] ??= {};
                    round1ExperimentalBoostTrimSellRates[city][mat] = sellRate;
                    if (sellUnits > 0) trimNotes.push(`${mat} -${Math.round(sellUnits)}`);
                }
                if (trimNotes.length > 0) {
                    const label = isPretrim ? 'boost pre-trim' : 'boost trim';
                    const prefix =
                        wasMode === 'off' ? 'active'
                            : wasMode === mode ? 'adjusted'
                                : wasMode === 'pre' && mode === 'full' ? 'escalated'
                                    : 'stepped-down';
                    events.push(
                        `Agriculture ${city} ${label} ${prefix} ` +
                        `(usage ${(usage * 100).toFixed(1)}%, pred ${(predictedUsage * 100).toFixed(1)}%, ${trimNotes.join(', ')}).`,
                    );
                }
            } catch { }
        }
        return events.length > 0 ? events : null;
    }

    function expandIndustryCost(industry) {
        try { return c.getIndustryData(industry).startingCost; } catch { return Infinity; }
    }

    function expandToCities(div, targetCities = CITIES) {
        const existing = c.getDivision(div).cities;
        for (const city of targetCities) {
            if (!existing.includes(city)) try { c.expandCity(div, city); } catch { }
        }
        for (const city of targetCities)
            if (!c.hasWarehouse(div, city)) try { c.purchaseWarehouse(div, city); } catch { }
    }

    function buyUnlock(name) {
        try {
            if (!c.hasUnlock(name)) { c.purchaseUnlock(name); log(ns, `  Purchased: ${name}`, false, 'info'); }
        } catch (e) { log(ns, `  WARN: Could not buy "${name}": ${e?.message}`, false, 'warning'); }
    }

    function enableSmartSupply(div, cities = CITIES) {
        if (!c.hasUnlock(UNLOCKS.smartSupply)) return;
        for (const city of cities)
            try { if (c.hasWarehouse(div, city)) c.setSmartSupply(div, city, true); } catch { }
    }

    function disableSmartSupply(div, cities = CITIES) {
        if (!c.hasUnlock(UNLOCKS.smartSupply)) return;
        for (const city of cities)
            try { if (c.hasWarehouse(div, city)) c.setSmartSupply(div, city, false); } catch { }
    }

    function setLeftovers(div, city, materials) {
        if (!c.hasUnlock(UNLOCKS.smartSupply)) return;
        for (const material of materials) {
            try { c.setSmartSupplyOption(div, city, material, 'leftovers'); } catch { }
        }
    }

    function divisionInfraReady(div, targetCities = CITIES) {
        try {
            const cities = c.getDivision(div).cities;
            return targetCities.every(city => cities.includes(city) && c.hasWarehouse(div, city));
        } catch {
            return false;
        }
    }

    async function waitForDivisionInfrastructure(div, label, targetCities = CITIES) {
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
                if (wh.level >= targetLevel) return;
                c.upgradeWarehouse(div, city, 1);
            } catch { }
            await waitCycles(1);
        }
    }

    function bulkUpgradeWarehousesToLevel(div, targetLevel, reserve = 0, targetCities = CITIES) {
        let complete = true;
        for (const city of targetCities) {
            try {
                while (true) {
                    const wh = c.getWarehouse(div, city);
                    if (wh.level >= targetLevel) break;
                    const cost = c.getUpgradeWarehouseCost(div, city, 1);
                    const funds = Number(c.getCorporation().funds ?? 0);
                    if (!Number.isFinite(cost) || funds - cost < reserve) {
                        complete = false;
                        break;
                    }
                    c.upgradeWarehouse(div, city, 1);
                }
                if (c.getWarehouse(div, city).level < targetLevel) complete = false;
            } catch {
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
            } catch { }
            await waitCycles(1);
        }
    }

    function maintainRound1AgriSupply(cities = CITIES, reserve = 0, refreshSecs = CYCLE_SECS, profile = 'dynamic') {
        if (!ROUND1_USE_CUSTOM_SUPPLY) return;
        const funds = Number(c.getCorporation().funds ?? 0);
        const reserveConstrained = Number.isFinite(reserve) && reserve > 0 && funds <= reserve;
        const clampBn3Inputs = useBn3Round2() && phase >= 4 && !c.hasUnlock(UNLOCKS.smartSupply);
        const startupSupplyMode = useRound1Route() && (profile === 'initial' || profile === 'startup');
        const initialSeedMode = startupSupplyMode;
        const effectiveRefreshSecs = Math.max(1, Number(refreshSecs ?? CYCLE_SECS) || CYCLE_SECS);
        const refillHorizonSecs = startupSupplyMode
            ? Math.min(effectiveRefreshSecs, CYCLE_SECS)
            : effectiveRefreshSecs;
        const bufferCycles = useRound1Route()
            ? (startupSupplyMode
                ? ROUND1_ROUTE_STARTUP_SUPPLY_BUFFER_CYCLES
                : ROUND1_ROUTE_AGRI_SUPPLY_BUFFER_CYCLES)
            : ROUND1_SUPPLY_BUFFER_CYCLES;
        for (const city of cities) {
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                const freeSpace = Math.max(0, wh.size - wh.sizeUsed);
                const usage = Number(wh.size ?? 0) > 0 ? Number(wh.sizeUsed ?? 0) / Number(wh.size ?? 1) : 0;
                const observedProd = Math.max(
                    c.getMaterial(DIV_AGRI, city, 'Plants').productionAmount || 0,
                    c.getMaterial(DIV_AGRI, city, 'Food').productionAmount || 0,
                    0,
                );
                const food = c.getMaterial(DIV_AGRI, city, 'Food');
                const plants = c.getMaterial(DIV_AGRI, city, 'Plants');
                const productStock = Math.max(0, Number(food.stored ?? 0)) + Math.max(0, Number(plants.stored ?? 0));
                const officeSize = Math.max(1, Number(c.getOffice(DIV_AGRI, city).size ?? 0));
                const bootstrapProd = Math.max(
                    8,
                    officeSize * (useBn3Round2() ? 3 : 2),
                );
                const hintedProd = Math.max(Number(agriSupplyProdHints[city] ?? 0) * 0.9, bootstrapProd);
                const rawProd = Math.max(observedProd, hintedProd);
                agriSupplyProdHints[city] = Math.max(Number(agriSupplyProdHints[city] ?? 0), observedProd, bootstrapProd);
                const needed = {};
                const targets = {};
                let totalNeedSize = 0;
                for (const [mat, coeff] of Object.entries(ROUND1_AGRI_REQUIRED)) {
                    const stored = c.getMaterial(DIV_AGRI, city, mat).stored;
                    const initialSeed = initialSeedMode
                        ? (ROUND1_ROUTE_INITIAL_SUPPLY_SPACE[mat] ?? 0) /
                            Math.max(ROUND1_AGRI_MAT_SIZES[mat] ?? 0.05, 1e-9)
                        : 0;
                    const seed = Math.max(
                        ROUND1_SUPPLY_SEED[mat] ?? 0,
                        initialSeed,
                        clampBn3Inputs
                            ? (((mat === 'Water' ? 0.06 : 0.024) * Number(wh.size ?? 0)) / Math.max(ROUND1_AGRI_MAT_SIZES[mat] ?? 0.05, 1e-9))
                            : 0,
                    );
                    const baseTarget = Math.max(seed, rawProd * coeff * CYCLE_SECS * bufferCycles);
                    const target = clampBn3Inputs
                        ? Math.min(baseTarget, seed * ROUND2_BN3_AGRI_INPUT_CAP_MULT)
                        : baseTarget;
                    const activeTarget = reserveConstrained ? seed : target;
                    const deficit = Math.max(0, activeTarget - stored);
                    targets[mat] = activeTarget;
                    needed[mat] = deficit;
                    totalNeedSize += deficit * (ROUND1_AGRI_MAT_SIZES[mat] ?? 0.05);
                }
                const scale = totalNeedSize > freeSpace && totalNeedSize > 0 ? freeSpace / totalNeedSize : 1;
                for (const [mat, deficit] of Object.entries(needed)) {
                    c.buyMaterial(DIV_AGRI, city, mat, Math.max(0, deficit * scale / refillHorizonSecs));
                }
                if (clampBn3Inputs) {
                    for (const mat of Object.keys(targets)) {
                        c.sellMaterial(DIV_AGRI, city, mat, '0', 'MP');
                    }
                }
            } catch { }
        }
    }

    function stopRound1AgriSupply(cities = CITIES) {
        if (!ROUND1_USE_CUSTOM_SUPPLY) return;
        for (const city of cities) {
            for (const mat of Object.keys(ROUND1_AGRI_REQUIRED)) {
                try { c.buyMaterial(DIV_AGRI, city, mat, 0); } catch { }
            }
        }
    }

    function getMaterialSize(material) {
        try { return Math.max(Number(c.getMaterialData(material)?.size ?? ROUND1_AGRI_MAT_SIZES[material] ?? 0.05), 1e-9); }
        catch { return Math.max(Number(ROUND1_AGRI_MAT_SIZES[material] ?? 0.05), 1e-9); }
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

    // Tobacco reqMats: Plants:1 1 Plant consumed per unit of product produced.
    // Like getChemicalPlantDemandFloor, this breaks the consumption=0 export=seed production=0
    // circular lock that occurs when support cities first switch to production jobs post-v1.
    // Agriculture reqMats: Water:0.5, Chemicals:0.2 Plants + Food.
    // Chemicals is a required input if Agri has none it produces zero Plants, which means
    // consumption reads 0, the export formula falls to just the seed refill, which then reaches
    // the seed cap and drops to '0'. This floor breaks that circular stall.
    if (false) {
        try {
            const targetMat = c.getMaterial(targetDiv, city, material);
            const stored = Math.max(0, Number(targetMat.stored ?? 0));
            const consumption = Math.max(0, -Number(targetMat.productionAmount ?? 0));
            const effectiveDemand = Math.max(consumption, Math.max(0, Number(minDemandRate ?? 0)));
            const bufferCycles = scaleByMaturity(baseBufferCycles, matureBufferCycles, maturity);
            const warehousePct = scaleByMaturity(baseWarehousePct, matureWarehousePct, maturity);
            const warehouseCap = getWarehouseMaterialCapacity(targetDiv, city, material) * warehousePct;
            const bufferedDemand = effectiveDemand * headroomMult;
            const uncappedTarget = Math.max(seed, bufferedDemand * CYCLE_SECS * bufferCycles);
            const targetStock = warehouseCap > 0
                ? Math.min(uncappedTarget, warehouseCap)
                : uncappedTarget;
            const deficit = Math.max(0, targetStock - stored);
            const refillRate = deficit / Math.max(CYCLE_SECS * refillCycles, 1);
            return formatExportRate(bufferedDemand + refillRate);
        } catch {
            return '0';
        }
    }

    function tryUpgradeWarehouseTo(div, city, targetLevel) {
        try {
            while (c.getWarehouse(div, city).level < targetLevel) {
                const cost = c.getUpgradeWarehouseCost(div, city, 1);
                if (c.getCorporation().funds < cost) break;
                c.upgradeWarehouse(div, city, 1);
            }
        } catch { }
    }

    function tryFillOffice(div, city, targetSize, jobs) {
        try { fillOffice(div, city, targetSize, jobs); } catch { }
    }

    function tobaccoProducts() {
        try { return [...c.getDivision(DIV_TOBACCO).products]; } catch { return []; }
    }

    function hasActiveTobaccoDevelopment() {
        for (const name of tobaccoProducts()) {
            try {
                if (c.getProduct(DIV_TOBACCO, HQ_CITY, name).developmentProgress < 100) return true;
            } catch { }
        }
        return false;
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

    function getTobaccoProductStats() {
        let highestProgress = 0;
        let activeProgress = 0;
        let activeProducts = 0;
        let finishedProducts = 0;
        for (const name of tobaccoProducts()) {
            try {
                const progress = c.getProduct(DIV_TOBACCO, HQ_CITY, name).developmentProgress || 0;
                if (progress > highestProgress) highestProgress = progress;
                if (progress >= 100) {
                    finishedProducts++;
                } else {
                    activeProducts++;
                    if (progress > activeProgress) activeProgress = progress;
                }
            } catch { }
        }
        return { highestProgress, activeProgress, activeProducts, finishedProducts };
    }

    function isBn3Round2MaterialTargetSetFilled(targets) {
        for (const city of CITIES) {
            try {
                for (const [mat, target] of Object.entries(targets)) {
                    if ((c.getMaterial(DIV_AGRI, city, mat).stored ?? 0) + 0.5 < target) return false;
                }
            } catch {
                return false;
            }
        }
        return true;
    }

    function isBn3HighBudgetPostfillUnlocked() {
        if (!useBn3HighBudgetRound2() || !hasDiv(DIV_AGRI)) return false;
        if (bn3HighBudgetPostfillUnlocked) return true;
        if (isBn3Round2MaterialTargetSetFilled(getBn3BaseMaterialTargets())) {
            bn3HighBudgetPostfillUnlocked = true;
            return true;
        }
        try {
            const { finishedProducts } = getTobaccoProductStats();
            if (finishedProducts > 0 ||
                c.getUpgradeLevel('Smart Storage') > ROUND2_BN3_SMART_TARGET ||
                c.getUpgradeLevel('ABC SalesBots') > ROUND2_BN3_SALESBOT_TARGET) {
                bn3HighBudgetPostfillUnlocked = true;
                return true;
            }
        } catch { }
        return false;
    }

    // One-way latch: set once the corp is mature enough to enter the debt-spike phase.
    // Checks base (pre-spike) maturity so there's no circular dep with isBn3Round2MaterialFilled.
    function sumJobCounts({ ops = 0, eng = 0, biz = 0, mgmt = 0, rnd = 0 } = {}) {
        return ops + eng + biz + mgmt + rnd;
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
            if (!hasDiv(DIV_AGRI)) return { avg: 0, peak: 0 };
            let totalUse = 0;
            let totalSize = 0;
            let peakUse = 0;
            for (const city of CITIES) {
                try {
                    const wh = c.getWarehouse(DIV_AGRI, city);
                    const size = Number(wh.size ?? 0);
                    const used = Number(wh.sizeUsed ?? 0);
                    if (size <= 0) continue;
                    totalUse += used;
                    totalSize += size;
                    peakUse = Math.max(peakUse, used / size);
                } catch { }
            }
            if (totalSize <= 0) return { avg: 0, peak: 0 };
            return {
                avg: totalUse / totalSize,
                peak: peakUse,
            };
        } catch {
            return { avg: 0, peak: 0 };
        }
    }

    function getAgriWarehouseUseStats() {
        const usage = getAgriWarehouseUsageSummary();
        const stats = {
            whAvg: `${(usage.avg * 100).toFixed(1)}%`,
            whPeak: `${(usage.peak * 100).toFixed(1)}%`,
        };
        // Per-city breakdown: only shown when at least one city is  85% full,
        // so it's silent in normal operation and visible when a city is pinned.
        try {
            if (hasDiv(DIV_AGRI)) {
                const parts = [];
                for (const city of CITIES) {
                    try {
                        const wh = c.getWarehouse(DIV_AGRI, city);
                        const pct = Number(wh.sizeUsed ?? 0) / Number(wh.size ?? 1);
                        if (pct >= 0.85) parts.push(`${getAgriCityDebugLabel(city)}:${(pct * 100).toFixed(0)}%`);
                    } catch { }
                }
                if (parts.length > 0) stats.whCities = parts.join(',');
            }
        } catch { }
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
            for (const city of CITIES) {
                try {
                    const food = c.getMaterial(DIV_AGRI, city, 'Food');
                    const plants = c.getMaterial(DIV_AGRI, city, 'Plants');
                    const waterMat = c.getMaterial(DIV_AGRI, city, 'Water');
                    const chemMat = c.getMaterial(DIV_AGRI, city, 'Chemicals');
                    production += Number(food.productionAmount ?? 0) + Number(plants.productionAmount ?? 0);
                    sell += Number(food.actualSellAmount ?? 0) + Number(plants.actualSellAmount ?? 0);
                    foodStock += Number(food.stored ?? 0);
                    plantsStock += Number(plants.stored ?? 0);
                    stored += Number(food.stored ?? 0) + Number(plants.stored ?? 0);
                    water += Number(waterMat.stored ?? 0);
                    chemicals += Number(chemMat.stored ?? 0);
                } catch { }
            }
            return { production, sell, stored, water, chemicals, foodStock, plantsStock };
        } catch {
            return { production: 0, sell: 0, stored: 0, water: 0, chemicals: 0, foodStock: 0, plantsStock: 0 };
        }
    }

    function getAgriCityFlowNumbers(city) {
        try {
            const food = c.getMaterial(DIV_AGRI, city, 'Food');
            const plants = c.getMaterial(DIV_AGRI, city, 'Plants');
            const waterMat = c.getMaterial(DIV_AGRI, city, 'Water');
            const chemMat = c.getMaterial(DIV_AGRI, city, 'Chemicals');
            return {
                foodProduction: Math.max(0, Number(food.productionAmount ?? 0)),
                plantsProduction: Math.max(0, Number(plants.productionAmount ?? 0)),
                foodStored: Math.max(0, Number(food.stored ?? 0)),
                plantsStored: Math.max(0, Number(plants.stored ?? 0)),
                waterStored: Math.max(0, Number(waterMat.stored ?? 0)),
                chemicalsStored: Math.max(0, Number(chemMat.stored ?? 0)),
            };
        } catch {
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
            return CITIES.map((city) => {
                try {
                    if (!c.hasWarehouse(DIV_AGRI, city)) return `${getAgriCityDebugLabel(city)}:na`;
                    const wh = c.getWarehouse(DIV_AGRI, city);
                    const size = Math.max(0, Number(wh.size ?? 0));
                    const used = Math.max(0, Number(wh.sizeUsed ?? 0));
                    const flow = getAgriCityFlowNumbers(city);
                    const wcSpace =
                        (flow.waterStored * getPhysicalMaterialSize('Water', getMaterialSize('Water'))) +
                        (flow.chemicalsStored * getPhysicalMaterialSize('Chemicals', getMaterialSize('Chemicals')));
                    const fpSpace =
                        (flow.foodStored * ROUND1_AGRI_PRODUCT_MAT_SIZES.Food) +
                        (flow.plantsStored * ROUND1_AGRI_PRODUCT_MAT_SIZES.Plants);
                    let boostSpace = 0;
                    for (const mat of AGRI_MATS) {
                        try {
                            const stored = Math.max(0, Number(c.getMaterial(DIV_AGRI, city, mat).stored ?? 0));
                            boostSpace += stored * getPhysicalMaterialSize(mat);
                        } catch { }
                    }
                    const knownSpace = wcSpace + fpSpace + boostSpace;
                    const otherSpace = Math.max(0, used - knownSpace);
                    const freeSpace = Math.max(0, size - used);
                    const pct = (value) => size > 0 ? Math.round((value / size) * 100) : 0;
                    return (
                        `${getAgriCityDebugLabel(city)}:${pct(used)}` +
                        `(wc${pct(wcSpace)},fp${pct(fpSpace)},b${pct(boostSpace)},o${pct(otherSpace)},f${pct(freeSpace)})`
                    );
                } catch {
                    return `${getAgriCityDebugLabel(city)}:err`;
                }
            }).join('|');
        } catch {
            return 'na';
        }
    }

    function getAgriCityInputsDebug() {
        try {
            return CITIES.map((city) => {
                try {
                    const flow = getAgriCityFlowNumbers(city);
                    return `${getAgriCityDebugLabel(city)}:${flow.waterStored.toFixed(0)}/${flow.chemicalsStored.toFixed(0)}`;
                } catch {
                    return `${getAgriCityDebugLabel(city)}:err`;
                }
            }).join('|');
        } catch {
            return 'na';
        }
    }

    function getExperimentalRound1TrimStats() {
        try {
            let revenue = 0;
            let activeCities = 0;
            let activeRate = 0;
            for (const city of CITIES) {
                const cityRates = round1ExperimentalBoostTrimSellRates[city] ?? {};
                let cityActive = false;
                for (const mat of ROUND1_ROUTE_BOOST_TRIM_ORDER) {
                    const rate = Math.max(0, Number(cityRates[mat] ?? 0));
                    if (rate <= 0) continue;
                    cityActive = true;
                    activeRate += rate;
                    revenue += rate * getMaterialBuyPrice(DIV_AGRI, city, mat);
                }
                if (cityActive) activeCities++;
            }
            return { revenue, activeCities, activeRate };
        } catch {
            return { revenue: 0, activeCities: 0, activeRate: 0 };
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
                } catch { }
            }
            return {
                revenue,
                expenses,
                liveRevenue: Number(corp.revenue ?? 0),
                nextState: corp.nextState ?? '?',
                prevState: corp.prevState ?? '?',
            };
        } catch {
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
    // that comes with expanding a city to 9 employees.
    function getBn3Round2Reserve() {
        const funds = c.getCorporation().funds;
        if (useBn3HighBudgetRound2()) {
            if (isBn3HighBudgetPostfillUnlocked()) {
                let reserve = Math.max(
                    ROUND2_BN3_HIGH_BUDGET_POSTFILL_RESERVE,
                    funds * ROUND2_BN3_HIGH_BUDGET_POSTFILL_RESERVE_PCT,
                );
                if (isBn3HighBudgetBuildoutMode() && !isBn3HighBudgetBuildoutHealthy()) {
                    const rawRecovery = Math.max(
                        ROUND2_BN3_HIGH_BUDGET_BUILDOUT_RECOVERY_RESERVE,
                        funds * ROUND2_BN3_HIGH_BUDGET_BUILDOUT_RECOVERY_RESERVE_PCT,
                    );
                    // Cap so the reserve never exceeds 50% of funds.
                    // Without this, a low-funds early buildout ($215M funds) would hit
                    // the $1B recovery floor and block all spending indefinitely.
                    reserve = Math.max(reserve, Math.min(rawRecovery, funds * 0.5));
                }
                return reserve;
            }
            return Math.max(ROUND2_BN3_HIGH_BUDGET_RESERVE, funds * ROUND2_BN3_HIGH_BUDGET_RESERVE_PCT);
        }
        return Math.max(ROUND2_BN3_RESERVE, funds * ROUND2_BN3_RESERVE_PCT);
    }

    function isRound1PrepBuiltOut() {
        try {
            if (c.getUpgradeLevel('Smart Storage') < getRound1SmartStorageTarget()) return false;
        } catch {
            return false;
        }
        try {
            if (c.getHireAdVertCount(DIV_AGRI) < getRound1AdvertTarget()) return false;
        } catch {
            return false;
        }
        for (const city of CITIES) {
            try {
                if (c.getWarehouse(DIV_AGRI, city).level < getRound1WarehouseTarget()) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    function getRound1PrepStatus() {
        const smartStorageTarget = getRound1SmartStorageTarget();
        const advertTarget = getRound1AdvertTarget();
        const warehouseTarget = getRound1WarehouseTarget();
        let smartStorageCurrent = 0;
        let advertCurrent = 0;
        let warehouseMin = Infinity;
        const missingWarehouseCities = [];

        try { smartStorageCurrent = Number(c.getUpgradeLevel('Smart Storage') ?? 0); } catch { }
        try { advertCurrent = Number(c.getHireAdVertCount(DIV_AGRI) ?? 0); } catch { }
        for (const city of CITIES) {
            try {
                const level = Number(c.getWarehouse(DIV_AGRI, city).level ?? 0);
                warehouseMin = Math.min(warehouseMin, level);
                if (level < warehouseTarget) missingWarehouseCities.push(`${city}:${level}/${warehouseTarget}`);
            } catch {
                warehouseMin = 0;
                missingWarehouseCities.push(`${city}:0/${warehouseTarget}`);
            }
        }
        if (!Number.isFinite(warehouseMin)) warehouseMin = 0;

        const missing = [];
        if (smartStorageCurrent < smartStorageTarget) missing.push(`SS ${smartStorageCurrent}/${smartStorageTarget}`);
        if (advertCurrent < advertTarget) missing.push(`AdVert ${advertCurrent}/${advertTarget}`);
        if (warehouseMin < warehouseTarget) {
            const cityPreview = missingWarehouseCities.slice(0, 2).join(', ');
            missing.push(
                `Warehouses ${warehouseMin}/${warehouseTarget}` +
                (cityPreview ? ` (${cityPreview}${missingWarehouseCities.length > 2 ? ', ...' : ''})` : ''),
            );
        }

        return {
            complete: missing.length === 0,
            smartStorageCurrent,
            smartStorageTarget,
            advertCurrent,
            advertTarget,
            warehouseMin,
            warehouseTarget,
            missing,
        };
    }

    function getRound1NextPrepCandidate() {
        try {
            const prep = getRound1PrepStatus();
            if (prep.smartStorageCurrent < prep.smartStorageTarget) {
                return {
                    label: `SS->${prep.smartStorageCurrent + 1}`,
                    cost: Number(c.getUpgradeLevelCost('Smart Storage') ?? 0),
                };
            }
            if (prep.advertCurrent < prep.advertTarget) {
                return {
                    label: `AdVert->${prep.advertCurrent + 1}`,
                    cost: Number(c.getHireAdVertCost(DIV_AGRI) ?? 0),
                };
            }
            if (prep.warehouseMin < prep.warehouseTarget) {
                let bestCity = '';
                let bestCost = Infinity;
                for (const city of CITIES) {
                    try {
                        const wh = c.getWarehouse(DIV_AGRI, city);
                        if (Number(wh.level ?? 0) >= prep.warehouseTarget) continue;
                        const cost = Number(c.getUpgradeWarehouseCost(DIV_AGRI, city, 1) ?? Infinity);
                        if (Number.isFinite(cost) && cost < bestCost) {
                            bestCost = cost;
                            bestCity = city;
                        }
                    } catch { }
                }
                if (bestCity && Number.isFinite(bestCost)) {
                    return {
                        label: `WH ${bestCity}->+1`,
                        cost: bestCost,
                    };
                }
            }
        } catch { }
        return null;
    }

    function shouldUseRound1Stretch(bestOffer, stagnantChecks) {
        if (!useRound1Route()) return false;
        return bestOffer >= ROUND1_REINVEST_STRETCH_TRIGGER ||
            stagnantChecks >= ROUND1_REINVEST_STRETCH_STAGNATION;
    }

    function getRound1ReinvestReserve(bestOffer) {
        const funds = Math.max(0, Number(c.getCorporation().funds ?? 0));
        const progress = clamp(bestOffer / Math.max(getRound1Target(), 1), 0, 1.25);
        if (progress >= getRound1FreezeRatio()) return Math.max(24e9, funds * 0.72);
        if (progress >= 0.82) return Math.max(16e9, funds * 0.55);
        if (progress >= 0.65) return Math.max(10e9, funds * 0.40);
        return Math.max(ROUND1_REINVEST_RESERVE_MIN, funds * 0.25);
    }

    function advanceRound1Prep(smartStorageTarget, warehouseTarget, advertTarget) {
        const funds = Math.max(0, Number(c.getCorporation().funds ?? 0));
        const prepBuffer = useRound1Route() ? ROUND1_ROUTE_PREP_RESERVE_BUFFER : 0;
        if (funds > 2e9)
            try {
                while (c.getUpgradeLevel('Smart Storage') < smartStorageTarget
                    && c.getCorporation().funds > c.getUpgradeLevelCost('Smart Storage') + prepBuffer) {
                    c.levelUpgrade('Smart Storage');
                }
            } catch { }
        if (funds > 3e9)
            try {
                while (c.getHireAdVertCount(DIV_AGRI) < advertTarget
                    && c.getCorporation().funds > c.getHireAdVertCost(DIV_AGRI) + prepBuffer) {
                    c.hireAdVert(DIV_AGRI);
                }
            } catch { }
        if (funds > 1e9)
            for (const city of CITIES)
                try {
                    while (c.getWarehouse(DIV_AGRI, city).level < warehouseTarget
                        && c.getCorporation().funds > c.getUpgradeWarehouseCost(DIV_AGRI, city, 1) + prepBuffer) {
                        c.upgradeWarehouse(DIV_AGRI, city, 1);
                    }
                } catch { }
        return isRound1PrepBuiltOut();
    }

    async function investInAgricultureForRound1(bestOffer, stagnantChecks, currentOffer = bestOffer) {
        if (bestOffer < ROUND1_REINVEST_TRIGGER &&
            stagnantChecks < ROUND1_REINVEST_TRIGGER_STAGNATION) {
            return {
                status: 'trigger-wait',
                message:
                    `Round-1 route waiting for reinvest trigger - best ${formatMoney(bestOffer)} / stagnant ${stagnantChecks}, ` +
                    `needs ${formatMoney(ROUND1_REINVEST_TRIGGER)} or stagnation ${ROUND1_REINVEST_TRIGGER_STAGNATION}.`,
            };
        }
        const stretch = shouldUseRound1Stretch(bestOffer, stagnantChecks);
        const officeTarget = stretch ? ROUND1_REINVEST_OFFICE_STRETCH : ROUND1_REINVEST_OFFICE;
        const warehouseTarget = stretch ? ROUND1_REINVEST_WAREHOUSE : getRound1WarehouseTarget();
        const advertTarget = stretch ? ROUND1_REINVEST_ADVERT_STRETCH : ROUND1_REINVEST_ADVERT;
        const smartFactoriesTarget = stretch ? ROUND1_REINVEST_SMART_FACTORIES_STRETCH : ROUND1_REINVEST_SMART_FACTORIES;
        const smartStorageTarget = Math.max(
            getRound1SmartStorageTarget(),
            stretch ? ROUND1_REINVEST_SMART_STORAGE : ROUND1_REINVEST_SMART_STORAGE - 1,
        );
        const reserve = getRound1ReinvestReserve(bestOffer);
        const materialFloor = -(stretch ? ROUND1_REINVEST_MATERIAL_DEBT_STRETCH : ROUND1_REINVEST_MATERIAL_DEBT);
        const maxDebtPushSpend = stretch ? ROUND1_RE_PUSH_MAX_SPEND_STRETCH : ROUND1_RE_PUSH_MAX_SPEND;
        const corpFunds = () => Number(c.getCorporation().funds ?? 0);
        const actions = [];
        let actionsTaken = 0;
        let capacityActionsTaken = 0;
        let debtPushGateReason = '';
        const canTakeAction = (cost, capacityAction = false) =>
            actionsTaken < ROUND1_REINVEST_MAX_ACTIONS &&
            (!capacityAction || capacityActionsTaken < ROUND1_REINVEST_MAX_CAPACITY_ACTIONS) &&
            Number.isFinite(cost) &&
            corpFunds() - cost >= reserve;
        const recordAction = (capacityAction = false) => {
            actionsTaken++;
            if (capacityAction) capacityActionsTaken++;
        };

        for (const city of CITIES) {
            try {
                const off = c.getOffice(DIV_AGRI, city);
                const targetSize = Math.max(Number(off.size ?? 0), officeTarget);
                if ((off.size ?? 0) < targetSize) {
                    const nextSize = Math.min(targetSize, off.size + 3);
                    const increase = nextSize - off.size;
                    const cost = c.getOfficeSizeUpgradeCost(DIV_AGRI, city, increase);
                    if (canTakeAction(cost)) {
                        fillOffice(DIV_AGRI, city, nextSize, getRound2AgriProductionJobs(nextSize));
                        recordAction();
                        actions.push(`Agriculture ${city} office -> ${nextSize}`);
                    } else {
                        fillOffice(DIV_AGRI, city, off.size, getRound2AgriProductionJobs(off.size));
                    }
                } else {
                    fillOffice(DIV_AGRI, city, off.size, getRound2AgriProductionJobs(off.size));
                }
            } catch { }

            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                if (wh.level < warehouseTarget) {
                    const spend = estimateWarehouseUpgradeSpend(DIV_AGRI, city);
                    if (canTakeAction(spend, true)) {
                        c.upgradeWarehouse(DIV_AGRI, city, 1);
                        recordAction(true);
                        actions.push(`Agriculture ${city} warehouse -> ${wh.level + 1}`);
                    }
                }
            } catch { }
        }

        try {
            while (c.getHireAdVertCount(DIV_AGRI) < advertTarget &&
                actionsTaken < ROUND1_REINVEST_MAX_ACTIONS) {
                const cost = c.getHireAdVertCost(DIV_AGRI);
                if (!canTakeAction(cost)) break;
                c.hireAdVert(DIV_AGRI);
                recordAction();
                actions.push(`Agriculture AdVert -> ${c.getHireAdVertCount(DIV_AGRI)}`);
            }
        } catch { }

        try {
            while (c.getUpgradeLevel('Smart Factories') < smartFactoriesTarget &&
                actionsTaken < ROUND1_REINVEST_MAX_ACTIONS) {
                const cost = c.getUpgradeLevelCost('Smart Factories');
                if (!canTakeAction(cost)) break;
                c.levelUpgrade('Smart Factories');
                recordAction();
                actions.push(`Smart Factories -> ${c.getUpgradeLevel('Smart Factories')}`);
            }
        } catch { }

        try {
            while (c.getUpgradeLevel('Smart Storage') < smartStorageTarget &&
                actionsTaken < ROUND1_REINVEST_MAX_ACTIONS) {
                const spend = estimateSmartStorageUpgradeSpend();
                if (!canTakeAction(spend, true)) break;
                c.levelUpgrade('Smart Storage');
                recordAction(true);
                actions.push(`Smart Storage -> ${c.getUpgradeLevel('Smart Storage')}`);
            }
        } catch { }

        await refreshBoosts(DIV_AGRI, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);

        if (actionsTaken < ROUND1_REINVEST_MAX_ACTIONS) {
            const usage = getAgriWarehouseUsageSummary();
            const topUpWindowOpen =
                bestOffer >= ROUND1_REINVEST_BOOST_TOPUP_TRIGGER ||
                (
                    stagnantChecks >= ROUND1_REINVEST_BOOST_TOPUP_STAGNATION &&
                    bestOffer >= ROUND1_REINVEST_BOOST_TOPUP_TRIGGER *
                        ROUND1_REINVEST_BOOST_TOPUP_STAGNATION_TRIGGER_PCT
                );
            const bridgeTopUpWindowOpen =
                !topUpWindowOpen &&
                bestOffer >= ROUND1_REINVEST_BRIDGE_TOPUP_TRIGGER &&
                currentOffer >= bestOffer * ROUND1_REINVEST_BRIDGE_TOPUP_NEAR_BEST_PCT &&
                usage.avg <= ROUND1_REINVEST_BRIDGE_TOPUP_MAX_USAGE_PCT &&
                usage.peak <= ROUND1_REINVEST_BRIDGE_TOPUP_MAX_PEAK_PCT;
            if (round1ReinvestDebtSettleChecks > 0) {
                debtPushGateReason = `settling previous debt push (${round1ReinvestDebtSettleChecks} checks left)`;
                round1ReinvestDebtSettleChecks--;
            } else if (currentOffer < bestOffer * ROUND1_RE_PUSH_OFFER_PCT) {
                debtPushGateReason =
                    `waiting for offer recovery (${formatMoney(currentOffer)} vs best ${formatMoney(bestOffer)})`;
            } else if (topUpWindowOpen) {
                const boostTopUp = await tryRound1ReinvestBoostTopUp(
                    materialFloor,
                    maxDebtPushSpend,
                    ROUND1_REINVEST_BOOST_TOPUP_MAX_USAGE_PCT,
                    ROUND1_REINVEST_BOOST_TOPUP_MAX_PEAK_PCT,
                );
                if (boostTopUp) {
                    round1ReinvestDebtSettleChecks = ROUND1_RE_PUSH_SETTLE_CHECKS;
                    recordAction();
                    actions.push(`${boostTopUp.label} (${formatMoney(boostTopUp.spend)})`);
                } else {
                    debtPushGateReason = 'no balanced boost top-up room or debt budget';
                }
            } else if (bridgeTopUpWindowOpen) {
                const bridgeBoostTopUp = await tryRound1ReinvestBoostTopUp(
                    materialFloor,
                    Math.min(maxDebtPushSpend, ROUND1_REINVEST_BRIDGE_TOPUP_MAX_SPEND),
                    ROUND1_REINVEST_BRIDGE_TOPUP_MAX_USAGE_PCT,
                    ROUND1_REINVEST_BRIDGE_TOPUP_MAX_PEAK_PCT,
                );
                if (bridgeBoostTopUp) {
                    round1ReinvestDebtSettleChecks = ROUND1_RE_PUSH_SETTLE_CHECKS;
                    recordAction();
                    actions.push(`${bridgeBoostTopUp.label} (${formatMoney(bridgeBoostTopUp.spend)})`);
                } else {
                    debtPushGateReason = 'no bridge boost top-up room or debt budget';
                }
            } else if (!topUpWindowOpen) {
                debtPushGateReason =
                    `waiting for late boost top-up window (${formatMoney(bestOffer)} vs trigger ` +
                    `${formatMoney(ROUND1_REINVEST_BOOST_TOPUP_TRIGGER)})`;
            } else {
                debtPushGateReason = 'bridge top-up blocked by warehouse headroom';
            }
        }

        if (actions.length > 0) {
            return {
                status: 'acted',
                actions,
                reserve,
                funds: corpFunds(),
            };
        }

        const smartStorageCurrent = (() => { try { return Number(c.getUpgradeLevel('Smart Storage') ?? 0); } catch { return 0; } })();
        const smartFactoriesCurrent = (() => { try { return Number(c.getUpgradeLevel('Smart Factories') ?? 0); } catch { return 0; } })();
        const advertCurrent = (() => { try { return Number(c.getHireAdVertCount(DIV_AGRI) ?? 0); } catch { return 0; } })();
        const minWarehouse = getMinWarehouseLevel(DIV_AGRI);
        const minOffice = getMinOfficeSize(DIV_AGRI, CITIES);
        const targetsMet =
            minOffice >= officeTarget &&
            minWarehouse >= warehouseTarget &&
            advertCurrent >= advertTarget &&
            smartFactoriesCurrent >= smartFactoriesTarget &&
            smartStorageCurrent >= smartStorageTarget;

        const pendingCosts = [];
        for (const city of CITIES) {
            try {
                const off = c.getOffice(DIV_AGRI, city);
                const targetSize = Math.max(Number(off.size ?? 0), officeTarget);
                if ((off.size ?? 0) < targetSize) {
                    const nextSize = Math.min(targetSize, off.size + 3);
                    const increase = nextSize - off.size;
                    pendingCosts.push({
                        label: `Agriculture ${city} office -> ${nextSize}`,
                        cost: c.getOfficeSizeUpgradeCost(DIV_AGRI, city, increase),
                    });
                }
            } catch { }
            try {
                const wh = c.getWarehouse(DIV_AGRI, city);
                if (wh.level < warehouseTarget) {
                    pendingCosts.push({
                        label: `Agriculture ${city} warehouse -> ${wh.level + 1}`,
                        cost: estimateWarehouseUpgradeSpend(DIV_AGRI, city),
                    });
                }
            } catch { }
        }
        try {
            if (advertCurrent < advertTarget) {
                pendingCosts.push({
                    label: `Agriculture AdVert -> ${advertCurrent + 1}`,
                    cost: c.getHireAdVertCost(DIV_AGRI),
                });
            }
        } catch { }
        try {
            if (smartFactoriesCurrent < smartFactoriesTarget) {
                pendingCosts.push({
                    label: `Smart Factories -> ${smartFactoriesCurrent + 1}`,
                    cost: c.getUpgradeLevelCost('Smart Factories'),
                });
            }
        } catch { }
        try {
            if (smartStorageCurrent < smartStorageTarget) {
                pendingCosts.push({
                    label: `Smart Storage -> ${smartStorageCurrent + 1}`,
                    cost: estimateSmartStorageUpgradeSpend(),
                });
            }
        } catch { }
        const cheapest = pendingCosts
            .filter((entry) => Number.isFinite(entry.cost) && entry.cost >= 0)
            .sort((a, b) => a.cost - b.cost)[0];
        const debtPushCandidate = getRound1ReinvestBoostTopUpPlan(
            materialFloor,
            maxDebtPushSpend,
        );

        return {
            status: targetsMet ? 'complete' : 'no-action',
            message: targetsMet
                ? `Round-1 route has no further reinvest targets left right now - ` +
                `Agri office ${minOffice}/${officeTarget}, warehouse ${minWarehouse}/${warehouseTarget}, ` +
                `AdVert ${advertCurrent}/${advertTarget}, SF ${smartFactoriesCurrent}/${smartFactoriesTarget}, ` +
                `SS ${smartStorageCurrent}/${smartStorageTarget}.`
                : `Round-1 route found no safe reinvest action - funds ${formatMoney(corpFunds())}, ` +
                `reserve ${formatMoney(reserve)}, material debt floor ${formatMoney(materialFloor)}, ` +
                `cheapest cash-only next is ${cheapest ? `${cheapest.label} for ${formatMoney(cheapest.cost)}` : 'unavailable'}, ` +
                `best debt push is ${debtPushCandidate ? `${debtPushCandidate.label} for ${formatMoney(debtPushCandidate.spend)}` : 'unavailable'}, ` +
                `debt gate is ${debtPushGateReason || 'open'}. ` +
                `Current Agri office ${minOffice}/${officeTarget}, warehouse ${minWarehouse}/${warehouseTarget}, ` +
                `AdVert ${advertCurrent}/${advertTarget}, SF ${smartFactoriesCurrent}/${smartFactoriesTarget}, ` +
                `SS ${smartStorageCurrent}/${smartStorageTarget}.`,
        };
    }

    function isPostRound2BootstrapReady() {
        if (!hasDiv(DIV_AGRI) || !hasDiv(DIV_CHEM) || !hasDiv(DIV_TOBACCO)) return false;
        if (!divisionInfraReady(DIV_AGRI) || !divisionInfraReady(DIV_CHEM) || !divisionInfraReady(DIV_TOBACCO)) return false;
        if (!c.hasUnlock(UNLOCKS.export) || !c.hasUnlock(UNLOCKS.smartSupply)) return false;
        try {
            if (c.getUpgradeLevel('Smart Factories') < ROUND2_POST_ACCEPT_SMART_FACTORIES_TARGET) return false;
            if (c.getUpgradeLevel('Smart Storage') < ROUND2_POST_ACCEPT_SMART_STORAGE_TARGET) return false;
            if (c.getUpgradeLevel('Wilson Analytics') < ROUND2_POST_ACCEPT_WILSON_TARGET) return false;
            if (c.getHireAdVertCount(DIV_TOBACCO) < ROUND2_POST_ACCEPT_TOB_ADVERT_TARGET) return false;
        } catch {
            return false;
        }
        for (const city of CITIES) {
            try {
                const agriOffice = c.getOffice(DIV_AGRI, city);
                const tobOffice = c.getOffice(DIV_TOBACCO, city);
                const chemOffice = c.getOffice(DIV_CHEM, city);
                const tobTarget = getPostRound2TobaccoOfficeTarget(city);
                if (agriOffice.size < ROUND2_POST_ACCEPT_AGRI_OFFICE || agriOffice.numEmployees < ROUND2_POST_ACCEPT_AGRI_OFFICE) return false;
                if (tobOffice.size < tobTarget || tobOffice.numEmployees < tobTarget) return false;
                if (chemOffice.size < ROUND2_POST_ACCEPT_CHEM_OFFICE || chemOffice.numEmployees < ROUND2_POST_ACCEPT_CHEM_OFFICE) return false;
                if (c.getWarehouse(DIV_AGRI, city).level < ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL) return false;
                if (c.getWarehouse(DIV_TOBACCO, city).level < ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL) return false;
                if (c.getWarehouse(DIV_CHEM, city).level < ROUND2_POST_ACCEPT_WAREHOUSE_LEVEL) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    function getRound2AgriProductionJobs(size) {
        if (size <= 4) return ROUND2_AGRI_PRODUCTION_JOBS;
        if (size < ROUND2_AGRI_OFFICE) return { ops: 2, eng: 2, biz: 1, mgmt: 1, rnd: Math.max(0, size - 6) };
        return { ops: 2, eng: 3, biz: 1, mgmt: 1, rnd: Math.max(0, size - 7) };
    }

    function isLeanTobSpikeUnlocked() {
        if (!useBn3LeanTobRound2() || !hasDiv(DIV_AGRI) || !hasDiv(DIV_TOBACCO)) return false;
        if (bn3LeanTobSpikeUnlocked) return true;
        if (!isBn3Round2MaterialTargetSetFilled(getBn3BaseMaterialTargets())) return false;
        if (!isBn3LateThroughputReady()) return false;
        if (getHighestTobaccoProductVersion() < 5) return false;
        try {
            const { finishedProducts } = getTobaccoProductStats();
            if (finishedProducts <= 0) return false;
            if (c.getUpgradeLevel('Wilson Analytics') < ROUND2_BN3_LATE_WILSON_TARGET) return false;
            if (c.getHireAdVertCount(DIV_TOBACCO) < ROUND2_BN3_LATE_TOB_ADVERT_TARGET) return false;
            if (c.getUpgradeLevel('Smart Storage') < ROUND2_BN3_LEAN_TOB_SPIKE_SMART_STORAGE) return false;
            const divNames = c.getCorporation().divisions;
            for (let i = 1; i <= ROUND2_BN3_LEAN_TOB_SPIKE_DUMMY_TARGET; i++) {
                if (!divNames.includes(`Dummy-${i}`)) return false;
            }
        } catch {
            return false;
        }
        if (bn3LeanTobPreSpikeDummySettleCounter > 0) return false;
        bn3LeanTobSpikeUnlocked = true;
        log(ns, `INFO: Lean-tob spike unlocked ${ROUND2_BN3_LEAN_TOB_SPIKE_DUMMY_TARGET} dummies settled, switching to spike targets with debt fill up to ${formatMoney(ROUND2_BN3_LEAN_TOB_SPIKE_DEBT_MAX)}.`, true, 'info');
        return true;
    }

    function isBn3Round2OfficeBuiltOut() {
        for (const city of CITIES) {
            try {
                const off = c.getOffice(DIV_AGRI, city);
                if (off.size < ROUND2_CLASSIC_AGRI_OFFICE || off.numEmployees < off.size) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    function isBn3Round2UpgradeBuiltOut() {
        return ['Smart Factories', 'Smart Storage'].every((upg) => {
            try { return c.getUpgradeLevel(upg) >= ROUND2_BN3_SMART_TARGET; }
            catch { return false; }
        });
    }

    function isBn3Round2WarehouseBuiltOut() {
        for (const city of CITIES) {
            try {
                if (c.getWarehouse(DIV_AGRI, city).level < ROUND2_CLASSIC_AGRI_WAREHOUSE) return false;
            } catch {
                return false;
            }
        }
        return true;
    }

    function getPostRound2TobaccoOfficeTarget(city) {
        return city === HQ_CITY ? ROUND2_POST_ACCEPT_TOB_HQ_OFFICE : ROUND2_POST_ACCEPT_TOB_SUPPORT_OFFICE;
    }

    function getMinOfficeSize(div, cities) {
        let minSize = Infinity;
        for (const city of cities) {
            try {
                minSize = Math.min(minSize, Number(c.getOffice(div, city).size ?? 0));
            } catch {
                return 0;
            }
        }
        return Number.isFinite(minSize) ? minSize : 0;
    }

    function getMinWarehouseLevel(div) {
        let minLevel = Infinity;
        for (const city of CITIES) {
            try {
                minLevel = Math.min(minLevel, Number(c.getWarehouse(div, city).level ?? 0));
            } catch {
                return 0;
            }
        }
        return Number.isFinite(minLevel) ? minLevel : 0;
    }

    // Docs: "Buy tea / throw party every cycle. Maintain maximum energy/morale."
    // Spike-mode morale management: bypasses the upkeep floor check entirely.
    // During debt-spike, funds are deeply negative but tea ($500k) and minimum
    // parties ($100k) are rounding error vs. $400B material debt safe to spend.
    // Only triggers at crisis thresholds, not the normal 98% maintenance level.
    //  Research (with RP threshold enforcement) 
    //  Upgrades 
    // All names are exact CorpUpgradeName enum VALUES (not keys).
    //  Product pricing 
    // setProductMarketTA2 sets auto-pricing only.
    // sellProduct must ALSO be called to configure the sell AMOUNT (MAX).
    // Without this the product sells 0 units if the amount was never set.
    function formatRound1Debug(corp, offerFunds, bestOffer, stagnantChecks, spendingFrozen, phase2PrepDone, actionState = '', offerBasis = null) {
        const prep = getRound1PrepStatus();
        const cycle = getStableCorpCycleStats();
        const prepReserve = !phase2PrepDone ? getExperimentalRound1PrepCashReserve() : 0;
        const reserveHold = prepReserve > 0 && Number(corp.funds ?? 0) <= prepReserve;
        const nextPrep = getRound1NextPrepCandidate();
        const { production, sell, stored, water, chemicals, foodStock, plantsStock } = getAgriFlowNumbers();
        const wh = getAgriWarehouseUseStats();
        const cycleProfit = Number(cycle.revenue ?? 0) - Number(cycle.expenses ?? 0);
        const offerRevenue = Number(offerBasis?.revenue ?? corp.revenue ?? 0);
        const offerExpenses = Number(offerBasis?.expenses ?? corp.expenses ?? 0);
        const offerProfit = offerRevenue - offerExpenses;
        const trim = getExperimentalRound1TrimStats();
        const cityWH = getAgriCityWarehouseCompositionDebug();
        const cityWC = getAgriCityInputsDebug();
        return formatRound2Debug({
            mode: 'r1-high',
            action: actionState || (phase2PrepDone ? (spendingFrozen ? 'frozen' : 'ready') : 'prep'),
            funds: formatMoney(corp.funds ?? 0),
            offer: formatMoney(offerFunds ?? 0),
            best: formatMoney(bestOffer ?? 0),
            target: formatMoney(getRound1Target()),
            floor: formatMoney(getRound1SoftFloor()),
            stagnant: stagnantChecks,
            freeze: spendingFrozen ? 'on' : 'off',
            prep: phase2PrepDone ? 'done' : 'wait',
            prepMissing: prep.missing.join(',') || 'none',
            prepRes: formatMoney(prepReserve),
            prepHold: reserveHold ? 'on' : 'off',
            nextPrep: nextPrep ? `${nextPrep.label} ${formatMoney(nextPrep.cost)}` : 'none',
            offerRev: formatMoney(offerRevenue),
            offerExp: formatMoney(offerExpenses),
            offerProfit: formatMoney(offerProfit),
            cycleRev: formatMoney(cycle.revenue),
            cycleExp: formatMoney(cycle.expenses),
            cycleProfit: formatMoney(cycleProfit),
            trimRev: formatMoney(trim.revenue),
            trimCities: trim.activeCities,
            state: `${cycle.prevState}->${cycle.nextState}`,
            ss: `${prep.smartStorageCurrent}/${prep.smartStorageTarget}`,
            adv: `${prep.advertCurrent}/${prep.advertTarget}`,
            wh: `${prep.warehouseMin}/${prep.warehouseTarget}`,
            ...wh,
            agriProd: `${production.toFixed(1)}/s`,
            agriSell: `${sell.toFixed(1)}/s`,
            agriStock: stored.toFixed(0),
            agriFP: `${foodStock.toFixed(0)}/${plantsStock.toFixed(0)}`,
            agriWC: `${water.toFixed(0)}/${chemicals.toFixed(0)}`,
            cityWH,
            cityWC,
        });
    }

    ns.tprint(`INFO: Round1 entering phase runner - phase=${phase}`);
        // 
        // PHASE 0 Create corp + essential unlocks
        // 
        if (phase <= 0) {
        if (!c.hasCorporation()) {
            log(ns, `INFO: Creating "${CORP_NAME}"...`, true, 'info');
            const inBn3 = ns.getResetInfo().currentNode === 3;
            if (!c.createCorporation(CORP_NAME, !inBn3 || opts['self-fund'])) {
                log(ns, `ERROR: Could not create corp. ${inBn3 ? 'Need SF3.' : 'Need SF3 or $150B.'}`, true, 'error');
                return;
            }
            await waitCycles(1);
        }
        log(ns, `INFO: "${c.getCorporation().name}" active. Funds: ${formatMoney(c.getCorporation().funds)}`, true);
        for (const name of [UNLOCKS.warehouseAPI, UNLOCKS.officeAPI]) buyUnlock(name);
        if (!ROUND1_USE_CUSTOM_SUPPLY) {
            buyUnlock(UNLOCKS.smartSupply);
        } else {
            log(ns, 'INFO: Delaying Smart Supply until after round 1 to improve valuation.', true, 'info');
        }
        writePhase(1); phase = 1;
        }

    // 
        // PHASE 1 Agriculture: all cities, offices, warehouses, initial boosts
        // 
        if (phase <= 1) {
            ns.tprint(`INFO: Round1 phase1 start - divisions=${c.getCorporation().divisions.join('/') || 'none'} funds=${formatMoney(c.getCorporation().funds)}`);
            const phase1Round1SmartStorageTarget = getRound1SmartStorageTarget();
            const phase1Round1WarehouseTarget = getRound1WarehouseTarget();
            const phase1Round1AdvertTarget = getRound1AdvertTarget();
            if (!c.getCorporation().divisions.includes(DIV_AGRI)) {
                ns.tprint(`INFO: Round1 expanding ${DIV_AGRI}`);
                log(ns, 'INFO: Expanding into Agriculture ($40B)...', true, 'info');
                c.expandIndustry(IND_AGRI, DIV_AGRI);
                ns.tprint(`INFO: Round1 expanded ${DIV_AGRI}`);
            }
            expandToCities(DIV_AGRI);
            ns.tprint(`INFO: Round1 expanded ${DIV_AGRI} to cities`);
            log(
                ns,
                `INFO: Round-1 route pre-boost warehouse step - raising Agriculture warehouses to ${ROUND1_ROUTE_PREBOOST_WAREHOUSE} during initial setup.`,
                true,
                'info',
            );
            bulkUpgradeWarehousesToLevel(DIV_AGRI, ROUND1_ROUTE_PREBOOST_WAREHOUSE);
            if (!ROUND1_USE_CUSTOM_SUPPLY) enableSmartSupply(DIV_AGRI);
            // Docs: "Upgrade from 3 to 4. Set 4 employees to R&D and wait until RP  55.
            // Switch to Ops(1)+Eng(1)+Biz(1)+Mgmt(1) before buying boost materials."
            for (const city of CITIES)
                fillOffice(DIV_AGRI, city, 4, { rnd: 4 });
            for (const city of CITIES) {
                try { c.sellMaterial(DIV_AGRI, city, 'Food', 'MAX', 'MP'); } catch { }
                try { c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP'); } catch { }
            }
            advanceRound1Prep(
                phase1Round1SmartStorageTarget,
                phase1Round1WarehouseTarget,
                phase1Round1AdvertTarget,
            );
            const initialSurplus = tryExperimentalRound1PreBoostSurplusSpend();
            if (initialSurplus?.actions?.length) {
                noteRound1Gate(
                    'round1-preboost-surplus',
                    `Round-1 route pre-boost surplus spend: ${initialSurplus.actions.join(', ')} ` +
                    `(cash floor ${formatMoney(initialSurplus.reserve)}, funds ${formatMoney(initialSurplus.funds)}).`,
                );
            }
            maintainRound1AgriSupply(CITIES, getExperimentalRound1PrepCashReserve(), CYCLE_SECS, 'initial');
            await waitCycles(1);
            // Wait for RP 55 before buying boost materials (docs requirement).
            log(ns, 'INFO: Waiting for Agriculture RP  55 before buying boost materials...', true);
            while (c.getDivision(DIV_AGRI).researchPoints < 55) {
                bulkUpgradeWarehousesToLevel(DIV_AGRI, ROUND1_ROUTE_PREBOOST_WAREHOUSE);
                advanceRound1Prep(
                    phase1Round1SmartStorageTarget,
                    phase1Round1WarehouseTarget,
                    phase1Round1AdvertTarget,
                );
                const surplus = tryExperimentalRound1PreBoostSurplusSpend();
                if (surplus?.actions?.length) {
                    noteRound1Gate(
                        'round1-preboost-surplus',
                        `Round-1 route pre-boost surplus spend: ${surplus.actions.join(', ')} ` +
                        `(cash floor ${formatMoney(surplus.reserve)}, funds ${formatMoney(surplus.funds)}).`,
                    );
                }
                maintainRound1AgriSupply(CITIES, getExperimentalRound1PrepCashReserve(), CYCLE_SECS, 'initial');
                await ns.sleep(5000);
            }
            log(ns, 'INFO: RP  55 switching to production jobs.', true, 'success');
            for (const city of CITIES)
                assignJobs(DIV_AGRI, city, { ops: 1, eng: 1, biz: 1, mgmt: 1 });
            advanceRound1Prep(
                phase1Round1SmartStorageTarget,
                phase1Round1WarehouseTarget,
                phase1Round1AdvertTarget,
            );
            const postRpSurplus = tryExperimentalRound1PreBoostSurplusSpend();
            if (postRpSurplus?.actions?.length) {
                noteRound1Gate(
                    'round1-preboost-surplus',
                    `Round-1 route pre-boost surplus spend: ${postRpSurplus.actions.join(', ')} ` +
                    `(cash floor ${formatMoney(postRpSurplus.reserve)}, funds ${formatMoney(postRpSurplus.funds)}).`,
                );
            }
            stopRound1AgriSupply(CITIES);
            maintainRound1AgriSupply(CITIES, getExperimentalRound1PrepCashReserve(), CYCLE_SECS, 'initial');
            await waitCycles(1);
            stopRound1AgriSupply(CITIES);
            log(ns, 'INFO: Applying Phase 1 Agriculture boost materials...', true);
            const initialBoostReserve = getExperimentalRound1PrepCashReserve();
            const initialBoostMaterialFloor = -ROUND1_ROUTE_INITIAL_BOOST_DEBT;
            let initialBoostScale = 1;
            const initialBoostTargetsByCity = {};
            let projectedSpend = 0;
            for (const city of CITIES) {
                const targets = getExperimentalRound1AgriBoostTargets(city, 'initial');
                initialBoostTargetsByCity[city] = targets;
                projectedSpend += estimateMaterialTargetSpend(DIV_AGRI, city, targets);
            }
            const budget = getExperimentalRound1InitialBoostBudget(initialBoostReserve);
            if (!Number.isFinite(projectedSpend) || projectedSpend <= 0 || budget <= 0) {
                initialBoostScale = 0;
            } else if (projectedSpend > budget) {
                initialBoostScale = budget / projectedSpend;
            }
            initialBoostScale = Math.min(initialBoostScale, ROUND1_ROUTE_INITIAL_BOOST_SCALE_CAP);
            if (initialBoostScale < 0.999) {
                noteRound1Gate(
                    'round1-initial-fill-budget',
                    `Round-1 route initial Agri boost budget cap active - scaling phase-1 fill to ` +
                    `${(initialBoostScale * 100).toFixed(1)}% (budget ${formatMoney(budget)}, projected spend ${formatMoney(projectedSpend)}, ` +
                    `debt floor ${formatMoney(-ROUND1_ROUTE_INITIAL_BOOST_DEBT)}).`,
                );
            }
            const initialBatchTargets = Object.fromEntries(
                CITIES.map((city) => [
                    city,
                    scaleMaterialTargets(
                        initialBoostTargetsByCity[city] ?? getExperimentalRound1AgriBoostTargets(city, 'initial'),
                        initialBoostScale,
                    ),
                ]),
            );
            const initialBatch = await applyBoostMaterialsBatchChunked(
                DIV_AGRI,
                initialBatchTargets,
                initialBoostMaterialFloor,
                ROUND1_ROUTE_INITIAL_BOOST_CHUNK_FRACTION,
                ROUND1_ROUTE_INITIAL_BOOST_MAX_PASSES,
            );
            if ((initialBatch?.passes ?? 0) > 1) {
                noteRound1Gate(
                    'round1-initial-fill-execution',
                    `Round-1 route initial Agri boost fill executed over ${initialBatch.passes} purchase passes ` +
                    `(chunk ${(ROUND1_ROUTE_INITIAL_BOOST_CHUNK_FRACTION * 100).toFixed(0)}%).`,
                );
            }
            maintainRound1AgriSupply(CITIES, 0, 2 * CYCLE_SECS, 'initial');
        writePhase(2); phase = 2;
    }

    // 
    // PHASE 2 Wait for and accept investment round 1
    // Docs: "Focus on Smart Storage and warehouse upgrade. Buy 2 Advert levels."
    // 
    if (phase <= 2) {
        const round1Target = getRound1Target();
        const round1SoftFloor = getRound1SoftFloor();
        const round1StagnationLimit = getRound1StagnationLimit();
        const round1SmartStorageTarget = getRound1SmartStorageTarget();
        const round1WarehouseTarget = getRound1WarehouseTarget();
        const round1AdvertTarget = getRound1AdvertTarget();
        log(ns, `INFO: Waiting for round-1 offer  ${formatMoney(round1Target)}...`, true);
        log(
            ns,
            `INFO: Round-1 route mode enabled - targeting ${formatMoney(round1Target)} with ` +
            `plateau accept at ${formatMoney(round1SoftFloor)}, plus post-prep Agri reinvest with bounded material debt before the final freeze.`,
            true,
            'info',
        );
        let bestOffer = 0;
        let stagnantChecks = 0;
        let spendingFrozen = false;
        let phase2PrepDone = false;

        while (true) {
            const lateRound1Window =
                spendingFrozen ||
                bestOffer >= round1SoftFloor * ROUND1_ROUTE_LATE_WINDOW_SOFT_FLOOR_PCT;
            await waitCycles(lateRound1Window ? 1 : 2);
            let round1ActionState = '';
            const startupSupplyProfile =
                !spendingFrozen && bestOffer < ROUND1_REINVEST_TRIGGER
                    ? 'startup'
                    : 'dynamic';

            // Keep Agriculture selling and jobs assigned no office expansion yet.
            for (const city of CITIES) {
                try { c.sellMaterial(DIV_AGRI, city, 'Food', 'MAX', 'MP'); } catch { }
                try { c.sellMaterial(DIV_AGRI, city, 'Plants', 'MAX', 'MP'); } catch { }
                try { assignJobs(DIV_AGRI, city, { ops: 1, eng: 1, biz: 1, mgmt: 1 }); } catch { }
            }
            if (!spendingFrozen && !phase2PrepDone) {
                phase2PrepDone = advanceRound1Prep(round1SmartStorageTarget, round1WarehouseTarget, round1AdvertTarget);
            }
            maintainRound1AgriSupply(
                CITIES,
                !phase2PrepDone ? getExperimentalRound1PrepCashReserve() : 0,
                lateRound1Window ? CYCLE_SECS : 2 * CYCLE_SECS,
                startupSupplyProfile,
            );

            const offer = c.getInvestmentOffer();
            const offerBasis = (() => {
                try {
                    const corpNow = c.getCorporation();
                    return {
                        revenue: Number(corpNow.revenue ?? 0),
                        expenses: Number(corpNow.expenses ?? 0),
                    };
                } catch {
                    return { revenue: 0, expenses: 0 };
                }
            })();
            if (offer.funds > bestOffer) {
                bestOffer = offer.funds;
                stagnantChecks = 0;
            } else {
                stagnantChecks++;
            }
            if (bestOffer >= round1Target * getRound1FreezeRatio()) spendingFrozen = true;

            if (!spendingFrozen) {
                if (!phase2PrepDone) {
                    round1ActionState = 'prep';
                    phase2PrepDone = advanceRound1Prep(round1SmartStorageTarget, round1WarehouseTarget, round1AdvertTarget);
                    if (!phase2PrepDone) {
                        const prep = getRound1PrepStatus();
                        noteRound1Gate(
                            'round1-prep',
                            `Round-1 route prep waiting on fixed setup - ${prep.missing.join(', ')}.`,
                        );
                    }
                } else {
                    const expRound1 = await investInAgricultureForRound1(bestOffer, stagnantChecks, offer.funds ?? 0);
                    round1ActionState = expRound1?.status || 'idle';
                    if (expRound1?.status === 'acted') {
                        noteRound1Gate(
                            'round1-spend',
                            `Round-1 route spend: ${expRound1.actions.join(', ')} ` +
                            `(funds ${formatMoney(expRound1.funds)}, reserve ${formatMoney(expRound1.reserve)}).`,
                        );
                    } else if (expRound1?.message) {
                        noteRound1Gate(
                            expRound1.status === 'trigger-wait'
                                ? 'round1-trigger'
                                : 'round1-spend',
                            expRound1.message,
                        );
                    }
                }
            } else {
                round1ActionState = 'frozen';
            }

            if (spendingFrozen) {
                stopExperimentalRound1BoostTrim();
            } else {
                const pressureEvents = manageExperimentalRound1BoostTrim(bestOffer, offer.funds ?? 0, stagnantChecks);
                if (pressureEvents?.length) {
                    noteRound1Gate(
                        'round1-pressure',
                        `Round-1 route pressure relief: ${pressureEvents.join(', ')}`,
                    );
                }
            }

            // Re-apply boosts if warehouse capacity has grown.
            await refreshBoosts(DIV_AGRI, AGRI_BOOST.factors, AGRI_BOOST.sizes, AGRI_BOOST.mats);

            log(ns, `  Round ${offer.round} offer: ${formatMoney(offer.funds)} (best ${formatMoney(bestOffer)})`, false);
            log(
                ns,
                `  Round ${offer.round} debug: ${formatRound1Debug(
                    c.getCorporation(),
                    offer.funds ?? 0,
                    bestOffer,
                    stagnantChecks,
                    spendingFrozen,
                    phase2PrepDone,
                    round1ActionState,
                    offerBasis,
                )}`,
                false,
            );
            if (offer.round > 1) { log(ns, 'INFO: Round 1 already accepted.', true, 'info'); break; }
            if (offer.round === 1 && offer.funds >= round1Target) {
                c.acceptInvestmentOffer();
                lockBn3HighBudgetRound2Profile(Number(offer.funds ?? 0));
                log(ns, `INFO: Accepted Round 1 received ${formatMoney(offer.funds)}!`, true, 'success');
                break;
            }
            const acceptExperimentalFrozenNearBest =
                offer.round === 1 &&
                spendingFrozen &&
                stagnantChecks >= ROUND1_ROUTE_FROZEN_ACCEPT_MIN_STAGNATION &&
                bestOffer >= round1Target * ROUND1_ROUTE_FROZEN_ACCEPT_TARGET_PCT &&
                offer.funds >= Math.max(
                    round1SoftFloor,
                    bestOffer * ROUND1_ROUTE_FROZEN_ACCEPT_NEAR_BEST_PCT,
                );
            if (acceptExperimentalFrozenNearBest) {
                c.acceptInvestmentOffer();
                lockBn3HighBudgetRound2Profile(Number(offer.funds ?? 0));
                log(
                    ns,
                    `INFO: Accepted Round 1 near-best freeze window received ${formatMoney(offer.funds)} ` +
                    `(best ${formatMoney(bestOffer)}).`,
                    true,
                    'success',
                );
                break;
            }
            if (offer.round === 1 && spendingFrozen && stagnantChecks >= round1StagnationLimit && offer.funds >= round1SoftFloor) {
                c.acceptInvestmentOffer();
                lockBn3HighBudgetRound2Profile(Number(offer.funds ?? 0));
                log(ns, `INFO: Accepted Round 1 soft floor received ${formatMoney(offer.funds)} after offer plateau.`, true, 'success');
                break;
            }
        }
        stopExperimentalRound1BoostTrim();
        if (!ROUND1_USE_CUSTOM_SUPPLY && c.hasUnlock(UNLOCKS.smartSupply)) {
            stopRound1AgriSupply();
            enableSmartSupply(DIV_AGRI);
        }
        await waitCycles(1);
        writePhase(3); phase = 3;
        if (opts['round1-only']) {
            log(ns, 'INFO: Round-1-only mode enabled stopping after round 1 for comparison.', true, 'info');
            return;
        }
    }

    // 
    // PHASE 3 Launch Chemical (and optionally Tobacco); supply chain; first product
    // 

    // Chain back to orchestrator when this script's phases are done
    handoffToOrchestrator('Phase 2 is complete; returning control to /corp/corp-setup.js for the post-round-1 corporation phases.');
}
