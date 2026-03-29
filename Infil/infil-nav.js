/**
 * infil-nav.js  —  Short-lived navigation helper for autoinfil.js
 *
 * Handles the two expensive Singularity calls (travelToCity + goToLocation)
 * that would otherwise inflate autoinfil.js's permanent RAM footprint by 4 GB.
 * This script is spawned on demand, does its job, signals completion via a
 * window global, and exits.
 *
 * RAM:  1.6 (base) + 0.5 (getPlayer) + 2.0 (travelToCity) + 2.0 (goToLocation)
 *     = 6.1 GB  — held only for the duration of travel (~1–2 s), then freed.
 *
 * @param {NS} ns
 */
export async function main(ns) {
    const flags = ns.flags([
        ["company", "NWO"],
        ["city",    "Volhaven"],
        ["initial", false],   // true on first launch: skips the "already on page" check
    ]);

    const wnd = eval("window");
    const doc = wnd.document;
    wnd._infNavDone = false;

    try {
        // ── Travel if we're in the wrong city ────────────────────────────────
        const player = ns.getPlayer();
        if (player.city !== flags.city) {
            const ok = ns.singularity.travelToCity(flags.city);
            if (!ok) {
                // Can't travel (no money or no SF4) — signal autoinfil.js to retry.
                wnd._infNeedsNav = true;
                return;
            }
            await ns.sleep(1000);
        }

        // ── Check if we're already on the company page ────────────────────────
        // Skip this on the initial launch since the page isn't open yet.
        if (!flags.initial) {
            const alreadyOnPage = [...doc.querySelectorAll("button")]
                .some(b => b.textContent.trim().toLowerCase().startsWith("infiltrate"));
            if (alreadyOnPage) {
                wnd._infNavDone = true;
                return;
            }
        }

        // ── Navigate to the company location page ─────────────────────────────
        ns.singularity.goToLocation(flags.company);
        await ns.sleep(300); // brief pause for the page to begin rendering

        wnd._infNavDone = true;

    } catch (err) {
        // Navigation failed for any reason — signal autoinfil.js to retry.
        wnd._infNeedsNav = true;
    }
}