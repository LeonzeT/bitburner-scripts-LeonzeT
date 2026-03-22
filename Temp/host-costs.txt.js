import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    Object.fromEntries([...Array(30).keys()].map(i => [i, ns.cloud.getServerCost(2**i)]))
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/host-costs.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }