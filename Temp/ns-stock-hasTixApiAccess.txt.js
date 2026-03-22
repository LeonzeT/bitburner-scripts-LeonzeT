import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.stock.hasTixApiAccess()
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/ns-stock-hasTixApiAccess.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }