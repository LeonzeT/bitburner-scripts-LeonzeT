import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.bladeburner.inBladeburner()
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/ns-bladeburner-inBladeburner.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }