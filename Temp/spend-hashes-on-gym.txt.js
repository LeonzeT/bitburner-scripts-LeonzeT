import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.hacknet.spendHashes("Improve Gym Training")
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/spend-hashes-on-gym.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }