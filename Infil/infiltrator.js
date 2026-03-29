/**
 * infiltrator.js — v3
 *
 * Polls the DOM every 30ms and sends infiltration game state to infil.py
 * via WebSocket.  Exits immediately — the interval and socket live on window.
 *
 * Usage:
 *   run infiltrator.js                   start (default port 12525)
 *   run infiltrator.js --port 9999       custom port
 *   run infiltrator.js --sell            auto-sell info for $ on victory
 *   run infiltrator.js --trade           auto-trade info for rep on victory
 *                                         (uses the faction currently selected
 *                                          in the dropdown; noop if "none")
 *   run infiltrator.js --restart         after each victory/quit, auto-click
 *                                         the "Infiltrate" button the next time
 *                                         it appears (so you can stay on the
 *                                         company page and loop indefinitely)
 *   run infiltrator.js --sell --restart  fully automated sell-then-re-infiltrate
 *   run infiltrator.js --stop            stop everything
 *
 * Changes from v1
 * ───────────────
 * BUG FIX (hexgrid "always top-left"): _findGridCells DFS flat-layout branch
 *   now rejects containers whose direct children are <span> elements.  The old
 *   code matched the <h5 Targets> element whose N <span> children (N = number
 *   of target symbols, 6-9) fall inside VALID_GRID, causing cursor detection to
 *   run on label spans rather than actual grid <p> cells → cursorIndex always 0.
 *
 * BUG FIX (wirecutting): wire-segment and wire-count queries are now scoped to
 *   .MuiContainer-root instead of doc.querySelectorAll("p").  The page-wide
 *   query picked up sidebar / terminal <p> elements with inline colors, inflating
 *   wireCount and corrupting colorEls.
 *
 * NEW: --sell / --trade / --restart flags for end-to-end automation.
 *
 * @param {NS} ns
 */
const wnd = eval("window");
const doc = wnd["document"];

export async function main(ns) {
    const flags = ns.flags([
        ["port",    12525],
        ["stop",    false],
        ["sell",    false],   // auto-sell information for money on victory
        ["trade",   false],   // auto-trade information for faction rep on victory
        ["faction", ""],      // faction name to auto-select when --trade is set
        ["restart", false],   // auto-click Infiltrate after each run ends
    ]);

    if (flags.stop) {
        if (wnd._infTimer) { wnd.clearInterval(wnd._infTimer); delete wnd._infTimer; }
        if (wnd._infWs)    { try { wnd._infWs.close(); } catch(_) {} delete wnd._infWs; }
        ns.tprint("infiltrator stopped.");
        return;
    }

    if (wnd._infTimer) { wnd.clearInterval(wnd._infTimer); delete wnd._infTimer; }
    if (wnd._infWs)    { try { wnd._infWs.close(); } catch(_) {} delete wnd._infWs; }

    wnd._infPort       = flags.port;
    wnd._infStarted    = false;
    wnd._infAutoSell   = flags.sell;
    wnd._infAutoTrade  = flags.trade;
    wnd._infFaction    = flags.faction || null;  // faction to select on trade
    wnd._infAutoRestart = flags.restart;
    wnd._infVictoryHandled = false;  // prevents double-click on victory buttons
    wnd._infSelectOpen = false;      // tracks whether the faction dropdown is open
    wnd._infNeedsNav   = false;      // signals autoinfil.js to call goToLocation

    _infOpenWs();
    wnd._infTimer = wnd.setInterval(_infTick, 30);
    ns.tprint(`infiltrator v2 running on port ${flags.port}.`);
    if (flags.sell)    ns.tprint("  auto-sell enabled.");
    if (flags.trade)   ns.tprint(`  auto-trade enabled${flags.faction ? ` (faction: ${flags.faction})` : " (uses dropdown selection)"}.`);
    if (flags.restart) ns.tprint("  auto-restart enabled.");
    ns.tprint(`run infiltrator.js --stop to kill it.`);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function _infOpenWs() {
    const port = wnd._infPort ?? 12525;
    try {
        const ws = new wnd.WebSocket(`ws://localhost:${port}`);
        ws.onopen  = () => console.log(`[inf] connected on port ${port}`);
        ws.onclose = () => { wnd._infWs = null; wnd.setTimeout(_infOpenWs, 2000); };
        ws.onerror = () => {};
        wnd._infWs = ws;
    } catch(_) { wnd.setTimeout(_infOpenWs, 2000); }
}

// ── Tick ──────────────────────────────────────────────────────────────────────

function _infTick() {
    try {
        // 1. Auto-start: click the "Start" button on the infiltration intro screen.
        if (!wnd._infStarted) {
            const btn = _findStartButton();
            if (btn) { btn.click(); wnd._infStarted = true; }
        }

        // 2. Auto-handle the victory screen (sell / trade) before sending state.
        //    Only attempt once per victory screen visit.
        if ((wnd._infAutoSell || wnd._infAutoTrade) && !wnd._infVictoryHandled) {
            if (_handleVictoryScreen()) {
                wnd._infVictoryHandled = true;
                wnd._infStarted = false;
                // Suppress navigation for 3 s so the trade/sell transition fully
                // completes before goToLocation() can fire.  Without this, the
                // Singularity nav fires while the reward screen is still
                // mid-transition and overwrites it — dropping the reward entirely.
                if (!wnd._infNavCooldown) {
                    wnd._infNavCooldown = true;
                    wnd.setTimeout(() => { delete wnd._infNavCooldown; }, 3000);
                }
                return;
            }
        }

        // 3. Reset flags once we leave the infiltration screens.
        if (!_onAnyInfiltrationScreen()) {
            wnd._infStarted = false;
            wnd._infVictoryHandled = false;  // ready for next run

            // 4. Auto-restart: look for an "Infiltrate" button and, if found,
            //    send its screen coordinates to Python for an OS-level mouse click.
            //    element.click() is swallowed by Bitburner's React/Electron layer
            //    for this button, so we rely on pynput in infil.py instead.
            //    If the button isn't visible we're on the city view — set a flag
            //    so autoinfil.js (which stays alive) can call goToLocation().
            //    ns is invalid after main() returns so it cannot be called here.
            if (wnd._infAutoRestart && !wnd._infRestartCooldown) {
                const infiltrateBtn = _findInfiltrateButton();
                if (infiltrateBtn) {
                    const dpr  = wnd.devicePixelRatio || 1;
                    const rect = infiltrateBtn.getBoundingClientRect();
                    const chromeH = wnd.outerHeight - wnd.innerHeight;
                    const cx = Math.round((rect.left + rect.width  / 2 + wnd.screenX) * dpr);
                    const cy = Math.round((rect.top  + rect.height / 2 + wnd.screenY + chromeH) * dpr);
                    const ws   = wnd._infWs;
                    if (ws && ws.readyState === 1)
                        ws.send(JSON.stringify({ active: true, game: "click", x: cx, y: cy }));
                    wnd._infRestartCooldown = true;
                    wnd.setTimeout(() => { delete wnd._infRestartCooldown; }, 1500);
                } else {
                    // City view — ask autoinfil.js to navigate back to the company page.
                    wnd._infNeedsNav = true;
                }
            }
        }

        // 5. Send DOM state to Python.
        const ws = wnd._infWs;
        if (ws && ws.readyState === 1)
            ws.send(JSON.stringify(_readState()));
    } catch(e) { console.error("[inf] tick error:", e); }
}

// ── Screen detection ──────────────────────────────────────────────────────────

function _onAnyInfiltrationScreen() {
    // The "Infiltrate Company" button only exists on the company location page,
    // never inside an actual infiltration.  If we see it, we are NOT in an
    // infiltration screen — return false so the restart logic can run.
    if (_findInfiltrateButton()) return false;
    // Intro screen ("Infiltrating <company>") or victory screen.
    for (const el of doc.querySelectorAll("h4")) {
        const t = el.textContent.trim();
        if (t.startsWith("Infiltrating") || t.includes("Infiltration successful")) return true;
    }
    // Mid-game: MuiContainer is present and the Infiltrate button is gone.
    if (doc.querySelector(".MuiContainer-root")) return true;
    return false;
}

function _findStartButton() {
    let onIntro = false;
    for (const el of doc.querySelectorAll("h4"))
        if (el.textContent.trim().startsWith("Infiltrating")) { onIntro = true; break; }
    if (!onIntro) return null;
    for (const btn of doc.querySelectorAll("button"))
        if (btn.textContent.trim().toLowerCase() === "start") return btn;
    return null;
}

/**
 * Looks for the victory reward buttons and clicks the appropriate one.
 * Returns true if the victory screen was detected (regardless of action taken).
 *
 * If --faction was supplied, we first ensure the MUI Select shows that faction
 * before clicking "Trade for rep".  The Select interaction is split across ticks:
 *   tick 1 — click the Select trigger to open the dropdown
 *   tick 2 — find the matching MenuItem and click it
 *   tick 3 — faction is now selected; click Trade
 */
function _handleVictoryScreen() {
    let onVictory = false;
    for (const el of doc.querySelectorAll("h4"))
        if (el.textContent.includes("Infiltration successful")) { onVictory = true; break; }
    if (!onVictory) return false;

    for (const btn of doc.querySelectorAll("button")) {
        const txt = btn.textContent.trim().toLowerCase();

        if (wnd._infAutoSell && txt.startsWith("sell for")) {
            btn.click(); return true;
        }

        if (wnd._infAutoTrade && txt.startsWith("trade for") && !btn.disabled) {
            // If a specific faction was requested, make sure it's selected first.
            if (wnd._infFaction) {
                if (!_selectFactionInDropdown(wnd._infFaction)) return true; // still selecting
            }
            btn.click(); return true;
        }
    }
    return true;
}

/**
 * Ensures the faction MUI Select shows `name` before we click Trade.
 * Returns true when the correct faction is already (or now) selected.
 * Returns false while the dropdown interaction is still in progress
 * (caller should skip the Trade click this tick and retry next tick).
 *
 * Interaction flow (split across setInterval ticks):
 *   Pass 1  — desired faction already displayed → return true immediately.
 *   Pass 2  — click the Select trigger to open the dropdown listbox.
 *   Pass 3+ — listbox is open; find the matching <li role="option"> and click it.
 */
function _selectFactionInDropdown(name) {
    const target = name.trim().toLowerCase();

    // Check the currently displayed value in the MUI Select.
    const display = doc.querySelector(".MuiSelect-select");
    if (display && display.textContent.trim().toLowerCase() === target) {
        wnd._infSelectOpen = false;
        return true;  // already correct — Trade can proceed
    }

    if (!wnd._infSelectOpen) {
        // Open the dropdown by clicking the Select trigger.
        if (display) {
            display.click();
            wnd._infSelectOpen = true;
        }
        return false;  // wait for the listbox to render
    }

    // Listbox should now be in the DOM as a portal (<ul role="listbox">).
    const options = doc.querySelectorAll('[role="option"], [role="listbox"] li, .MuiMenuItem-root');
    for (const opt of options) {
        if (opt.textContent.trim().toLowerCase() === target) {
            opt.click();
            wnd._infSelectOpen = false;
            return false;  // wait one more tick for React to update the display value
        }
    }

    // Options not rendered yet — stay open and retry.
    return false;
}

/**
 * Looks for an "Infiltrate" button anywhere on the page (appears on company
 * location pages).  Returns the button element or null.
 */
function _findInfiltrateButton() {
    for (const btn of doc.querySelectorAll("button"))
        if (btn.textContent.trim().toLowerCase().startsWith("infiltrate")) return btn;
    return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Valid minesweeper / hexgrid total cell counts
const VALID_GRID = new Set([9, 12, 16, 20, 25, 30, 36]);

/**
 * DFS from `root` looking for a grid container whose direct children look like
 * game cells (not inline <span> elements used for target labels).
 * Returns a flat array of cell elements, or [] if nothing matched.
 *
 * Handles two layouts:
 *   Flat  — parent has exactly N children where N is in VALID_GRID
 *   Rows  — parent has R children each with C children, R×C in VALID_GRID
 *
 * BUG FIX: The old code would match the <h5 Targets> element in the hexgrid
 * game because its <span> children count (= number of target symbols, 6–9) is
 * in VALID_GRID.  We now exclude containers whose first child is a <span>.
 * Grid cells are rendered as <p> (Typography) or <div> (Box) — never <span>.
 */
function _findGridCells(root) {
    let found = [];
    (function walk(el) {
        if (found.length) return;
        const ch = [...el.children];

        // Flat layout — but reject SPAN children (those are inline text labels,
        // not game-cell elements).  This prevents matching the Targets h5 in
        // the hexgrid (Cyberpunk2077) game.
        if (VALID_GRID.has(ch.length) && ch[0]?.tagName !== "SPAN") {
            found = ch; return;
        }
        // Row layout: 3–6 rows × 3–6 cols (also reject SPAN rows)
        if (ch.length >= 3 && ch.length <= 6 && ch[0]?.tagName !== "SPAN") {
            const rowKids = ch.map(r => [...r.children]);
            const rowLen  = rowKids[0]?.length ?? 0;
            if (rowLen >= 3 && rowKids.every(r => r.length === rowLen)
                    && VALID_GRID.has(ch.length * rowLen)) {
                found = rowKids.flat(); return;
            }
        }
        for (const c of ch) walk(c);
    }(root));
    return found;
}

// ── State extraction ──────────────────────────────────────────────────────────

function _readState() {
    if (!doc.querySelector(".MuiContainer-root"))
        return { active: false };

    const allH4 = [...doc.querySelectorAll("h4")];
    if (allH4.length < 2) return { active: true, game: "waiting" };

    const titleEl  = allH4[1];
    const titleRaw = titleEl.textContent.trim();
    const title    = titleRaw.toLowerCase();

    if (!titleRaw || title.includes("get ready"))
        return { active: true, game: "waiting" };

    // Victory screen — Python side just does nothing (JS handles clicks above).
    if (title.includes("infiltration successful"))
        return { active: true, game: "victory" };

    const allH5 = [...doc.querySelectorAll("h5")].map(e => e.textContent.trim());

    // ── Slash ─────────────────────────────────────────────────────────────────
    if (title.startsWith("guarding") || title.startsWith("distracted") || title.startsWith("alerted")) {
        return {
            active: true,
            game:   "slash",
            phase:  title.startsWith("distracted") ? 1
                  : title.startsWith("alerted")    ? 2 : 0,
        };
    }

    // ── CheatCode ─────────────────────────────────────────────────────────────
    if (title.includes("enter the code")) {
        let currentArrow = null;
        const codeH4 = allH4[2];
        if (codeH4) {
            for (const span of codeH4.querySelectorAll("span")) {
                const op  = span.style.opacity;
                const txt = span.textContent.trim();
                if ((!op || op === "1") && txt && txt !== "?") {
                    currentArrow = txt;
                    break;
                }
            }
        }
        return { active: true, game: "cheatcode", currentArrow };
    }

    // ── Bracket ───────────────────────────────────────────────────────────────
    if (title.includes("close the bracket")) {
        let brackets = "";
        for (const el of doc.querySelectorAll("p, span")) {
            if (el.style && el.style.fontSize === "5em") {
                brackets = el.textContent.replace(/[^[\](){}<>]/g, "");
                break;
            }
        }
        if (!brackets) {
            for (const el of doc.querySelectorAll("p")) {
                if (!(titleEl.compareDocumentPosition(el) & 4)) continue;
                const t = el.textContent.replace(/[^[\](){}<>]/g, "");
                if (t.length >= 2 && t.length <= 14) { brackets = t; break; }
            }
        }
        return { active: true, game: "bracket", brackets };
    }

    // ── Bribe ─────────────────────────────────────────────────────────────────
    if (title.includes("say something nice")) {
        let baseIdx = 0;
        for (let i = 0; i < allH5.length; i++) {
            if (/\d+\s*\/\s*\d+/.test(allH5[i])) { baseIdx = i + 1; break; }
        }
        return {
            active:  true,
            game:    "bribe",
            above:   (allH5[baseIdx]     ?? "").toLowerCase().trim(),
            current: (allH5[baseIdx + 1] ?? "").toLowerCase().trim(),
            below:   (allH5[baseIdx + 2] ?? "").toLowerCase().trim(),
        };
    }

    // ── Backward ──────────────────────────────────────────────────────────────
    if (title.includes("type it")) {
        let answer = "";
        for (const el of doc.querySelectorAll("p")) {
            if (!(titleEl.compareDocumentPosition(el) & 4)) continue;
            if (!el.style || el.style.transform === "") continue;
            const t = el.textContent.trim();
            if (t && /^[A-Za-z][A-Za-z ]*$/.test(t) && t.length >= 2 && t.length <= 60) {
                answer = t;
                break;
            }
        }
        return { active: true, game: "backward", answer: answer.toLowerCase() };
    }

    // ── WireCutting ───────────────────────────────────────────────────────────
    // BUG FIX: scope to .MuiContainer-root instead of doc.querySelectorAll("p").
    // The page-wide query picked up sidebar/terminal <p> elements with inline
    // colors, corrupting wireCount and colorEls.
    if (title.includes("cut the wire")) {
        const container  = doc.querySelector(".MuiContainer-root");
        const scopedPEls = container
            ? [...container.querySelectorAll("p")]
            : [...doc.querySelectorAll("p")];

        const instructions = [];
        for (const el of scopedPEls) {
            const t = el.textContent.trim().toLowerCase();
            if (t.includes("cut wire") || t.includes("cut all")) instructions.push(t);
        }
        const wireCount = scopedPEls.filter(el => /^\d$/.test(el.textContent.trim())).length;
        const colorEls  = scopedPEls
            .filter(el => !/^\d$/.test(el.textContent.trim()) && el.style?.color)
            .map(el => ({ text: el.textContent.trim(), color: el.style.color }));
        return { active: true, game: "wirecutting", instructions: instructions.join(" "), wireCount, colorEls };
    }

    // ── Minesweeper ───────────────────────────────────────────────────────────
    if (title.includes("mine")) {
        const memory    = title.includes("remember");
        const container = doc.querySelector(".MuiContainer-root");
        const cells        = container ? _findGridCells(container) : [];
        const cellChildren = cells.map(el =>
            (el.querySelector("svg") !== null || el.textContent.trim() === "X") ? 1 : 0
        );

        // Cursor detection: the current cell has borderTopColor == infolight (minority).
        // Python now uses software tracking as primary and ignores cursorIndex, but we
        // still send it as a diagnostic / future-proof fallback.
        let cursorIndex = 0;
        if (!memory && cells.length > 0) {
            const bColors = cells.map(el => wnd.getComputedStyle(el).borderTopColor);
            const freq = {};
            for (const c of bColors) freq[c] = (freq[c] || 0) + 1;
            const minColor = Object.entries(freq).sort((a, b) => a[1] - b[1])[0]?.[0];
            if (minColor !== undefined) cursorIndex = bColors.indexOf(minColor);
        }

        return { active: true, game: "minesweeper", memory, cellChildren, cursorIndex };
    }

    // ── Hex Symbol Grid (Cyberpunk2077) ───────────────────────────────────────
    if (title.includes("match the symbol")) {
        const targets = [];
        for (const h5el of doc.querySelectorAll("h5")) {
            for (const span of h5el.querySelectorAll("span")) {
                const t = span.textContent.trim();
                if (/^[0-9A-Fa-f]{2}$/.test(t)) targets.push(t.toUpperCase());
            }
        }

        // BUG FIX: _findGridCells now excludes <span> children, so it will
        // correctly skip the Targets <h5> and find the actual grid <p> cells.
        const container = doc.querySelector(".MuiContainer-root");
        const cells = container ? _findGridCells(container) : [];
        const grid  = cells.map(el => el.textContent.trim().toUpperCase());

        // Cursor detection: selected cell has borderTopWidth "2px", others "0px".
        // Same note as minesweeper — Python uses software tracking as primary.
        let cursorIndex = 0;
        for (let i = 0; i < cells.length; i++) {
            const bw = wnd.getComputedStyle(cells[i]).borderTopWidth;
            if (bw && bw !== "0px") { cursorIndex = i; break; }
        }

        return { active: true, game: "hexgrid", targets, grid, cursorIndex };
    }

    return { active: true, game: "waiting" };
}