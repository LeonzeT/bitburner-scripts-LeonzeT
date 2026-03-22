import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    (() => { try { return Object.fromEntries(ns.args.map(sym => [sym, ns.stock.getAskPrice(sym)])); } catch { return null; } })()
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/stock-getAskPrice-all.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }