import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    [...Array(ns.hacknet.numNodes()).keys()].map(i => ns.hacknet.getNodeStats(i)).reduce(([l, r, c], s) => [l + s.level, r + s.ram, c + s.cores], [0, 0, 0])
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/hacknet-Netburners-stats.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }