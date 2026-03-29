/**
 * autoinfil.js
 *
 * Full-loop infiltration automation using Singularity.
 * Navigates to a company, launches infiltrator.js, and lets it loop
 * indefinitely — re-infiltrating and collecting rewards automatically.
 *
 * Requirements
 * ────────────
 *   • Source-File 4 (Singularity) for travel / location navigation
 *   • infiltrator.js + infil-nav.js + infil.py in the Infil/ folder
 *   • pip install websockets pynput  (for infil.py)
 *
 * Usage
 * ─────
 *   run Infil/autoinfil.js --reward money
 *   run Infil/autoinfil.js --reward rep --faction "Silhouette"
 *   run Infil/autoinfil.js --stop
 *
 * RAM breakdown (why this is cheap)
 * ──────────────────────────────────
 *   This script only ever calls ns.run + ns.sleep + ns.tprint — 2.6 GB total.
 *   The expensive Singularity calls (travelToCity, goToLocation) live in
 *   infil-nav.js (6.1 GB) which is spawned briefly on demand and exits
 *   immediately after navigating.  RAM is only borrowed, never held.
 *
 * @param {NS} ns
 */

// Resolve paths from script-paths.json (ns.read costs 0 GB — no RAM impact).
let _scriptPaths = null;
function resolvePath(ns, key) {
    if (!_scriptPaths) {
        _scriptPaths = {};
        try {
            const raw = ns.read('/script-paths.json');
            if (raw) { _scriptPaths = JSON.parse(raw); delete _scriptPaths._comment; }
        } catch {}
    }
    return _scriptPaths[key] ?? (key.endsWith('.js') ? key : key + '.js');
}

export async function main(ns) {
    const flags = ns.flags([
        ["reward",  "money"],    // "money" or "rep"
        ["faction", ""],         // faction name (required when reward=rep)
        ["company", "NWO"],      // company location name (Singularity string)
        ["city",    "Volhaven"], // city to travel to
        ["port",    12525],      // WebSocket port for infil.py
        ["stop",    false],      // stop everything
    ]);

    const wnd = eval("window");

    // ── Stop ──────────────────────────────────────────────────────────────────
    // Directly clear infiltrator's window globals instead of spawning a stop
    // instance — avoids needing ns.isRunning and saves its 0.1 GB RAM cost.
    if (flags.stop) {
        if (wnd._infTimer) { wnd.clearInterval(wnd._infTimer); delete wnd._infTimer; }
        if (wnd._infWs)    { try { wnd._infWs.close(); } catch (_) {} delete wnd._infWs; }
        wnd._infNeedsNav = false;
        ns.tprint("autoinfil: infiltrator stopped.");
        return;
    }

    // ── Validation ────────────────────────────────────────────────────────────
    const reward = String(flags.reward).toLowerCase();
    if (reward !== "money" && reward !== "rep") {
        ns.tprint("ERROR  --reward must be 'money' or 'rep'");
        ns.tprint("       e.g.  run Infil/autoinfil.js --reward money");
        ns.tprint("             run Infil/autoinfil.js --reward rep --faction \"Silhouette\"");
        return;
    }
    if (reward === "rep" && !flags.faction) {
        ns.tprint("ERROR  --faction <name> is required when --reward rep");
        ns.tprint("       e.g.  run Infil/autoinfil.js --reward rep --faction \"Silhouette\"");
        return;
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    ns.tprint("╔══════════════════════════════════════════╗");
    ns.tprint("║         autoinfil — loop controller      ║");
    ns.tprint("╚══════════════════════════════════════════╝");
    ns.tprint(`  Company : ${flags.company} (${flags.city})`);
    ns.tprint(`  Reward  : ${reward === "money" ? "Sell for $" : `Rep → ${flags.faction}`}`);
    ns.tprint(`  WS port : ${flags.port}`);
    ns.tprint("");

    // ── Kill any existing infiltrator ─────────────────────────────────────────
    // Use the window timer directly — avoids ns.isRunning (saves 0.1 GB).
    if (wnd._infTimer) {
        ns.tprint("  Stopping existing infiltrator.js...");
        wnd.clearInterval(wnd._infTimer); delete wnd._infTimer;
        if (wnd._infWs) { try { wnd._infWs.close(); } catch (_) {} delete wnd._infWs; }
        await ns.sleep(600);
    }

    // ── Build infiltrator.js argument list ────────────────────────────────────
    const infArgs = ["--restart", "--port", flags.port];
    if (reward === "money") {
        infArgs.push("--sell");
    } else {
        infArgs.push("--trade", "--faction", flags.faction);
    }

    // ── Initial navigation — spawn infil-nav.js ───────────────────────────────
    // infil-nav.js owns travelToCity + goToLocation + getPlayer, so those 4.6 GB
    // of RAM are never baked into this script's footprint.
    ns.tprint(`  Navigating to ${flags.company} in ${flags.city}...`);
    wnd._infNeedsNav  = false;
    wnd._infNavDone   = false;
    const navPid = ns.run(resolvePath(ns, "infil-nav"), 1,
        "--company", flags.company, "--city", flags.city, "--initial");
    if (!navPid) {
        ns.tprint("ERROR  Failed to launch infil-nav.js — not enough free RAM?");
        return;
    }
    // Wait for infil-nav.js to signal completion via window global.
    for (let i = 0; i < 30 && !wnd._infNavDone; i++) await ns.sleep(500);
    if (!wnd._infNavDone) {
        ns.tprint("ERROR  infil-nav.js timed out. Is SF4 active and do you have $200k?");
        return;
    }
    ns.tprint(`  Opened ${flags.company} location page.`);

    // ── Launch infiltrator.js ─────────────────────────────────────────────────
    const pid = ns.run(resolvePath(ns, "infiltrate"), 1, ...infArgs);
    if (!pid) {
        ns.tprint("ERROR  Failed to launch infiltrator.js.");
        ns.tprint("       Make sure infiltrator.js is in the Infil/ directory.");
        return;
    }

    ns.tprint("");
    ns.tprint("  infiltrator.js is running — loop active.");
    ns.tprint("  Make sure infil.py is running on your PC:");
    ns.tprint(`    python infil.py --port ${flags.port}`);
    ns.tprint("");
    ns.tprint("  To stop:  run Infil/autoinfil.js --stop");
    ns.tprint("");
    ns.tprint("  [monitor] Watching for navigation signals from infiltrator.js...");

    // ── Navigation monitor loop ───────────────────────────────────────────────
    // infiltrator.js exits main() immediately (its loop lives in setInterval on
    // window), so ns is invalid inside it.  This loop stays alive so it can
    // spawn infil-nav.js whenever infiltrator.js sets wnd._infNeedsNav = true.
    //
    // RAM cost of this loop: zero extra — only ns.sleep and window reads.
    // The expensive Singularity calls happen inside infil-nav.js instead.
    while (true) {
        await ns.sleep(500);
        if (!wnd._infNeedsNav || wnd._infNavCooldown) continue;
        wnd._infNeedsNav = false;

        // Set a cooldown so we don't spawn multiple nav helpers back-to-back.
        // infil-nav.js also sets _infNavDone when it finishes, but we don't
        // need to wait for it — the cooldown is enough to prevent pile-ups.
        wnd._infNavCooldown = true;
        wnd.setTimeout(() => { delete wnd._infNavCooldown; }, 3000);

        const p = ns.run(resolvePath(ns, "infil-nav"), 1,
            "--company", flags.company, "--city", flags.city);
        if (!p) {
            // Not enough RAM to spawn right now — re-arm and retry next tick.
            ns.tprint("  [monitor] WARN: Could not spawn infil-nav.js (low RAM?). Will retry.");
            wnd._infNeedsNav   = true;
            delete wnd._infNavCooldown;
        }
    }
}