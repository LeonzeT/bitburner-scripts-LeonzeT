import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.go.analysis.getValidMoves()
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/ns-go-analysis-getValidMoves.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }