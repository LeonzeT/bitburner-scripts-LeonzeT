import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    (() => { try { return ns.stock.getSymbols(); } catch { return null; } })()
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/stock-symbols.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }