import { jsonReplacer, scanAllServers } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    scanAllServers(ns)
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/scanAllServers.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }