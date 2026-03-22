import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.scan("The-Cave").includes("w0r1d_d43m0n") ? ns.getServerRequiredHackingLevel("w0r1d_d43m0n"): -1
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/wd-hackingLevel.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }