import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    Object.fromEntries(ns.args.map(s => [s, ns.getScriptRam(s, 'home')]))
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/script-costs.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }