const SETUP_PHASE_FILE = '/corp-setup-phase.txt';
const SETUP_DONE_FLAG = '/corp-setup-done.txt';
const SETUP_ROUTE_FILE = '/corp-setup-route.txt';
const DIV_AGRI = 'Agriculture';
const DIV_CHEM = 'Chemical';
const DIV_TOBACCO = 'Tobacco';
const HQ_CITY = 'Sector-12';

function resolvePath(ns, key, fallbackFile) {
    try {
        const p = JSON.parse(ns.read('/script-paths.json') || '{}');
        if (typeof p[key] === 'string' && p[key].length > 0) return p[key];
    } catch { }
    return `corp/${fallbackFile}`;
}

function getRound1Script(ns) { return resolvePath(ns, 'corp-round1', 'corp-round1.js'); }
function getRound2BuildoutScript(ns) { return resolvePath(ns, 'corp-round2-buildout', 'corp-round2-buildout.js'); }
function getRound2WaitScript(ns) { return resolvePath(ns, 'corp-round2-wait', 'corp-round2-wait.js'); }
function getRound3Script(ns) { return resolvePath(ns, 'corp-round3', 'corp-round3.js'); }
function getAutopilotScript(ns) { return resolvePath(ns, 'corp-autopilot', 'corp-autopilot.js'); }

function readPhase(ns) {
    try {
        if (!ns.fileExists(SETUP_PHASE_FILE, 'home')) return 0;
        const raw = String(ns.read(SETUP_PHASE_FILE) ?? '').trim();
        const value = Number(raw);
        return Number.isFinite(value) ? value : 0;
    } catch {
        return 0;
    }
}

function isSetupDone(ns) {
    try {
        return String(ns.read(SETUP_DONE_FLAG) ?? '').trim().toLowerCase() === 'true';
    } catch {
        return false;
    }
}

function resetSetupState(ns) {
    try { ns.write(SETUP_PHASE_FILE, '0', 'w'); } catch { }
    try { ns.rm(SETUP_DONE_FLAG, 'home'); } catch { }
    try { ns.rm(SETUP_ROUTE_FILE, 'home'); } catch { }
}

function getTargetForPhase(ns, phase, done) {
    if (done || phase >= 10) return getAutopilotScript(ns);
    if (phase <= 2) return getRound1Script(ns);
    if (phase <= 3) return getRound2BuildoutScript(ns);
    if (phase <= 4) return getRound2WaitScript(ns);
    return getRound3Script(ns);
}

function hasDivision(ns, name) {
    try {
        return new Set(ns.corporation.getCorporation().divisions ?? []).has(name);
    } catch {
        return false;
    }
}

function isRound2HighBudgetShellReady(ns) {
    try {
        const c = ns.corporation;
        if (!c.hasUnlock('Export')) return false;
        if (!hasDivision(ns, DIV_CHEM) || !hasDivision(ns, DIV_TOBACCO)) return false;
        const chemWh = c.getWarehouse(DIV_CHEM, HQ_CITY);
        const chemOffice = c.getOffice(DIV_CHEM, HQ_CITY);
        const tobWh = c.getWarehouse(DIV_TOBACCO, HQ_CITY);
        const tobOffice = c.getOffice(DIV_TOBACCO, HQ_CITY);
        const tobProducts = c.getDivision(DIV_TOBACCO).products ?? [];
        return (chemWh.level ?? 0) >= 1
            && (chemOffice.size ?? 0) >= 3
            && (chemOffice.numEmployees ?? 0) >= 3
            && (tobWh.level ?? 0) >= 1
            && (tobOffice.size ?? 0) >= 6
            && (tobOffice.numEmployees ?? 0) >= 6
            && tobProducts.length > 0;
    } catch {
        return false;
    }
}

function inferTargetFromCorpState(ns, phase, done) {
    const fallback = getTargetForPhase(ns, phase, done);
    const c = ns.corporation;
    const info = {
        target: fallback,
        reason: `saved phase fallback (${phase})`,
        savedPhase: phase,
        offerRound: null,
        hasCorp: false,
        divisions: [],
        public: false,
        warehouseApi: false,
        officeApi: false,
        exportUnlock: false,
    };

    try {
        info.hasCorp = c?.hasCorporation?.() ?? false;
    } catch (error) {
        info.reason = `corp API error while checking corporation: ${error?.message ?? error}`;
        return info;
    }
    if (!info.hasCorp) {
        info.target = getRound1Script(ns);
        info.reason = 'no corporation';
        return info;
    }

    let corp = null;
    try {
        corp = c.getCorporation();
        info.public = !!corp?.public;
        info.divisions = Array.isArray(corp?.divisions) ? corp.divisions.slice() : [];
    } catch (error) {
        info.reason = `corp API error while reading corporation state: ${error?.message ?? error}`;
        return info;
    }

    if (info.public || done || phase >= 10) {
        info.target = getAutopilotScript(ns);
        info.reason = info.public ? 'corporation is public' : (done ? 'setup marked done' : `saved phase ${phase} >= 10`);
        return info;
    }

    let hasWarehouseApi = false;
    let hasOfficeApi = false;
    let hasExport = false;
    try {
        hasWarehouseApi = c.hasUnlock('Warehouse API');
        hasOfficeApi = c.hasUnlock('Office API');
        hasExport = c.hasUnlock('Export');
        info.warehouseApi = hasWarehouseApi;
        info.officeApi = hasOfficeApi;
        info.exportUnlock = hasExport;
    } catch (error) {
        info.reason = `corp API error while reading unlocks: ${error?.message ?? error}`;
        return info;
    }

    const hasAgri = info.divisions.includes(DIV_AGRI);
    const hasChem = info.divisions.includes(DIV_CHEM);
    const hasTob = info.divisions.includes(DIV_TOBACCO);
    const hasLatePrivateSignals = hasChem || hasTob || hasExport;

    try {
        const rawRound = Number(c.getInvestmentOffer().round ?? NaN);
        info.offerRound = Number.isFinite(rawRound) ? rawRound : null;
    } catch (error) {
        info.reason = `investment offer read failed: ${error?.message ?? error}`;
    }

    if (Number.isFinite(info.offerRound)) {
        if (info.offerRound <= 2 && phase >= 5 && hasLatePrivateSignals) {
            info.target = ROUND3_SCRIPT;
            info.reason = `investment round ${info.offerRound} conflicts with saved late phase ${phase}; using the phase-5+ worker`;
            return info;
        }
        if (info.offerRound <= 1 && hasLatePrivateSignals) {
            if (phase >= 4) info.target = ROUND2_WAIT_SCRIPT;
            else info.target = isRound2HighBudgetShellReady(ns) ? ROUND2_WAIT_SCRIPT : ROUND2_BUILDOUT_SCRIPT;
            info.reason = `investment round ${info.offerRound} conflicts with late private-stage structure`;
            return info;
        }
        if (info.offerRound <= 1) {
            info.target = ROUND1_SCRIPT;
            info.reason = `investment round ${info.offerRound}`;
            return info;
        }
        if (info.offerRound <= 2) {
            info.target = isRound2HighBudgetShellReady(ns) ? ROUND2_WAIT_SCRIPT : ROUND2_BUILDOUT_SCRIPT;
            info.reason = info.target === ROUND2_WAIT_SCRIPT
                ? 'investment round 2 shell ready'
                : 'investment round 2 shell incomplete';
            return info;
        }
        info.target = ROUND3_SCRIPT;
        info.reason = `investment round ${info.offerRound}`;
        return info;
    }

    if (phase >= 5) {
        info.target = ROUND3_SCRIPT;
        info.reason = `${info.reason}; using saved late phase ${phase}`;
        return info;
    }
    if (hasChem || hasTob || hasExport) {
        info.target = isRound2HighBudgetShellReady(ns) ? ROUND2_WAIT_SCRIPT : ROUND2_BUILDOUT_SCRIPT;
        info.reason = `${info.reason}; inferred late private-stage corp from divisions/unlocks`;
        return info;
    }
    if (!hasWarehouseApi || !hasOfficeApi) {
        info.target = ROUND1_SCRIPT;
        info.reason = 'missing Warehouse API or Office API';
        return info;
    }
    if (!hasAgri) {
        info.target = ROUND1_SCRIPT;
        info.reason = 'Agriculture division missing';
        return info;
    }
    return info;
}

function shouldRetryInference(info, phase, done) {
    if (!info?.hasCorp || info.public || done || phase <= 0) return false;
    if (info.target !== ROUND1_SCRIPT) return false;
    return info.reason === 'investment round 1'
        || info.reason === 'Agriculture division missing'
        || info.reason === 'missing Warehouse API or Office API'
        || (!Number.isFinite(info.offerRound) && (info.divisions?.length ?? 0) === 0);
}

function getTargetPriority(target) {
    if (target === AUTOPILOT_SCRIPT) return 5;
    if (target === ROUND3_SCRIPT) return 4;
    if (target === ROUND2_WAIT_SCRIPT) return 3;
    if (target === ROUND2_BUILDOUT_SCRIPT) return 2;
    return 1;
}

function normalizeScriptPath(path) {
    const raw = String(path ?? '').trim();
    if (!raw) return '';
    return raw.startsWith('/') ? raw.slice(1) : raw;
}

function isRunning(ns, target) {
    try {
        const normalized = normalizeScriptPath(target);
        return ns.ps('home').some((proc) => normalizeScriptPath(proc.filename) === normalized);
    } catch {
        return false;
    }
}

export async function main(ns) {
    function getLauncherSnapshot(label = '') {
        const parts = [];
        if (label) parts.push(`label=${label}`);
        parts.push(`script=${ns.getScriptName()}`);
        parts.push(`args=${JSON.stringify(ns.args)}`);
        parts.push(`savedPhase=${readPhase(ns)}`);
        parts.push(`done=${isSetupDone(ns) ? 'true' : 'false'}`);
        try {
            const hasCorp = ns.corporation?.hasCorporation?.() ?? false;
            parts.push(`hasCorp=${hasCorp ? 'yes' : 'no'}`);
            if (hasCorp) {
                const corp = ns.corporation.getCorporation();
                const divs = Array.isArray(corp?.divisions) ? corp.divisions : [];
                parts.push(`public=${corp?.public ? 'yes' : 'no'}`);
                parts.push(`round=${Number(ns.corporation.getInvestmentOffer().round ?? NaN)}`);
                parts.push(`divisions=${divs.length ? divs.join('/') : 'none'}`);
                parts.push(`funds=${Number(corp?.funds ?? 0)}`);
            }
        } catch (error) {
            parts.push(`corpErr=${error?.message ?? error}`);
        }
        return parts.join(' | ');
    }

    function traceLauncher(message) {
        ns.tprint(message);
    }

    function getLaunchDiagnostics(target) {
        const normalized = normalizeScriptPath(target);
        const parts = [];
        try {
            parts.push(`exists=${ns.fileExists(target, 'home') ? 'yes' : 'no'}`);
        } catch (error) {
            parts.push(`existsErr=${error?.message ?? error}`);
        }
        try {
            parts.push(`scriptRam=${ns.getScriptRam(target, 'home')}`);
        } catch (error) {
            parts.push(`scriptRamErr=${error?.message ?? error}`);
        }
        try {
            const maxRam = Number(ns.getServerMaxRam('home') ?? 0);
            const usedRam = Number(ns.getServerUsedRam('home') ?? 0);
            parts.push(`homeRamFree=${Math.max(0, maxRam - usedRam)}`);
            parts.push(`homeRamUsed=${usedRam}`);
            parts.push(`homeRamMax=${maxRam}`);
        } catch (error) {
            parts.push(`homeRamErr=${error?.message ?? error}`);
        }
        try {
            const matches = ns.ps('home')
                .filter((proc) => normalizeScriptPath(proc.filename) === normalized)
                .map((proc) => `${proc.filename}#${proc.pid}`);
            parts.push(`running=${matches.length ? matches.join(',') : 'none'}`);
        } catch (error) {
            parts.push(`runningErr=${error?.message ?? error}`);
        }
        return parts.join(' | ');
    }

    function reportLauncherFatal(stage, error) {
        const lines = String(error?.stack ?? error?.message ?? error).split(/\r?\n/).filter(Boolean);
        const headline = lines.shift() ?? 'Unknown error';
        traceLauncher(`ERROR: Launcher fatal ${stage} - ${headline}`);
        for (const line of lines.slice(0, 6)) traceLauncher(`ERROR: ${line}`);
        traceLauncher(`ERROR: Launcher snapshot - ${getLauncherSnapshot(stage)}`);
    }

    traceLauncher(`INFO: Launcher startup - ${getLauncherSnapshot('entry')}`);

    try {
        const hasCorp = (() => {
            try { return ns.corporation?.hasCorporation?.() ?? false; } catch { return false; }
        })();
        if (!hasCorp) resetSetupState(ns);

        const phase = readPhase(ns);
        const done = isSetupDone(ns);
        let inference = inferTargetFromCorpState(ns, phase, done);
        let bestInference = inference;
        for (let attempt = 0; attempt < 12 && shouldRetryInference(inference, phase, done); attempt++) {
            await ns.sleep(500);
            inference = inferTargetFromCorpState(ns, phase, done);
            if (getTargetPriority(inference.target) >= getTargetPriority(bestInference.target)) {
                bestInference = inference;
            }
            if (!shouldRetryInference(inference, phase, done)) break;
        }
        inference = bestInference;
        const target = inference.target;
        const offerRoundText = Number.isFinite(inference.offerRound) ? `, offer round ${inference.offerRound}` : '';
        const earlyDiag = target === ROUND1_SCRIPT && inference.hasCorp
            ? `, divisions ${inference.divisions.length ? inference.divisions.join('/') : 'none'}, export ${inference.exportUnlock ? 'yes' : 'no'}, warehouseAPI ${inference.warehouseApi ? 'yes' : 'no'}, officeAPI ${inference.officeApi ? 'yes' : 'no'}`
            : '';

        traceLauncher(
            `INFO: Launcher resolved target ${target}. Saved phase ${phase}${offerRoundText}${earlyDiag}; reason: ${inference.reason}.`,
        );

        if (isRunning(ns, target)) {
            ns.tprint(`INFO: Corporation orchestrator found ${target} already running. Saved phase ${phase}${offerRoundText}${earlyDiag}; reason: ${inference.reason}.`);
            return;
        }

        const pid = ns.run(target, 1, ...ns.args);
        if (pid === 0) {
            ns.tprint(
                `ERROR: Failed to launch ${target}. Saved phase ${phase}${offerRoundText}${earlyDiag}; ` +
                `reason: ${inference.reason}. ${getLaunchDiagnostics(target)}`,
            );
        } else {
            ns.tprint(`INFO: Corporation orchestrator launched ${target}. Saved phase ${phase}${offerRoundText}${earlyDiag}; reason: ${inference.reason}.`);
        }
    } catch (error) {
        reportLauncherFatal('main', error);
        throw error;
    }
}
