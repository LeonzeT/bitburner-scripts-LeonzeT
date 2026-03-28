
// Resolve registered script paths via script-paths.json (0 GB — ns.read only)
let _scriptPaths = null;
function resolveScript(ns, key) {
    if (!_scriptPaths) {
        _scriptPaths = {};
        try { const r = ns.read('/script-paths.json'); if (r && r !== '') { _scriptPaths = JSON.parse(r); delete _scriptPaths._comment; } } catch {}
    }
    return _scriptPaths[key] ?? (key.endsWith('.js') ? key : key + '.js');
}
/** darknet-worker.js — exec'd by darknet-crawler.js onto each darknet server. @param {NS} ns */
export async function main(ns) {
    const flags = ns.flags([
        ["depth",          0],
        ["max-depth",      8],
        ["phish",          false],
        ["packet-capture", false],
        ["quiet",          false],
    ]);
    ns.disableLog("ALL");
    const myHost   = ns.getHostname();
    const depth    = flags["depth"];
    const maxDepth = flags["max-depth"];
    const doPhish  = flags["phish"];
    const doPacket = flags["packet-capture"];
    const PORT     = 3;
    const report   = (msg) => ns.tryWritePort(PORT, JSON.stringify(msg));

    // Open our own caches
    for (const file of ns.ls(myHost, ".cache")) {
        try {
            const r = ns.dnet.openCache(file, true);
            report({ t: "cache", host: myHost, file, result: r.message, karma: r.karmaLoss });
        } catch { }
    }
    // Read clue files
    for (const file of ns.ls(myHost, ".data.txt")) {
        try {
            const content = ns.read(file);
            if (content) report({ t: "clue", host: myHost, file, content: content.slice(0, 200) });
        } catch { }
    }
    // Phishing
    if (doPhish) {
        try {
            const r = await ns.dnet.phishingAttack();
            report({ t: "phish", host: myHost, success: r.success, msg: r.message ?? "" });
        } catch { }
    }

    const neighbours = ns.dnet.probe();
    report({ t: "probe", host: myHost, depth, neighbours });

    if (depth >= maxDepth) return;

    let knownPasswords = {};
    try {
        const raw = ns.read("/Temp/dnet-passwords.txt");
        if (raw) knownPasswords = JSON.parse(raw);
    } catch { }

    const myScript   = resolveScript(ns, 'darknet-worker');
    const reallocScript = resolveScript(ns, 'darknet-realloc');
    const workerRam  = ns.getScriptRam(myScript, "home");
    // 1 GB static + ~1.75 GB base = ~2.75 GB minimum per thread
    const reallocRam = ns.fileExists(reallocScript, "home")
        ? ns.getScriptRam(reallocScript, "home") : 2.75;

    for (const host of neighbours) {
        if (!ns.dnet.isDarknetServer(host)) continue;
        let authDetails;
        try { authDetails = ns.dnet.getServerAuthDetails(host); } catch { continue; }
        if (!authDetails.isOnline) continue;

        if (authDetails.hasAdminRights) {
            if (!authDetails.hasSession && knownPasswords[host] !== undefined) {
                ns.dnet.connectToSession(host, knownPasswords[host]);
            }

            // If the server has blocked RAM, try to liberate it before exec-ing a worker.
            // We run darknet-realloc.js with as many threads as the current host can spare
            // so each call clears more per iteration (clearance scales linearly with threads).
            // Only start a realloc if one isn't already running — it runs to completion.
            const blocked = ns.dnet.getBlockedRam(host);
            if (blocked > 0 && !ns.isRunning(reallocScript, myHost)) {
                const myFree    = ns.getServerMaxRam(myHost) - ns.getServerUsedRam(myHost);
                const threads   = Math.max(1, Math.floor(myFree / reallocRam));
                if (!ns.fileExists(reallocScript, myHost)) ns.scp(reallocScript, myHost, "home");
                const pid = ns.exec(reallocScript, myHost, threads, host, 50);
                if (pid > 0)
                    report({ t: "realloc_start", host: myHost, target: host,
                             blocked: blocked.toFixed(1), threads });
            }

            // Only exec the worker once blocked RAM is fully cleared.
            // If it's still blocked, the realloc script is running — skip for now.
            const stillBlocked = ns.dnet.getBlockedRam(host);
            if (stillBlocked > 0) continue;

            if (!ns.isRunning(myScript, host)) {
                const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
                if (free >= workerRam) {
                    if (!ns.fileExists(myScript, host)) ns.scp(myScript, host, "home");
                    ns.exec(myScript, host, 1,
                        "--depth", depth + 1, "--max-depth", maxDepth,
                        "--phish", doPhish, "--packet-capture", doPacket, "--quiet", flags["quiet"]);
                }
            }
            continue;
        }

        const result = await solveAndAuth(ns, host, authDetails, doPacket);
        if (result.success) {
            report({ t: "cracked", host, password: result.password, depth: depth + 1 });
            // Start realloc immediately on the newly cracked server if it has blocked RAM.
            // We're on myHost, which is directly connected to host (we just cracked it).
            const blocked = ns.dnet.getBlockedRam(host);
            if (blocked > 0 && !ns.isRunning(reallocScript, myHost)) {
                const myFree  = ns.getServerMaxRam(myHost) - ns.getServerUsedRam(myHost);
                const threads = Math.max(1, Math.floor(myFree / reallocRam));
                if (!ns.fileExists(reallocScript, myHost)) ns.scp(reallocScript, myHost, "home");
                ns.exec(reallocScript, myHost, threads, host, 50);
                report({ t: "realloc_start", host: myHost, target: host,
                         blocked: blocked.toFixed(1), threads });
                // Don't exec the worker yet — it will be exec'd once realloc finishes
                // and the crawler re-execs this worker on the next mutation cycle.
            } else {
                const free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
                if (free >= workerRam) {
                    if (!ns.fileExists(myScript, host)) ns.scp(myScript, host, "home");
                    ns.exec(myScript, host, 1,
                        "--depth", depth + 1, "--max-depth", maxDepth,
                        "--phish", doPhish, "--packet-capture", doPacket, "--quiet", flags["quiet"]);
                }
            }
        } else {
            report({ t: "failed", host, model: authDetails.modelId });
        }
    }
}

// ── SOLVER ────────────────────────────────────────────────────────────────────

async function solveAndAuth(ns, host, authDetails, doPacket) {
    const { modelId, passwordHint: hint, data, passwordLength, passwordFormat } = authDetails;
    const charset = getCharset(passwordFormat);
    const fail    = { success: false, password: "" };

    // ── GUARD: never send an oversized password to the API ────────────────────
    const MAX_PW = 50;
    const tryPw = async function attemptPassword(pw) {
        const s = String(pw);
        if (s.length > MAX_PW) {
            ns.print("GUARD: blocked oversized attempt, len=" + s.length + " starts=" + s.slice(0, 20));
            return { success: false, password: s, data: "", message: "too long" };
        }
        const r = await ns.dnet.authenticate(host, s);
        return { success: r.success, password: s, data: r ? r.data : "", message: r ? r.message : "" };
    };

    const tryCandidates = async function tryCandidateList(list) {
        for (let i = 0; i < list.length; i++) {
            const s = String(list[i]).trim();
            if (s.length === 0) continue;
            if (s.length > MAX_PW) continue;
            if (passwordLength > 0 && s.length !== passwordLength) continue;
            const r = await tryPw(s);
            if (r.success) return r;
        }
        return fail;
    };
    // ─────────────────────────────────────────────────────────────────────────

    switch (modelId) {

        case "ZeroLogon":
            return tryPw("");

        case "DeskMemo_3.1": {
            const m = hint.match(/(?:password|pin|key|secret|set to|is)\s+(\S+)/i);
            return tryPw(m ? m[1] : "");
        }

        case "FreshInstall_1.0":
            return tryCandidates(["admin", "password", "0000", "12345"]);

        case "Laika4":
            return tryCandidates(["fido", "spot", "rover", "max"]);

        case "TopPass":
            return tryCandidates(COMMON_PASSWORDS);

        case "EuroZone Free":
            return tryCandidates(EU_COUNTRIES);

        case "CloudBlare(tm)":
            return tryPw(data.replace(/[^0-9]/g, ""));

        case "110100100":
            return tryPw(data.split(" ").map(function(b) { return String.fromCharCode(parseInt(b, 2)); }).join(""));

        case "OrdoXenos": {
            const sep = data.indexOf(";");
            if (sep === -1) return fail;
            const cipher = data.slice(0, sep);
            const masks  = data.slice(sep + 1).split(" ").map(function(m) { return parseInt(m, 2); });
            if (masks.length !== cipher.length) return fail;
            return tryPw(cipher.split("").map(function(c, i) { return String.fromCharCode(c.charCodeAt(0) ^ masks[i]); }).join(""));
        }

        case "BellaCuore": {
            if (data && data.includes(",")) {
                const parts = data.split(",");
                return bsearch(romanToInt(parts[0]), romanToInt(parts[1]), tryPw);
            }
            const m = hint.match(/'([IVXLCDM]+|nulla)'/i);
            return m ? tryPw(String(romanToInt(m[1]))) : fail;
        }

        case "OctantVoxel": {
            const parts = data.split(",");
            return tryPw(String(parseBaseN(parts[1], parseFloat(parts[0]))));
        }

        case "MathML": {
            const expr = data
                .split(",")[0]
                .replace(/ns\.exit\(\),?/g, "")
                .replace(/ҳ/g, "*").replace(/÷/g, "/").replace(/➕/g, "+").replace(/➖/g, "-");
            const result = safeEval(expr.replace(/\s+/g, ""));
            return result != null ? tryPw(String(result)) : fail;
        }

        case "PrimeTime 2":
            return tryPw(String(largestPrime(parseInt(data))));

        case "Pr0verFl0":
            return tryPw("■".repeat(passwordLength * 2));

        case "AccountsManager_4.2": {
            const m = hint.match(/between\s+(\d+)\s+and\s+(\d+)/i);
            return bsearch(m ? +m[1] : 0, m ? +m[2] : 999999, tryPw);
        }

        case "Factori-Os": {
            const sp = [2,3,5,7,11,13,17,19,23,29,31,37,41,43,47];
            const lp = [1069,1409,1471,1567,1597,1601,1697,1747,1801,1889,
                        1979,1999,2063,2207,2371,2503,2539,2693,2741,2753];
            const divs = [];
            for (let i = 0; i < sp.length; i++) {
                const r = await tryPw(String(sp[i]));
                if (r.success) return r;
                if (r.data === "true") divs.push(sp[i]);
            }
            let cand = 1;
            for (let i = 0; i < divs.length; i++) cand *= divs[i];
            for (let i = 0; i < lp.length; i++) {
                const r = await tryPw(String(lp[i]));
                if (r.success) return r;
                if (r.data === "true") { cand *= lp[i]; break; }
            }
            const r0 = await tryPw(String(cand)); if (r0.success) return r0;
            for (let i = 0; i < sp.length; i++) {
                const r = await tryPw(String(cand * sp[i])); if (r.success) return r;
            }
            return fail;
        }

        case "BigMo%od": {
            const primes = [2,3,5,7,11,13,17,19,23,29,31];
            const res = {};
            for (let i = 0; i < primes.length; i++) {
                const r = await tryPw(String(primes[i]));
                if (r.success) return r;
                res[primes[i]] = parseInt(r.data ? r.data : "0");
            }
            const pw = crt(primes.map(function(p) { return res[p]; }), primes);
            if (pw === null) return fail;
            const lcm = primes.reduce(function(a, b) { return a * b / gcd(a, b); }, 1);
            for (let k = 0; k <= 10; k++) {
                const r = await tryPw(String(pw + k * lcm)); if (r.success) return r;
            }
            return fail;
        }

        case "2G_cellular": {
            const known = [];
            for (let i = 0; i < passwordLength; i++) known.push(charset[0]);
            for (let pos = 0; pos < passwordLength; pos++) {
                for (let ci = 0; ci < charset.length; ci++) {
                    known[pos] = charset[ci];
                    const r = await tryPw(known.join(""));
                    if (r.success) return r;
                    const msg = r.message ? r.message : "";
                    const match = msg.match(/\((\d+)\)/);
                    const idx = match ? parseInt(match[1]) : -1;
                    if (idx > pos) break;
                }
            }
            return fail;
        }

        case "NIL":
        case "RateMyPix.Auth": {
            const isSpice = modelId === "RateMyPix.Auth";
            const known = [];
            for (let i = 0; i < passwordLength; i++) known.push(charset[0]);
            for (let pos = 0; pos < passwordLength; pos++) {
                for (let ci = 0; ci < charset.length; ci++) {
                    known[pos] = charset[ci];
                    const r = await tryPw(known.join(""));
                    if (r.success) return r;
                    const fb = r.data ? r.data : "";
                    const correct = isSpice
                        ? (fb.match(/\uD83C\uDF36\uFE0F/g) || []).length >= pos + 1
                        : fb.split(",")[pos] === "yes";
                    if (correct) break;
                }
            }
            return tryPw(known.join(""));
        }

        case "PHP 5.4": {
            const sortedStr = (data.split(";")[0] || "").replace(/[^0-9]/g, "");
            if (!sortedStr) return fail;
            const digits = sortedStr.split("");
            if (digits.length <= 6) {
                const perms = uniquePerms(digits);
                for (let i = 0; i < perms.length; i++) {
                    const r = await tryPw(perms[i].join("")); if (r.success) return r;
                }
            } else {
                for (let i = 0; i < 40; i++) {
                    const p = digits.slice();
                    for (let j = p.length - 1; j > 0; j--) {
                        const k = Math.floor(Math.random() * (j + 1));
                        const tmp = p[j]; p[j] = p[k]; p[k] = tmp;
                    }
                    const r = await tryPw(p.join("")); if (r.success) return r;
                }
            }
            return fail;
        }

        case "DeepGreen": {
            const cs = charset.length <= 10 ? charset : charset.slice(0, 10);
            let cands = genStrings(cs, passwordLength);
            if (!cands.length) return fail;
            let guess = cands[0];
            for (let i = 0; i < 15 && cands.length > 0; i++) {
                const r = await tryPw(guess); if (r.success) return r;
                const parts = (r.data ? r.data : "0,0").split(",");
                const e = parseInt(parts[0]) || 0;
                const mv = parseInt(parts[1]) || 0;
                cands = cands.filter(function(c) {
                    const s = mmScore(guess, c); return s.e === e && s.m === mv;
                });
                if (cands.length === 1) return tryPw(cands[0]);
                if (cands.length === 0) return fail;
                guess = cands[0];
            }
            return fail;
        }

        case "KingOfTheHill": {
            const maxV = Math.pow(10, passwordLength);
            let lo = 0, hi = maxV;
            for (let i = 0; i < 60 && hi - lo > 1; i++) {
                const m1 = Math.floor(lo + (hi - lo) / 3);
                const m2 = Math.floor(lo + 2 * (hi - lo) / 3);
                const r1 = await tryPw(String(m1)); if (r1.success) return r1;
                const r2 = await tryPw(String(m2)); if (r2.success) return r2;
                if (parseFloat(r1.data) < parseFloat(r2.data)) lo = m1; else hi = m2;
            }
            for (let v = Math.max(0, lo - 2); v <= Math.min(maxV, hi + 2); v++) {
                const r = await tryPw(String(v)); if (r.success) return r;
            }
            return fail;
        }

        case "OpenWebAccessPoint": {
            if (!doPacket) return fail;
            try {
                const result = await ns.dnet.packetCapture(host);
                if (!result.success) return fail;
                const raw    = result.data ? result.data : "";
                const tokens = raw.split(/[\s,.:;!?"'()\[\]{}]+/);
                // Only try tokens that are the right length and not too long
                const candidates = tokens.filter(function(t) {
                    return t.length === passwordLength && t.length <= MAX_PW;
                });
                return tryCandidates(candidates);
            } catch { return fail; }
        }

        case "(The Labyrinth)":
            return fail;

        default:
            ns.tryWritePort(3, JSON.stringify({ t: "failed", host, model: modelId }));
            return fail;
    }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

async function bsearch(lo, hi, tryPw) {
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const r   = await tryPw(String(mid));
        if (r.success) return r;
        const h = r.data ? r.data : "";
        if (h === "Higher" || h === "PARUM BREVIS")    lo = mid + 1;
        else if (h === "Lower" || h === "ALTUS NIMIS") hi = mid - 1;
        else break;
    }
    return { success: false, password: "" };
}

function romanToInt(s) {
    if (!s || s.toLowerCase() === "nulla") return 0;
    const m = { I:1, V:5, X:10, L:50, C:100, D:500, M:1000 };
    let t = 0, p = 0;
    for (let i = s.length - 1; i >= 0; i--) {
        const v = m[s[i].toUpperCase()] || 0;
        t += v < p ? -v : v;
        p = v;
    }
    return t;
}

function parseBaseN(str, base) {
    const ch = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let r = 0, d = str.split(".")[0].length - 1;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === ".") { d = -1; continue; }
        r += ch.indexOf(c.toUpperCase()) * Math.pow(base, d--);
    }
    return Math.round(r);
}

function largestPrime(n) {
    let l = 1, d = 2, rem = n;
    while (d * d <= rem) {
        while (rem % d === 0) { l = d; rem = Math.floor(rem / d); }
        d++;
    }
    return rem > 1 ? rem : l;
}

function safeEval(s) {
    try {
        let m;
        while ((m = s.match(/\(([^()]+)\)/))) s = s.replace(m[0], safeEval(m[1]));
        while ((m = s.match(/(-?\d+\.?\d*)\s*([*/])\s*(-?\d+\.?\d*)/))) {
            const r = m[2] === "*" ? +m[1] * +m[3] : +m[1] / +m[3];
            s = s.replace(m[0], String(r));
        }
        while ((m = s.match(/(-?\d+\.?\d*)\s*([+\-])\s*(-?\d+\.?\d*)/))) {
            const r = m[2] === "+" ? +m[1] + +m[3] : +m[1] - +m[3];
            s = s.replace(m[0], String(r));
        }
        const n = s.match(/(-?\d+\.?\d*)/);
        return n ? parseFloat(n[1]) : null;
    } catch { return null; }
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

function crt(rem, mod) {
    const M = mod.reduce(function(a, b) { return a * b; }, 1);
    let x = 0;
    for (let i = 0; i < mod.length; i++) {
        const Mi  = M / mod[i];
        const inv = modInv(Mi % mod[i], mod[i]);
        if (inv === null) return null;
        x += rem[i] * Mi * inv;
    }
    return ((x % M) + M) % M;
}

function modInv(a, m) {
    let or = a, r = m, os = 1, s = 0;
    while (r !== 0) {
        const q = Math.floor(or / r);
        const tr = r; r = or - q * r; or = tr;
        const ts = s; s = os - q * s; os = ts;
    }
    return or !== 1 ? null : ((os % m) + m) % m;
}

function mmScore(guess, answer) {
    let e = 0;
    const rg = [], ra = [];
    for (let i = 0; i < guess.length; i++) {
        if (guess[i] === answer[i]) e++;
        else { rg.push(guess[i]); ra.push(answer[i]); }
    }
    let mv = 0;
    for (let i = 0; i < rg.length; i++) {
        const idx = ra.indexOf(rg[i]);
        if (idx !== -1) { mv++; ra.splice(idx, 1); }
    }
    return { e, m: mv };
}

function uniquePerms(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const result = [], used = {};
    for (let i = 0; i < arr.length; i++) {
        if (used[arr[i]]) continue;
        used[arr[i]] = true;
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        const sub  = uniquePerms(rest);
        for (let j = 0; j < sub.length; j++) result.push([arr[i]].concat(sub[j]));
    }
    return result;
}

function genStrings(cs, len) {
    if (len === 0) return [""];
    const sub = genStrings(cs, len - 1);
    const r   = [];
    for (let i = 0; i < cs.length; i++) {
        for (let j = 0; j < sub.length; j++) {
            r.push(cs[i] + sub[j]);
            if (r.length > 100000) return r;
        }
    }
    return r;
}

function getCharset(fmt) {
    const n = "0123456789";
    const l = "abcdefghijklmnopqrstuvwxyz";
    const u = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    if (fmt === "numeric")      return n.split("");
    if (fmt === "alphabetic")   return (l + u).split("");
    if (fmt === "alphanumeric") return (n + l + u).split("");
    return n.split("");
}

const COMMON_PASSWORDS = [
    "123456","password","12345678","qwerty","123456789","12345","1234","111111",
    "1234567","dragon","123123","baseball","abc123","football","monkey","letmein",
    "696969","shadow","master","666666","qwertyuiop","123321","mustang","1234567890",
    "michael","654321","superman","1qaz2wsx","7777777","121212","0","qazwsx",
    "123qwe","trustno1","jordan","jennifer","zxcvbnm","asdfgh","hunter","buster",
    "soccer","harley","batman","andrew","tigger","sunshine","iloveyou","2000",
    "charlie","robert","thomas","hockey","ranger","daniel","starwars","112233",
    "george","computer","michelle","jessica","pepper","1111","zxcvbn","555555",
    "11111111","131313","freedom","777777","pass","maggie","159753","aaaaaa",
    "ginger","princess","joshua","cheese","amanda","summer","love","ashley",
    "6969","nicole","chelsea","biteme","matthew","access","yankees","987654321",
    "dallas","austin","thunder","taylor","matrix",
];

const EU_COUNTRIES = [
    "Austria","Belgium","Bulgaria","Croatia","Republic of Cyprus","Czech Republic",
    "Denmark","Estonia","Finland","France","Germany","Greece","Hungary","Ireland",
    "Italy","Latvia","Lithuania","Luxembourg","Malta","Netherlands","Poland",
    "Portugal","Romania","Slovakia","Slovenia","Spain","Sweden",
];