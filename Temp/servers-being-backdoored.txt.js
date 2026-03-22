import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.ps().filter(script => script.filename == ns.args[0]).map(script => script.args[0])
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/servers-being-backdoored.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }