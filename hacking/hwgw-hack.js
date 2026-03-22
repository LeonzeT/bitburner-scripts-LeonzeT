/**
 * hwgw-hack.js — Single-shot hack worker for HWGW batching.
 *
 * Waits for its scheduled delay, fires one hack() call, then exits.
 * Hack is the fastest operation (~25% of weaken time), so it always
 * gets the largest delay offset — it starts last but lands second
 * in the W1 → H → W2 → G sequence.
 *
 * Args:
 *   ns.args[0]  {string}  target   — hostname of the server to hack
 *   ns.args[1]  {number}  delay    — milliseconds to wait before firing
 *   ns.args[2]  {number}  batchId  — batch identifier (for desync detection)
 *   ns.args[3]  {string}  role     — always "H" for hack workers
 *   ns.args[4]  {number}  stockFlag — 1 to pass {stock:true} to ns.hack() (influences stock price), 0 otherwise
 *
 * A note on hack failure: if the server isn't fully prepped when hack
 * lands (min security, max money), the hack will either steal less than
 * expected or fail entirely. This is how desync cascades — one bad batch
 * leaves the server in a degraded state, which makes the next batch worse,
 * and so on. The orchestrator detects this through the completion port
 * and triggers a prep cycle to recover.
 *
 * RAM cost: ~1.7 GB
 */

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("hack");

    const [target, delay, batchId, role, stockFlag] = ns.args;

    if (!target) {
        ns.tprint("ERROR hwgw-hack: no target specified.");
        return;
    }

    if (delay > 0) await ns.sleep(delay);

    // ns.hack() returns the actual amount of money stolen (or 0 on failure).
    // When stockFlag is set, pass {stock: true} so the hack influences the
    // associated stock's second-order forecast (pushes price down — good for
    // short positions or bearish stocks that stockmaster is tracking).
    const moneyStolen = await ns.hack(target, stockFlag ? { stock: true } : undefined);

    const port = ns.getPortHandle(1);
    port.tryWrite(`${role}:${batchId}:${moneyStolen.toFixed(2)}:${target}`);
}