// Runs the web-search ask (kys-llm-eval "web") on every test name, 5 per request, PAR requests at a time.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
const token = readFileSync(`${homedir()}/.kys-eval-token`, "utf8").trim();
const model = process.env.MODEL || "mistral-medium-latest", par = Number(process.env.PAR || 6), out = process.env.OUT || "results-web-medium.json";
const { cases } = JSON.parse(readFileSync("cases.json", "utf8"));
const chunks = []; for (let i = 0; i < cases.length; i += 5) chunks.push(cases.slice(i, i + 5));
const rows = []; let k = 0;
async function worker() {
  while (k < chunks.length) {
    const ch = chunks[k++];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch("https://cxvwngmnkxtweuwaxfmz.supabase.co/functions/v1/kys-llm-eval", { method: "POST", headers: { "x-eval-token": token, "content-type": "application/json" }, body: JSON.stringify({ action: "web", names: ch.map((c) => c.name), options: { webModel: model }, today: "2026-10-14" }) });
        const j = await r.json();
        for (const x of j.results) { const c = ch.find((y) => y.name === x.name); rows.push({ ...c, ...x }); }
        break;
      } catch (e) { if (attempt === 3) for (const c of ch) rows.push({ ...c, error: String(e) }); }
    }
    process.stderr.write(`web: ${rows.length}/${cases.length}\r`);
  }
}
await Promise.all(Array.from({ length: par }, worker));
writeFileSync(out, JSON.stringify({ ran: new Date().toISOString(), model, rows }, null, 1));
const s = rows.reduce((a, r) => a + (r.searches ?? 0), 0), ms = rows.reduce((a, r) => a + (r.ms ?? 0), 0);
console.log(`\n${rows.length} names, ${s} searches (${(s / rows.length).toFixed(2)} a name, ~$${(s * 0.03).toFixed(2)}), avg ${(ms / rows.length / 1000).toFixed(1)} s, errors ${rows.filter((r) => r.error).length}`);
