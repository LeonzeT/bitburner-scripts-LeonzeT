// Resolve registered script paths via script-paths.json (0 GB — ns.read only)
let _scriptPaths = null;
function resolveScript(ns, key) {
    if (!_scriptPaths) {
        _scriptPaths = {};
        try { const r = ns.read('/script-paths.json'); if (r && r !== '') { _scriptPaths = JSON.parse(r); delete _scriptPaths._comment; } } catch {}
    }
    return _scriptPaths[key] ?? (key.endsWith('.js') ? key : key + '.js');
}
/**
 * dashboard-stocks.js — on-demand, Stocks tab only (~3 GB)
 *
 * Handles per-symbol stock data gathering and buy/sell actions.
 * The always-on data.js retains only the lightweight stock flags
 * (hasWse, hasTix, has4SData, has4SApi, stockCosts) needed by the
 * Shortcuts "Stock Market" section. All per-symbol work lives here.
 *
 * @param {NS} ns
 */

const SING_PORT       = 18;
const STOCKS_FILE     = '/Temp/dashboard-stocks.txt';
const ACTIVE_TAB_FILE = '/Temp/dashboard-active-tab.txt';
const MY_TAB          = 'Stocks';

async function gatherData(ns) {
    const d = {}, safe = f => { try { return f(); } catch { return undefined; } };

    // Check TIX access separately from symbol data — don't let one failure kill both.
    let hasTix = false, has4S = false;
    try { hasTix = ns.stock.hasTixApiAccess(); } catch (e) { ns.print('hasTixApiAccess error: ' + e); }
    try { has4S = ns.stock.has4SDataTixApi(); } catch (e) { ns.print('has4SDataTixApi error: ' + e); }

    // Also check via the dashboard-data.js cached flags as a fallback.
    // dashboard-data.js uses a temp-script approach that's more reliable in some BNs.
    if (!hasTix) {
        try {
            const raw = ns.read('/Temp/dashboard-data.txt');
            if (raw && raw !== '') {
                const cached = JSON.parse(raw);
                if (cached.hasTix) hasTix = true;
                if (cached.has4SApi) has4S = true;
            }
        } catch {}
    }

    if (hasTix) {
        try {
            const syms = safe(() => ns.stock.getSymbols()) ?? [], allStocks = [];
            let tv = 0, tc = 0;
            for (const sym of syms) {
                const pos      = safe(() => ns.stock.getPosition(sym)) ?? [0,0,0,0];
                const price    = safe(() => ns.stock.getPrice(sym))    ?? 0;
                const maxSh    = safe(() => ns.stock.getMaxShares(sym)) ?? 0;
                const forecast = has4S ? (safe(() => ns.stock.getForecast(sym)) ?? null) : null;
                const lv = pos[0]*price, lc = pos[0]*pos[1];
                tv += pos[0]>0?lv:0; tc += pos[0]>0?lc:0;
                // Short P&L: profit when price falls below avg short price.
                const shortPnL = pos[2] > 0 ? (pos[3] - price) * pos[2] : 0;
                tv += pos[2]>0 ? pos[2]*pos[3] : 0; // sold for avgShortPrice
                tc += pos[2]>0 ? pos[2]*price  : 0; // costs currentPrice to close
                allStocks.push({ sym, price, maxSh, forecast, longSh:pos[0], longAvg:pos[1],
                    longVal:lv, longCost:lc, longPnL:lv-lc,
                    shortSh:pos[2], shortAvg:pos[3], shortPnL });
            }
            allStocks.sort((a,b) => b.longVal-a.longVal || (b.forecast??0.5)-(a.forecast??0.5));
            d.stocks = { allStocks, has4S, totalVal:tv, totalPnL:tv-tc };
        } catch (e) {
            ns.print('Stock data gather error: ' + e);
            d.stocks = null;
        }
    } else {
        d.stocks = null;
    }
    d.stocksLoaded    = true;
    d.stocksTimestamp = Date.now();
    return d;
}

function processCmd(ns, cmd) {
    try {
        switch (cmd.type) {
            case 'buyStock':       ns.stock.buyStock(cmd.sym, cmd.qty);      break;
            case 'sellStock':      ns.stock.sellStock(cmd.sym, cmd.qty);     break;
            case 'sellShortStock': ns.stock.sellShort(cmd.sym, cmd.qty);     break;
            default: break;
        }
    } catch (e) { ns.print('STOCKS CMD ERR [' + cmd.type + ']: ' + (e?.message ?? e)); }
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');
    const uiScript = ns.getScriptName().replace(/dashboard-stocks\.js$/, 'dashboard.js');
    const singPort = ns.getPortHandle(SING_PORT);

    // Clear stale data when script exits (tab change, UI close, crash)
    ns.atExit(() => ns.write(STOCKS_FILE, '', 'w'));

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
            try { processCmd(ns, JSON.parse(singPort.read())); }
            catch (e) { ns.print('STOCKS port error: ' + (e?.message ?? e)); }
        }
        try { ns.write(STOCKS_FILE, JSON.stringify(await gatherData(ns)), 'w'); }
        catch (e) { ns.print('gatherData error: ' + (e?.message ?? e)); }

        await ns.sleep(1000);
    }
}