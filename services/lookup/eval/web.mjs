import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const token = readFileSync(`${homedir()}/.kys-eval-token`, "utf8").trim();
const names = process.argv.slice(2);
const model = process.env.MODEL || "mistral-medium-latest";
for (let i = 0; i < names.length; i += 5) {
  const r = await fetch("https://cxvwngmnkxtweuwaxfmz.supabase.co/functions/v1/kys-llm-eval", { method: "POST", headers: { "x-eval-token": token, "content-type": "application/json" }, body: JSON.stringify({ action: "web", names: names.slice(i, i + 5), options: { webModel: model }, today: "2026-10-14" }) });
  const j = await r.json();
  for (const x of j.results ?? [j]) console.log(JSON.stringify({ name: x.name, ms: x.ms, err: x.error, ans: x.answer && { o: x.answer.owner, c: x.answer.country, k: x.answer.confidence, r: x.answer.reason }, searches: x.searches, refs: (x.refs ?? []).slice(0, 3).map((r) => r.url), usage: x.usage, raw: x.answer ? undefined : x.raw?.slice(0, 200) }));
}
