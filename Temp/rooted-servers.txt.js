import { jsonReplacer, scanAllServers } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    scanAllServers(ns).filter(s => ns.hasRootAccess(s))
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/rooted-servers.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }