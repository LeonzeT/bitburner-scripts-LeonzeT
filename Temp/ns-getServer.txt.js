import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.getServer(ns.args[0]).backdoorInstalled
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/ns-getServer.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }