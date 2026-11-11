// Lists every name where some setup's answer differs from our list, with each setup's owner and country.
import { readFileSync, existsSync } from "node:fs";
const setups = process.argv.slice(2);
const { cases } = JSON.parse(readFileSync("cases.json", "utf8"));
const res = Object.fromEntries(setups.filter((s) => existsSync(`results-${s}.json`)).map((s) => [s, new Map(JSON.parse(readFileSync(`results-${s}.json`, "utf8")).rows.map((r) => [r.name, r]))]));
for (const c of cases) {
  const answers = Object.entries(res).map(([s, m]) => {
    const r = m.get(c.name);
    if (!r) return null;
    const top = r.samples?.length > 1 ? (() => { const by = {}; for (const x of r.samples) if (x.b && x.c && x.k !== "low") by[x.c] = (by[x.c] ?? 0) + 1; return Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}${v}`).join("/"); })() : "";
    return { s, d: r.decision, c: r.country, o: r.owner ?? r.samples?.[0]?.o, top, reg: r.registry?.country };
  }).filter(Boolean);
  const differs = answers.some((a) => a.d === "found" && a.c !== c.expected) || (c.expected === null && answers.some((a) => a.d === "found"));
  if (!differs) continue;
  console.log(`${c.name} | list: ${c.expected} (${c.owner ?? "-"})`);
  for (const a of answers) console.log(`    ${a.s.padEnd(14)} ${a.d === "found" ? `${a.c} ${a.o}` : a.d}${a.top ? `  [${a.top}]` : ""}${a.reg ? `  reg:${a.reg}` : ""}`);
}
