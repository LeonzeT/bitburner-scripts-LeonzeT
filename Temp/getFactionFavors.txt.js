import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    Object.fromEntries(ns.args.map(o => [o, ns.singularity.getFactionFavor(o)]))
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/getFactionFavors.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }