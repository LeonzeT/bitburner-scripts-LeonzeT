import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.args.filter(server => !ns.getServer(server).backdoorInstalled)
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/getServers-where-not-backdoorInstalled.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }