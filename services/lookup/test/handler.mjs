// The live handler (kys-lookup.ts) with a stand-in database and Mistral: a request from an Irish bank (answers kept per
// country, web-checked AI answers for a year, Companies House not used), then Mistral out of credit and today's AI
// limit reached (nothing kept, so the names are tried again later), then how long other AI answers are kept. Uses
// Wikidata and GLEIF for real.
// Run: node services/lookup/test/handler.mjs
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kys-handler-"));
for (const f of ["kys-lookup.ts", "lookup.ts", "registries.ts", "ai.ts"]) cpSync(join(here, "..", f), join(dir, f));
writeFileSync(join(dir, "kys-lookup.ts"), readFileSync(join(dir, "kys-lookup.ts"), "utf8").replace("npm:@supabase/supabase-js@2", "./fake-db.mjs"));
writeFileSync(join(dir, "fake-db.mjs"), `export const log = [];
export const state = { usage: null, webCount: 3, cache: [] };
const q = (table) => {
  const filters = [];
  const api = {
    select() { return api; }, eq(c, v) { filters.push([c, v]); return api; }, in(c, v) { filters.push([c, v]); return api; },
    async maybeSingle() { return { data: table === "kys_usage_counts" ? { count: state.webCount } : state.usage }; },
    then(res) {
      // the request counts: unknown unless a test sets state.seen (1 = a name nobody has asked about yet)
      if (table === "kys_lookup_names") {
        const names = filters.find(([c]) => c === "name")?.[1] ?? [];
        return Promise.resolve(state.seen == null ? { data: null, error: { message: "stand-in: no count" } } : { data: state.seen === 1 ? [] : names.map((name) => ({ name, requests: state.seen - 1 })) }).then(res);
      }
      return Promise.resolve({ data: table === "kys_lookup_cache" ? state.cache : [] }).then(res);
    },
    async upsert(rows) { log.push(["upsert", table, rows.map((r) => [r.key, r.via, r.tier, Math.ceil((Date.parse(r.expires_at) - Date.now()) / 864e5 - 1e-6), r.updated_at, r.expires_at])]); return {}; },
  };
  return api;
};
export const createClient = () => ({ from: q, rpc: async (fn, args) => {
  log.push(["rpc", fn, args]);
  return {};
} });
`);

const ok = (c, m) => { if (!c) process.exitCode = 1; console.log(c ? "ok  " : "FAIL", m); };
const env = { MISTRAL_API_KEY: "x", DAILY_WEB_CAP: "200", DAILY_LLM_CAP: "100" };
globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { globalThis.__handler = h; } };
const realFetch = globalThis.fetch;
let mode = "ok", chat = 0, web = 0;
const answer = (o, c) => JSON.stringify({ is_business: true, brand: "Zzq Shop", ultimate_owner: o, owner_type: "private_company", owner_country: c, confidence: "high", match: null, reason: "r" });
const localAnswer = JSON.stringify({ is_business: true, brand: "Zzq Cafe", ultimate_owner: null, owner_type: "unknown", owner_country: null, confidence: "low", scale: "local", match: null, reason: "A small café." });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!u.includes("api.mistral.ai")) return realFetch(url, init);
  if (mode === "402") { chat++; return new Response(JSON.stringify({ object: "error", message: "Out of credits", type: "billing_error" }), { status: 402 }); }
  if (u.endsWith("/chat/completions")) {
    chat++;
    const b = JSON.parse(init.body);
    const said = mode === "person" ? JSON.stringify({ is_business: false, brand: null, ultimate_owner: null, owner_type: "unknown", owner_country: null, confidence: "high", match: null, reason: "A person's name." }) : mode === "frasers" ? answer("Frasers Group", "GB") : mode === "local" ? localAnswer : answer("Zzq Holdings Made Up", "IE");
    return new Response(JSON.stringify({ choices: Array.from({ length: b.n }, () => ({ message: { content: said } })), usage: {} }), { status: 200 });
  }
  web++;
  const said = mode === "low" ? JSON.stringify({ is_business: true, brand: "Zzq Shop", ultimate_owner: null, owner_type: "unknown", owner_country: null, confidence: "low", match: null, reason: "r" }) : mode === "local" ? localAnswer : answer("Frasers Group", "GB");
  return new Response(JSON.stringify({ outputs: [{ type: "tool.execution", name: "web_search" }, { type: "message.output", content: [{ type: "text", text: said }] }], usage: {} }), { status: 200 });
};
const { log, state } = await import(pathToFileURL(join(dir, "fake-db.mjs")).href);
await import(pathToFileURL(join(dir, "kys-lookup.ts")).href);
const ask = async (merchants, country, again) => (await globalThis.__handler(new Request("https://x/", { method: "POST", headers: { "content-type": "application/json", origin: "https://knowyourspend-app.vercel.app" }, body: JSON.stringify({ merchants, country, ...(again ? { again } : {}) }) }))).json();

// 1. An Irish bank, names no register knows: the web-checked AI answer is kept for a year under "IE:".
let j = await ask(["ZZQ SHOP ONE", "ZZQ SHOP TWO"], "IE");
const up = log.find((l) => l[0] === "upsert");
ok(j.results.every((r) => r.status === "RESOLVED" && r.via === "llm" && r.entry.owner_country === "GB"), `Irish bank: ${j.results.map((r) => `${r.query} ${r.status} ${r.entry?.owner_country}`).join(", ")}`);
ok(up && up[2].every(([k, via, tier, days]) => k.startsWith("IE:") && via === "llm" && tier === "LLM_GUESS" && days === 365), `kept as ${JSON.stringify(up?.[2])}`);
ok(j.results.every((r) => r.trace.some((s) => s.step === "companies_house" && s.status === "skipped") && r.trace.some((s) => s.step === "reference_list" && s.status === "skipped")), "Companies House and our UK list not used for a bank outside the UK");
ok(log.filter((l) => l[1] === "kys_count").length === web && web === 2, `web checks counted (${web})`);

// 2. Mistral out of credit: no more calls after the first ones, nothing kept, an error step so the app asks again later.
log.length = 0; mode = "402"; chat = 0;
j = await ask(["ZZQ SHOP 1", "ZZQ SHOP 2", "ZZQ SHOP 3", "ZZQ SHOP 4", "ZZQ SHOP 5", "ZZQ SHOP 6", "ZZQ SHOP 7", "ZZQ SHOP 8"]);
ok(chat <= 4 && j.results.every((r) => r.status === "UNRESOLVED" && r.trace.some((s) => s.step === "llm" && s.status === "error")), `out of credit: ${chat} Mistral calls for 8 names; "${j.results[7].trace.find((s) => s.step === "llm").detail}"`);
ok(!log.some((l) => l[0] === "upsert") && j.sources.ai === false, "out of credit: nothing kept, sources.ai false");
ok(log.find((l) => l[1] === "kys_bump_usage")?.[2].p_llm === chat, "out of credit: AI calls counted");
ok(!log.some((l) => l[1] === "kys_count_names"), "out of credit: no name counted (none was answered)");

// 3. Today's AI limit reached: no Mistral calls at all, nothing kept.
log.length = 0; mode = "ok"; chat = 0; state.usage = { llm_calls: 100, ch_calls: 0 };
j = await ask(["ZZQ SHOP 9"]);
ok(chat === 0 && !log.some((l) => l[0] === "upsert") && /limit/.test(j.results[0].trace.find((s) => s.step === "llm").detail), `limit reached: "${j.results[0].trace.find((s) => s.step === "llm").detail}"`);

// 4. The web search answers but isn't sure: the vote's answer is used, and kept 30 days (it had its web check).
log.length = 0; state.usage = null; mode = "low"; web = 0;
j = await ask(["ZZQ SHOP 10"], "IE");
const up4 = log.find((l) => l[0] === "upsert");
ok(j.results[0].status === "RESOLVED" && j.results[0].entry.owner_country === "IE" && up4?.[2][0][3] === 30, `web not sure → the vote's answer (${j.results[0].entry?.owner_country}), kept ${up4?.[2][0][3]} days`);

// 5. A name the AI couldn't place, kept from earlier today: answered from the cache, no Mistral call.
log.length = 0; mode = "ok"; chat = 0; web = 0;
const at = new Date().toISOString();
state.cache = [{ key: "ZZQ SHOP 11", expires_at: new Date(Date.now() + 864e5).toISOString(), result: { query: "ZZQ SHOP 11", status: "UNRESOLVED", looked_up_at: at, trace: [{ step: "cache", status: "not_found", detail: "Not looked up before." }, { step: "llm", status: "rejected", detail: "AI wasn't sure enough (r)." }] } }];
j = await ask(["ZZQ SHOP 11"]);
ok(chat === 0 && web === 0 && j.results[0].status === "UNRESOLVED" && j.results[0].trace[0].step === "cache" && j.results[0].trace[0].status === "found", `kept "no owner found" served from the cache: "${j.results[0].trace[0].detail}"`);
state.cache = [];

// 6. Today's web limit reached: the vote's answer is used, and kept only 3 days so it gets its web check soon.
log.length = 0; mode = "ok"; chat = 0; web = 0; state.webCount = 200;
j = await ask(["ZZQ SHOP 12"], "IE");
const up6 = log.find((l) => l[0] === "upsert");
ok(web === 0 && j.results[0].status === "RESOLVED" && j.results[0].entry.owner_country === "IE" && up6?.[2][0][3] === 3, `web limit reached → the vote's answer (${j.results[0].entry?.owner_country}), kept ${up6?.[2][0][3]} days`);
state.webCount = 3;

// 7. The AI says it isn't a business: kept 30 days, as long as the app waits before asking again.
log.length = 0; mode = "person"; chat = 0; web = 0;
j = await ask(["ZZQ SHOP 13"]);
const up7 = log.find((l) => l[0] === "upsert");
ok(web === 0 && j.results[0].status === "NOT_A_BUSINESS" && up7?.[2][0][3] === 30, `not a business → kept ${up7?.[2][0][3]} days`);
ok(!log.some((l) => l[1] === "kys_count_names"), "not a business → not counted (it may be someone's name)");

// 8. All five answers agree and the register confirms the owner: no web search, kept a year.
log.length = 0; mode = "frasers"; chat = 0; web = 0;
j = await ask(["ZZQ SHOP 14"]);
const up8 = log.find((l) => l[0] === "upsert");
ok(web === 0 && j.results[0].status === "RESOLVED" && j.results[0].entry.owner_country === "GB" && up8?.[2][0][3] === 365, `unanimous and confirmed → no web, ${j.results[0].entry?.owner_country}, kept ${up8?.[2][0][3]} days`);

// 9. A small local business, the first request for the name: no web search, kept 3 days so a later request checks it.
log.length = 0; mode = "local"; chat = 0; web = 0; state.seen = 1;
j = await ask(["ZZQ CORNER CAFE"]);
const up9 = log.find((l) => l[0] === "upsert");
ok(web === 0 && j.results[0].status === "LOCAL_BUSINESS" && up9?.[2][0][1] === "llm" && up9?.[2][0][3] === 3, `local, first request → no web, ${j.results[0].status}, kept ${up9?.[2][0][3]} days`);
ok(log.some((l) => l[1] === "kys_count_names" && l[2].p_names.includes("ZZQ CORNER CAFE")), "the name is counted once answered");
const days9 = up9?.[2][0][5]?.slice(0, 10);
ok(j.results[0].recheck_after && j.results[0].recheck_after === days9 && up9?.[2][0][4]?.endsWith("T00:00:00.000Z") && up9?.[2][0][5]?.endsWith("T00:00:00.000Z"), `first-request answer: the app is told to ask again on ${j.results[0].recheck_after} (kept until ${days9}); times kept to the day (${up9?.[2][0][4]})`);
ok(/^\d{4}-\d{2}-\d{2}$/.test(j.results[0].looked_up_at) && !j.results[0].checked, `looked_up_at is the day only (${j.results[0].looked_up_at}); not web-checked`);

// 10. …and a later request: the web search finds no owner either, so it's a local business, kept a year.
log.length = 0; chat = 0; web = 0; state.seen = 2;
j = await ask(["ZZQ CORNER CAFE"]);
const up10 = log.find((l) => l[0] === "upsert");
ok(web === 1 && j.results[0].status === "LOCAL_BUSINESS" && up10?.[2][0][3] === 365 && /web search found no owner/.test(j.results[0].trace.find((s) => s.step === "llm").detail), `local, later request → web, ${j.results[0].status}, kept ${up10?.[2][0][3]} days`);
ok(j.results[0].checked === "web" && !j.results[0].recheck_after, `…marked web-checked for the app, nothing to ask again (${j.results[0].checked})`);

// 11. The app sends a name again (its answer came before the full check): the same phone asking isn't another
// request, so a name only that phone has asked about stays a first request (no web search), and isn't counted again.
log.length = 0; chat = 0; web = 0; state.seen = 2;
j = await ask(["ZZQ CORNER CAFE"], undefined, ["ZZQ CORNER CAFE"]);
ok(web === 0 && j.results[0].status === "LOCAL_BUSINESS" && !log.some((l) => l[1] === "kys_count_names"), `asked again by the same phone → still a first request, not counted (web ${web}, ${j.results[0].status})`);
// …but once someone else has asked too, asking again gets the full check
log.length = 0; chat = 0; web = 0; state.seen = 3;
j = await ask(["ZZQ CORNER CAFE"], undefined, ["ZZQ CORNER CAFE"]);
ok(web === 1 && j.results[0].checked === "web", `asked again after someone else asked → full check (web ${web})`);
state.seen = undefined;
