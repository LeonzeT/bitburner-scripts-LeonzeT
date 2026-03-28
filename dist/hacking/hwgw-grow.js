/**
 * hwgw-grow.js — Single-shot grow worker for HWGW batching.
 *
 * Waits for its scheduled delay, fires one grow() call, then exits.
 * Grow is the second-longest operation (80% of weaken time), so it gets
 * a moderate delay offset — it starts third but lands last in the
 * W1 → H → W2 → G sequence.
 *
 * Args:
 *   ns.args[0]  {string}  target   — hostname of the server to grow
 *   ns.args[1]  {number}  delay    — milliseconds to wait before firing
 *   ns.args[2]  {number}  batchId  — batch identifier (for desync detection)
 *   ns.args[3]  {string}  role     — "G" for grow workers, "PREP" for prep workers
 *   ns.args[4]  {number}  stockFlag — 1 to pass {stock:true} to ns.grow() (influences stock price), 0 otherwise
 *
 * The grow factor reported back tells the orchestrator how much money was
 * restored. A factor near 1.0 means the server was already at max money
 * when grow landed — which means hack didn't steal the expected amount,
 * signaling a potential desync.
 *
 * RAM cost: ~1.75 GB
 */

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("grow");

    const [target, delay, batchId, role, stockFlag] = ns.args;

    if (!target) {
        ns.tprint("ERROR hwgw-grow: no target specified.");
        return;
    }

    if (delay > 0) await ns.sleep(delay);

    // ns.grow() returns the multiplier applied to the server's money.
    // When stockFlag is set, pass {stock: true} so the grow influences the
    // associated stock's second-order forecast (pushes price up — good for
    // long positions or bullish stocks that stockmaster is tracking).
    const growthFactor = await ns.grow(target, stockFlag ? { stock: true } : undefined);

    const port = ns.getPortHandle(1);
    // Don't signal the batcher port for prep workers — they use role='PREP'
    // and batchId=-1, which the batcher would count as anomalies.
    if (role !== 'PREP') port.tryWrite(`${role}:${batchId}:${growthFactor.toFixed(6)}:${target}`);
}
