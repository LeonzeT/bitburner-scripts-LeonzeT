/**
 * dashboard-corp.js - on-demand, Corp tab only (~3 GB static)
 *
 * Corporation API calls live inside a one-shot temp gather script so this
 * companion only holds exec/isRunning/read/write RAM while the Corp tab is open.
 *
 * @param {NS} ns
 */

const CORP_FILE          = '/Temp/dashboard-corp-ui.txt';
const AUTOPILOT_SNAPSHOT = '/Temp/dashboard-corp.txt';
const ACTIVE_TAB_FILE    = '/Temp/dashboard-active-tab.txt';
const MY_TAB             = 'Corp';
const GATHER_SCRIPT      = '/Temp/dash-corp-gather.js';
const GATHER_OUT         = '/Temp/dash-corp-gathered.txt';

function writeGatherScript(ns) {
    ns.write(GATHER_SCRIPT, [
        'export async function main(ns) {',
        '  const safe = f => { try { return f(); } catch { return undefined; } };',
        '  const d = { corpLoaded: true };',
        `  try {`,
        `    const raw = ns.read("${AUTOPILOT_SNAPSHOT}");`,
        '    if (raw && raw !== "") {',
        '      const snap = JSON.parse(raw);',
        '      Object.assign(d, snap);',
        '      d.corpSnapshotFresh = !!snap._ts && (Date.now() - snap._ts) < 15000;',
        '    } else {',
        '      d.corpSnapshotFresh = false;',
        '    }',
        '  } catch { d.corpSnapshotFresh = false; }',
        '  try {',
        '    const procs = ns.ps("home");',
        '    const hasScript = name => procs.some(p => String(p.filename ?? "").split("/").pop() === name);',
        '    d.corpLauncherRunning = hasScript("corp.js") || hasScript("corp-fixed.js");',
        '    d.corpSetupRunning = hasScript("corp-setup.js");',
        '    d.corpAutopilotRunning = hasScript("corp-autopilot.js");',
        '  } catch {',
        '    d.corpLauncherRunning = false;',
        '    d.corpSetupRunning = false;',
        '    d.corpAutopilotRunning = false;',
        '  }',
        '  try { d.setupDone = ns.read("/corp-setup-done.txt").trim().toLowerCase() === "true"; } catch { d.setupDone = false; }',
        '  try { d.setupPhase = Number.parseInt(ns.read("/corp-setup-phase.txt") || "0", 10) || 0; } catch { d.setupPhase = 0; }',
        '  const api = ns.corporation;',
        '  if (!api || typeof api.hasCorporation !== "function") {',
        `    ns.write("${GATHER_OUT}", JSON.stringify(d), "w");`,
        '    return;',
        '  }',
        '  let hasCorp = false;',
        '  try { hasCorp = !!api.hasCorporation(); } catch {}',
        '  d.corpExists = hasCorp;',
        '  if (!hasCorp) {',
        '    d.public = false;',
        '    d.divisions = [];',
        '    d.offerFunds = 0;',
        `    ns.write("${GATHER_OUT}", JSON.stringify(d), "w");`,
        '    return;',
        '  }',
        '  const corp = safe(() => api.getCorporation()) ?? null;',
        '  if (corp) {',
        '    d.corpName = corp.name ?? d.corpName ?? null;',
        '    d.state = corp.state ?? d.state ?? null;',
        '    d.funds = Number(corp.funds ?? d.funds ?? 0);',
        '    d.revenue = Number(corp.revenue ?? d.revenue ?? 0);',
        '    d.expenses = Number(corp.expenses ?? d.expenses ?? 0);',
        '    d.profit = d.revenue - d.expenses;',
        '    d.public = !!corp.public;',
        '    d.ownedShares = Number(corp.numShares ?? d.ownedShares ?? 0);',
        '    d.issuedShares = Number(corp.issuedShares ?? d.issuedShares ?? 0);',
        '    d.totalShares = Number((corp.numShares ?? 0) + (corp.issuedShares ?? 0));',
        '    d.ownershipPct = d.totalShares > 0 ? d.ownedShares / d.totalShares : 1;',
        '    d.sharePrice = Number(corp.sharePrice ?? d.sharePrice ?? 0);',
        '    d.dividendRate = Number(corp.dividendRate ?? d.dividendRate ?? 0);',
        '  }',
        '  const offer = safe(() => api.getInvestmentOffer()) ?? null;',
        '  d.fundingRound = Number(offer?.round ?? d.fundingRound ?? 0);',
        '  d.offerFunds = Number(offer?.funds ?? 0);',
        '  d.offerShares = Number(offer?.shares ?? offer?.numShares ?? 0);',
        '  d.upgrades = {',
        '    wilson: safe(() => api.getUpgradeLevel("Wilson Analytics")),',
        '    smartFactories: safe(() => api.getUpgradeLevel("Smart Factories")),',
        '    smartStorage: safe(() => api.getUpgradeLevel("Smart Storage")),',
        '    salesBots: safe(() => api.getUpgradeLevel("ABC SalesBots")),',
        '  };',
        '  const divNames = Array.isArray(corp?.divisions) ? corp.divisions : [];',
        '  d.divisions = divNames.map(name => {',
        '    const div = safe(() => api.getDivision(name)) ?? { name };',
        '    const cities = Array.isArray(div.cities) ? div.cities : [];',
        '    let employees = 0;',
        '    let minOfficeSize = null, maxOfficeSize = null;',
        '    let minWarehouseLevel = null, maxWarehouseLevel = null;',
        '    for (const city of cities) {',
        '      const office = safe(() => api.getOffice(name, city));',
        '      const officeSize = Number(office?.size ?? office?.numEmployees ?? 0);',
        '      const officeEmployees = Number(office?.numEmployees ?? office?.size ?? 0);',
        '      employees += officeEmployees;',
        '      if (minOfficeSize == null || officeSize < minOfficeSize) minOfficeSize = officeSize;',
        '      if (maxOfficeSize == null || officeSize > maxOfficeSize) maxOfficeSize = officeSize;',
        '      const warehouse = safe(() => api.getWarehouse(name, city));',
        '      const warehouseLevel = warehouse?.level != null ? Number(warehouse.level) : null;',
        '      if (warehouseLevel != null) {',
        '        if (minWarehouseLevel == null || warehouseLevel < minWarehouseLevel) minWarehouseLevel = warehouseLevel;',
        '        if (maxWarehouseLevel == null || warehouseLevel > maxWarehouseLevel) maxWarehouseLevel = warehouseLevel;',
        '      }',
        '    }',
        '    const products = Array.isArray(div.products) ? div.products : [];',
        '    let developing = 0, completed = 0;',
        '    for (const productName of products) {',
        '      let info = null;',
        '      for (const city of cities) {',
        '        info = safe(() => api.getProduct(name, city, productName));',
        '        if (info) break;',
        '      }',
        '      const progress = Number(info?.developmentProgress ?? 100);',
        '      if (progress < 100) developing++; else completed++;',
        '    }',
        '    const productPipeline = products.length === 0',
        '      ? null',
        '      : (developing > 0',
        '          ? `${completed}/${products.length} complete, ${developing} developing`',
        '          : `${completed}/${products.length} complete`);',
        '    return {',
        '      name: div.name ?? name,',
        '      type: div.type ?? null,',
        '      cities: cities.length,',
        '      products: products.length,',
        '      rp: Number(div.researchPoints ?? 0),',
        '      employees,',
        '      advertCount: Number(safe(() => api.getHireAdVertCount(name)) ?? 0),',
        '      minOfficeSize,',
        '      maxOfficeSize,',
        '      minWarehouseLevel,',
        '      maxWarehouseLevel,',
        '      productPipeline,',
        '    };',
        '  });',
        '  d.corpTimestamp = Date.now();',
        `  ns.write("${GATHER_OUT}", JSON.stringify(d), "w");`,
        '}',
    ].join('\n'), 'w');
}

async function runTemp(ns, script, timeout = 5000) {
    const pid = ns.exec(script, 'home');
    if (!pid) { ns.print('WARN: could not exec ' + script); return false; }
    const deadline = Date.now() + timeout;
    while (ns.isRunning(pid) && Date.now() < deadline) await ns.sleep(50);
    return !ns.isRunning(pid);
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const uiScript = ns.getScriptName().replace(/dashboard-corp\.js$/, 'dashboard.js');
    ns.atExit(() => ns.write(CORP_FILE, '', 'w'));
    writeGatherScript(ns);

    while (true) {
        if (!ns.isRunning(uiScript, 'home')) {
            ns.print('UI closed. Exiting.');
            ns.write(CORP_FILE, '', 'w');
            return;
        }
        try {
            const activeTab = ns.read(ACTIVE_TAB_FILE).trim();
            if (activeTab && activeTab !== MY_TAB) {
                ns.print(`Tab = "${activeTab}". Freeing RAM.`);
                ns.write(CORP_FILE, '', 'w');
                return;
            }
        } catch {}

        if (await runTemp(ns, GATHER_SCRIPT)) {
            try {
                const raw = ns.read(GATHER_OUT);
                if (raw) ns.write(CORP_FILE, raw, 'w');
            } catch {}
        }

        await ns.sleep(1000);
    }
}
