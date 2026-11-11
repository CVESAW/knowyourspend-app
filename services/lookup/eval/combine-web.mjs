// Offline: combine the five-answer step (tier 1) with the web-search ask, under several rules, and grade them.
import { readFileSync } from "node:fs";
import { decide, grade } from "./run.mjs";
const t1rows = new Map(JSON.parse(readFileSync(process.env.T1 || "results-ask-large4.json", "utf8")).rows.map((r) => [r.name, r]));
const wrows = new Map(JSON.parse(readFileSync(process.env.WEB || "results-web-medium.json", "utf8")).rows.map((r) => [r.name, r]));
const { cases } = JSON.parse(readFileSync("cases.json", "utf8"));
const webDecision = (w) => {
  if (!w || w.error || !w.answer) return { decision: "declined", missing: !w || !!w.error };
  const a = w.answer;
  if (!a.is_business) return { decision: "not_business" };
  if (a.country && a.owner && a.confidence !== "low") return { decision: "found", country: a.country };
  return { decision: "declined" };
};
// unanimous: all five answers name the same country. doubt: an answer took the name for a person or not a business,
// so the live rule doesn't search the web for it.
const unanimous = (r) => { const by = {}; for (const s of r.samples ?? []) if (s.b && s.c && s.o && s.k !== "low") by[s.c] = (by[s.c] ?? 0) + 1; return Math.max(0, ...Object.values(by)) === 5; };
const doubt = (r) => (r.samples ?? []).some((s) => !s.b);
const rules = {
  "tier 1 only": (t, w) => [t, false],
  "web only": (t, w) => [w, true],
  "web when tier 1 isn't confirmed by a register": (t, w, r) => (t.decision === "not_business" ? [t, false] : t.decision === "found" && r.verified && !r.conflict ? [t, false] : [w.decision === "found" || w.decision === "not_business" ? w : t.decision === "found" ? t : w, true]),
  "same, but drop unconfirmed tier 1 when web can't answer": (t, w, r) => (t.decision === "not_business" ? [t, false] : t.decision === "found" && r.verified && !r.conflict ? [t, false] : [w.decision !== "declined" ? w : { decision: "declined" }, true]),
  "web unless all five agree and a register confirms; web wins (live)": (t, w, r) => (t.decision === "not_business" || doubt(r) || (t.decision === "found" && r.verified && !r.conflict && unanimous(r)) ? [t, false] : [w.decision !== "declined" ? w : t, true]),
  "web for every business; web wins": (t, w) => (t.decision === "not_business" ? [t, false] : [w.decision !== "declined" ? w : t, true]),
  "web for every business; register-confirmed answer and web disagree → decline": (t, w, r) => (t.decision === "not_business" ? [t, false] : [t.decision === "found" && r.verified && !r.conflict && w.decision === "found" && w.country !== t.country ? { decision: "declined" } : w.decision !== "declined" ? w : t, true]),
  "web for every business; must agree": (t, w) => (t.decision === "not_business" ? [t, false] : [t.decision === "found" && w.decision === "found" ? (t.country === w.country ? t : { decision: "declined" }) : w.decision === "found" ? w : { decision: "declined" }, true]),
};
for (const minAgree of [0.6, 0.8]) {
  console.log(`\n-- tier 1 at agreement ≥${minAgree} (decline when the register disagrees)`);
  for (const [label, rule] of Object.entries(rules)) {
    const t = { right: 0, wrong: 0, declined: 0, skip: 0, error: 0 }, wrongs = [];
    let webCalls = 0, searches = 0, missing = 0;
    for (const c of cases) {
      const r = t1rows.get(c.name), w = wrows.get(c.name);
      const d1 = decide(r, { minAgree, policy: "decline", total: 5 });
      const dw = webDecision(w);
      const [d, usedWeb] = rule(d1, dw, r);
      if (usedWeb) { webCalls++; searches += w?.searches ?? 0; if (dw.missing) missing++; }
      const g = grade(c, d);
      t[g]++;
      if (g === "wrong") wrongs.push(`${c.name}→${d.country}`);
    }
    console.log(`${label.padEnd(56)} right ${String(t.right).padStart(3)} wrong ${String(t.wrong).padStart(2)} declined ${String(t.declined).padStart(2)} | web asks ${webCalls}, searches ${searches}${missing ? `, ${missing} web answers missing` : ""} | ${wrongs.join(", ")}`);
  }
}
