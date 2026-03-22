import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    Object.fromEntries(JSON.parse(ns.args[0]).map(c => [c.contract, ns.codingcontract.getContractType(c.contract, c.hostname)]))
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/contract-types.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }