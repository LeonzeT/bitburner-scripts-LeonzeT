export async function main(ns) {
  const scripts = ["hacking/hwgw-weaken.js","hacking/hwgw-grow.js"];
  const hosts   = ["daemon"];
  for (const host of hosts)
    for (const script of scripts)
      if (ns.fileExists(script,"home") && !ns.fileExists(script,host))
        ns.scp(script, host, "home");
}