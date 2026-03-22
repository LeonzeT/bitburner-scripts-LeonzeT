export async function main(ns) {
  const safe = f => { try { return f(); } catch { return undefined; } };
  const d = {};
  try {
    const count = ns.sleeve.getNumSleeves();
    const sleeves = [];
    for (let i = 0; i < count; i++) {
      const s = safe(() => ns.sleeve.getSleeve(i));
      const t = safe(() => ns.sleeve.getTask(i));
      if (!s) continue;
      // Format task description
      let task = "Idle";
      if (t) {
        if (t.type === "CRIME")        task = "Crime: " + (t.crimeType ?? "?");
        else if (t.type === "CLASS")    task = "Class: " + (t.classType ?? "?") + " @ " + (t.location ?? "?");
        else if (t.type === "COMPANY")  task = "Work: " + (t.companyName ?? "?");
        else if (t.type === "FACTION")  task = "Faction: " + (t.factionName ?? "?") + " (" + (t.factionWorkType ?? "?") + ")";
        else if (t.type === "RECOVERY") task = "Shock Recovery";
        else if (t.type === "SYNCHRO")  task = "Synchronize";
        else if (t.type === "BLADEBURNER") task = "Bladeburner: " + (t.actionName ?? "?");
        else if (t.type === "INFILTRATE") task = "Infiltrating";
        else if (t.type === "SUPPORT")  task = "Bladeburner Support";
        else task = t.type ?? "Unknown";
      }
      sleeves.push({
        index: i, task,
        shock: s.shock ?? 0,
        sync:  s.sync  ?? 0,
        str: s.skills?.strength  ?? s.str ?? 0,
        def: s.skills?.defense   ?? s.def ?? 0,
        dex: s.skills?.dexterity ?? s.dex ?? 0,
        agi: s.skills?.agility   ?? s.agi ?? 0,
        hack: s.skills?.hacking  ?? s.hack ?? 0,
        cha: s.skills?.charisma  ?? s.cha ?? 0,
      });
    }
    d.sleeves = sleeves;
  } catch (e) { d.sleeves = []; }
  d._writer = "dashboard-sleeves.js";
  d._ts = Date.now();
  ns.write("/Temp/dash-sleeves-gathered.txt", JSON.stringify(d), "w");
}