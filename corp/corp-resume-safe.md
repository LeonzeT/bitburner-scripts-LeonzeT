# Corporation setup notes

## Aug-install safety
The setup is restart-safe in the sense that it does not blindly restart from phase 0.

- `corp.js` checks:
  - whether the corporation exists,
  - whether `/corp-setup-done.txt` exists,
  - and whether `/corp-setup-phase.txt` says setup is complete.
- `corp-setup.js` updates `/corp-setup-phase.txt` after each completed phase.
- If the corp is missing after an aug install, setup resets to phase 0 and rebuilds from the current state.

That means the scripts are resumable by phase, not just “run once from the top.”

## Chemical funding issue
Chemical is a 70b starting-cost industry in the game data, so 26b is not enough to create it yet.

The practical path is:

- keep setup from forcing Chemical too early,
- let the setup finish with the temporary support chain already in place,
- and let autopilot create Chemical later when funds are high enough.

## Why the offer can fall
While waiting for an investment round, aggressive spending can suppress the next offer. The biggest offenders are:
- morale spending,
- warehouse upgrades,
- and any other nonessential expansion during the wait loop.

Reducing those during the round-1 wait usually improves the offer trajectory more than adding more spending.
