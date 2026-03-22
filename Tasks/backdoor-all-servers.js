import { getNsDataThroughFile, getFilePath, getConfiguration, instanceCount, log, getErrorInfo } from '../helpers.js'

const argsSchema = [
    ['reserved-home-ram', 22], // Don't launch if home free ram is below this (backdoor-one.js costs ~3.6 GB)
];

export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

/** Scan all servers, backdoor anything that can be backdoored.
 * Requires: SF-4.1
 * @param {NS} ns **/
export async function main(ns) {
    let notAtHome = false;
    try {
        const options = getConfiguration(ns, argsSchema);

        if (await instanceCount(ns, "home", false, false) > 1)
            return log(ns, 'Another instance is already running. Shutting down...');

        // ── BFS network scan using ns.scan() directly (0.2 GB, no temp scripts) ──────
        // Original used getNsDataThroughFile(ns.scan) per hop — one temp-script
        // round-trip per server (~70+ for a full network). Direct ns.scan() is
        // free to call in a loop and avoids all that overhead.
        ns.disableLog('scan');
        const servers = ['home'];
        const routes  = { home: ['home'] };
        for (let i = 0; i < servers.length; i++) {
            for (const neighbor of ns.scan(servers[i])) {
                if (!servers.includes(neighbor)) {
                    servers.push(neighbor);
                    routes[neighbor] = [...routes[servers[i]], neighbor];
                }
            }
        }

        const myHackingLevel = ns.getHackingLevel();

        // Filter out home, hacknet nodes, and purchased servers
        const hackableServers = servers.filter(s =>
            s !== 'home' && !s.startsWith('hacknet-') && !s.startsWith('daemon'));

        // Batch-fetch required hacking level, root status, and backdoor status in
        // three temp-script calls instead of per-server calls
        const dictReqLevel = await getNsDataThroughFile(ns,
            `Object.fromEntries(ns.args.map(server => [server, ns.getServerRequiredHackingLevel(server)]))`,
            '/Temp/getServerRequiredHackingLevel-all.txt', hackableServers);
        const dictRooted   = await getNsDataThroughFile(ns,
            `Object.fromEntries(ns.args.map(server => [server, ns.hasRootAccess(server)]))`,
            '/Temp/hasRootAccess-all.txt', hackableServers);
        const dictBackdoor = await getNsDataThroughFile(ns,
            `ns.args.filter(server => !ns.getServer(server).backdoorInstalled)`,
            '/Temp/getServers-where-not-backdoorInstalled.txt', hackableServers);

        ns.print(`${hackableServers.length} world servers found.`);

        // Filter to servers that need backdooring and that we can currently do
        // dictBackdoor is an array of servers that still need backdooring (original filter shape)
        const needsBackdoor = new Set(dictBackdoor);
        let toBackdoor = hackableServers.filter(s =>
            needsBackdoor.has(s) &&
            dictRooted[s] &&
            myHackingLevel > dictReqLevel[s]);

        ns.print(`${toBackdoor.length} servers need backdooring and are within reach.`);
        if (toBackdoor.length === 0) return;

        // Sort by required hacking level — easiest first
        toBackdoor.sort((a, b) => dictReqLevel[a] - dictReqLevel[b]);
        ns.print(`Order: ${toBackdoor.join(', ')}`);

        // Check home RAM once before the loop — avoids a temp-script call per server
        const homeFreeRam = ns.getServerMaxRam('home') - ns.getServerUsedRam('home');
        if (homeFreeRam < options['reserved-home-ram'])
            return log(ns, `WARNING: Home is low on RAM (${homeFreeRam.toFixed(0)} GB free, need ${options['reserved-home-ram']} GB). Aborting.`);

        const scriptPath = getFilePath('/Tasks/backdoor-all-servers.js.backdoor-one.js');

        // Skip servers already being backdoored by a prior run still in progress
        const serversBeingBackdoored = await getNsDataThroughFile(ns,
            'ns.ps().filter(script => script.filename == ns.args[0]).map(script => script.args[0])',
            '/Temp/servers-being-backdoored.txt', [scriptPath]);

        for (const server of toBackdoor) {
            if (serversBeingBackdoored.includes(server)) {
                log(ns, `INFO: ${server} already being backdoored by a prior instance, skipping.`);
                continue;
            }

            // Navigate to the target server
            notAtHome = true;
            const success = await getNsDataThroughFile(ns,
                'ns.args.reduce((success, hop) => success && ns.singularity.connect(hop), true)',
                '/Temp/singularity-connect-hop-to-server.txt', routes[server]);

            if (!success) {
                log(ns, `ERROR: Could not navigate to ${server}. Skipping.`, true, 'error');
                await getNsDataThroughFile(ns, 'ns.singularity.connect(ns.args[0])', null, ['home']);
                notAtHome = false;
                continue;
            }

            if (server === 'w0r1d_d43m0n') {
                ns.alert('Ready to hack w0r1d_d43m0n!');
                log(ns, 'INFO: Sleeping forever to avoid duplicate w0r1d_d43m0n navigations.');
                while (true) await ns.sleep(10000);
            }

            ns.print(`Installing backdoor on "${server}"...`);

            // Launch backdoor-one.js while we are still connected to the target.
            // IMPORTANT: we must wait for installBackdoor() to actually finish before
            // connecting back home — installTime = hackingTime/4, which can be seconds.
            // The original script used a fixed 50ms delay and then immediately navigated
            // home, silently cancelling the backdoor mid-install on any non-trivial server.
            // Fix: wait for backdoor-one.js to finish running (pid exits) before leaving.
            const pid = ns.run(scriptPath, { temporary: true }, server);
            if (pid === 0) {
                log(ns, `WARN: Could not start backdoor of "${server}" (insufficient RAM?). Skipping.`, false, 'warning');
                await getNsDataThroughFile(ns, 'ns.singularity.connect(ns.args[0])', null, ['home']);
                notAtHome = false;
                continue;
            }

            // Poll until backdoor-one.js finishes. It exits as soon as installBackdoor()
            // resolves (success or error), so this wait is exactly as long as needed.
            // Timeout of 10 minutes covers the worst-case low-level hack time.
            const deadline = Date.now() + 10 * 60 * 1000;
            while (ns.isRunning(pid) && Date.now() < deadline)
                await ns.sleep(200);

            if (ns.isRunning(pid)) {
                log(ns, `WARNING: Backdoor of "${server}" timed out after 10 minutes. Killing and continuing.`, false, 'warning');
                ns.kill(pid);
            }

            // Navigate back home before moving to the next server
            const backAtHome = await getNsDataThroughFile(ns, 'ns.singularity.connect(ns.args[0])', null, ['home']);
            if (backAtHome) notAtHome = false;
        }
    } catch (err) {
        log(ns, `ERROR: ${ns.getScriptName()} caught an unexpected error:\n${getErrorInfo(err)}`, false, 'error');
    } finally {
        if (notAtHome)
            await getNsDataThroughFile(ns, 'ns.singularity.connect(ns.args[0])', null, ['home']);
    }
}