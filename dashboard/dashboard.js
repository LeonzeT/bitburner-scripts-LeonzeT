/**
 * AUTHOR: LeonzeT
 *
 * dashboard.js — NEXUS overlay UI  (~3 GB, always running)
 *
 * RAM breakdown (3-file split):
 *   dashboard.js           ~3 GB  always on, UI only
 *   dashboard-data.js     ~10 GB  always on, non-singularity data + actions
 *   dashboard-factions.js  large  ONLY while Factions tab is open
 *   dashboard-shortcuts.js  large  ONLY while Shortcuts tab is open
 *   dashboard-servers.js   small  ONLY while Servers tab is open
 *   dashboard-stocks.js    small  ONLY while Stocks tab is open
 *
 * When watching HWGW (normal use), the expensive factions script is not running,
 * so that RAM is free for batcher workers.
 *
 * Commands:  React → cmdQueue → port 17 → data script (forwards sing. to port 18)
 * Data:      dashboard-data.js    → /Temp/dashboard-data.txt     → merged
 *            dashboard-factions.js → /Temp/dashboard-factions.txt ┐
 *            dashboard-shortcuts.js → /Temp/dashboard-shortcuts.txt │ merged
 *            dashboard-servers.js   → /Temp/dashboard-servers.txt   │ into
 *            dashboard-stocks.js    → /Temp/dashboard-stocks.txt    ┘ one state
 *
 * @param {NS} ns
 */

const CMD_PORT      = 17;
const DATA_FILE     = '/Temp/dashboard-data.txt';
const FACTIONS_FILE   = '/Temp/dashboard-factions.txt';
const SHORTCUTS_FILE  = '/Temp/dashboard-shortcuts.txt';
const SERVERS_FILE    = '/Temp/dashboard-servers.txt';
const STOCKS_FILE     = '/Temp/dashboard-stocks.txt';
const CORP_FILE       = '/Temp/dashboard-corp-ui.txt';
const GANGS_FILE      = '/Temp/dashboard-gangs.txt';
const SLEEVES_FILE    = '/Temp/dashboard-sleeves.txt';

// Maps each tab to the companion script that gathers its data.
// Tabs not in this map (HWGW, Player, Darknet) use always-on data from dashboard-data.js.
const ON_DEMAND_TABS = {
    Factions:  'dashboard-factions.js',
    Shortcuts: 'dashboard-shortcuts.js',
    Servers:   'dashboard-servers.js',
    Stocks:    'dashboard-stocks.js',
    Corp:      'dashboard-corp.js',
    Gang:      'dashboard-gangs.js',
    Sleeves:   'dashboard-sleeves.js',
};

// ── Formatters ────────────────────────────────────────────────────────────────
function fm(n) {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e15) return s + (a/1e15).toFixed(2) + 'q';
    if (a >= 1e12) return s + (a/1e12).toFixed(2) + 't';
    if (a >= 1e9)  return s + '$' + (a/1e9).toFixed(2) + 'b';
    if (a >= 1e6)  return s + '$' + (a/1e6).toFixed(2) + 'm';
    if (a >= 1e3)  return s + '$' + (a/1e3).toFixed(1) + 'k';
    return s + '$' + a.toFixed(0);
}
function fr(gb) {
    if (gb == null) return '—';
    if (gb >= 1024*1024) return (gb/(1024*1024)).toFixed(2) + ' PB';
    if (gb >= 1024)      return (gb/1024).toFixed(2) + ' TB';
    return gb.toFixed(0) + ' GB';
}
function fn(n) {
    if (n == null || isNaN(n)) return '—';
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e12) return s + (a/1e12).toFixed(2) + 't';
    if (a >= 1e9)  return s + (a/1e9).toFixed(2) + 'b';
    if (a >= 1e6)  return s + (a/1e6).toFixed(2) + 'm';
    if (a >= 1e3)  return s + (a/1e3).toFixed(1) + 'k';
    return s + a.toFixed(0);
}
function fp(n, d=1) { return n == null ? '—' : (n*100).toFixed(d) + '%'; }
function fx(n, d=3) { return n == null ? '—' : n.toFixed(d) + 'x'; }
function fts(sec) {
    if (sec == null) return '—';
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = Math.floor(sec%60);
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
}
function hwgwAutoMinMoney(hackLevel, bnMults = {}) {
    const effectiveHackLevel = Math.max(0, Number(hackLevel ?? 0) * Math.max(0.01, Number(bnMults.HackingLevelMultiplier ?? 1)));
    let baseThreshold = 0;
    if (effectiveHackLevel >= 1000) baseThreshold = 1e9;
    else if (effectiveHackLevel >= 500) baseThreshold = 1e8;
    else if (effectiveHackLevel >= 250) baseThreshold = 2e7;
    else if (effectiveHackLevel >= 100) baseThreshold = 1e7;
    else if (effectiveHackLevel >= 50) baseThreshold = 1e6;
    else return 0;
    const serverMoneyScale = Math.max(0.01, Number(bnMults.ServerMaxMoney ?? 1));
    const raw = baseThreshold * serverMoneyScale;
    const power = Math.max(0, Math.floor(Math.log10(raw)) - 1);
    const unit = 10 ** power;
    return Math.max(unit, Math.round(raw / unit) * unit);
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const CSS = `
.nd{position:fixed;width:820px;background:#060b06;border:1px solid #173317;border-radius:3px;
  font-family:'Courier New',Courier,monospace;font-size:13px;color:#7aac7a;
  z-index:2147483647;box-shadow:0 0 60px rgba(30,160,30,.08),0 14px 44px rgba(0,0,0,.97);
  overflow:hidden;pointer-events:all;user-select:none;}
.nd-header{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#0b140b;
  border-bottom:1px solid #173317;cursor:move;min-height:30px;}
.nd-logo{color:#33ff33;font-size:18px;line-height:1;}
.nd-title{color:#33ff33;font-weight:bold;font-size:14px;letter-spacing:3px;}
.nd-hbtn{background:none;border:1px solid #173317;color:#3a6a3a;cursor:pointer;
  font-family:inherit;font-size:11px;padding:2px 8px;border-radius:2px;line-height:1.5;
  transition:color .12s,border-color .12s;}
.nd-hbtn:hover{border-color:#33ff33;color:#33ff33;}
.nd-close:hover{border-color:#ff3355 !important;color:#ff3355 !important;}
.nd-clock{color:#2a5a2a;font-size:11px;font-family:inherit;}
.nd-tabs{display:flex;background:#080e08;border-bottom:1px solid #173317;overflow-x:auto;scrollbar-width:none;}
.nd-tabs::-webkit-scrollbar{display:none;}
.nd-tab{background:none;border:none;border-right:1px solid #10200f;color:#2d5a2d;cursor:pointer;
  font-family:inherit;font-size:12px;padding:6px 14px;white-space:nowrap;
  transition:color .1s,background .1s;outline:none;}
.nd-tab:hover{color:#7aac7a;background:#0b140b;}
.nd-tab-on{color:#33ff33;background:#0e1c0e;border-bottom:2px solid #33ff33;}
.nd-subtabs{display:flex;gap:5px;margin-bottom:10px;}
.nd-subtab{background:none;border:1px solid #173317;color:#3a6a3a;cursor:pointer;
  font-family:inherit;font-size:12px;padding:3px 13px;border-radius:2px;transition:all .1s;}
.nd-subtab:hover{color:#7aac7a;border-color:#7aac7a;}
.nd-subtab-on{color:#33ff33;border-color:#33ff33;background:#0e1c0e;}
.nd-body{max-height:68vh;overflow-y:auto;padding:11px 14px;
  scrollbar-width:thin;scrollbar-color:#173317 transparent;}
.nd-body::-webkit-scrollbar{width:4px;}
.nd-body::-webkit-scrollbar-thumb{background:#173317;border-radius:2px;}
.nd-sec{color:#33ff33;font-size:11px;letter-spacing:2.5px;text-transform:uppercase;
  margin:14px 0 6px;padding-bottom:3px;border-bottom:1px solid #173317;}
.nd-sec:first-child{margin-top:0;}
.nd-row{display:flex;justify-content:space-between;align-items:baseline;
  padding:3px 0;border-bottom:1px solid #0c150c;}
.nd-lbl{color:#2d5a2d;font-size:12px;}
.nd-val{color:#b8d8b8;font-size:12px;}
.nd-hi{color:#33ff33;}.nd-warn{color:#ffd700;}.nd-bad{color:#ff3355;}.nd-dim{color:#1d3d1d;}
.nd-bar{height:3px;background:#0b140b;border-radius:1px;margin:3px 0 5px;overflow:hidden;}
.nd-bar-fill{height:100%;border-radius:1px;transition:width .5s;}
.nd-card{background:#0b140b;border:1px solid #173317;border-radius:2px;padding:8px 10px;margin-bottom:7px;}
.nd-card-title{color:#33ff33;font-size:12px;letter-spacing:1px;margin-bottom:5px;font-weight:bold;}
.nd-btn{background:#0b140b;border:1px solid #173317;color:#7aac7a;cursor:pointer;
  font-family:inherit;font-size:12px;padding:3px 10px;border-radius:2px;
  transition:color .1s,border-color .1s;line-height:1.5;}
.nd-btn:hover:not([disabled]){border-color:#33ff33;color:#33ff33;}
.nd-btn[disabled]{opacity:.3;cursor:default;}
.nd-btn-red:hover:not([disabled]){border-color:#ff3355 !important;color:#ff3355 !important;}
.nd-btn-yel{border-color:#5a4a00;color:#a08000;}
.nd-btn-yel:hover:not([disabled]){border-color:#ffd700 !important;color:#ffd700 !important;}
.nd-btn-sm{font-size:11px;padding:2px 7px;}
.nd-tbl{width:100%;border-collapse:collapse;font-size:12px;}
.nd-tbl th{color:#2d5a2d;text-align:left;padding:3px 6px;border-bottom:1px solid #173317;
  font-weight:normal;font-size:11px;}
.nd-tbl td{padding:3px 6px;border-bottom:1px solid #0c150c;color:#7aac7a;vertical-align:middle;}
.nd-tbl tr:last-child td{border-bottom:none;}
.nd-input{background:#0b140b;border:1px solid #173317;color:#b8d8b8;font-family:inherit;
  font-size:12px;padding:3px 8px;border-radius:2px;outline:none;}
.nd-input:focus{border-color:#33ff33;}
.nd-input-sm{width:72px;}
.nd-select{background:#0b140b;border:1px solid #173317;color:#b8d8b8;font-family:inherit;
  font-size:12px;padding:3px 7px;border-radius:2px;outline:none;cursor:pointer;}
.nd-empty{color:#1d3d1d;text-align:center;padding:28px;font-size:12px;}
.nd-pill{display:inline-block;background:#0e1c0e;border:1px solid #173317;color:#3a6a3a;
  font-size:10px;padding:1px 6px;border-radius:10px;margin:1px;}
.nd-pill-hi{border-color:#33ff33;color:#33ff33;}
.nd-pill-warn{border-color:#ffd700;color:#ffd700;}
.nd-notify{margin-bottom:8px;padding:6px 9px;background:#0e1c0e;border:1px solid #3a3a00;
  border-radius:2px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.nd-row-ac{display:flex;align-items:center;gap:7px;padding:4px 0;
  border-bottom:1px solid #0c150c;flex-wrap:wrap;}
.nd-work-row{display:flex;align-items:center;gap:6px;padding:3px 0;flex-wrap:wrap;}
.nd-tab-div{display:inline-block;width:1px;background:#173317;margin:0 4px;height:16px;align-self:center;}
.nd-tab-mgmt{color:#5a8a5a;}
.nd-tab-mgmt.nd-tab-on{color:#33ff33;}
.nd-notif-bar{display:flex;flex-wrap:wrap;gap:5px;padding:5px 8px 4px;border-bottom:1px solid #0c150c;background:#040d04;}
.nd-notif-item{font-size:10px;padding:1px 7px;border-radius:10px;border:1px solid;display:inline-flex;gap:3px;align-items:center;}
.nd-notif-label{font-weight:bold;}
.nd-pcard{border:1px solid #0c150c;border-radius:3px;margin-bottom:4px;}
.nd-pcard-hdr{display:flex;justify-content:space-between;align-items:center;padding:4px 8px;cursor:pointer;background:#070f07;font-size:11px;color:#5a8a5a;font-weight:bold;letter-spacing:0.05em;}
.nd-pcard-hdr:hover{background:#0b160b;}
.nd-pcard-chev{font-size:10px;color:#3a6a3a;}
.nd-pcard-body{padding:2px 0 4px;}
`;

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog('ALL');

    const myScript       = ns.getScriptName();
    const dataScript     = myScript.replace(/dashboard\.js$/, 'dashboard-data.js');
    // Resolve companion script paths relative to dashboard.js location
    const resolveScript = name => myScript.replace(/dashboard\.js$/, name);

    if (!ns.isRunning(dataScript, 'home')) {
        if (!ns.run(dataScript)) {
            ns.tprint(`ERROR: Could not launch ${dataScript} — is the file missing?`);
            return;
        }
    }

    const doc   = window.document;
    const React = window.React;
    const RDom  = window.ReactDOM;
    const h     = React.createElement;
    if (!React || !RDom) { ns.tprint('ERROR: React/ReactDOM not on window.'); return; }

    doc.getElementById('nd-style')?.remove();
    const oldRoot = doc.getElementById('nd-root');
    if (oldRoot) { try { RDom.unmountComponentAtNode(oldRoot); } catch {} oldRoot.remove(); }
    const styleEl = doc.createElement('style');
    styleEl.id = 'nd-style'; styleEl.textContent = CSS;
    doc.head.appendChild(styleEl);
    const mountEl = doc.createElement('div');
    mountEl.id = 'nd-root'; doc.body.appendChild(mountEl);

    // Stop keyboard events from bubbling to the game terminal when typing
    // inside any dashboard input, so the terminal doesn't consume the keystrokes.
    const stopKeys = e => { if (doc.activeElement?.closest('#nd-root')) e.stopImmediatePropagation(); };
    doc.addEventListener('keydown', stopKeys, true);
    doc.addEventListener('keyup',   stopKeys, true);

    // Shared between React and main loop (module-level closure)
    let currentTab = 'HWGW';
    const cmdQueue = [];
    const enqueue  = (cmd) => cmdQueue.push(cmd);
    let pushData   = null;

    ns.atExit(() => {
        doc.removeEventListener('keydown', stopKeys, true);
        doc.removeEventListener('keyup',   stopKeys, true);
        try { RDom.unmountComponentAtNode(mountEl); } catch {}
        doc.getElementById('nd-root')?.remove();
        doc.getElementById('nd-style')?.remove();
    });

    // ── Shared components ─────────────────────────────────────────────────────
    const Row = ({ label, val, color }) =>
        h('div', { className: 'nd-row' },
            h('span', { className: 'nd-lbl' }, label),
            h('span', { className: 'nd-val' + (color ? ' nd-' + color : '') }, val));

    const Sec = ({ title }) => h('div', { className: 'nd-sec' }, title);

    const Btn = ({ children, cmd, disabled, title, color, sm, onClick }) =>
        h('button', {
            className: 'nd-btn' + (color ? ' nd-btn-' + color : '') + (sm ? ' nd-btn-sm' : ''),
            disabled: !!disabled, title,
            onClick: () => { if (!disabled) { if (cmd) enqueue(cmd); if (onClick) onClick(); } },
        }, children);

    /** Collapsible card with a header toggle */
    function Card({ title, children, defaultOpen = false }) {
        const [open, setOpen] = React.useState(defaultOpen);
        return h('div', { className: 'nd-pcard' },
            h('div', { className: 'nd-pcard-hdr', onClick: () => setOpen(o => !o) },
                h('span', null, title),
                h('span', { className: 'nd-pcard-chev' }, open ? '▾' : '▸'),
            ),
            open && h('div', { className: 'nd-pcard-body' }, children),
        );
    }

    const Bar = ({ pct, color }) =>
        h('div', { className: 'nd-bar' },
            h('div', { className: 'nd-bar-fill', style: {
                width: Math.min(100, Math.max(0, (pct ?? 0) * 100)) + '%',
                background: color ?? '#33ff33',
            }}));

    const SubTabs = ({ tabs, active, onChange }) =>
        h('div', { className: 'nd-subtabs' },
            tabs.map(t => h('button', {
                key: t,
                className: 'nd-subtab' + (active === t ? ' nd-subtab-on' : ''),
                onClick: () => onChange(t),
            }, t)));

    /** Notification bar — surfaces things that need attention without reading every tab */
    function NotifBar({ data }) {
        const notes = [];
        const { player, inGang, wantedPenalty, wantedLevel, respect, members,
                sleeves, hwgw, managerRunning, gangName } = data;

        // Wanted level penalty
        if (inGang && (wantedPenalty ?? 1) < 0.95)
            notes.push({ color:'#ff3355', label:'Wanted', val: '-' + ((1-(wantedPenalty??1))*100).toFixed(1)+'% penalty' });

        // Sleeve shock
        (sleeves ?? []).forEach(s => {
            if ((s.shock ?? 0) > 20)
                notes.push({ color:'#ffd700', label:'Sleeve '+s.index, val:'shock '+s.shock.toFixed(0)+'%' });
        });

        // HWGW no targets
        if (managerRunning && (!hwgw?.targets?.length))
            notes.push({ color:'#ffd700', label:'HWGW', val:'no active targets' });

        // Home RAM nearly full
        const rp = data.homeMaxRam > 0 ? data.homeUsedRam / data.homeMaxRam : 0;
        if (rp > 0.95)
            notes.push({ color:'#ff3355', label:'RAM', val:(rp*100).toFixed(0)+'% used' });

        // Gang territory warfare off but power is ready
        if (inGang && data.power > 0 && !data.territoryWarfareEngaged && (data.territory ?? 0) < 0.99)
            notes.push({ color:'#2288ff', label:'Gang', val:'warfare off' });

        if (!notes.length) return null;
        return h('div', { className:'nd-notif-bar' },
            notes.map((n, i) => h('span', { key:i, className:'nd-notif-item',
                style:{ borderColor: n.color, color: n.color } },
                h('span', { className:'nd-notif-label' }, n.label),
                h('span', null, ' ' + n.val),
            ))
        );
    }

    class ErrBound extends React.Component {
        constructor(p) { super(p); this.state = { err: null }; }
        static getDerivedStateFromError(e) { return { err: e }; }
        render() {
            if (this.state.err)
                return h('div', { style: { color: '#ff3355', padding: 16, fontSize: 12 } },
                    'Render error: ' + (this.state.err?.message ?? String(this.state.err)),
                    h('br'),
                    h('button', { className: 'nd-btn', style: { marginTop: 8 },
                        onClick: () => this.setState({ err: null }) }, 'Retry'));
            return this.props.children;
        }
    }

    // ── Tab: HWGW ─────────────────────────────────────────────────────────────
    function HwgwTab({ data }) {
        const { hwgw, targetStats, execCount, execRamMax, execRamUsed, forceTarget,
                prepRunning, prepTargets, managerRunning } = data;
        const [ftInput,  setFtInput]  = React.useState('');
        const [mTargets, setMTargets] = React.useState('0');
        const [mHackPct, setMHackPct] = React.useState('0.1');
        const [mReserve, setMReserve] = React.useState('32');
        const [mPeriod,  setMPeriod]  = React.useState('200');
        const [mMinMon,  setMMinMon]  = React.useState('');
        const [mQuiet,   setMQuiet]   = React.useState(true);
        const [showAdv,  setShowAdv]  = React.useState(false);
        const hackLevel = data.player?.skills?.hacking ?? 0;
        const defaultMinMoney = hwgwAutoMinMoney(hackLevel, data.bnMults);
        const buildMgrArgs = () => {
            const a = [];
            if (mTargets.trim() && mTargets !== '0') a.push('--targets', mTargets.trim());
            if (mHackPct.trim()) a.push('--hack-percent', mHackPct.trim());
            if (mReserve.trim()) a.push('--reserve-ram',  mReserve.trim());
            if (mPeriod.trim())  a.push('--period',       mPeriod.trim());
            const mm = mMinMon.trim();
            if (mm && mm !== '0') a.push('--min-money', mm);
            if (mQuiet) a.push('--quiet');
            return a;
        };
        const InRow = ({ label, val, setter, placeholder }) =>
            h('div', { style:{ display:'flex', alignItems:'center', gap:5, marginBottom:3 } },
                h('span', { style:{ color:'#2d5a2d', fontSize:11, width:120, flexShrink:0 } }, label),
                h('input', { className:'nd-input nd-input-sm', style:{ width:90 },
                    placeholder, value:val, onChange: e => setter(e.target.value) }));
        const targets = hwgw?.targets ?? [], batchers = hwgw?.batchers ?? {};

        // Prep progress section: show weaken + grow bars for each target being prepped.
        // Weaken progress: minSec/currentSec → 1.0 = fully weakened.
        // Grow progress:   money/maxMoney   → 1.0 = fully grown.
        // ETA shows the cycle duration (weakenTime) since that's the bottleneck per cycle.
        const prepSection = prepRunning && (prepTargets ?? []).length > 0 && h(React.Fragment, null,
            h(Sec, { title: 'Prep in Progress' }),
            (prepTargets ?? []).map(t => {
                const ts = targetStats?.[t];
                const weakenPct = ts?.sec > 0 && ts?.minSec > 0
                    ? Math.min(1, ts.minSec / ts.sec) : 0;
                const growPct = ts?.maxMoney > 0
                    ? Math.min(1, (ts.money ?? 0) / ts.maxMoney) : 0;
                const weakenDone = weakenPct >= 0.999;
                const growDone   = growPct   >= 0.999;
                const cycleMs = ts?.weakenTime;
                const etaStr = cycleMs != null
                    ? (cycleMs >= 60000
                        ? (cycleMs / 60000).toFixed(1) + 'm / cycle'
                        : (cycleMs / 1000).toFixed(1) + 's / cycle')
                    : null;
                return h('div', { key: t, className: 'nd-card' },
                    h('div', { className: 'nd-card-title' }, t),
                    h('div', { style: { display:'flex', justifyContent:'space-between',
                        fontSize: 11, color: '#2d5a2d', marginBottom: 2 } },
                        h('span', null, 'Weaken'),
                        h('span', null,
                            weakenDone ? h('span', { className: 'nd-hi' }, '✓ Done')
                                : (ts?.sec != null
                                    ? (ts.sec.toFixed(2) + ' → ' + (ts.minSec?.toFixed(2) ?? '?'))
                                    : '—')
                        ),
                    ),
                    h(Bar, { pct: weakenPct,
                        color: weakenDone ? '#33ff33' : weakenPct > 0.7 ? '#ffd700' : '#ff6633' }),
                    h('div', { style: { display:'flex', justifyContent:'space-between',
                        fontSize: 11, color: '#2d5a2d', marginBottom: 2, marginTop: 6 } },
                        h('span', null, 'Grow'),
                        h('span', null,
                            growDone ? h('span', { className: 'nd-hi' }, '✓ Done')
                                : (ts?.money != null
                                    ? (fm(ts.money) + ' / ' + fm(ts.maxMoney))
                                    : '—')
                        ),
                    ),
                    h(Bar, { pct: growPct,
                        color: growDone ? '#33ff33' : growPct > 0.7 ? '#ffd700' : '#ff6633' }),
                    etaStr && h('div', { style: { fontSize: 10, color: '#2d5a2d',
                        textAlign: 'right', marginTop: 3 } }, etaStr),
                );
            })
        );

        const execUsePct = execRamMax > 0 ? execRamUsed / execRamMax : 0;
        return h(React.Fragment, null,
            h('div', { style:{ display:'flex', alignItems:'center', gap:6, marginBottom:8, flexWrap:'wrap' } },
                h('span', { className: managerRunning ? 'nd-hi' : 'nd-dim', style:{ flex:1, fontSize:12 } },
                    managerRunning ? '● Manager running' : '○ Manager stopped'),
                managerRunning
                    ? h(Btn, { sm:true, color:'red', cmd:{ type:'killHwgw' } }, 'Stop')
                    : h('button', { className:'nd-btn nd-btn-sm',
                        onClick: () => enqueue({ type:'launchManager', args:buildMgrArgs() }) }, 'Launch'),
                h('button', { className:'nd-btn nd-btn-sm', onClick: () => setShowAdv(v => !v) },
                    showAdv ? 'Hide params' : 'Params'),
            ),
            showAdv && h('div', { style:{ background:'#0b140b', border:'1px solid #173317',
                    borderRadius:2, padding:'8px 10px', marginBottom:8 } },
                h(InRow, { label:'--targets',      val:mTargets, setter:setMTargets, placeholder:'0 = auto' }),
                h(InRow, { label:'--hack-percent', val:mHackPct, setter:setMHackPct, placeholder:'0.1' }),
                h(InRow, { label:'--reserve-ram',  val:mReserve, setter:setMReserve, placeholder:'32' }),
                h(InRow, { label:'--period',       val:mPeriod,  setter:setMPeriod,  placeholder:'200' }),
                h(InRow, { label:'--min-money',    val:mMinMon,  setter:setMMinMon,
                    placeholder: defaultMinMoney > 0 ? 'auto (' + fm(defaultMinMoney) + ')' : 'auto (none)' }),
                h('div', { style:{ display:'flex', alignItems:'center', gap:5, marginTop:4 } },
                    h('input', { type:'checkbox', id:'nd-quiet-chk', checked:mQuiet,
                        onChange: e => setMQuiet(e.target.checked) }),
                    h('label', { htmlFor:'nd-quiet-chk',
                        style:{ color:'#2d5a2d', fontSize:11, cursor:'pointer' } }, '--quiet')),
            ),
            prepSection,
            h(Sec, { title: 'Infrastructure' }),
            h('div', { style: { display: 'flex', gap: 12, fontSize: 11, color: '#7aac7a',
                padding: '4px 0', borderBottom: '1px solid #0c150c', flexWrap: 'wrap' } },
                h('span', null, fn(execCount ?? 0) + ' hosts'),
                h('span', { style: { color: '#2d5a2d' } }, '|'),
                h('span', { style: { color: execUsePct > 0.95 ? '#ffd700' : '#7aac7a' } },
                    fr(execRamUsed) + ' / ' + fr(execRamMax) + ' RAM'),
                execRamMax > 0 && h(Bar, { pct: execUsePct,
                    color: execUsePct > 0.95 ? '#ffd700' : '#33ff33' }),
                h('span', { style: { color: '#2d5a2d' } }, '|'),
                h('span', null, 'reserve ' + fr(hwgw?.reserveRam ?? 32)),
            ),
            h(Sec, { title: 'Target Override' }),
            h('div', { className: 'nd-row-ac' },
                h('span', { className: 'nd-lbl' }, forceTarget ? 'Forced: ' + forceTarget : 'Auto-selecting'),
                h('input', {
                    className: 'nd-input', placeholder: 'hostname (blank = auto)',
                    style: { width: 180 }, value: ftInput,
                    onChange: e => setFtInput(e.target.value),
                }),
                h(Btn, { cmd: { type: 'setForceTarget', target: ftInput.trim() } },
                    ftInput.trim() ? 'Set Target' : 'Clear Override'),
            ),
            h(Sec, { title: 'Targets (' + targets.length + ')' }),
            targets.length === 0
                ? h('div', { className: 'nd-empty' }, 'No active targets')
                : targets.map(t => {
                    const b = batchers[t], ts = targetStats?.[t];
                    const mp = ts?.maxMoney > 0 ? (ts.money ?? 0) / ts.maxMoney : 0;
                    const sp = ts ? (ts.sec ?? 0) / (ts.minSec ?? 1) : 1;
                    return h('div', { key: t, className: 'nd-card' },
                        h('div', { className: 'nd-card-title' }, t),
                        b  && h(Row, { label: 'PID / Uptime', val: b.pid + ' · ' + fts(b.uptimeS) }),
                        ts && h(Row, { label: 'Money',
                            val: fm(ts.money) + ' / ' + fm(ts.maxMoney) + ' (' + fp(mp, 0) + ')',
                            color: mp < 0.5 ? 'bad' : mp < 0.9 ? 'warn' : 'hi' }),
                        ts && h(Bar, { pct: mp, color: mp < 0.5 ? '#ff3355' : mp < 0.9 ? '#ffd700' : '#33ff33' }),
                        ts && h(Row, { label: 'Security',
                            val: (ts.sec?.toFixed(2) ?? '—') + ' / ' + (ts.minSec?.toFixed(2) ?? '—'),
                            color: sp > 1.5 ? 'bad' : sp > 1.05 ? 'warn' : 'hi' }),
                        ts && h(Row, { label: 'Hack Chance', val: fp(ts.chance) }),
                    );
                })
        );
    }

    // ── Tab: Darknet ──────────────────────────────────────────────────────────
    function DarknetTab({ data }) {
        const { dnet, crawlerRunning, crawlerWorkerRunning } = data;
        const [crawlArgs, setCrawlArgs] = React.useState('');
        const crawlerSection = h('div', { className:'nd-row-ac', style:{ marginBottom:8 } },
            h('span', { className: crawlerRunning ? 'nd-hi' : 'nd-dim', style:{ flex:1, fontSize:12 } },
                crawlerRunning
                    ? '● Crawler' + (crawlerWorkerRunning ? ' + workers' : '') + ' running'
                    : '○ Crawler stopped'),
            crawlerRunning
                ? h(Btn, { sm:true, color:'red', cmd:{ type:'killCrawler' } }, 'Stop')
                : h(React.Fragment, null,
                    h('input', { className:'nd-input', style:{ width:160 },
                        placeholder:'--phish --max-depth 8',
                        value:crawlArgs, onChange: e => setCrawlArgs(e.target.value) }),
                    h('button', { className:'nd-btn nd-btn-sm',
                        onClick: () => enqueue({ type:'launchCrawler',
                            args: crawlArgs.trim().split(/\s+/).filter(Boolean) }) }, 'Launch'),
                ),
        );
        if (!dnet) return h('div', null,
            crawlerSection,
            h('div', { className:'nd-empty' }, 'No cracked servers yet'));
        const entries = Object.entries(dnet);
        if (!entries.length) return h('div', null, crawlerSection,
            h('div', { className: 'nd-empty' }, 'No servers cracked yet'));
        return h(React.Fragment, null,
            crawlerSection,
            h(Sec, { title: 'Cracked Servers (' + entries.length + ')' }),
            h('table', { className: 'nd-tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Hostname'), h('th', null, 'Password'), h('th', null, 'Auth'))),
                h('tbody', null, entries.map(([host, pw]) =>
                    h('tr', { key: host },
                        h('td', null, host),
                        h('td', { style: { color: '#2d5a2d' } }, pw === '' ? '(auto)' : pw.slice(0, 4) + '....'),
                        h('td', { className: 'nd-hi' }, 'OK'),
                    )
                ))
            )
        );
    }

    // ── Tab: Player ───────────────────────────────────────────────────────────
    function PlayerTab({ data }) {
        const { player, homeMaxRam, homeUsedRam, bnMults, moneySources, wdHackReq, facman } = data;
        if (!player) return h('div', { className: 'nd-empty' }, 'Loading...');
        const pm = player.mults ?? {}, sk = player.skills ?? {}, ex = player.exp ?? {};
        const bn = bnMults ?? {}, rp = homeMaxRam > 0 ? homeUsedRam / homeMaxRam : 0;
        const money = player.money ?? 0;
        const eff = (pMult, bnKey) => {
            const p = pMult ?? 1, b = bn[bnKey] ?? 1, e = p * b;
            return Math.abs(b - 1) > 0.001
                ? fx(e) + '  (' + fx(p, 2) + ' x BN' + fx(b, 2) + ')'
                : fx(e);
        };

        // ── Income breakdown (since last aug) ──────────────────────────────
        const ms = moneySources?.sinceInstall;
        const incomeSection = ms && h(React.Fragment, null,
            h(Sec, { title: 'Income Since Aug' }),
            ...[
                ['Hacking',  ms.hacking],
                ['Gang',     ms.gang],
                ['Stocks',   ms.stock],
                ['Crime',    ms.crime],
                ['Other',    (ms.total ?? 0) - (ms.hacking ?? 0) - (ms.gang ?? 0) - (ms.stock ?? 0) - (ms.crime ?? 0)],
            ]
            .filter(([, v]) => Math.abs(v ?? 0) > 1000)
            .map(([label, val]) => h(Row, { key: label, label, val: fm(val),
                color: (val ?? 0) > 0 ? 'hi' : 'bad' })),
        );

        // ── BN completion / Daedalus progress ──────────────────────────────
        const hackLvl = sk.hacking ?? 0;
        const wd = wdHackReq;
        const wdSection = wd != null && h(React.Fragment, null,
            h(Sec, { title: 'BN Progress' }),
            h(Row, { label: 'WD Hack Req', val: fn(hackLvl) + ' / ' + fn(wd),
                color: hackLvl >= wd ? 'hi' : hackLvl >= wd * 0.75 ? 'warn' : undefined }),
            h(Bar, { pct: Math.min(1, hackLvl / wd),
                color: hackLvl >= wd ? '#33ff33' : hackLvl >= wd * 0.75 ? '#ffd700' : '#33ff33' }),
        );

        // Daedalus bars — show if not yet a member and requirements are partially met
        const daedalusReqAugs = (bn.DaedalusAugsRequirement ?? 30);
        const installedCount  = facman?.installed_count ?? null;
        const inDaedalus      = (player.factions ?? []).includes('Daedalus');
        const daedalusSection = !inDaedalus && h(React.Fragment, null,
            h(Sec, { title: 'Daedalus Gate' }),
            // Money bar: 100B
            h(Row, { label: 'Money', val: fm(money) + ' / $100b',
                color: money >= 100e9 ? 'hi' : undefined }),
            h(Bar, { pct: Math.min(1, money / 100e9),
                color: money >= 100e9 ? '#33ff33' : '#2288ff' }),
            // Hack bar: 2500
            h(Row, { label: 'Hack', val: fn(hackLvl) + ' / 2500',
                color: hackLvl >= 2500 ? 'hi' : undefined }),
            h(Bar, { pct: Math.min(1, hackLvl / 2500),
                color: hackLvl >= 2500 ? '#33ff33' : '#2288ff' }),
            // Augs bar
            installedCount != null && h(Row, { label: 'Augs', val: installedCount + ' / ' + daedalusReqAugs,
                color: installedCount >= daedalusReqAugs ? 'hi' : undefined }),
            installedCount != null && h(Bar, { pct: Math.min(1, installedCount / daedalusReqAugs),
                color: installedCount >= daedalusReqAugs ? '#33ff33' : '#2288ff' }),
        );

        return h(React.Fragment, null,
            h(Card, { title: 'Wealth', defaultOpen: true },
                h(Row, { label: 'Balance', val: fm(money), color: 'hi' }),
                incomeSection,
                wdSection,
                daedalusSection,
            ),
            h(Card, { title: 'Hacking', defaultOpen: true },
            h(Row, { label: 'Level',      val: fn(sk.hacking) }),
            h(Row, { label: 'XP',         val: fn(ex.hacking) }),
            (() => {
                const INT = sk.intelligence ?? 0;
                if (INT <= 0) return null;
                const b1 = 1 + Math.pow(INT, 0.8) / 600;
                const b2 = 1 + 2 * Math.pow(INT, 0.8) / 600;
                const b3 = 1 + 3 * Math.pow(INT, 0.8) / 600;
                const tip = 'INT ' + INT + '\n' +
                    'Speed/Chance (w=1): ' + b1.toFixed(4) + 'x\n' +
                    'Share Power  (w=2): ' + b2.toFixed(4) + 'x\n' +
                    'Prog Speed   (w=3): ' + b3.toFixed(4) + 'x\n' +
                    'Formula: 1 + (INT^0.8 × weight) / 600';
                return h(Row, { label: 'INT',
                    val: fn(INT) + '  (spd ' + fx(b1,3) + '  share ' + fx(b2,3) + '  prog ' + fx(b3,3) + ')',
                    color: 'hi', title: tip });
            })(),
            h(Row, { label: 'Hack Mult',  val: eff(pm.hacking,       'HackingLevelMultiplier') }),
            h(Row, { label: 'Hack Money', val: eff(pm.hacking_money, 'ScriptHackMoney'),  color: 'hi' }),
            h(Row, { label: 'Hack Speed', val: (() => {
                // Effective hack/grow/weaken speed = aug_mult × BN_mult × INT_bonus(weight=1)
                // INT bonus must be multiplied in manually — it's not part of player.mults
                const INT = sk.intelligence ?? 0;
                const intBonus = INT > 0 ? 1 + Math.pow(INT, 0.8) / 600 : 1;
                const augBn = (pm.hacking_speed ?? 1) * (bn['ServerWeakenRate'] ?? 1);
                const full = augBn * intBonus;
                return fx(full) + (intBonus > 1 ? `  (aug×BN ${fx(augBn, 2)} × INT ${fx(intBonus, 3)})` : '');
            })(), color: 'hi',
                title: 'Includes INT bonus (weight=1). Formula: aug×BN×(1+INT^0.8/600)' }),
            h(Row, { label: 'Grow Multi', val: eff(pm.hacking_grow,  'ServerGrowthRate') }),
            ),
            h(Card, { title: 'Reputation' },
                h(Row, { label: 'Faction Rep', val: eff(pm.faction_rep, 'FactionWorkRepGain'), color: 'hi' }),
                h(Row, { label: 'Company Rep', val: eff(pm.company_rep, 'CompanyWorkRepGain') }),
                (pm.hacknet_node_money ?? 1) > 1.001 &&
                    h(Row, { label: 'Hacknet $', val: eff(pm.hacknet_node_money, 'HacknetNodeMoney') }),
            ),
            h(Card, { title: 'Home' },
                h(Row, { label: 'RAM',
                    val: fr(homeUsedRam) + ' / ' + fr(homeMaxRam),
                    color: rp > 0.9 ? 'bad' : rp > 0.75 ? 'warn' : undefined }),
                h(Bar, { pct: rp, color: rp > 0.9 ? '#ff3355' : rp > 0.75 ? '#ffd700' : '#33ff33' }),
            ),
        );
    }

    // ── AugTable — paginated aug list with tooltips ──────────────────────────
    const AUG_PAGE_SIZE = 15;
    function AugTable({ augs, faction, money, page, setPage, buyable }) {
        const totalPages = Math.ceil(augs.length / AUG_PAGE_SIZE);
        const safePage   = Math.min(page, Math.max(0, totalPages - 1));
        const pageAugs   = augs.slice(safePage * AUG_PAGE_SIZE, (safePage + 1) * AUG_PAGE_SIZE);
        // Collect set of all owned aug names to check prereqs
        const ownedSet   = new Set();  // populated from augs not in the list (simplified check)
        return h('div', null,
            buyable.length > 0 && h('button', {
                className:'nd-btn', style:{ marginBottom:7 },
                onClick: () => { for (const a of buyable) enqueue({ type:'buyAug', faction, aug:a.name }); },
            }, 'Buy All Affordable (' + buyable.length + ')'),
            h('table', { className:'nd-tbl' },
                h('thead', null, h('tr', null,
                    h('th', null, 'Augmentation'), h('th', null, 'Rep Req'),
                    h('th', null, 'Price'), h('th', null, ''))),
                h('tbody', null, pageAugs.map(a => {
                    const missingPrereq = (a.prereq ?? []).filter(p =>
                        augs.some(x => x.name === p));  // prereq still in unowned list
                    return h('tr', { key:a.name, style:{ opacity: a.canBuy ? 1 : 0.4 } },
                        h('td', {
                            title: augTooltip(a),
                            style: { maxWidth:250, overflow:'hidden',
                                textOverflow:'ellipsis', whiteSpace:'nowrap', cursor:'help' },
                        },
                            missingPrereq.length > 0 && h('span', {
                                title: 'Requires: ' + missingPrereq.join(', '),
                                style: { color:'#ffd700', marginRight:4, fontSize:11 },
                            }, '⚠'),
                            a.name,
                        ),
                        h('td', null, fn(a.repReq)),
                        h('td', { style:{ color: money >= a.price ? '#33ff33' : '#ff3355' } },
                            fm(a.price)),
                        h('td', null, a.canBuy && h(Btn, { sm:true,
                            cmd:{ type:'buyAug', faction, aug:a.name } }, 'Buy')),
                    );
                }))
            ),
            totalPages > 1 && h('div', { style:{ display:'flex', alignItems:'center', gap:6,
                marginTop:6, fontSize:11, color:'#2d5a2d' } },
                h('button', { className:'nd-btn nd-btn-sm',
                    disabled: safePage === 0,
                    onClick: () => setPage(safePage - 1) }, '< Prev'),
                h('span', null, (safePage + 1) + ' / ' + totalPages +
                    '  (' + augs.length + ' total)'),
                h('button', { className:'nd-btn nd-btn-sm',
                    disabled: safePage >= totalPages - 1,
                    onClick: () => setPage(safePage + 1) }, 'Next >'),
            ),
        );
    }

    // ── Tab: Factions ─────────────────────────────────────────────────────────
    function FactionsTab({ data }) {
        const { factionData, pendingAugs, player, currentWork,
                donateMinFavor, fRepMult, factionsLoaded, facman, wffOverride } = data;
        const money = player?.money ?? 0;
        const [expanded,  setExpanded]  = React.useState(null);
        const [section,   setSection]   = React.useState({});
        const [donateAmt, setDonateAmt] = React.useState({});
        const [augPage,   setAugPage]   = React.useState({});  // {factionName: pageIndex}

        if (!factionsLoaded) return h('div', { className: 'nd-empty' },
            'Loading faction data (dashboard-factions.js starting up)...');

        const toggleSection = (f, sec) =>
            setSection(prev => ({ ...prev, [f]: prev[f] === sec ? null : sec }));

        const curWorkStr = currentWork
            ? (currentWork.type === 'FACTION'
                ? 'Working for ' + currentWork.factionName + ' (' + currentWork.factionWorkType + ')'
                : currentWork.type)
            : 'Idle';

        // Aug purchase summary from faction-manager output
        const augSummary = facman && h(React.Fragment, null,
            h(Sec, { title: 'Install Readiness' }),
            h(Row, { label: 'Affordable', val: (facman.affordable_count_ex_nf ?? 0) + ' augs' +
                (facman.affordable_count_nf > 0 ? ' + ' + facman.affordable_count_nf + ' NF' : ''),
                color: (facman.affordable_count_ex_nf ?? 0) > 0 ? 'hi' : undefined }),
            h(Row, { label: 'Queued', val: (facman.awaiting_install_count ?? 0) + ' owned, not installed' }),
            facman.total_aug_cost > 0 && h(Row, { label: 'Total Cost',
                val: fm(facman.total_aug_cost),
                color: money >= facman.total_aug_cost ? 'hi' : 'warn' }),
        );

        return h(React.Fragment, null,
            augSummary,
            h(Sec, { title: 'Status' }),
            h(Row, { label: 'Current Work', val: curWorkStr, color: currentWork ? 'hi' : 'dim' }),

            // WFF override banner
            (() => {
                const ov = wffOverride;
                if (!ov || !ov.faction || (ov.until && ov.until <= Date.now())) return null;
                const WL = { hacking: 'Hacking', field: 'Field', security: 'Security' };
                return h('div', { className: 'nd-notify', style: { borderColor: '#33ff33' } },
                    h('span', { style: { flex: 1 } },
                        h('span', { className: 'nd-hi' }, 'WFF Override: '),
                        h('span', { className: 'nd-val' }, ov.faction + ' · ' + (WL[ov.workType] ?? ov.workType)),
                        ov.until && h('span', { className: 'nd-dim', style: { fontSize: 11, marginLeft: 6 } },
                            'expires ' + new Date(ov.until).toLocaleTimeString()),
                    ),
                    h(Btn, { sm: true, color: 'red',
                        cmd: { type: 'clearWffOverride' },
                        title: 'Clear — work-for-factions resumes auto-selection',
                    }, 'Clear'),
                );
            })(),

            pendingAugs > 0 && h('div', { className: 'nd-notify' },
                h('span', { className: 'nd-warn' },
                    pendingAugs + ' aug' + (pendingAugs > 1 ? 's' : '') + ' pending install'),
                h(Btn, { color: 'yel', cmd: { type: 'installAugs' } }, 'Install Now'),
            ),
            h(Sec, { title: 'Joined Factions' }),
            !factionData?.length
                ? h('div', { className: 'nd-empty' }, 'No factions joined')
                : factionData.map(f => {
                    const isOpen = expanded === f.name, sec = section[f.name] ?? null;
                    const buyable = f.augs.filter(a => a.canBuy), wt = f.workTypes ?? [];
                    const WORK_LABELS = { hacking: 'Hacking', field: 'Field', security: 'Security' };
                    const rawDonate = donateAmt[f.name] ?? '';
                    const donateNum = parseFloat(rawDonate.replace(/,/g, '')) || 0;
                    const donateRep = donateNum > 0 ? (donateNum / 1e6) * (fRepMult ?? 1) : 0;
                    const canDonate = f.canDonate && donateNum > 0 && donateNum <= money;
                    return h('div', { key: f.name, className: 'nd-card' },
                        h('div', { style: { display:'flex', alignItems:'center', gap:6, cursor:'pointer' },
                            onClick: () => setExpanded(isOpen ? null : f.name) },
                            h('span', { className: 'nd-card-title', style: { marginBottom:0, flex:1 } }, f.name),
                            h('span', { style: { color:'#2d5a2d', fontSize:11 } },
                                'Rep ' + fn(f.rep) + ' · Favor ' + Math.floor(f.favor)),
                            f.buyable > 0 && h('span', { className:'nd-pill nd-pill-hi' }, f.buyable + ' buyable'),
                            h('span', { style: { color:'#1d3d1d', fontSize:11 } }, isOpen ? ' v' : ' >'),
                        ),
                        isOpen && h('div', { style: { marginTop:7 } },
                            h('div', { style: { display:'flex', gap:5, marginBottom:8, flexWrap:'wrap' } },
                                wt.length > 0 && h('button', {
                                    className: 'nd-subtab' + (sec === 'work' ? ' nd-subtab-on' : ''),
                                    onClick: () => toggleSection(f.name, 'work'),
                                }, 'Work'),
                                h('button', {
                                    className: 'nd-subtab' + (sec === 'donate' ? ' nd-subtab-on' : ''),
                                    onClick: () => toggleSection(f.name, 'donate'),
                                }, 'Donate' + (f.canDonate ? '' : ' (need ' + donateMinFavor + ' favor)')),
                                f.augs.length > 0 && h('button', {
                                    className: 'nd-subtab' + (sec === 'augs' ? ' nd-subtab-on' : ''),
                                    onClick: () => toggleSection(f.name, 'augs'),
                                }, 'Augments (' + f.augs.length + ')'),
                            ),
                            sec === 'work' && wt.length > 0 && h('div', null,
                                wt.map(workType => h('div', { key: workType, className: 'nd-work-row' },
                                    h('span', { style: { color:'#7aac7a', flex:1 } },
                                        WORK_LABELS[workType] ?? workType),
                                    h(Btn, { sm:true, cmd: { type:'workForFaction', faction:f.name, workType, focus:false } },
                                        'Work (bg)'),
                                    h(Btn, { sm:true, cmd: { type:'workForFaction', faction:f.name, workType, focus:true } },
                                        'Work (focus)'),
                                ))
                            ),
                            sec === 'donate' && h('div', null,
                                !f.canDonate && h('div', { style: { color:'#ffd700', fontSize:11, marginBottom:5 } },
                                    'Need ' + donateMinFavor + ' favor. Current: ' + Math.floor(f.favor)),
                                h('div', { className: 'nd-work-row' },
                                    h('input', { className:'nd-input', style:{width:140}, placeholder:'amount ($)',
                                        value: rawDonate,
                                        onChange: e => setDonateAmt(prev => ({ ...prev, [f.name]: e.target.value })) }),
                                    donateNum > 0 && h('span', { style:{ color:'#2d5a2d', fontSize:11 } },
                                        '-> ' + fn(donateRep) + ' rep'),
                                    h(Btn, { disabled: !canDonate,
                                        title: !f.canDonate ? 'Need ' + donateMinFavor + ' favor'
                                            : donateNum <= 0 ? 'Enter an amount'
                                            : donateNum > money ? 'Insufficient funds'
                                            : 'Donate ' + fm(donateNum),
                                        cmd: { type:'donateToFaction', faction:f.name, amount:donateNum },
                                    }, 'Donate'),
                                ),
                            ),
                            sec === 'augs' && h(React.Fragment, null,
                                h(AugTable, {
                                    augs: f.augs, faction: f.name, money,
                                    page: augPage[f.name] ?? 0,
                                    setPage: p => setAugPage(prev => ({ ...prev, [f.name]: p })),
                                    buyable,
                                }),
                            ),
                        ),
                    );
                })
        );
    }

    // ── Tab: Servers ──────────────────────────────────────────────────────────
    function ServersTab({ data }) {
        const { purchasedServers, serverLimit, serverMaxRam, serverCosts, player,
                serversLoaded } = data;
        const money = player?.money ?? 0, servers = purchasedServers ?? [];
        const maxRam = serverMaxRam ?? 2**20, limit = serverLimit ?? 25, costs = serverCosts ?? {};
        const [newName, setNewName] = React.useState('');
        const [newRam,  setNewRam]  = React.useState(8);
        const newCost = costs[newRam] ?? null;
        const canPurchase = !!newName.trim() && newCost != null && money >= newCost;
        const totalMax  = servers.reduce((s, sv) => s + (sv.maxRam  ?? 0), 0);
        const totalUsed = servers.reduce((s, sv) => s + (sv.usedRam ?? 0), 0);
        const ramOpts   = Array.from({ length: 18 }, (_, i) => 2 ** (i + 3));
        if (!serversLoaded) return h('div', { className:'nd-empty' }, 'Loading...');
        return h(React.Fragment, null,
            h(Sec, { title: 'Fleet  ' + servers.length + ' / ' + limit }),
            h(Row, { label: 'Total RAM', val: fr(totalMax) }),
            h(Row, { label: 'Used RAM',  val: fr(totalUsed) }),
            h(Bar, { pct: totalMax > 0 ? totalUsed / totalMax : 0 }),
            servers.length === 0
                ? h('div', { className: 'nd-empty' }, 'No purchased servers')
                : h('table', { className:'nd-tbl', style:{ marginTop:8 } },
                    h('thead', null, h('tr', null,
                        h('th', null, 'Name'), h('th', null, 'RAM'), h('th', null, 'Load'),
                        h('th', null, 'Next'), h('th', null, 'Cost'), h('th', null, ''))),
                    h('tbody', null, servers.map(sv => {
                        const loadPct = sv.maxRam > 0 ? sv.usedRam / sv.maxRam : 0;
                        const canUp = sv.nextRam > sv.maxRam;
                        const canAfford = canUp && sv.upgradeCost != null && money >= sv.upgradeCost;
                        return h('tr', { key: sv.name },
                            h('td', null, sv.name),
                            h('td', null, fr(sv.maxRam)),
                            h('td', { style:{ color: loadPct>.9?'#ff3355':loadPct>.7?'#ffd700':'#3a8a3a' } },
                                fp(loadPct, 0)),
                            h('td', { style:{ color:'#2d5a2d' } }, canUp ? fr(sv.nextRam) : 'max'),
                            h('td', { style:{ color: canAfford?'#33ff33':'#7aac7a' } },
                                canUp && sv.upgradeCost != null ? fm(sv.upgradeCost) : '—'),
                            h('td', null, h('span', { style:{ display:'flex', gap:4 } },
                                canUp && h(Btn, { sm:true, disabled:!canAfford,
                                    cmd:{ type:'upgradeServer', name:sv.name, nextRam:sv.nextRam } }, 'Up'),
                                h('button', { className:'nd-btn nd-btn-sm nd-btn-red',
                                    title: 'Double-click to delete ' + sv.name,
                                    onDoubleClick: () => enqueue({ type:'deleteServer', name:sv.name }),
                                    onClick: () => {},
                                }, 'Del'),
                            )),
                        );
                    }))
                ),
            servers.length < limit && h(React.Fragment, null,
                h(Sec, { title: 'Purchase New Server' }),
                h('div', { className:'nd-row-ac' },
                    h('input', { className:'nd-input', placeholder:'hostname', style:{ width:150 },
                        value:newName, onChange: e => setNewName(e.target.value) }),
                    h('select', { className:'nd-select', value:newRam,
                        onChange: e => setNewRam(Number(e.target.value)) },
                        ramOpts.filter(r => r <= maxRam).map(r =>
                            h('option', { key:r, value:r }, fr(r)))),
                    newCost != null
                        ? h('span', { style:{ color: money>=newCost?'#33ff33':'#ff3355' } }, fm(newCost))
                        : h('span', { className:'nd-dim' }, '—'),
                    h('button', { className:'nd-btn', disabled:!canPurchase,
                        onClick: () => {
                            if (!canPurchase) return;
                            enqueue({ type:'purchaseServer', name:newName.trim(), ram:newRam });
                            setNewName('');
                        },
                    }, 'Purchase'),
                )
            ),
        );
    }

    // ── Tab: Stocks ───────────────────────────────────────────────────────────
    function StocksTab({ data }) {
        const { stocks, player, hasWse, hasTix } = data;
        const money = player?.money ?? 0;
        const [sub,  setSub]  = React.useState('Portfolio');
        const [qtys, setQtys] = React.useState({});
        const setQty = (sym, v) => setQtys(q => ({ ...q, [sym]: v }));
        // stocks is null either because the on-demand script hasn't loaded yet,
        // or because hasTixApiAccess() returned false (no WSE/TIX).
        // Use stocksLoaded flag to distinguish the two cases.
        if (!stocks) return h('div', { className:'nd-empty' },
            data.stocksLoaded === true
                ? 'No TIX API access — buy it from the Shortcuts tab'
                : 'Loading...');
        const { allStocks, has4S, totalVal, totalPnL } = stocks;
        const longPositions  = (allStocks ?? []).filter(s => s.longSh  > 0);
        const shortPositions = (allStocks ?? []).filter(s => s.shortSh > 0);
        const positions = longPositions;
        const FcBar = ({ fc }) => {
            if (fc == null) return h('span', { className:'nd-dim' }, '—');
            const pct = Math.round(fc * 100);
            const clr = fc > 0.55 ? '#33ff33' : fc < 0.45 ? '#ff3355' : '#ffd700';
            return h('span', { style:{ display:'flex', alignItems:'center', gap:5 } },
                h('span', { style:{ display:'inline-block', width:40, height:5,
                    background:'#0b140b', border:'1px solid #173317', borderRadius:2, overflow:'hidden' }},
                    h('span', { style:{ display:'block', width:pct+'%', height:'100%', background:clr } })),
                h('span', { style:{ color:clr, fontSize:11 } }, pct + '%'),
            );
        };
        const Portfolio = () => h(React.Fragment, null,
            h(Sec, { title:'Summary' }),
            h(Row, { label:'Total Value',    val:fm(totalVal), color:'hi' }),
            h(Row, { label:'Unrealized P&L', val:fm(totalPnL), color:totalPnL>=0?'hi':'bad' }),
            h(Sec, { title:'Long Positions (' + longPositions.length + ')' }),
            longPositions.length === 0 ? h('div', { className:'nd-empty' }, 'No long positions')
                : h('table', { className:'nd-tbl' },
                    h('thead', null, h('tr', null,
                        h('th',null,'Sym'), h('th',null,'Shares'), h('th',null,'Avg'),
                        h('th',null,'Price'), h('th',null,'P&L'),
                        has4S && h('th',null,'Forecast'), h('th',null,''))),
                    h('tbody', null, longPositions.map(s => {
                        const pnlPct = s.longCost > 0 ? s.longPnL / s.longCost : 0;
                        return h('tr', { key:s.sym },
                            h('td',null,s.sym), h('td',null,fn(s.longSh)),
                            h('td',null,fm(s.longAvg)), h('td',null,fm(s.price)),
                            h('td', { style:{ color:s.longPnL>=0?'#33ff33':'#ff3355' } },
                                fm(s.longPnL) + ' (' + fp(pnlPct,0) + ')'),
                            has4S && h('td',null, h(FcBar, { fc:s.forecast })),
                            h('td',null, h(Btn, { sm:true, color:'red',
                                cmd:{ type:'sellStock', sym:s.sym, qty:s.longSh } }, 'Sell All')),
                        );
                    }))
                ),
            shortPositions.length > 0 && h(React.Fragment, null,
                h(Sec, { title:'Short Positions (' + shortPositions.length + ')' }),
                h('table', { className:'nd-tbl' },
                    h('thead', null, h('tr', null,
                        h('th',null,'Sym'), h('th',null,'Shares'), h('th',null,'Avg Short'),
                        h('th',null,'Price'), h('th',null,'P&L'),
                        has4S && h('th',null,'Forecast'), h('th',null,''))),
                    h('tbody', null, shortPositions.map(s => {
                        const pnlPct = s.shortAvg > 0 ? s.shortPnL / (s.shortSh * s.shortAvg) : 0;
                        return h('tr', { key:s.sym+'-s' },
                            h('td',null,s.sym), h('td',null,fn(s.shortSh)),
                            h('td',null,fm(s.shortAvg)), h('td',null,fm(s.price)),
                            h('td', { style:{ color:s.shortPnL>=0?'#33ff33':'#ff3355' } },
                                fm(s.shortPnL) + ' (' + fp(pnlPct,0) + ')'),
                            has4S && h('td',null, h(FcBar, { fc:s.forecast })),
                            h('td',null, h(Btn, { sm:true, color:'red',
                                cmd:{ type:'sellShortStock', sym:s.sym, qty:s.shortSh } }, 'Cover')),
                        );
                    }))
                )
            ),
        );
        const Market = () => h(React.Fragment, null,
            !has4S && h('div', { style:{ color:'#2d5a2d', marginBottom:8, fontSize:11 } },
                'Forecast requires 4S Market Data TIX API.'),
            h('table', { className:'nd-tbl' },
                h('thead', null, h('tr', null,
                    h('th',null,'Sym'), h('th',null,'Price'),
                    has4S && h('th',null,'Forecast'),
                    h('th',null,'Position'), h('th',null,'Qty'), h('th',null,'Cost'), h('th',null,''))),
                h('tbody', null, (allStocks ?? []).map(s => {
                    const rawQty = qtys[s.sym] ?? '';
                    const qty = Math.floor(Number(rawQty));
                    const buyCost = qty > 0 ? qty * s.price + 100e3 : 0;
                    const canBuy = qty > 0 && qty <= s.maxSh - s.longSh && buyCost <= money && !isNaN(qty);
                    const positionText = [
                        s.longSh > 0 ? 'L ' + fn(s.longSh) : null,
                        s.shortSh > 0 ? 'S ' + fn(s.shortSh) : null,
                    ].filter(Boolean).join(' / ');
                    const positionColor = s.longSh > 0 || s.shortSh > 0 ? '#7aac7a' : '#1d3d1d';
                    return h('tr', { key:s.sym },
                        h('td',null,s.sym), h('td',null,fm(s.price)),
                        has4S && h('td',null, h(FcBar, { fc:s.forecast })),
                        h('td', { style:{ color:positionColor } },
                            positionText ? positionText :
                            s.longSh > 0 ? fn(s.longSh) : '—'),
                        h('td',null, h('input', { className:'nd-input nd-input-sm', type:'text', placeholder:'qty',
                            value:rawQty, onChange: e => setQty(s.sym, e.target.value) })),
                        h('td', { style:{ color:rawQty?(canBuy?'#33ff33':'#ff3355'):'#1d3d1d', fontSize:11 } },
                            rawQty ? fm(buyCost) : '—'),
                        h('td',null, h('span', { style:{ display:'flex', gap:4 } },
                            h('button', { className:'nd-btn nd-btn-sm', disabled:!canBuy,
                                onClick: () => { if (!canBuy) return; enqueue({ type:'buyStock', sym:s.sym, qty }); setQty(s.sym,''); },
                            }, 'Buy'),
                            s.longSh > 0 && h(Btn, { sm:true, color:'red',
                                cmd:{ type:'sellStock', sym:s.sym, qty:s.longSh } }, 'Sell'),
                            s.shortSh > 0 && h(Btn, { sm:true, color:'red',
                                cmd:{ type:'sellShortStock', sym:s.sym, qty:s.shortSh } }, 'Cover'),
                        )),
                    );
                }))
            )
        );
        return h(React.Fragment, null,
            h(SubTabs, { tabs:['Portfolio','Market'], active:sub, onChange:setSub }),
            sub === 'Portfolio' ? h(Portfolio) : h(Market),
        );
    }

    // ── Tab: Shortcuts ────────────────────────────────────────────────────────
    function ShortcutsTab({ data }) {
        const { homeRamCost, homeCoresCost, homeMaxRam, homeCores,
                pendingAugs, darkwebPrograms, player,
                hasTor, hasWse, hasTix, has4SData, has4SApi, stockCosts,
                shortcutsLoaded,
                infilLocations, infilRunning, infilMode,
                infilBestMoney, infilBestRep,
                infilCompany: activeCompany, infilCity: activeCity,
                infilReward: activeReward, infilFaction: activeFaction } = data;
        const mults = data.bnMults ?? {};
        const money = player?.money ?? 0;
        const sc = {
            wse: stockCosts?.wse ?? 200e6,
            tix: stockCosts?.tix ?? 5e9,
            s4d: stockCosts?.s4d ?? 1e9 * (Number(mults.FourSigmaMarketDataCost) || 1),
            s4a: stockCosts?.s4a ?? 25e9 * (Number(mults.FourSigmaMarketDataApiCost) || 1),
        };
        const loading = !shortcutsLoaded
            ? h('div', { style:{ color:'#2d5a2d', fontSize:11, marginBottom:6 } }, 'Loading...')
            : null;

        // ── Infiltration dropdown state ────────────────────────────────────────
        const [infilCity,    setInfilCity]    = React.useState(activeCity    ?? '');
        const [infilCompany, setInfilCompany] = React.useState(activeCompany ?? '');
        const [infilReward,  setInfilReward]  = React.useState('money');
        const [infilFaction, setInfilFaction] = React.useState('');

        React.useEffect(() => {
            if (infilRunning) {
                if (activeCity    && !infilCity)    setInfilCity(activeCity);
                if (activeCompany && !infilCompany) setInfilCompany(activeCompany);
                // Always sync reward + faction from the running process — these
                // can't be changed while running anyway, and the dropdowns need
                // to reflect the actual launched args (not their default state).
                if (activeReward)  setInfilReward(activeReward);
                if (activeFaction) setInfilFaction(activeFaction);
            } else if (activeCity == null) {
                setInfilCity(''); setInfilCompany('');
            }
        }, [infilRunning, activeCity, activeCompany, activeReward, activeFaction]);

        const locs            = infilLocations ?? [];
        const cities          = [...new Set(locs.map(l => l.city))];
        const companiesInCity = locs.filter(l => l.city === infilCity);
        const selectedLoc     = companiesInCity.find(l => l.name === infilCompany) ?? null;
        const canLaunch       = !infilRunning && !!infilCity && !!infilCompany
            && (infilReward === 'money' || !!infilFaction);

        function diffColor(d) {
            if (d == null) return '#7aac7a';
            if (d >= 57.1) return '#ff3355';
            if (d >= 42.9) return '#ffd700';
            return '#33ff33';
        }

        // Reward summary rows — shown above dropdowns
        const RewardRow = ({ label, loc, valKey, fmt }) => {
            if (!loc) return null;
            const val = loc[valKey];
            return h('div', { className:'nd-row-ac', style:{ fontSize:11 } },
                h('span', { className:'nd-lbl', style:{ width:80, flexShrink:0 } }, label),
                h('span', { className:'nd-hi', style:{ flex:1 } }, fmt(val)),
                h('span', { style:{ color:'#2d5a2d', fontSize:10 } }, loc.name),
                h('span', { style:{ color:'#1d3d1d', fontSize:10 } }, '·'),
                h('span', { style:{ color:'#2d5a2d', fontSize:10 } }, loc.city),
            );
        };

        return h(React.Fragment, null,

            h(Sec, { title:'Home' }),
            loading,
            h('div', { className:'nd-row-ac' },
                h('span', { className:'nd-lbl' },
                    'RAM  ' + fr(homeMaxRam ?? 0) + '  →  ' + fr((homeMaxRam ?? 0) * 2)),
                homeRamCost != null
                    ? h('span', { style:{ color: money>=homeRamCost?'#33ff33':'#ff3355' } }, fm(homeRamCost))
                    : h('span', { className:'nd-dim' }, '...'),
                h(Btn, { disabled: homeRamCost==null||money<homeRamCost, cmd:{ type:'upgradeRam' } }, 'Upgrade'),
            ),
            h('div', { className:'nd-row-ac' },
                h('span', { className:'nd-lbl' },
                    'Cores  ' + (homeCores ?? '?') + '  →  ' + ((homeCores ?? 0) + 1)),
                homeCoresCost != null
                    ? h('span', { style:{ color: money>=homeCoresCost?'#33ff33':'#ff3355' } }, fm(homeCoresCost))
                    : h('span', { className:'nd-dim' }, '...'),
                h(Btn, { disabled: homeCoresCost==null||money<homeCoresCost, cmd:{ type:'upgradeCores' } }, 'Upgrade'),
            ),
            pendingAugs > 0 && h(React.Fragment, null,
                h(Sec, { title:'Augmentations' }),
                h('div', { className:'nd-row-ac' },
                    h('span', { className:'nd-lbl' }, pendingAugs + ' pending — stop batcher first'),
                    h(Btn, { color:'yel', cmd:{ type:'installAugs' } }, 'Install Now'),
                )
            ),
            h(Sec, { title:'Stock Market' }),
            loading,
            ...[
                ['WSE Account',   hasWse,    sc.wse,    200e6,        'purchaseWse',    true],
                ['TIX API',       hasTix,    sc.tix,    5e9,          'purchaseTix',    !!hasWse],
                ['4S Market Data',has4SData, sc.s4d,    1e9,          'purchase4SData', true],
                ['4S TIX API',    has4SApi,  sc.s4a,    25e9,         'purchase4SApi',  !!hasTix],
            ].map(([label, owned, cost, fallback, cmdType, prereq]) =>
                h('div', { key:label, className:'nd-row-ac' },
                    h('span', { className:'nd-lbl', style:{ flex:1 } }, label),
                    owned == null ? h('span', { className:'nd-dim' }, '...')
                        : owned ? h('span', { className:'nd-hi' }, 'Owned')
                        : h(React.Fragment, null,
                            h('span', { style:{ color: (cost??fallback)!=null&&money>=(cost??fallback)?'#33ff33':'#ff3355' } },
                                fm(cost ?? fallback)),
                            h(Btn, { disabled: !prereq || (cost??fallback)==null || money<(cost??fallback),
                                cmd:{ type:cmdType } }, 'Buy'),
                        ),
                )
            ),
            h(Sec, { title:'Darkweb Access' }),
            ...[
                ['TOR Router',    hasTor,    null,      200000,       'purchaseTor',    true],
            ].map(([label, owned, cost, fallback, cmdType, prereq]) =>
                h('div', { key:label, className:'nd-row-ac' },
                    h('span', { className:'nd-lbl', style:{ flex:1 } }, label),
                    owned == null ? h('span', { className:'nd-dim' }, '...')
                        : owned ? h('span', { className:'nd-hi' }, 'Owned')
                        : h(React.Fragment, null,
                            h('span', { style:{ color: (cost??fallback)!=null&&money>=(cost??fallback)?'#33ff33':'#ff3355' } },
                                fm(cost ?? fallback)),
                            h(Btn, { disabled: !prereq || (cost??fallback)==null || money<(cost??fallback),
                                cmd:{ type:cmdType } }, 'Buy'),
                        ),
                )
            ),
            (darkwebPrograms ?? []).filter(p => !p.owned).length > 0 && h(React.Fragment, null,
                h(Sec, { title:'Darkweb Programs' }),
                (darkwebPrograms ?? []).filter(p => !p.owned).map(p =>
                    h('div', { key:p.name, className:'nd-row-ac' },
                        h('span', { className:'nd-lbl', style:{ flex:1 } }, p.name),
                        p.cost!=null && h('span', { style:{ color:money>=p.cost?'#33ff33':'#ff3355' } }, fm(p.cost)),
                        h(Btn, { disabled:!hasTor||p.cost==null||money<p.cost,
                            title:!hasTor?'Requires TOR Router':'',
                            cmd:{ type:'buyProgram', program:p.name } }, 'Buy'),
                    )
                )
            ),

            // ── Infiltration ────────────────────────────────────────────────────
            h(Sec, { title: 'Infiltration' }),
            locs.length === 0
                ? h('div', { style:{ color:'#2d5a2d', fontSize:11 } },
                    shortcutsLoaded ? 'No locations available.' : 'Loading...')
                : h(React.Fragment, null,

                    // Best reward summary — always visible
                    h(RewardRow, { label: 'Best $',   loc: infilBestMoney, valKey: 'sellCash', fmt: fm }),
                    h(RewardRow, { label: 'Best rep', loc: infilBestRep,   valKey: 'tradeRep', fmt: fn }),

                    // City dropdown
                    h('div', { className:'nd-row-ac', style:{ marginTop:6, marginBottom:4 } },
                        h('span', { className:'nd-lbl', style:{ width:54, flexShrink:0 } }, 'City'),
                        h('select', {
                            className: 'nd-select', style: { flex:1 },
                            disabled: infilRunning,
                            value: infilCity,
                            onChange: e => { setInfilCity(e.target.value); setInfilCompany(''); },
                        },
                            h('option', { value:'' }, '— pick city —'),
                            cities.map(c => h('option', { key:c, value:c }, c)),
                        ),
                    ),

                    // Company dropdown — filtered, sorted easiest first, difficulty in label
                    h('div', { className:'nd-row-ac', style:{ marginBottom:4 } },
                        h('span', { className:'nd-lbl', style:{ width:54, flexShrink:0 } }, 'Company'),
                        h('select', {
                            className: 'nd-select', style: { flex:1 },
                            disabled: infilRunning || !infilCity,
                            value: infilCompany,
                            onChange: e => setInfilCompany(e.target.value),
                        },
                            h('option', { value:'' }, infilCity ? '— pick company —' : '— pick city first —'),
                            companiesInCity.map(l => {
                                const d = l.displayDiff;
                                const label = d != null
                                    ? l.name + '  [' + d.toFixed(1) + '/100]'
                                    : l.name;
                                return h('option', { key: l.name, value: l.name }, label);
                            }),
                        ),
                    ),

                    // Selected company: difficulty badge + reward preview
                    selectedLoc && h('div', { style:{ display:'flex', gap:14, fontSize:11,
                            padding:'2px 0 4px', flexWrap:'wrap' } },
                        selectedLoc.displayDiff != null && h('span', null,
                            h('span', { style:{ color:'#2d5a2d' } }, 'Difficulty  '),
                            h('span', { style:{ color: diffColor(selectedLoc.displayDiff) } },
                                selectedLoc.displayDiff.toFixed(1) + '/100'),
                            selectedLoc.displayDiff >= 57.1
                                ? h('span', { style:{ color:'#ff3355' } }, ' — brutal')
                                : selectedLoc.displayDiff >= 42.9
                                ? h('span', { style:{ color:'#ffd700' } }, ' — hard')
                                : h('span', { style:{ color:'#33ff33' } }, ' — ok'),
                        ),
                        selectedLoc.sellCash != null && h('span', null,
                            h('span', { style:{ color:'#2d5a2d' } }, '$  '),
                            h('span', { className:'nd-hi' }, fm(selectedLoc.sellCash)),
                        ),
                        selectedLoc.tradeRep != null && h('span', null,
                            h('span', { style:{ color:'#2d5a2d' } }, 'rep  '),
                            h('span', { style:{ color:'#b8d8b8' } }, fn(selectedLoc.tradeRep)),
                        ),
                    ),

                    // Reward selector
                    h('div', { className: 'nd-row-ac', style: { marginBottom: 4 } },
                        h('span', { className: 'nd-lbl', style: { width: 54, flexShrink: 0 } }, 'Reward'),
                        h('select', {
                            className: 'nd-select',
                            disabled: infilRunning,
                            value: infilReward,
                            onChange: e => {
                                setInfilReward(e.target.value);
                                if (e.target.value === 'money') setInfilFaction('');
                            },
                        },
                            h('option', { value: 'money' }, 'Sell for $'),
                            h('option', { value: 'rep'   }, 'Trade for rep'),
                        ),
                    ),

                    // Faction dropdown — visible only when reward=rep, populated from joined factions
                    infilReward === 'rep' && h('div', { className: 'nd-row-ac', style: { marginBottom: 4 } },
                        h('span', { className: 'nd-lbl', style: { width: 54, flexShrink: 0 } }, 'Faction'),
                        h('select', {
                            className: 'nd-select', style: { flex: 1 },
                            disabled: infilRunning,
                            value: infilFaction,
                            onChange: e => setInfilFaction(e.target.value),
                        },
                            h('option', { value: '' }, '— pick faction —'),
                            (player?.factions ?? []).map(f =>
                                h('option', { key: f, value: f }, f)
                            ),
                        ),
                    ),

                    // Status row + Launch/Stop
                    h('div', { className:'nd-row-ac' },
                        infilRunning
                            ? h(React.Fragment, null,
                                h('span', { className:'nd-hi', style:{ flex:1, fontSize:12 } },
                                    '● Infiltrating' + (infilMode ? '  ·  ' + infilMode : '')),
                                h(Btn, { sm:true, color:'red', cmd:{ type:'killInfil' } }, 'Stop'),
                              )
                            : h(React.Fragment, null,
                                h('span', { style:{ flex:1 } }),
                                h(Btn, {
                                    disabled: !canLaunch,
                                    title: !infilCity ? 'Select a city first'
                                        : !infilCompany ? 'Select a company'
                                        : '',
                                    cmd: { type: 'launchInfil', company: infilCompany, city: infilCity,
                                           reward: infilReward, faction: infilFaction || undefined },
                                }, 'Launch'),
                              ),
                    ),
                ),
        );
    }

    // ── Gang: expandable member rows ─────────────────────────────────────────
    function CorpTab({ data }) {
        const { corpLoaded, corpExists, corpName, state: corpState,
                funds, revenue, expenses, profit,
                public: isPublic, ownershipPct, ownedShares, issuedShares, totalShares,
                sharePrice, dividendRate, fundingRound, offerFunds,
                setupDone, setupPhase, corpLauncherRunning, corpSetupRunning, corpAutopilotRunning,
                divisions, upgrades, economicMode, agriRpReady, exportsSetUp, corpSnapshotFresh } = data;

        if (!corpLoaded) return h('div', { className:'nd-empty' }, 'Loading...');

        const Pill = ({ label, on, warn }) => h('span', {
            className: 'nd-pill' + (on ? ' nd-pill-hi' : warn ? ' nd-pill-warn' : ''),
        }, label);

        const scriptRow = h('div', { className:'nd-row-ac', style:{ marginTop:4 } },
            h('span', { className:'nd-lbl', style:{ minWidth:72 } }, 'Scripts'),
            h(Pill, { label:'corp.js' + (corpLauncherRunning ? ' on' : ' off'), on:corpLauncherRunning }),
            h(Pill, { label:'setup' + (corpSetupRunning ? ' on' : ' off'), on:corpSetupRunning }),
            h(Pill, { label:'autopilot' + (corpAutopilotRunning ? ' on' : ' off'), on:corpAutopilotRunning }),
            corpSnapshotFresh != null && h(Pill, {
                label:'snapshot ' + (corpSnapshotFresh ? 'fresh' : 'stale'),
                on:!!corpSnapshotFresh,
                warn:!corpSnapshotFresh,
            }),
        );

        if (!corpExists) {
            return h(React.Fragment, null,
                h(Sec, { title:'Corporation' }),
                h(Row, { label:'Status', val: corpSetupRunning ? 'Setting up' : 'No corporation yet', color:corpSetupRunning ? 'warn' : undefined }),
                h(Row, { label:'Setup Phase', val: setupPhase != null ? String(setupPhase) : '...' }),
                h(Row, { label:'Setup Done', val: setupDone ? 'Yes' : 'No', color:setupDone ? 'hi' : undefined }),
                scriptRow,
            );
        }

        const divs = divisions ?? [];
        const upgradeRows = [
            ['Wilson Analytics', upgrades?.wilson],
            ['Smart Factories', upgrades?.smartFactories],
            ['Smart Storage', upgrades?.smartStorage],
            ['SalesBots', upgrades?.salesBots],
        ].filter(([, val]) => val != null);

        return h(React.Fragment, null,
            h(Sec, { title:'Corporation' }),
            h(Row, { label:'Name', val: corpName ?? '...', color:'hi' }),
            h(Row, { label:'Status', val: (isPublic ? 'Public' : 'Private') + (corpState ? '  |  ' + corpState : ''), color:isPublic ? 'hi' : 'warn' }),
            h(Row, { label:'Funds', val: fm(funds), color:'hi' }),
            h(Row, { label:'Profit / sec', val: fm(profit), color:profit >= 0 ? 'hi' : 'bad' }),
            h(Row, { label:'Revenue / sec', val: fm(revenue) }),
            h(Row, { label:'Expenses / sec', val: fm(expenses), color:expenses > revenue ? 'bad' : undefined }),

            h(Sec, { title:'Ownership' }),
            h(Row, { label:'Ownership', val: ownershipPct != null ? fp(ownershipPct, 1) : '...' }),
            h(Row, { label:'Owned Shares', val: ownedShares != null ? fn(ownedShares) : '...' }),
            h(Row, { label:'Issued Shares', val: issuedShares != null ? fn(issuedShares) : '...' }),
            h(Row, { label:'Total Shares', val: totalShares != null ? fn(totalShares) : '...' }),
            sharePrice != null && h(Row, { label:'Share Price', val: fm(sharePrice) }),
            h(Row, { label:'Dividend Rate', val: dividendRate != null ? fp(dividendRate, 2) : '...' }),
            offerFunds != null && fundingRound > 0 && !isPublic && h(Row, {
                label:'Investment Offer',
                val:'Round ' + fundingRound + '  |  ' + fm(offerFunds),
                color:'warn',
            }),

            h(Sec, { title:'Automation' }),
            h(Row, { label:'Setup Phase', val: setupPhase != null ? String(setupPhase) : '...' }),
            h(Row, { label:'Setup Done', val: setupDone ? 'Yes' : 'No', color:setupDone ? 'hi' : undefined }),
            economicMode && h(Row, { label:'Mode', val: economicMode }),
            agriRpReady != null && h(Row, { label:'Agri RP Ready', val: agriRpReady ? 'Yes' : 'No', color:agriRpReady ? 'hi' : undefined }),
            exportsSetUp != null && h(Row, { label:'Exports Set Up', val: exportsSetUp ? 'Yes' : 'No', color:exportsSetUp ? 'hi' : undefined }),
            scriptRow,

            upgradeRows.length > 0 && h(React.Fragment, null,
                h(Sec, { title:'Upgrades' }),
                ...upgradeRows.map(([label, val]) => h(Row, { key:label, label, val: fn(val) })),
            ),

            h(Sec, { title:'Divisions (' + divs.length + ')' }),
            divs.length === 0
                ? h('div', { className:'nd-empty' }, 'No divisions')
                : divs.map(div => h(Card, { key:div.name, title:div.name, defaultOpen:divs.length <= 2 },
                    h(Row, { label:'Type', val: div.type ?? '...' }),
                    h(Row, { label:'Cities', val: fn(div.cities ?? 0) }),
                    h(Row, { label:'Employees', val: fn(div.employees ?? 0) }),
                    h(Row, { label:'Research', val: fn(div.rp ?? 0) }),
                    h(Row, { label:'Products', val: fn(div.products ?? 0) }),
                    div.productPipeline && h(Row, { label:'Pipeline', val: div.productPipeline }),
                    div.advertCount != null && h(Row, { label:'AdVerts', val: fn(div.advertCount) }),
                    div.minOfficeSize != null && h(Row, {
                        label:'Office Size',
                        val: div.maxOfficeSize > div.minOfficeSize
                            ? fn(div.minOfficeSize) + '  ->  ' + fn(div.maxOfficeSize)
                            : fn(div.minOfficeSize),
                    }),
                    div.minWarehouseLevel != null && h(Row, {
                        label:'Warehouse',
                        val: div.maxWarehouseLevel > div.minWarehouseLevel
                            ? fn(div.minWarehouseLevel) + '  ->  ' + fn(div.maxWarehouseLevel)
                            : fn(div.minWarehouseLevel),
                    }),
                )),
        );
    }

    function MemberTable({ members, isHacking, ascensionResults }) {
        const [expanded, setExpanded] = React.useState(null);
        const toggle = name => setExpanded(e => e === name ? null : name);
        return h('table', { className: 'nd-tbl' },
            h('thead', null, h('tr', null,
                h('th', null, 'Name'),
                h('th', null, 'Task'),
                h('th', null, isHacking ? 'Hack' : 'Str'),
                h('th', null, 'Cha'),
                h('th', null, 'Asc×'),
                h('th', null, ''))),
            h('tbody', null, members.map(m => {
                const ar = ascensionResults?.[m.name];
                const gains = ar ? ['str','def','dex','agi','cha','hack']
                    .filter(s => (ar[s] ?? 0) > 1.005)
                    .map(s => s + '→×' + ar[s].toFixed(3)) : [];
                const isOpen = expanded === m.name;
                // Shorten task label
                const taskShort = (m.task ?? '—')
                    .replace('Traffick Illegal Arms', 'TIA')
                    .replace('Human Trafficking', 'HT')
                    .replace('Vigilante Justice', 'VJ')
                    .replace('Territory Warfare', 'TW')
                    .replace('Train Combat', 'Train Cbt')
                    .replace('Train Charisma', 'Train Cha');
                return [
                    h('tr', { key: m.name,
                        style: { cursor: 'pointer', background: isOpen ? '#0e1c0e' : undefined },
                        onClick: () => toggle(m.name) },
                        h('td', null,
                            h('span', { style: { color: '#2d5a2d', fontSize: 10, marginRight: 4 } }, isOpen ? '▾' : '▸'),
                            m.name),
                        h('td', { style: { color: '#2d5a2d', fontSize: 11 } }, taskShort),
                        h('td', null, fn(isHacking ? m.hack : m.str)),
                        h('td', { style: { color: (m.cha ?? 0) < 350 ? '#ffd700' : undefined } }, fn(m.cha)),
                        h('td', { style: { color: '#2d5a2d', fontSize: 10 } },
                            fx(isHacking ? m.hackAscMult : m.strAscMult, 2) + ' / ' + fx(m.chaAscMult ?? 1, 2)),
                        h('td', null, ar && h(Btn, { sm: true,
                            title: 'Ascend ' + m.name + '\n' + (gains.length ? gains.join('  ') : 'no gain'),
                            cmd: { type: 'ascendMember', member: m.name },
                            onClick: e => e?.stopPropagation?.(),
                        }, '⬆')),
                    ),
                    isOpen && h('tr', { key: m.name + '-exp' },
                        h('td', { colSpan: 6, style: { background: '#080e08', padding: '6px 10px' } },
                            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px', fontSize: 11 } },
                                [['str', m.str], ['def', m.def], ['dex', m.dex], ['agi', m.agi],
                                 ['hack', m.hack], ['cha', m.cha]].map(([s, v]) =>
                                    h('span', { key: s, style: { color: '#3a6a3a' } },
                                        s + ': ', h('span', { style: { color: '#b8d8b8' } }, fn(v)))
                                ),
                                h('span', { style: { color: '#3a6a3a' } },
                                    'Total×: ', h('span', { style: { color: '#b8d8b8' } },
                                        fx(isHacking ? m.hackTotalMult : m.strTotalMult, 2))),
                                gains.length > 0 && h('span', { style: { color: '#33ff33' } },
                                    'Asc gain: ' + gains.join(' ')),
                            )
                        )
                    ),
                ];
            }))
        );
    }

    // ── Tab: Gang ─────────────────────────────────────────────────────────────
    function GangTab({ data }) {
        const { inGang, gangName, isHacking, territory, power, respect,
                wantedLevel, wantedPenalty, moneyPerSec, respectPerSec, wantedPerSec,
                territoryWarfareEngaged, otherGangs, members, ascensionResults, gangsLoaded,
                canRecruit, nextRecruitAt, maxMembers } = data;

        if (!gangsLoaded) return h('div', { className: 'nd-empty' }, 'Loading...');
        if (!inGang) return h('div', { className: 'nd-empty' },
            'Not in a gang yet. Need karma ≤ -54,000 or BitNode 2.');

        const wantedBad = (wantedPenalty ?? 1) < 0.999;
        const taskCounts = {};
        for (const m of members ?? []) taskCounts[m.task] = (taskCounts[m.task] ?? 0) + 1;

        const terrPct  = territory ?? 0;
        const terrClr  = terrPct >= 0.99 ? '#33ff33' : terrPct >= 0.5 ? '#ffd700' : '#2288ff';

        return h(React.Fragment, null,
            h(Sec, { title: gangName ?? 'Gang' }),
            h(Row, { label: 'Type',       val: isHacking ? 'Hacking' : 'Combat' }),
            (() => {
                const cnt     = members?.length ?? 0;
                const maxM    = data.maxMembers ?? 12;
                const nextAt  = data.nextRecruitAt;
                const canRec  = data.canRecruit;
                if (cnt >= maxM) {
                    return h(Row, { label: 'Members', val: `${cnt} / ${maxM}  ✓ MAX`, color: 'hi' });
                }
                const pct     = nextAt ? Math.min(1, (respect ?? 0) / nextAt) : 1;
                const filled  = Math.round(pct * 20);
                const bar     = '█'.repeat(filled) + '░'.repeat(20 - filled);
                const eta     = nextAt && (respectPerSec ?? 0) > 0
                    ? '  ETA ' + (secs => secs < 60 ? secs.toFixed(0)+'s' : secs < 3600 ? (secs/60).toFixed(1)+'m' : (secs/3600).toFixed(1)+'h')(Math.max(0, nextAt - (respect ?? 0)) / (respectPerSec ?? 1))
                    : '';
                return h(React.Fragment, null,
                    h(Row, { label: 'Members', val: `${cnt} / ${maxM}  ${canRec ? '✓ Can recruit!' : ''}`,
                        color: canRec ? 'hi' : undefined }),
                    h(Row, { label: '  Next recruit',
                        val: `[${bar}] ${(pct*100).toFixed(1)}%  (${fn(respect ?? 0)} / ${fn(nextAt ?? 0)})${eta}`,
                        title: `${fn(nextAt ?? 0)} respect needed to recruit next member` }),
                );
            })(),
            h(Row, { label: 'Income',     val: fm(moneyPerSec ?? 0) + '/s', color: 'hi' }),
            h(Row, { label: 'Respect',    val: fn(respect) + '  (+' + fn(respectPerSec ?? 0) + '/s)' }),
            wantedBad && h(Row, { label: 'Wanted Penalty',
                val: fp(1 - (wantedPenalty ?? 1)) + ' penalty  (+' + (wantedPerSec ?? 0).toFixed(4) + '/s)', color: 'warn' }),

            h(Sec, { title: 'Territory' }),
            h(Row, { label: 'Owned',
                val: fp(terrPct) + (terrPct >= 0.999 ? '  ✓ Complete' : ''),
                color: terrPct >= 0.999 ? 'hi' : undefined }),
            h(Bar, { pct: terrPct, color: terrClr }),
            h(Row, { label: 'Power',       val: fn(power) }),
            h(Row, { label: 'Warfare', val: territoryWarfareEngaged ? 'Active' : 'Off',
                color: territoryWarfareEngaged ? 'warn' : 'dim' }),

            (otherGangs ?? []).length > 0 && h(React.Fragment, null,
                h(Sec, { title: 'Rival Gangs' }),
                h('table', { className: 'nd-tbl' },
                    h('thead', null, h('tr', null,
                        h('th', null, 'Gang'), h('th', null, 'Territory'), h('th', null, 'Power'))),
                    h('tbody', null, (otherGangs ?? []).map(g =>
                        h('tr', { key: g.name },
                            h('td', null, g.name),
                            h('td', null, fp(g.territory ?? 0)),
                            h('td', null, fn(g.power ?? 0)),
                        )
                    ))
                )
            ),

            h(Sec, { title: 'Members (' + (members ?? []).length + ')' }),
            Object.keys(taskCounts).length > 0 && h('div', {
                style: { fontSize: 11, color: '#7aac7a', marginBottom: 6, paddingLeft: 2 } },
                Object.entries(taskCounts).map(([task, n]) => n + '× ' + task).join('  ·  ')
            ),
            h(MemberTable, { members: members ?? [], isHacking, ascensionResults }),
        );
    }

    // ── Root ──────────────────────────────────────────────────────────────────
    // ── Aug helpers ──────────────────────────────────────────────────────────
    const MULT_LABELS = {
        hacking:'Hack', hacking_exp:'Hack Exp', hacking_speed:'Hack Speed',
        hacking_money:'Hack $', hacking_grow:'Grow', hacking_chance:'Hack Chance',
        faction_rep:'Faction Rep', company_rep:'Company Rep',
        crime_money:'Crime $', crime_success:'Crime Success', work_money:'Work $',
        strength:'Str', defense:'Def', dexterity:'Dex', agility:'Agi', charisma:'Cha',
        strength_exp:'Str Exp', defense_exp:'Def Exp', agility_exp:'Agi Exp',
        hacknet_node_money:'Hacknet $',
        bladeburner_max_stamina:'BB Stamina', bladeburner_success_chance:'BB Success',
    };
    function augTooltip(a) {
        const mults = Object.entries(a.stats ?? {})
            .filter(([k, v]) => MULT_LABELS[k] && Math.abs(v - 1) > 0.0001)
            .map(([k, v]) => MULT_LABELS[k] + ': ×' + v.toFixed(3))
            .join('\n');
        const prereq = (a.prereq ?? []).length > 0
            ? '\nPrereqs: ' + a.prereq.join(', ') : '';
        return (mults || '(no stat bonuses)') + prereq;
    }

    // ── Tab: Sleeves ─────────────────────────────────────────────────────────

    function SleevesTab({ data }) {
        const { sleeves, sleeveOverrides, sleevesUnlocked, player } = data;
        const joinedFactions = player?.factions ?? [];

        // Per-sleeve override editor state: { [index]: draftSpec | null }
        const [editing, setEditing] = React.useState({});

        if (!sleevesUnlocked)
            return h('div', { className: 'nd-empty' }, 'Sleeves not available (requires SF10 or BN10).');
        if (!sleeves || !sleeves.length)
            return h('div', { className: 'nd-empty' }, 'Loading sleeve data...');

        const overrides = sleeveOverrides ?? {};

        // Quick-assign options shown in the override selector
        const QUICK_TASKS = [
            { label: 'Shock Recovery',  spec: { type: 'RECOVERY' } },
            { label: 'Synchronize',     spec: { type: 'SYNCHRO'  } },
            { label: 'Homicide',        spec: { type: 'CRIME',   crimeType: 'Homicide' } },
            { label: 'Mug',             spec: { type: 'CRIME',   crimeType: 'Mug Someone' } },
            { label: 'Heist',           spec: { type: 'CRIME',   crimeType: 'Heist' } },
            { label: 'Assassination',   spec: { type: 'CRIME',   crimeType: 'Assassination' } },
            { label: 'Trafficking',     spec: { type: 'CRIME',   crimeType: 'Traffick Illegal Arms' } },
            { label: 'Human Trafficking', spec: { type: 'CRIME', crimeType: 'Human Trafficking' } },
            { label: 'Terrorism',       spec: { type: 'CRIME',   crimeType: 'Terrorism' } },
        ];

        const toggleEdit = (i) =>
            setEditing(e => ({ ...e, [i]: e[i] == null ? 'RECOVERY' : null }));

        const applyQuick = (i, spec) => {
            enqueue({ type: 'setSleeveTask', index: i, task: spec });
            setEditing(e => ({ ...e, [i]: null }));
        };

        return h(React.Fragment, null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                h(Sec, { title: 'Sleeves (' + sleeves.length + ')' }),
                Object.keys(overrides).length > 0 && h(Btn, {
                    sm: true, color: 'red',
                    cmd: { type: 'clearAllSleeveOverrides' },
                    title: 'Remove all overrides — sleeves return to auto-management',
                }, 'Clear All Overrides'),
            ),
            sleeves.map(sv => {
                const ov  = overrides[String(sv.index)];
                const isEditing = editing[sv.index] != null;

                const ovLabel = ov
                    ? (ov.type === 'CRIME'   ? ov.crimeType
                    :  ov.type === 'FACTION' ? ov.factionName + ' / ' + ov.workType
                    :  ov.type === 'RECOVERY' ? 'Shock Recovery'
                    :  ov.type === 'SYNCHRO'  ? 'Synchronize'
                    :  ov.type)
                    : null;

                return h('div', { key: sv.index, className: 'nd-card' },
                    // Header row
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                        h('span', { className: 'nd-card-title', style: { marginBottom: 0 } },
                            'Sleeve ' + sv.index),
                        ov && h('span', { className: 'nd-pill nd-pill-hi', title: 'Override active' },
                            ovLabel),
                        h('span', { style: { flex: 1 } }),
                        ov && h(Btn, { sm: true, color: 'red',
                            cmd: { type: 'clearSleeveOverride', index: sv.index },
                            title: 'Clear this override',
                        }, 'Clear'),
                        h(Btn, { sm: true,
                            onClick: () => toggleEdit(sv.index),
                        }, isEditing ? 'Cancel' : 'Override'),
                    ),

                    // Stats row
                    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 } },
                        h('span', { className: 'nd-dim', style: { fontSize: 11 } },
                            'Task: ' + sv.task),
                        h('span', { style: { color: sv.shock > 50 ? '#ff3355' : sv.shock > 20 ? '#ffd700' : '#2d5a2d', fontSize: 11 } },
                            'Shock ' + sv.shock.toFixed(1) + '%'),
                        h('span', { style: { color: sv.sync < 50 ? '#ff3355' : sv.sync < 90 ? '#ffd700' : '#33ff33', fontSize: 11 } },
                            'Sync ' + sv.sync.toFixed(1) + '%'),
                    ),
                    h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 2 } },
                        [['str', sv.str], ['def', sv.def], ['dex', sv.dex],
                         ['agi', sv.agi], ['hack', sv.hack], ['cha', sv.cha]].map(([stat, val]) =>
                            h('span', { key: stat, style: { color: '#2d5a2d', fontSize: 11 } },
                                stat + ':' + fn(val))
                        ),
                    ),

                    // Quick-assign panel — dropdown layout
                    isEditing && h('div', { style: {
                        marginTop: 8, padding: '7px 0 2px',
                        borderTop: '1px solid #173317',
                        display: 'flex', flexDirection: 'column', gap: 6,
                    }},
                        // Instant tasks (no config needed)
                        h('div', { style: { display: 'flex', gap: 5 } },
                            h('span', { style: { color: '#3a6a3a', fontSize: 10, alignSelf: 'center', width: 55 } }, 'Quick:'),
                            h('button', { className: 'nd-btn nd-btn-sm', onClick: () => applyQuick(sv.index, { type: 'RECOVERY' }) }, 'Shock Recovery'),
                            h('button', { className: 'nd-btn nd-btn-sm', onClick: () => applyQuick(sv.index, { type: 'SYNCHRO'  }) }, 'Synchronize'),
                        ),
                        // Crime dropdown
                        h('div', { style: { display: 'flex', gap: 5, alignItems: 'center' } },
                            h('span', { style: { color: '#3a6a3a', fontSize: 10, width: 55 } }, 'Crime:'),
                            h('select', { className: 'nd-select', style: { flex: 1 },
                                defaultValue: '',
                                onChange: e => { if (e.target.value) applyQuick(sv.index, { type: 'CRIME', crimeType: e.target.value }); e.target.value = ''; }},
                                h('option', { value: '' }, '— pick crime —'),
                                ['Homicide','Mug Someone','Heist','Assassination',
                                 'Traffick Illegal Arms','Human Trafficking','Terrorism',
                                 'Grand Theft Auto','Kidnap','Larceny','Rob Store','Shoplift',
                                 'Bond Forgery','Deal Drugs','Fraud & Counterfeiting',
                                 'Run a Con','Strongarm Civilians','Threaten & Blackmail',
                                ].map(c => h('option', { key: c, value: c }, c))
                            ),
                        ),
                        // Faction dropdown
                        joinedFactions.length > 0 && h('div', { style: { display: 'flex', gap: 5, alignItems: 'center' } },
                            h('span', { style: { color: '#3a6a3a', fontSize: 10, width: 55 } }, 'Faction:'),
                            h('select', { className: 'nd-select',
                                value: editing[sv.index + '-faction'] ?? '',
                                onChange: e => setEditing(ed => ({ ...ed, [sv.index + '-faction']: e.target.value || null })) },
                                h('option', { value: '' }, '— pick faction —'),
                                joinedFactions.map(f => h('option', { key: f, value: f }, f))
                            ),
                            editing[sv.index + '-faction'] && ['field','security','hacking'].map(wt =>
                                h('button', { key: wt, className: 'nd-btn nd-btn-sm',
                                    onClick: () => applyQuick(sv.index, { type: 'FACTION',
                                        factionName: editing[sv.index + '-faction'], workType: wt }) }, wt)
                            ),
                        ),
                    ),
                );
            })
        );
    }

    const STATUS_TABS = ['Player','HWGW','Darknet','Servers','Stocks'];
    const MGMT_TABS   = ['Corp','Gang','Factions','Sleeves','Shortcuts'];
    const TABS = [...STATUS_TABS, ...MGMT_TABS];
    const TAB_MAP = { HWGW:HwgwTab, Darknet:DarknetTab, Player:PlayerTab,
        Corp:CorpTab, Gang:GangTab, Factions:FactionsTab, Servers:ServersTab, Stocks:StocksTab,
        Sleeves:SleevesTab, Shortcuts:ShortcutsTab };

    function Dashboard() {
        const [data, setData]   = React.useState({});
        const [tab,  setTabSt]  = React.useState('HWGW');
        const [mini, setMini]   = React.useState(false);
        const [pos,  setPos]    = React.useState({ x: Math.max(10, window.innerWidth - 850), y: 20 });
        const drag = React.useRef({ on:false, ox:0, oy:0 });
        const [, setTick] = React.useState(0);

        const setTab = (t) => { currentTab = t; setTabSt(t); enqueue({ type:'setActiveTab', tab:t }); };

        React.useEffect(() => { pushData = (d) => setData(d); return () => { pushData = null; }; }, []);
        React.useEffect(() => { const id = setInterval(() => setTick(t => t+1), 1000); return () => clearInterval(id); }, []);
        React.useEffect(() => {
            const onMove = (e) => { if (!drag.current.on) return; setPos({ x:e.clientX-drag.current.ox, y:e.clientY-drag.current.oy }); };
            const onUp   = ()  => { drag.current.on = false; };
            doc.addEventListener('mousemove', onMove); doc.addEventListener('mouseup', onUp);
            return () => { doc.removeEventListener('mousemove', onMove); doc.removeEventListener('mouseup', onUp); };
        }, []);

        const onHeaderDown = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            drag.current = { on:true, ox:e.clientX-pos.x, oy:e.clientY-pos.y };
            e.preventDefault();
        };

        const ActiveTab = TAB_MAP[tab], pendingAugs = data.pendingAugs ?? 0;

        return h('div', { className:'nd', style:{ left:pos.x+'px', top:pos.y+'px' } },
            h('div', { className:'nd-header', onMouseDown:onHeaderDown },
                h('span', { className:'nd-logo' }, '#'),
                h('span', { className:'nd-title' }, 'NEXUS'),
                h('span', { style:{ flex:1 } }),
                pendingAugs > 0 && h('span', { className:'nd-pill nd-pill-warn', style:{ marginRight:4 } },
                    pendingAugs + ' aug' + (pendingAugs>1?'s':'')),
                h('span', { className:'nd-clock', style:{ marginRight:6 } }, new Date().toLocaleTimeString()),
                h('button', { className:'nd-btn nd-hbtn', onClick:() => setMini(m => !m) }, mini?'v':'^'),
                h('button', { className:'nd-btn nd-hbtn nd-close', onClick:() => enqueue({ type:'exit' }) }, 'X'),
            ),
            !mini && h(React.Fragment, null,
                h('div', { className:'nd-tabs' },
                    STATUS_TABS.map(t => h('button', {
                        key:t, className:'nd-tab' + (tab===t?' nd-tab-on':''), onClick:() => setTab(t),
                    }, t)),
                    h('span', { className:'nd-tab-div' }),
                    MGMT_TABS.map(t => h('button', {
                        key:t, className:'nd-tab nd-tab-mgmt' + (tab===t?' nd-tab-on':''), onClick:() => setTab(t),
                    }, t))
                ),
                h(NotifBar, { data }),
                h('div', { className:'nd-body' },
                    ActiveTab
                        ? h(ErrBound, null, h(ActiveTab, { data }))
                        : h('div', { className:'nd-empty' }, '...')
                )
            )
        );
    }

    RDom.render(h(Dashboard), mountEl);

    // ── Main loop ─────────────────────────────────────────────────────────────
    const port = ns.getPortHandle(CMD_PORT);

    while (true) {
        while (cmdQueue.length > 0) {
            const cmd = cmdQueue.shift();
            if (cmd.type === 'exit') { ns.exit(); return; }
            if (!port.tryWrite(JSON.stringify(cmd)))
                ns.print('WARN: port full, dropping: ' + cmd.type);
        }

        // Launch the companion script for the current tab (on-demand tabs only).
        // Each script self-exits when the tab changes away — one script runs at a time.
        const onDemandScript = ON_DEMAND_TABS[currentTab];
        if (onDemandScript) {
            // Write ACTIVE_TAB_FILE directly here so the companion reads the correct tab
            // name the moment it starts. If we rely solely on the port→dashboard-data.js
            // path, the companion can launch, read the stale old-tab value, and self-exit
            // before dashboard-data.js has processed the setActiveTab command.
            ns.write('/Temp/dashboard-active-tab.txt', currentTab, 'w');
            const resolved = resolveScript(onDemandScript);
            if (!ns.isRunning(resolved, 'home')) {
                const pid = ns.run(resolved);
                if (!pid) ns.print(`WARN: failed to launch ${resolved} — file missing or insufficient RAM?`);
            }
        }

        // Merge all data files: always-on base + whichever on-demand file is fresh
        try {
            const raw  = ns.read(DATA_FILE);
            const rawF = ns.read(FACTIONS_FILE);
            const rawS = ns.read(SHORTCUTS_FILE);
            const rawR = ns.read(SERVERS_FILE);
            const rawT = ns.read(STOCKS_FILE);
            const rawC = ns.read(CORP_FILE);
            const rawG = ns.read(GANGS_FILE);
            const rawSl = ns.read(SLEEVES_FILE);
            const base  = raw   && raw   !== '' ? JSON.parse(raw)   : {};
            const facs  = rawF  && rawF  !== '' ? JSON.parse(rawF)  : {};
            const shcut = rawS  && rawS  !== '' ? JSON.parse(rawS)  : {};
            const srvs  = rawR  && rawR  !== '' ? JSON.parse(rawR)  : {};
            const stks  = rawT  && rawT  !== '' ? JSON.parse(rawT)  : {};
            const corp  = rawC  && rawC  !== '' ? JSON.parse(rawC)  : {};
            const gangs = rawG  && rawG  !== '' ? JSON.parse(rawG)  : {};
            const slvs  = rawSl && rawSl !== '' ? JSON.parse(rawSl) : {};
            if (pushData) pushData({ ...base, ...facs, ...shcut, ...srvs, ...stks, ...corp, ...gangs, ...slvs });
        } catch (e) { ns.print('Data parse error: ' + (e?.message ?? e)); }

        await ns.sleep(1000);
    }
}
