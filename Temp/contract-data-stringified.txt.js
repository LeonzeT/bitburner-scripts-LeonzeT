import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    Object.fromEntries(JSON.parse(ns.args[0]).map(c => [c.contract, JSON.stringify(ns.codingcontract.getData(c.contract, c.hostname), jsonReplacer)]))
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/contract-data-stringified.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }