import { jsonReplacer } from 'helpers.js'
export async function main(ns) { let r;try{r=JSON.stringify(
    ns.sleeve.setToGymWorkout(ns.args[0], ns.args[1], ns.args[2])
, jsonReplacer);}catch(e){r="ERROR: "+(typeof e=='string'?e:e?.message??JSON.stringify(e));}
const f="/Temp/sleeve-setToGymWorkout.txt"; if(ns.read(f)!==r) ns.write(f,r,'w') }