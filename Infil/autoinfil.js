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
 *   • infiltrator.js + infil.py already present and configured
 *   • pip install websockets pynput  (for infil.py)
 *
 * Usage
 * ─────
 *   run autoinfil.js --reward money
 *       Infiltrate NWO in Volhaven, sell every reward for $.
 *
 *   run autoinfil.js --reward rep --faction "Silhouette"
 *       Infiltrate NWO in Volhaven, trade every reward for Silhouette rep.
 *
 *   run autoinfil.js --reward rep --faction "Silhouette" --company NWO --city Volhaven
 *       Same as above with explicit defaults shown.
 *
 *   run autoinfil.js --stop
 *       Stop the running infiltrator.js (and therefore the whole loop).
 *
 * Flags
 * ─────
 *   --reward  money | rep   Which reward to take on each victory. (default: money)
 *   --faction <name>        Faction to trade rep to. Required when --reward rep.
 *   --company <name>        Company location to infiltrate.        (default: NWO)
 *   --city    <name>        City the company is in.                (default: Volhaven)
 *   --port    <number>      WebSocket port matching infil.py.      (default: 12525)
 *   --stop                  Send stop signal to infiltrator.js and exit.
 *
 * How it works
 * ────────────
 * 1. Travels to --city via ns.singularity.travelToCity (free if already there).
 * 2. Opens the company page via ns.singularity.goToLocation.
 * 3. Spawns infiltrator.js with --restart plus --sell or --trade --faction.
 *    infiltrator.js then handles everything inside Bitburner:
 *      • auto-clicks "Start" on the intro screen
 *      • sends mini-game state to infil.py over WebSocket
 *      • auto-selects the faction in the dropdown (if --reward rep)
 *      • auto-clicks "Sell for $" or "Trade for rep" on the victory screen
 *      • auto-clicks "Infiltrate" to begin the next run
 * 4. autoinfil.js exits — the loop lives entirely inside infiltrator.js's
 *    setInterval, so it keeps running even after this script finishes.
 *
 * @param {NS} ns
 */
export async function main(ns) {
    const flags = ns.flags([
        ["reward",  "money"],   // "money" or "rep"
        ["faction", ""],        // faction name (required when reward=rep)
        ["company", "NWO"],     // company location name (Singularity string)
        ["city",    "Volhaven"],// city to travel to
        ["port",    12525],     // WebSocket port for infil.py
        ["stop",    false],     // stop everything
    ]);

    // ── Stop ──────────────────────────────────────────────────────────────────
    if (flags.stop) {
        ns.run("./infiltrator.js", 1, "--stop");
        ns.tprint("autoinfil: stop signal sent to infiltrator.js.");
        return;
    }

    // ── Validation ────────────────────────────────────────────────────────────
    const reward = String(flags.reward).toLowerCase();
    if (reward !== "money" && reward !== "rep") {
        ns.tprint("ERROR  --reward must be 'money' or 'rep'");
        ns.tprint("       e.g.  run autoinfil.js --reward money");
        ns.tprint("             run autoinfil.js --reward rep --faction \"Silhouette\"");
        return;
    }
    if (reward === "rep" && !flags.faction) {
        ns.tprint("ERROR  --faction <name> is required when --reward rep");
        ns.tprint("       e.g.  run autoinfil.js --reward rep --faction \"Silhouette\"");
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
    if (ns.isRunning("./infiltrator.js")) {
        ns.tprint("  Stopping existing infiltrator.js...");
        ns.run("./infiltrator.js", 1, "--stop");
        await ns.sleep(600);
    }

    // ── Build infiltrator.js argument list ────────────────────────────────────
    // --restart  → auto-click "Infiltrate" after each victory
    // --sell     → auto-click "Sell for $"   (money mode)
    // --trade    → auto-click "Trade for rep" (rep mode)
    // --faction  → auto-select faction in the dropdown before trading
    // --port     → WebSocket port
    const infArgs = ["--restart", "--port", flags.port];
    if (reward === "money") {
        infArgs.push("--sell");
    } else {
        infArgs.push("--trade", "--faction", flags.faction);
    }

    // ── Navigate to company ───────────────────────────────────────────────────
    ns.tprint(`  Navigating to ${flags.company} in ${flags.city}...`);

    const player = ns.getPlayer();
    if (player.city !== flags.city) {
        const travelled = ns.singularity.travelToCity(flags.city);
        if (!travelled) {
            ns.tprint(`ERROR  Could not travel to ${flags.city}.`);
            ns.tprint("       Check you have enough money ($200k) and SF4.");
            return;
        }
        ns.tprint(`  Travelled to ${flags.city}.`);
        await ns.sleep(1000);
    } else {
        ns.tprint(`  Already in ${flags.city}.`);
    }

    ns.singularity.goToLocation(flags.company);
    await ns.sleep(500);
    ns.tprint(`  Opened ${flags.company} location page.`);

    // ── Launch infiltrator.js ─────────────────────────────────────────────────
    const pid = ns.run("./infiltrator.js", 1, ...infArgs);
    if (!pid) {
        ns.tprint("ERROR  Failed to launch infiltrator.js.");
        ns.tprint("       Make sure infiltrator.js is in the root directory.");
        return;
    }

    ns.tprint("");
    ns.tprint("  infiltrator.js is running — loop active.");
    ns.tprint("  Make sure infil.py is running on your PC:");
    ns.tprint(`    python infil.py --port ${flags.port}`);
    ns.tprint("");
    ns.tprint("  To stop:  run autoinfil.js --stop");
    ns.tprint("");
    ns.tprint("  [monitor] Watching for navigation signals from infiltrator.js...");

    // ── Navigation monitor loop ───────────────────────────────────────────────
    // infiltrator.js exits main() immediately (its loop lives in setInterval on
    // window), so ns becomes invalid inside it.  This loop stays alive so that
    // ns.singularity.goToLocation() remains available for navigating back to the
    // company page after each infiltration ends.
    //
    // infiltrator.js signals via wnd._infNeedsNav = true whenever it detects
    // that the Infiltrate button is gone (i.e., we've been dropped to city view).
    // We honour it only after _infNavCooldown clears (set for 3 s after each
    // victory to let the trade/sell transition finish before navigating).
    const wnd = eval("window");
    const doc = wnd.document;
    while (true) {
        await ns.sleep(500);
        if (!wnd._infNeedsNav || wnd._infNavCooldown) continue;
        wnd._infNeedsNav = false;

        try {
            // If the Infiltrate button is already visible we are already on the
            // company page — infiltrator.js handles the click itself.  Calling
            // goToLocation() here would be redundant and can throw in some states.
            const alreadyOnPage = [...doc.querySelectorAll("button")]
                .some(b => b.textContent.trim().toLowerCase().startsWith("infiltrate"));
            if (alreadyOnPage) continue;

            // Re-check city — other scripts (work-for-factions, daemon) may have
            // moved the player while the infiltration was running.
            const currentPlayer = ns.getPlayer();
            if (currentPlayer.city !== flags.city) {
                ns.tprint(`  [monitor] Wrong city (${currentPlayer.city}), travelling to ${flags.city}...`);
                const travelled = ns.singularity.travelToCity(flags.city);
                if (!travelled) {
                    ns.tprint(`  [monitor] WARNING: Could not travel to ${flags.city} (not enough money?). Will retry.`);
                    wnd._infNeedsNav = true; // retry on next 500ms tick
                    continue;
                }
                await ns.sleep(1000);
            }

            ns.tprint(`  [monitor] Navigating back to ${flags.company}...`);
            ns.singularity.goToLocation(flags.company);
            // Brief cooldown so we don't spam goToLocation on consecutive ticks.
            wnd._infNavCooldown = true;
            wnd.setTimeout(() => { delete wnd._infNavCooldown; }, 2000);

        } catch (err) {
            // Never let a navigation error kill the monitor loop.
            // Log and re-arm _infNeedsNav so we retry on the next tick.
            ns.tprint(`  [monitor] ERROR during navigation: ${err?.message ?? err}. Will retry.`);
            wnd._infNeedsNav = true;
        }
    }
}