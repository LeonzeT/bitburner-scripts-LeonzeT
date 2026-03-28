/**
 * corp/corp.js  —  Corporation entry-point launcher
 *
 * Checks the current corporation state and delegates to the right script:
 *   • corp-setup.js      when the corp hasn't been bootstrapped yet
 *   • corp-autopilot.js  once setup is complete
 *
 * Usage:
 *   run corp/corp.js
 *   run corp/corp.js --force-setup   (re-run setup even if done flag is set)
 *
 * @param {NS} ns
 */
import { log, formatMoney } from '/helpers.js';

const argsSchema = [
    ['force-setup', false],   // Wipe the done flag and re-run setup
    ['no-tail',    false],    // Skip opening a tail window
];

export function autocomplete(data) { data.flags(argsSchema); return []; }

export async function main(ns) {
    const opts = ns.flags(argsSchema);
    ns.disableLog('ALL');
    if (!opts['no-tail']) ns.tail();

    const setupScript     = 'corp/corp-setup.js';
    const autopilotScript = 'corp/corp-autopilot.js';
    const setupDoneFlag   = '/Temp/corp-setup-done.txt';

    // ── No corporation yet ────────────────────────────────────────────────────
    if (!ns.corporation.hasCorporation()) {
        log(ns, 'INFO: No corporation found. Launching corp-setup.js...', true, 'info');
        if (!ns.isRunning(setupScript)) {
            const pid = ns.run(setupScript);
            if (!pid) log(ns, `ERROR: Failed to start ${setupScript} — not enough free RAM?`, true, 'error');
        } else {
            log(ns, 'INFO: corp-setup.js is already running.', true);
        }
        return;
    }

    // ── Corp exists but setup may not be complete ────────────────────────────
    if (opts['force-setup']) ns.write(setupDoneFlag, '', 'w');

    const setupDone = ns.read(setupDoneFlag).trim() === 'true';

    if (!setupDone) {
        if (ns.isRunning(setupScript)) {
            log(ns, 'INFO: corp-setup.js is already running. Waiting for it to finish.', true);
            return;
        }
        log(ns, 'INFO: Setup not complete — launching corp-setup.js to resume.', true, 'info');
        const pid = ns.run(setupScript);
        if (!pid) log(ns, `ERROR: Failed to start ${setupScript} — not enough free RAM?`, true, 'error');
        return;
    }

    // ── Setup complete — hand off to autopilot ────────────────────────────────
    const corp = ns.corporation.getCorporation();
    log(ns, `INFO: "${corp.name}" is up. Revenue: ${formatMoney(corp.revenue)}/s. Launching autopilot...`, true, 'info');

    if (ns.isRunning(autopilotScript)) {
        log(ns, 'INFO: corp-autopilot.js is already running — nothing to do.', true);
        return;
    }

    const pid = ns.run(autopilotScript);
    if (!pid) log(ns, `ERROR: Failed to start ${autopilotScript} — not enough free RAM?`, true, 'error');
}