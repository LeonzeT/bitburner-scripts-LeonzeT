const CITIES = ['Aevum', 'Chongqing', 'Sector-12', 'New Tokyo', 'Ishima', 'Volhaven'];

const CORP_TEA_COST = 500e3;
const CORP_MORALE_PARTY_SPEND_MIN = 100e3;
const CORP_MORALE_PARTY_SPEND_MAX = 250e3;
const CORP_MORALE_UPKEEP_MIN_FUNDS = 50e6;
const CORP_MORALE_UPKEEP_RESERVE_SECS = 60;
const CORP_MORALE_THRESHOLD = 98;
const CORP_ENERGY_THRESHOLD = 98;
const CORP_MORALE_ACTION_COOLDOWN_MS = 30_000;
const CORP_SPIKE_ENERGY_THRESHOLD = 45;
const CORP_SPIKE_MORALE_THRESHOLD = 55;

const LOG_FILE = '/Temp/corp-workers.log.txt';
const STATE_FILE = '/Temp/corp-morale-state.txt';
const SNAPSHOT_FILE = '/Temp/corp-morale-last.txt';

function parseOptions(args) {
    const opts = {
        phase: 0,
        source: '',
        spike: false,
        divs: [],
    };
    for (let i = 0; i < args.length; i++) {
        const arg = String(args[i]);
        if (arg === '--phase' && i + 1 < args.length) {
            opts.phase = Number(args[++i]) || 0;
        } else if (arg === '--source' && i + 1 < args.length) {
            opts.source = String(args[++i]);
        } else if (arg === '--spike') {
            opts.spike = true;
        } else if (arg === '--div' && i + 1 < args.length) {
            opts.divs.push(String(args[++i]));
        }
    }
    return opts;
}

function appendWorkerLog(ns, worker, message) {
    try {
        const stamp = new Date().toISOString();
        ns.write(LOG_FILE, `${stamp} [${worker}] ${message}\n`, 'a');
    } catch { }
}

function readJson(ns, path, fallback) {
    try {
        const raw = String(ns.read(path) ?? '').trim();
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(ns, path, payload) {
    try {
        ns.write(path, JSON.stringify(payload), 'w');
    } catch { }
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getOfficeSpendKey(div, city) {
    return `${div}::${city}`;
}

function getMoraleUpkeepFloor(c) {
    const corp = c.getCorporation();
    const funds = Math.max(0, Number(corp?.funds ?? 0));
    const revenue = Math.max(0, Number(corp?.revenue ?? 0));
    const expenses = Math.max(0, Number(corp?.expenses ?? 0));
    const profit = revenue - expenses;
    const raw = Math.max(
        CORP_MORALE_UPKEEP_MIN_FUNDS,
        expenses * CORP_MORALE_UPKEEP_RESERVE_SECS,
    );
    const profitBudget = profit > 0
        ? Math.max(CORP_TEA_COST * 2, profit)
        : CORP_TEA_COST * 2;
    return Math.min(raw, Math.max(0, funds - profitBudget));
}

export async function main(ns) {
    const opts = parseOptions(ns.args);
    const c = ns.corporation;
    try {
        if (!c?.hasCorporation?.()) return;
        const corp = c.getCorporation();
        const availableDivs = new Set(Array.isArray(corp?.divisions) ? corp.divisions : []);
        const divs = opts.divs.filter((div) => availableDivs.has(div));
        if (!divs.length) {
            writeJson(ns, SNAPSHOT_FILE, {
                time: Date.now(),
                source: opts.source,
                phase: opts.phase,
                spike: opts.spike,
                tea: 0,
                party: 0,
            });
            return;
        }

        const state = readJson(ns, STATE_FILE, {
            teaCooldownByOffice: {},
            partyCooldownByOffice: {},
        });
        const teaCooldownByOffice = state?.teaCooldownByOffice && typeof state.teaCooldownByOffice === 'object'
            ? state.teaCooldownByOffice
            : {};
        const partyCooldownByOffice = state?.partyCooldownByOffice && typeof state.partyCooldownByOffice === 'object'
            ? state.partyCooldownByOffice
            : {};
        const now = Date.now();
        const upkeepFloor = opts.spike ? Number.NEGATIVE_INFINITY : getMoraleUpkeepFloor(c);
        let teaSpend = 0;
        let partySpend = 0;

        for (const div of divs) {
            for (const city of CITIES) {
                try {
                    const office = c.getOffice(div, city);
                    if (Number(office?.numEmployees ?? 0) < 9) continue;
                    const key = getOfficeSpendKey(div, city);
                    const teaCooldown = Number(teaCooldownByOffice[key] ?? 0);
                    const partyCooldown = Number(partyCooldownByOffice[key] ?? 0);
                    if (opts.spike) {
                        if (Number(office?.avgEnergy ?? 100) < CORP_SPIKE_ENERGY_THRESHOLD && now >= teaCooldown) {
                            try {
                                c.buyTea(div, city);
                                teaCooldownByOffice[key] = now + CORP_MORALE_ACTION_COOLDOWN_MS;
                                teaSpend += CORP_TEA_COST;
                            } catch { }
                        }
                        const moraleGap = Math.max(0, CORP_SPIKE_MORALE_THRESHOLD - Number(office?.avgMorale ?? 100));
                        if (moraleGap > 0 && now >= partyCooldown) {
                            try {
                                c.throwParty(div, city, CORP_MORALE_PARTY_SPEND_MIN);
                                partyCooldownByOffice[key] = now + CORP_MORALE_ACTION_COOLDOWN_MS;
                                partySpend += CORP_MORALE_PARTY_SPEND_MIN;
                            } catch { }
                        }
                        continue;
                    }

                    if (
                        Number(office?.avgEnergy ?? 100) < CORP_ENERGY_THRESHOLD
                        && now >= teaCooldown
                        && Number(c.getCorporation().funds ?? 0) - CORP_TEA_COST >= upkeepFloor
                    ) {
                        try {
                            c.buyTea(div, city);
                            teaCooldownByOffice[key] = now + CORP_MORALE_ACTION_COOLDOWN_MS;
                            teaSpend += CORP_TEA_COST;
                        } catch { }
                    }
                    const moraleGap = Math.max(0, CORP_MORALE_THRESHOLD - Number(office?.avgMorale ?? 100));
                    if (moraleGap <= 0 || now < partyCooldown) continue;
                    const spend = clamp(
                        Math.round(Number(office?.numEmployees ?? 0) * moraleGap * 15e3),
                        CORP_MORALE_PARTY_SPEND_MIN,
                        CORP_MORALE_PARTY_SPEND_MAX,
                    );
                    if (Number(c.getCorporation().funds ?? 0) - spend < upkeepFloor) continue;
                    try {
                        c.throwParty(div, city, spend);
                        partyCooldownByOffice[key] = now + CORP_MORALE_ACTION_COOLDOWN_MS;
                        partySpend += spend;
                    } catch { }
                } catch { }
            }
        }

        writeJson(ns, STATE_FILE, {
            teaCooldownByOffice,
            partyCooldownByOffice,
        });
        writeJson(ns, SNAPSHOT_FILE, {
            time: now,
            source: opts.source,
            phase: opts.phase,
            spike: opts.spike,
            tea: teaSpend,
            party: partySpend,
        });
    } catch (error) {
        appendWorkerLog(ns, 'corp-morale-worker', `fatal: ${error?.stack ?? error?.message ?? error}`);
        writeJson(ns, SNAPSHOT_FILE, {
            time: Date.now(),
            source: opts.source,
            phase: opts.phase,
            spike: opts.spike,
            tea: 0,
            party: 0,
            error: String(error?.message ?? error),
        });
    }
}
