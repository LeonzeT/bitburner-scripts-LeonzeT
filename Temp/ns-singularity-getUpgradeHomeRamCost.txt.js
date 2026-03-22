import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.singularity.getUpgradeHomeRamCost()
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/ns-singularity-getUpgradeHomeRamCost.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }