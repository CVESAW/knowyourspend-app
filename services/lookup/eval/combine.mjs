// Offline: pool the answers of two five-answer runs (independent calls) and grade agreement rules.
import { readFileSync } from "node:fs";
import { accepted, grade } from "./run.mjs";
const [a, b] = process.argv.slice(2);
const load = (s) => new Map(JSON.parse(readFileSync(`results-${s}.json`, "utf8")).rows.map((r) => [r.name, r]));
const A = load(a), B = load(b);
const { cases } = JSON.parse(readFileSync("cases.json", "utf8"));
const topOf = (samples) => { const by = {}; for (const x of samples) if (x.b && x.c && x.o && x.k !== "low") by[x.c] = (by[x.c] ?? 0) + 1; const t = Object.entries(by).sort((p, q) => q[1] - p[1])[0]; return t ? { c: t[0], k: t[1] } : null; };
function decidePooled(ra, rb, rule) {
  const sa = ra.samples ?? [], sb = rb.samples ?? [];
  const all = [...sa, ...sb], n = 10;
  if (all.filter((x) => !x.b).length / n > 0.5) return { decision: "not_business" };
  const ta = topOf(sa), tb = topOf(sb), tp = topOf(all);
  let country;
  if (rule.kind === "pooled") { if (!tp || tp.k / n < rule.min) return { decision: "declined" }; country = tp.c; }
  else { if (!ta || !tb || ta.c !== tb.c || ta.k / 5 < rule.min || tb.k / 5 < rule.min) return { decision: "declined" }; country = ta.c; }
  const reg = [ra, rb].map((r) => (r.decision === "found" && r.country === country ? r.registry?.country : r.registry && r.conflict?.model === country ? r.registry.country : null)).find(Boolean);
  if (reg && reg !== country) { if (rule.policy === "registry") country = reg; else if (rule.policy === "decline") return { decision: "declined" }; }
  return { decision: "found", country };
}
const rules = [];
for (const min of [0.6, 0.7, 0.8, 0.9, 1]) for (const policy of ["registry", "decline"]) rules.push({ kind: "pooled", min, policy });
for (const min of [0.6, 0.8, 1]) for (const policy of ["registry", "decline"]) rules.push({ kind: "both", min, policy });
for (const rule of rules) {
  const t = { right: 0, wrong: 0, declined: 0, skip: 0, error: 0 }, wrongs = [];
  for (const c of cases) { const ra = A.get(c.name), rb = B.get(c.name); if (!ra || !rb) continue; const d = decidePooled(ra, rb, rule); const g = grade(c, d); t[g]++; if (g === "wrong") wrongs.push(`${c.name}→${d.country}`); }
  console.log(`${rule.kind.padEnd(6)} ≥${String(rule.min).padEnd(3)} ${rule.policy.padEnd(8)} right ${t.right}  wrong ${t.wrong}  declined ${t.declined}   ${wrongs.join(", ")}`);
}
