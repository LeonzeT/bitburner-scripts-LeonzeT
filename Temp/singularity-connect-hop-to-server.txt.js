import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.args.reduce((success, hop) => success && ns.singularity.connect(hop), true)
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/singularity-connect-hop-to-server.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }