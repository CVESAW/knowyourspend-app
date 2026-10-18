/**
 * The AI look-up test bench: runs named setups of the AI step (ai.ts) through the kys-llm-eval Edge
 * Function (the API keys stay in Supabase) on the test names in cases.json, then grades them.
 *
 *   node services/lookup/eval/run.mjs <setup> [<setup> …]      run setups, save results-<setup>.json
 *   node services/lookup/eval/run.mjs --report <setup> […]     grade saved results again (no API calls)
 *
 * The token is read from EVAL_TOKEN or ~/.kys-eval-token. CHUNK (default 20) names go per request,
 * CONCURRENCY (default 4) at a time inside the function.
 *
 * Grading: "right" = the country is one truth.json accepts for that name (our list's country unless a
 * hand check changed it, with the source noted there); "wrong" = another country; "declined" = no answer
 * (the app then estimates from where you paid). For names that aren't businesses, any non-answer is right.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const URL_ = "https://cxvwngmnkxtweuwaxfmz.supabase.co/functions/v1/kys-llm-eval";

// The prompt the look-up used before 14 Oct 2026 (Claude Haiku era), kept to compare like with like.
const OLD_SYSTEM = `You identify UK card-payment merchants. Given the merchant name as printed on a UK bank statement (already cleaned), say which business it is and who ultimately controls it (the top parent company, private-equity owner, family holding company, or state) as far as you know. Country = ISO 3166-1 alpha-2 code of where that ultimate owner is run from (operational headquarters).
Rules: If the name is a person, a bank transfer, or too generic to identify (e.g. "CAFE", "SHOP"), set is_business false. If you are not reasonably sure which business it is, use confidence "low". Never invent companies. Reply with ONLY a JSON object: {"is_business": boolean, "brand": string|null, "ultimate_owner": string|null, "owner_country": string|null, "confidence": "high"|"medium"|"low", "reason": string (max 25 words)}`;

const one = { samples: 1, evidence: false, verify: false };
// minAgree 0 and onConflict "model" keep every answer, so other thresholds and policies can be graded offline.
const many = { samples: 5, temperature: 0.7, minAgree: 0, verify: true, onConflict: "model", evidence: false };
export const SETUPS = {
  "old-large3": { ...one, model: "mistral-large-2512", system: OLD_SYSTEM },
  "old-large4": { ...one, model: "mistral-large-4", system: OLD_SYSTEM },
  "v2-large3": { ...one, model: "mistral-large-2512" },
  "v2-large4": { ...one, model: "mistral-large-4" },
  "v2-large4-think": { ...one, model: "mistral-large-4", reasoning: "medium", maxTokens: 4000, timeoutMs: 60000 },
  "v2-medium": { ...one, model: "mistral-medium-3-5" },
  "v2-small": { ...one, model: "mistral-small-2603" },
  "n5-large4": { ...many, model: "mistral-large-4" },
  "n5-large4-ev": { ...many, model: "mistral-large-4", evidence: true, hideExact: true },
  "n5-medium": { ...many, model: "mistral-medium-3-5" },
  // 14 Oct, second round: exact-name owner check, and a second look when the register disagrees
  "ask-large4": { ...many, model: "mistral-large-4", minAgree: 0.6, onConflict: "ask" },
  "ask-large4-ev": { ...many, model: "mistral-large-4", minAgree: 0.6, onConflict: "ask", evidence: true, hideExact: true },
  // What the live look-up runs (AI_DEFAULTS in ai.ts, nothing overridden): five Large 4 answers, then Medium 3.5 with
  // web search, whose answer wins, unless all five agree and a register confirms the owner. Graded as run (asRun),
  // since the vote isn't the last word.
  live: { asRun: true },
  // 17 Oct 2026: the first request for each name (the live look-up counts requests per name): no web search yet for a
  // name the answers call a small local business or can't place. "live" is a later request: the full check.
  "live-first": { asRun: true, seen: 1 },
  // The live setting until 14 Oct: the web search for every business.
  always: { asRun: true, web: "always" },
};
// USD per million tokens (input, output). Approximate: Large 4 and Medium 3.5 prices are from third-party
// listings (Oct 2026); check Mistral's console before relying on them.
const PRICE = { "mistral-large-2512": [0.5, 1.5], "mistral-large-4": [0.68, 2.09], "mistral-medium-3-5": [1.5, 7.5], "mistral-small-2603": [0.15, 0.6] };
const WEB_SEARCH_USD = 0.03; // per web search (Mistral's web_search tool), approximate

const token = process.env.EVAL_TOKEN ?? (existsSync(join(homedir(), ".kys-eval-token")) ? readFileSync(join(homedir(), ".kys-eval-token"), "utf8").trim() : "");
async function call(body) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(URL_, { method: "POST", headers: { "x-eval-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = { error: `HTTP ${r.status}: ${text.slice(0, 200)}` }; }
    if (r.ok) return j;
    if (attempt >= 3) throw new Error(j.error ?? `HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 5000 * attempt));
  }
}

const { cases } = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const truth = existsSync(join(here, "truth.json")) ? JSON.parse(readFileSync(join(here, "truth.json"), "utf8")).names : {};
/** Countries accepted for a case: truth.json's hand check if there is one, else our list's country. */
export const accepted = (c) => (truth[c.name] ? truth[c.name].accept : c.expected === null ? [] : [c.expected]);

/** Decide a row again with other settings, from the answers the function returned. */
export function decide(row, { minAgree = 0.6, policy = "registry", total = 5 } = {}) {
  if (row.decision === "error") return { decision: "error" };
  const s = row.samples ?? [];
  const n = Math.max(total, s.length, 1);
  const notBiz = s.filter((x) => !x.b).length;
  if (notBiz / n > 0.5) return { decision: "not_business" };
  const usable = s.filter((x) => x.b && x.c && x.o && x.k !== "low");
  const by = {};
  for (const x of usable) by[x.c] = (by[x.c] ?? 0) + 1;
  const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] / n < minAgree) return { decision: "declined" };
  let country = top[0];
  if (policy === "ask") {
    // as the function decided at minAgree 0.6; at stricter thresholds only the vote above changes
    if (row.decision !== "found") return { decision: row.decision === "not_business" ? "not_business" : "declined" };
    return { decision: "found", country: row.country };
  }
  const reg = row.registry?.country;
  if (reg && reg !== country && row.decision === "found") {
    if (policy === "registry") country = reg;
    else if (policy === "decline") return { decision: "declined", conflict: true };
  }
  return { decision: "found", country };
}

export function grade(c, d) {
  if (truth[c.name]?.skip) return "skip";
  if (d.decision === "error") return "error";
  const ok = accepted(c);
  // "local" (since 17 Oct 2026): the app counts it where it was paid, the bank's country (GB on the bench)
  if (d.decision === "local") return !ok.length || ok.includes("GB") ? "right" : "wrong";
  if (!ok.length) return d.decision === "found" ? "wrong" : "right";
  if (d.decision !== "found") return "declined";
  return ok.includes(d.country) ? "right" : "wrong";
}

function tally(rows, cfg) {
  const t = { right: 0, wrong: 0, declined: 0, error: 0, skip: 0, n: rows.length };
  for (const r of rows) t[grade(r, cfg ? decide(r, cfg) : { decision: r.decision, country: r.country })]++;
  return t;
}
const fmt = (t) => `right ${String(t.right).padStart(3)}  wrong ${String(t.wrong).padStart(3)}  declined ${String(t.declined).padStart(3)}${t.error ? `  errors ${t.error}` : ""}`;

function report(name, saved) {
  const { setup, rows } = saved;
  const ok = rows.filter((r) => r.usage);
  const avg = (f) => ok.reduce((a, r) => a + f(r), 0) / Math.max(ok.length, 1);
  if (setup.asRun) {
    // the live defaults: tokens priced as Large 4 (the web step's Medium 3.5 tokens cost more), plus the searches
    const p = PRICE["mistral-large-4"], searches = avg((r) => r.usage.searches ?? 0);
    const cost = ((avg((r) => r.usage.in) * p[0] + avg((r) => r.usage.out) * p[1]) / 1e6 + searches * WEB_SEARCH_USD) * 1000;
    const ms = ok.map((r) => r.ms ?? 0).sort((a, b) => a - b), pct = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] / 1000;
    console.log(`\n== ${name}  (the live defaults${setup.web ? `, web "${setup.web}"` : ""}${setup.seen ? `, as request ${setup.seen} for each name` : ""})`);
    console.log(`   median ${pct(0.5).toFixed(1)} s, 90th percentile ${pct(0.9).toFixed(1)} s; ${avg((r) => r.usage.web ?? 0).toFixed(2)} web checks and ${searches.toFixed(2)} searches a name; ~$${cost.toFixed(0)} per 1,000 names`);
    const locals = rows.filter((r) => r.decision === "local");
    if (locals.length) console.log(`   ${locals.length} answered "a small local business": ${locals.map((r) => r.name).join(", ")}`);
  } else {
    const p = PRICE[setup.model];
    const cost = p ? ((avg((r) => r.usage.in) * p[0] + avg((r) => r.usage.out) * p[1]) / 1e6) * 1000 : NaN;
    console.log(`\n== ${name}  (${setup.model}, ${setup.samples} answer${setup.samples > 1 ? "s" : ""}${setup.evidence ? ", evidence" : ""}${setup.verify ? ", owner check" : ""}${setup.reasoning ? `, reasoning ${setup.reasoning}` : ""})`);
    console.log(`   avg ${(avg((r) => r.ms ?? 0) / 1000).toFixed(1)} s, ${Math.round(avg((r) => r.usage.in))} in / ${Math.round(avg((r) => r.usage.out))} out tokens, ~$${cost.toFixed(2)} per 1,000 names`);
  }
  if (setup.samples > 1 && !setup.asRun) {
    for (const minAgree of [0.6, 0.8, 1]) for (const policy of setup.onConflict === "ask" ? ["ask", "decline"] : ["model", "registry", "decline"]) {
      console.log(`   agree ≥${String(minAgree).padEnd(3)} ${policy.padEnd(8)} ${fmt(tally(rows, { minAgree, policy, total: setup.samples }))}`);
    }
  } else {
    console.log(`   ${"as run".padEnd(21)} ${fmt(tally(rows))}`);
  }
  for (const set of ["known-chains", "owned-brands", "not-a-business", "local-independents"]) {
    const rs = rows.filter((r) => r.set === set);
    const cfg = setup.samples > 1 && !setup.asRun ? { minAgree: 0.6, policy: setup.onConflict === "ask" ? "ask" : "decline", total: setup.samples } : null;
    console.log(`     ${set.padEnd(15)} ${fmt(tally(rs, cfg))}`);
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const args = isMain ? process.argv.slice(2) : [];
if (!isMain) {
  // imported by another script (combine.mjs): nothing to run
} else if (args[0] === "--report") {
  for (const name of args.slice(1)) report(name, JSON.parse(readFileSync(join(here, `results-${name}.json`), "utf8")));
} else {
  if (!token) { console.error("Set EVAL_TOKEN (or put it in ~/.kys-eval-token)"); process.exit(1); }
  const chunk = Number(process.env.CHUNK || 20), conc = Number(process.env.CONCURRENCY || 4);
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
  const todo = only ? cases.filter((c) => only.has(c.name)) : cases;
  for (const name of args) {
    const setup = SETUPS[name];
    if (!setup) { console.error(`unknown setup ${name}; known: ${Object.keys(SETUPS).join(", ")}`); continue; }
    const t0 = Date.now();
    const rows = [];
    for (let i = 0; i < todo.length; i += chunk) {
      const j = await call({ action: "run", options: setup, seen: setup.seen, cases: todo.slice(i, i + chunk), concurrency: conc, today: "2026-10-14" });
      rows.push(...j.rows);
      process.stderr.write(`${name}: ${rows.length}/${todo.length}\r`);
    }
    const saved = { ran: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), setup: { ...setup, system: setup.system ? "(old prompt)" : undefined }, rows };
    writeFileSync(join(here, `results-${name}.json`), JSON.stringify(saved, null, 1));
    report(name, saved);
  }
}
