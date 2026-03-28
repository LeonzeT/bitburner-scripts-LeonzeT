/**
 * dashboard-stocks.js — on-demand, Stocks tab only (~3 GB static)
 *
 * ALL ns.stock.* calls are delegated to temp scripts via ns.exec.
 * This script only uses: ns.exec(1.3) + ns.isRunning(0.05) + ns.read/write(0)
 * = ~3 GB total static RAM.
 *
 * Old version: ~26.6 GB (10 unique ns.stock.* API calls held the entire time
 *   the Stocks tab was open — 10 × 2.5 GB each)
 * New version: ~3 GB sustained, ~8 GB peak during 1s gather
 *
 * Buy/sell commands are also delegated to one-shot temp scripts so this
 * file never directly references any ns.stock.* function.
 *
 * @param {NS} ns
 */

const SING_PORT       = 18;
const STOCKS_FILE     = '/Temp/dashboard-stocks.txt';
const ACTIVE_TAB_FILE = '/Temp/dashboard-active-tab.txt';
const MY_TAB          = 'Stocks';
const GATHER_SCRIPT   = '/Temp/dash-stocks-gather.js';
const GATHER_OUT      = '/Temp/dash-stocks-gathered.txt';
const CMD_SCRIPT      = '/Temp/dash-stocks-cmd.js';

function writeGatherScript(ns) {
    // All ns.stock.* calls live here. This temp script runs for <1s,
    // writes results to GATHER_OUT, then exits and frees its ~8 GB.
    ns.write(GATHER_SCRIPT, `
export async function main(ns) {
    const d = {}, safe = f => { try { return f(); } catch { return undefined; } };

    let hasTix = false, has4S = false;
    try { hasTix = ns.stock.hasTixApiAccess(); } catch {}
    try { has4S  = ns.stock.has4SDataTixApi(); } catch {}

    if (hasTix) {
        try {
            const syms = safe(() => ns.stock.getSymbols()) ?? [];
            const allStocks = [];
            let tv = 0, tc = 0;
            for (const sym of syms) {
                const pos      = safe(() => ns.stock.getPosition(sym))  ?? [0,0,0,0];
                const price    = safe(() => ns.stock.getPrice(sym))     ?? 0;
                const maxSh    = safe(() => ns.stock.getMaxShares(sym)) ?? 0;
                const forecast = has4S ? (safe(() => ns.stock.getForecast(sym)) ?? null) : null;
                const lv = pos[0] * price, lc = pos[0] * pos[1];
                tv += pos[0] > 0 ? lv : 0; tc += pos[0] > 0 ? lc : 0;
                const shortPnL = pos[2] > 0 ? (pos[3] - price) * pos[2] : 0;
                tv += pos[2] > 0 ? pos[2] * pos[3] : 0;
                tc += pos[2] > 0 ? pos[2] * price  : 0;
                allStocks.push({
                    sym, price, maxSh, forecast,
                    longSh: pos[0], longAvg: pos[1], longVal: lv, longCost: lc, longPnL: lv - lc,
                    shortSh: pos[2], shortAvg: pos[3], shortPnL,
                });
            }
            allStocks.sort((a, b) => b.longVal - a.longVal || (b.forecast ?? 0.5) - (a.forecast ?? 0.5));
            d.stocks = { allStocks, has4S, totalVal: tv, totalPnL: tv - tc };
        } catch { d.stocks = null; }
    } else {
        d.stocks = null;
    }
    d.stocksLoaded    = true;
    d.stocksTimestamp = Date.now();
    ns.write("${GATHER_OUT}", JSON.stringify(d), "w");
}
`, 'w');
}

async function runTemp(ns, script, timeout = 5000) {
    const pid = ns.exec(script, 'home');
    if (!pid) { ns.print('WARN: could not exec ' + script); return false; }
    const deadline = Date.now() + timeout;
    while (ns.isRunning(pid) && Date.now() < deadline) await ns.sleep(50);
    return !ns.isRunning(pid);
}

async function runCmd(ns, code) {
    ns.write(CMD_SCRIPT, `export async function main(ns) { ${code} }`, 'w');
    return runTemp(ns, CMD_SCRIPT, 3000);
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const uiScript = ns.getScriptName().replace(/dashboard-stocks\.js$/, 'dashboard.js');
    const singPort = ns.getPortHandle(SING_PORT);
    ns.atExit(() => ns.write(STOCKS_FILE, '', 'w'));
    writeGatherScript(ns);

    while (true) {
        if (!ns.isRunning(uiScript, 'home')) {
            ns.print('UI closed. Exiting.'); ns.write(STOCKS_FILE, '', 'w'); return;
        }
        try {
            const activeTab = ns.read(ACTIVE_TAB_FILE).trim();
            if (activeTab && activeTab !== MY_TAB) {
                ns.print(`Tab = "${activeTab}". Freeing RAM.`);
                ns.write(STOCKS_FILE, '', 'w'); return;
            }
        } catch {}

        while (!singPort.empty()) {
            try {
                const cmd = JSON.parse(singPort.read());
                switch (cmd.type) {
                    case 'buyStock':
                        await runCmd(ns, `ns.stock.buyStock(${JSON.stringify(cmd.sym)}, ${cmd.qty})`);
                        break;
                    case 'sellStock':
                        await runCmd(ns, `ns.stock.sellStock(${JSON.stringify(cmd.sym)}, ${cmd.qty})`);
                        break;
                    case 'sellShortStock':
                        await runCmd(ns, `ns.stock.sellShort(${JSON.stringify(cmd.sym)}, ${cmd.qty})`);
                        break;
                    default: ns.print(`Ignored cmd: ${cmd.type}`);
                }
            } catch (e) { ns.print('STOCKS port error: ' + (e?.message ?? e)); }
        }

        if (await runTemp(ns, GATHER_SCRIPT)) {
            try {
                const raw = ns.read(GATHER_OUT);
                if (raw) ns.write(STOCKS_FILE, raw, 'w');
            } catch {}
        }

        await ns.sleep(1000);
    }
}