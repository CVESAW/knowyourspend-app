// Re-runs the names that errored in results-web-medium.json, one request at a time, and merges them back.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
const token = readFileSync(`${homedir()}/.kys-eval-token`, "utf8").trim();
const file = process.env.OUT || "results-web-medium.json";
const saved = JSON.parse(readFileSync(file, "utf8"));
const todo = saved.rows.filter((r) => r.error);
let done = 0;
for (let i = 0; i < todo.length; i += 5) {
  const ch = todo.slice(i, i + 5);
  const r = await fetch("https://cxvwngmnkxtweuwaxfmz.supabase.co/functions/v1/kys-llm-eval", { method: "POST", headers: { "x-eval-token": token, "content-type": "application/json" }, body: JSON.stringify({ action: "web", names: ch.map((c) => c.name), options: { webModel: saved.model }, today: "2026-10-14" }) });
  const j = await r.json().catch(() => ({ results: [] }));
  for (const x of j.results ?? []) { const k = saved.rows.findIndex((y) => y.name === x.name); const { error, ...base } = saved.rows[k]; saved.rows[k] = { ...base, ...x }; }
  done += ch.length;
  writeFileSync(file, JSON.stringify(saved, null, 1));
  process.stderr.write(`redo ${done}/${todo.length}, still failing ${saved.rows.filter((x) => x.error).length}\r`);
  await new Promise((res) => setTimeout(res, 3000));
}
const s = saved.rows.reduce((a, r) => a + (r.searches ?? 0), 0);
console.log(`\nerrors left ${saved.rows.filter((r) => r.error).length}; ${s} searches in all (~$${(s * 0.03).toFixed(2)})`);
