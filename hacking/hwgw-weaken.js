/**
 * hwgw-weaken.js — Single-shot weaken worker for HWGW batching.
 *
 * Waits for its scheduled delay, fires one weaken() call, then exits.
 * Weaken is the slowest operation and serves as the timing reference —
 * W1 is the first to land (sets the baseline), W2 lands last to clean
 * up security raised by grow. Both use this same script.
 *
 * Args:
 *   ns.args[0]  {string}  target   — hostname of the server to weaken
 *   ns.args[1]  {number}  delay    — milliseconds to wait before firing
 *   ns.args[2]  {number}  batchId  — batch identifier (for desync detection)
 *   ns.args[3]  {string}  role     — "W1" or "W2" for batch workers, "PREP" for prep workers
 *
 * Weaken does not support stock manipulation ({stock:true} is not a valid
 * option for ns.weaken()), so no stockFlag arg is needed.
 *
 * RAM cost: ~1.75 GB
 */

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("weaken");
    ns.disableLog("sleep");

    const [target, delay, batchId, role] = ns.args;

    if (!target) {
        ns.tprint("ERROR hwgw-weaken: no target specified.");
        return;
    }

    if (delay > 0) await ns.sleep(delay);

    // ns.weaken() returns the security decrease applied to the server.
    const securityDecrease = await ns.weaken(target);

    const port = ns.getPortHandle(1);
    // Don't signal the batcher port for prep workers — they use role='PREP'
    // and batchId=-1, which the batcher would count as anomalies.
    if (role !== 'PREP') {
        const message = `${role}:${batchId}:${securityDecrease.toFixed(6)}:${target}`;
        if (!port.tryWrite(message)) {
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline) {
                await ns.sleep(25);
                if (port.tryWrite(message)) return;
            }
            ns.print(`WARN hwgw-weaken: completion port stayed full for batch ${batchId} on ${target}`);
        }
    }
}
