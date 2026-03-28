/**
 * darknet-share.js — persistent share loop for darknet servers.
 *
 * Exec'd by darknet-worker.js onto each cracked darknet server.
 * ns.share() blocks for 10 seconds per call, boosting faction rep gain
 * rate proportional to: threads * server.cpuCores * share_power_formula.
 * Loops until killed (e.g. server migrates and crawler re-execs the worker).
 *
 * RAM cost: 1.6 base + 2.4 ns.share = 4.0 GB per instance.
 * Run with as many threads as spare RAM allows for maximum effect.
 *
 * @param {NS} ns
 */
export async function main(ns) {
    ns.disableLog("ALL");
    while (true) {
        await ns.share();
    }
}