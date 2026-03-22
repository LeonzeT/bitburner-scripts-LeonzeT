import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    Object.fromEntries(ns.args.map(c => [c, ns.singularity.getCrimeChance(c)]))
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/crime-chances.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }