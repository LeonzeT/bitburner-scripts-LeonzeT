/** @param {NS} ns **/
export async function main(ns) {
    let target = ns.args.length > 0 ? ns.args[0] : '(unspecified server)';
    // Guard: installBackdoor() throws if the server is already backdoored or if we're not
    // connected to it. Check state before attempting so we don't spam error toasts.
    const serverInfo = ns.getServer(target);
    if (serverInfo.backdoorInstalled) {
        ns.print(`INFO: ${target} is already backdoored. Skipping.`);
        return;
    }
    // Also skip purchased servers — they can't be backdoored and will always throw.
    if (serverInfo.purchasedByPlayer) {
        ns.print(`INFO: ${target} is a purchased server. Skipping.`);
        return;
    }
    try {
        await ns.singularity.installBackdoor();
        ns.toast(`Backdoored ${target}`, 'success');
    }
    catch (err) {
        // Swallow "already backdoored" errors that slip through the guard (e.g. race
        // condition if another instance ran concurrently). Re-throw anything else.
        const msg = String(err).toLowerCase();
        if (msg.includes('already') || msg.includes('backdoor')) {
            ns.print(`INFO: ${target} backdoor already installed (caught race condition).`);
        } else {
            ns.tprint(`Error while running backdoor (intended for ${target}): ${String(err)}`);
            throw (err);
        }
    }
}