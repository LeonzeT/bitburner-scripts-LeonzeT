#!/usr/bin/env python3
"""
infil.py — Bitburner infiltration solver  v3
=============================================
Requirements:  pip install websockets pynput
Usage:         python infil.py [--port 12525]

Changes from v2
───────────────
REFACTOR (minesweeper mark phase — CP2077-style direct navigation):
  The v2 serpentine scan visited every cell in the grid row by row, pressing
  Space only on mine cells.  Any desync between the software cursor and the
  game cursor would cause Space to land on a non-mine → immediate failure.

  MinesweeperModel.onKey (BB source) uses identical wrapping arithmetic to
  Cyberpunk2077Model.onKey:
      x = (x + dx + width)  % width
      y = (y + dy + height) % height
  so the same proven navigation strategy can be applied to both games.

  New approach (mirrors _hex_step / _init_hexgrid exactly):
    • _store_mines now builds a flat target list [(row, col), …] of mine
      positions instead of a 2-D boolean grid.
    • _init_mark_phase sets gs["targets"] from that list and positions the
      software cursor at (0,0), exactly as _init_hexgrid does.
    • _mark_step navigates directly to each mine (y-axis first, then x-axis,
      wrapping arithmetic) and presses Space, then pops the target — no
      serpentine sweep of non-mine cells at all.

  Benefits over serpentine:
    • Fewer keypresses → smaller window for timing jitter to cause desync.
    • Any remaining desync only affects the path to a mine, not whether Space
      lands on a mine (we always arrive before pressing Space).
    • Code is structurally identical to _hex_step, making both easy to audit.

TIMING (startup delay increased 150 ms → 200 ms):
  _init_mark_phase and _init_hexgrid now set gs["last_step"] = time.time() +
  0.20 (was 0.15).  The extra 50 ms gives the OS input queue more room to drain
  stale keys from the previous mini-game before the first arrow/Space is sent.
  Both games have 15 s / 10-15 s timers, so 200 ms has no practical impact.
"""

import asyncio
import json
import re
import argparse
import time

try:
    from pynput.keyboard import Controller, Key
    from pynput.mouse import Controller as MouseController, Button as MouseButton
except ImportError:
    print("ERROR: pynput not installed.  pip install pynput websockets")
    raise

keyboard = Controller()
mouse    = MouseController()

# ── Key helpers ───────────────────────────────────────────────────────────────

ARROW = {
    "↑": Key.up,   "up":    Key.up,
    "↓": Key.down, "down":  Key.down,
    "←": Key.left, "left":  Key.left,
    "→": Key.right,"right": Key.right,
}
BRACKET_CLOSE = {"[": "]", "(": ")", "{": "}", "<": ">"}

def tap(key, delay=0.05):
    """Press and release a Key.* constant."""
    keyboard.press(key)
    time.sleep(0.01)
    keyboard.release(key)
    time.sleep(delay)

def tap_char(ch, delay=0.05):
    """
    Type a single printable character.

    keyboard.type(ch) is the correct pynput API for producing a character: it
    handles the platform key-map internally, including any required Shift
    modifier.
    """
    if ch == " ":
        tap(Key.space, delay)
    else:
        keyboard.type(ch)
        time.sleep(delay)

def mouse_click(x, y, delay=0.05):
    """Move the OS cursor to (x, y) in physical screen pixels and left-click."""
    mouse.position = (x, y)
    time.sleep(delay)
    mouse.click(MouseButton.left)
    time.sleep(delay)

# ── Positive words (Bitburner source BribeModel.ts) ──────────────────────────

POSITIVE = {
    "affectionate", "agreeable", "bright", "charming", "creative",
    "determined", "energetic", "friendly", "funny", "generous",
    "polite", "likable", "diplomatic", "helpful", "giving",
    "kind", "hardworking", "patient", "dynamic", "loyal", "straightforward",
}

# ── Grid size lookup ──────────────────────────────────────────────────────────

GRID_DIMS = {9:(3,3), 12:(3,4), 16:(4,4), 20:(4,5), 25:(5,5), 30:(5,6), 36:(6,6)}

# ── Per-game state ────────────────────────────────────────────────────────────

current_game = None
gs           = {}
mine_data    = None   # persists from memory phase to mark phase

# ── init_game ─────────────────────────────────────────────────────────────────

def init_game(game, state):
    """Initialise per-game state.  Returns False if init should be retried."""
    global gs
    print(f"\n[{game.upper()}]")
    gs = {}

    if game == "slash":
        gs["done"] = False

    elif game == "cheatcode":
        gs["last_arrow"] = None

    elif game == "bracket":
        brackets = state.get("brackets", "")
        if not brackets:
            print(f"  brackets not ready yet — will retry next tick")
            return False

        OPEN_TO_CLOSE = {"[": "]", "(": ")", "{": "}", "<": ">"}
        CLOSE_CHARS   = set(OPEN_TO_CLOSE.values())
        stack = []
        for ch in brackets:
            if ch in OPEN_TO_CLOSE:
                stack.append(OPEN_TO_CLOSE[ch])
            elif ch in CLOSE_CHARS and stack and stack[-1] == ch:
                stack.pop()
        closing = list(reversed(stack))
        gs["queue"] = closing
        print(f"  brackets={brackets!r}  will type={''.join(closing)!r}")

    elif game == "bribe":
        gs["done"]      = False
        gs["last_move"] = 0.0

    elif game == "backward":
        answer = state.get("answer", "")
        gs["queue"] = list(answer)
        gs["done"]  = False
        print(f"  word (DOM)={answer!r}  typing={answer!r}")

    elif game == "wirecutting":
        gs["queue"] = _build_wire_queue(state)
        gs["sent"]  = set()
        print(f"  wires to cut: {gs['queue']}")

    elif game == "minesweeper":
        if state.get("memory"):
            _store_mines(state)
        else:
            _init_mark_phase()

    elif game == "hexgrid":
        _init_hexgrid(state)

    return True


def _build_wire_queue(state):
    CSS_COLOR = {
        "rgb(255, 0, 0)":    "red",
        "red":               "red",
        "rgb(255, 193, 7)":  "yellow",
        "#ffc107":           "yellow",
        "rgb(33, 150, 243)": "blue",
        "blue":              "blue",
        "rgb(0, 0, 255)":    "blue",
        "white":             "white",
        "rgb(255,255,255)":  "white",
        "rgb(255, 255, 255)":"white",
    }
    instr      = state.get("instructions", "").lower()
    wire_count = state.get("wireCount", 0)
    color_els  = state.get("colorEls", [])

    wire_colors = {}
    idx = 0
    for _row in range(3):
        for col in range(wire_count):
            if idx >= len(color_els): break
            raw   = color_els[idx].get("color", "").strip().lower()
            color = CSS_COLOR.get(raw, "")
            if color:
                wire_colors.setdefault(col + 1, []).append(color)
            idx += 1

    to_cut = set()
    for m in re.finditer(r"cut wire(?:s)? number\s*(\d+)", instr):
        to_cut.add(int(m.group(1)))
    for m in re.finditer(r"cut all wires? colou?red?\s*(\w[-\w]*)", instr):
        target = m.group(1).lower()
        for wnum, colors in wire_colors.items():
            if target in colors:
                to_cut.add(wnum)
    return sorted(to_cut)


def _store_mines(state):
    global mine_data
    cells = state.get("cellChildren", [])
    dims  = GRID_DIMS.get(len(cells))
    if not dims:
        print(f"  unknown grid size ({len(cells)} cells) — cell detection may still be wrong")
        return
    cols, rows = dims

    # Build target list: (row, col) for every mine cell.
    # cells are ordered left-to-right, top-to-bottom (row-major).
    targets = []
    for idx, val in enumerate(cells):
        if val > 0:
            r = idx // cols
            c = idx % cols
            targets.append((r, c))

    # Only commit mine_data once we see at least one mine.
    # The first DOM tick during the memory phase often returns all-zero before
    # React has rendered the SVG bomb icons.
    if not targets:
        print(f"  memory tick: no mines detected yet in {len(cells)}-cell grid — waiting...")
        return

    mine_data = {"rows": rows, "cols": cols, "targets": targets}
    print(f"  memory: {cols}×{rows}, {len(targets)} mines at {targets}")


def _init_mark_phase():
    """
    Initialise the mark-phase cursor at (0,0) — matching MinesweeperModel
    which always resets to x=0, y=0.

    Uses the same target-list approach as _init_hexgrid: navigate directly to
    each mine position (y-axis first, then x-axis, wrapping arithmetic) and
    press Space, instead of doing a serpentine sweep of every cell.
    """
    global gs
    if not mine_data:
        print("  WARNING: no mine data from memory phase!")
        return
    gs["cols"]    = mine_data["cols"]
    gs["rows"]    = mine_data["rows"]
    gs["targets"] = list(mine_data["targets"])   # mutable copy
    gs["x"]       = 0
    gs["y"]       = 0
    # 200 ms startup delay — same as _init_hexgrid — lets stale keys from
    # the previous mini-game drain out of the OS input queue before the first
    # arrow/Space is sent.
    gs["last_step"] = time.time() + 0.20
    print(f"  mark: {gs['cols']}×{gs['rows']}, {len(gs['targets'])} target(s): "
          f"{gs['targets']} — first step in ~200 ms")


def _init_hexgrid(state):
    """
    Initialise the hexgrid cursor at (0,0) — matching Cyberpunk2077Model
    which always resets to x=0, y=0.
    """
    target_syms = state.get("targets", [])
    grid_syms   = state.get("grid",    [])
    dims = GRID_DIMS.get(len(grid_syms))
    if not dims:
        print(f"  unknown grid size ({len(grid_syms)} cells)")
        return
    cols, rows = dims
    grid, idx  = [], 0
    for r in range(rows):
        row = []
        for c in range(cols):
            row.append(grid_syms[idx] if idx < len(grid_syms) else "")
            idx += 1
        grid.append(row)
    targets = []
    for sym in target_syms:
        for r, row in enumerate(grid):
            if sym in row:
                targets.append((r, row.index(sym)))
                break
    gs["grid"]      = grid
    gs["cols"]      = cols
    gs["rows"]      = rows
    gs["targets"]   = targets
    gs["x"]         = 0    # software cursor — starts at (0,0) like the model
    gs["y"]         = 0
    # Same 200 ms startup delay as _init_mark_phase — drain stale keys before
    # the first arrow/Space is sent.
    gs["last_step"] = time.time() + 0.20
    print(f"  grid {cols}×{rows}, {len(targets)} targets: {targets} — first step in ~200 ms")

# ── play_game ─────────────────────────────────────────────────────────────────

def play_game(game, state):
    if game == "slash":
        if gs.get("done"): return
        if state.get("phase") == 1:
            tap(Key.space)
            gs["done"] = True

    elif game == "cheatcode":
        arrow_sym = state.get("currentArrow", "")
        key = ARROW.get(arrow_sym)
        if key and arrow_sym != gs.get("last_arrow"):
            tap(key)
            gs["last_arrow"] = arrow_sym

    elif game in ("bracket", "backward"):
        q = gs.get("queue", [])
        if game == "bracket":
            while q:
                tap_char(q.pop(0), delay=0.02)
        elif q:
            tap_char(q.pop(0))

    elif game == "bribe":
        if gs.get("done"): return
        cur   = state.get("current", "")
        above = state.get("above",   "")
        below = state.get("below",   "")
        if cur in POSITIVE:
            tap(Key.space)
            gs["done"] = True
            return
        now = time.time()
        if now - gs.get("last_move", 0.0) < 0.15:
            return
        if above in POSITIVE:
            tap(Key.up)
        elif below in POSITIVE:
            tap(Key.down)
        else:
            tap(Key.down)
        gs["last_move"] = now

    elif game == "wirecutting":
        q    = gs.get("queue", [])
        sent = gs.get("sent", set())
        for wire in list(q):
            if wire not in sent:
                tap_char(str(wire))
                sent.add(wire)
                gs["sent"] = sent
                break

    elif game == "minesweeper":
        if state.get("memory"): return
        _mark_step()

    elif game == "hexgrid":
        _hex_step()

    elif game == "victory":
        pass  # JS side handles victory button clicks; Python does nothing


# ── minesweeper mark phase ─────────────────────────────────────────────────────

def _mark_step():
    """
    Navigate directly to each mine and press Space.

    STRATEGY — mirrors _hex_step exactly:
    ──────────────────────────────────────
    Instead of sweeping every cell in a serpentine pattern, we navigate
    straight to each mine position and press Space.  MinesweeperModel.onKey
    (BB source) uses identical wrapping arithmetic to Cyberpunk2077Model.onKey:

        x = (x + dx + width)  % width
        y = (y + dy + height) % height

    so the same direct-navigation strategy applies to both games.

    Navigation: move along y first, then x.  For the largest grid (6×6) this
    reaches any cell in at most 5+5 = 10 moves, well within the 15 s timer.
    After pressing Space the game cursor does not move; x/y stay the same for
    the next target.
    """
    targets = gs.get("targets", [])
    if not targets:
        return  # all mines marked

    now = time.time()
    if now - gs.get("last_step", 0.0) < 0.15:
        return
    gs["last_step"] = now

    cols = gs["cols"]
    rows = gs["rows"]
    x    = gs["x"]
    y    = gs["y"]

    ty, tx = targets[0]

    if y != ty:
        if y > ty:
            tap(Key.up)
            gs["y"] = (y - 1 + rows) % rows
        else:
            tap(Key.down)
            gs["y"] = (y + 1) % rows
    elif x != tx:
        if x > tx:
            tap(Key.left)
            gs["x"] = (x - 1 + cols) % cols
        else:
            tap(Key.right)
            gs["x"] = (x + 1) % cols
    else:
        # At the mine cell — press Space to mark it.
        # The game cursor does not move on Space; x/y stay the same for the
        # next target (which may be at a different position).
        tap(Key.space)
        targets.pop(0)
        print(f"  ✓ marked mine at ({x},{y}); {len(targets)} target(s) remaining")


# ── hexgrid ────────────────────────────────────────────────────────────────────

def _hex_step():
    """
    Navigate to each target symbol and press Space.

    POSITION TRACKING — software only (no DOM cursorIndex):
    ─────────────────────────────────────────────────────────
    Same fix as _mark_step.  Cyberpunk2077Model initialises x=0, y=0 and uses
    wrapping arithmetic:
        x = (x + dx + width)  % width
        y = (y + dy + height) % height
    We mirror that arithmetic so the software cursor stays in lockstep.

    Navigation strategy: move along y first, then x.  For small grids
    (3×3 to 6×6) this reaches any cell in at most (rows-1)+(cols-1) = 10 moves,
    well within the timer budget.
    """
    targets = gs.get("targets", [])
    if not targets: return

    now = time.time()
    if now - gs.get("last_step", 0.0) < 0.15:
        return
    gs["last_step"] = now

    cols = gs["cols"]
    rows = gs["rows"]
    x    = gs["x"]
    y    = gs["y"]

    ty, tx = targets[0]

    if y != ty:
        if y > ty:
            tap(Key.up)
            gs["y"] = (y - 1 + rows) % rows
        else:
            tap(Key.down)
            gs["y"] = (y + 1) % rows
    elif x != tx:
        if x > tx:
            tap(Key.left)
            gs["x"] = (x - 1 + cols) % cols
        else:
            tap(Key.right)
            gs["x"] = (x + 1) % cols
    else:
        # At the target cell — press Space to mark it.
        # The game cursor does not move on Space; x/y stay the same for the
        # next target (which may be at a different position).
        tap(Key.space)
        targets.pop(0)
        print(f"  ✓ marked ({x},{y}); {len(targets)} target(s) remaining")

# ── WebSocket server ──────────────────────────────────────────────────────────

async def handle(websocket):
    global current_game, gs, mine_data
    print(f"[+] Bitburner connected: {websocket.remote_address}")
    try:
        async for raw in websocket:
            try:
                state = json.loads(raw)
            except Exception:
                continue

            if not state.get("active"):
                if current_game:
                    print("[server] Infiltration ended — resetting.")
                    current_game = None
                    gs           = {}
                    mine_data    = None
                continue

            game = state.get("game", "waiting")

            # OS-level mouse click requested by infiltrator.js (for buttons that
            # swallow synthetic DOM .click() events, e.g. "Infiltrate Company").
            if game == "click":
                x = state.get("x", 0)
                y = state.get("y", 0)
                if x and y:
                    print(f"  [click] ({x}, {y})")
                    mouse_click(x, y)
                continue

            if game in ("waiting", "victory"):
                continue

            # Minesweeper: handle memory → mark transition specially
            if game == "minesweeper":
                memory = state.get("memory", False)
                if memory:
                    # New memory phase: clear stale mine_data from any previous
                    # minesweeper encounter so a fresh solution is always built.
                    if current_game != "minesweeper":
                        mine_data = None
                        current_game = "minesweeper"
                    init_game(game, state)   # calls _store_mines each tick until mines appear
                elif current_game != "minesweeper_mark":
                    current_game = "minesweeper_mark"
                    _init_mark_phase()
                play_game(game, state)
                continue

            if game != current_game:
                # Only commit current_game if init succeeded.
                if init_game(game, state):
                    current_game = game

            play_game(game, state)

    except Exception as e:
        if "ConnectionClosed" not in type(e).__name__:
            print(f"[server] Error: {e}")
    print(f"[-] Bitburner disconnected: {websocket.remote_address}")


async def serve(port):
    import websockets
    print("╔══════════════════════════════════════════╗")
    print("║  Bitburner Infiltration Bot  (infil.py)  ║")
    print("╚══════════════════════════════════════════╝")
    print(f"\n  Listening on port {port}")
    print("  1. Keep this window open")
    print("  2. run infiltrator.js inside Bitburner")
    print("  3. Click Infiltrate on a company\n")
    async with websockets.serve(handle, "localhost", port):
        await asyncio.Future()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=12525)
    args = p.parse_args()
    try:
        asyncio.run(serve(args.port))
    except KeyboardInterrupt:
        print("\nStopped.")