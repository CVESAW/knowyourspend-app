// @ts-nocheck — plain JavaScript in a .ts file (the look-up was recovered from its deployed bundle on 12 Oct 2026).
// KnowYourSpend ownership look-up — Supabase Edge Function "kys-lookup" (verify_jwt on). Deploy this file as
// index.ts together with lookup.ts, registries.ts and ai.ts. Order for each name: cache → our list →
// Wikidata + GLEIF → Companies House → Wikidata alone → AI estimate.
// 14 Oct 2026: the AI step runs on Mistral AI (ai.ts): five answers that must agree, the owner looked up in
// Wikidata/GLEIF, and Mistral's web search (whose answer wins) unless all five agree and the register confirms the
// owner. Requests may give the bank's country ({ merchants, country }); the default is GB. Secrets: MISTRAL_API_KEY,
// COMPANIES_HOUSE_API_KEY; optional LLM_MODEL, WEB_SEARCH ("unsure", "always", "check", "fallback" or "off"),
// DAILY_LLM_CAP (2,000 names a day), DAILY_CH_CAP (5,000 Companies House calls a day) and DAILY_WEB_CAP (200 web checks
// a day, about $0.06 each).
import { createClient } from "npm:@supabase/supabase-js@2";
import { COUNTRIES, CompaniesHouse, Gleif, Wikidata, normaliseName } from "./registries.ts";
import { cacheKey, lookupName } from "./lookup.ts";
import { AI_DEFAULTS } from "./ai.ts";
var MAX_NAMES = 60, MAX_LEN = 60, DAY = 864e5, WEB_WINDOW = 6e4, TTL = { EXACT_ID: 120 * DAY, NAME_MATCH: 60 * DAY, LLM_GUESS: 30 * DAY, NONE: 7 * DAY }, ALLOWED_ORIGINS = new Set(["https://knowyourspend-app.vercel.app", "https://knowyourspend.vercel.app", "https://knowyourspend.org", "https://www.knowyourspend.org", "https://app.knowyourspend.org", "http://localhost:8081", "http://localhost:3000"]), env = (k) => Deno.env.get(k) ?? "", db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: !1 } });
function cors(origin) {
  let h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
  return origin && ALLOWED_ORIGINS.has(origin) && (h["Access-Control-Allow-Origin"] = origin), h;
}
var reply = (status, body, origin) => new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" } });
async function mapLimit(items, n, f) {
  let out = new Array(items.length), i = 0;
  return await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (; i < items.length; ) {
      let k = i++;
      out[k] = await f(items[k]);
    }
  })), out;
}
// Runs f at most n at a time.
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { f, res, rej } = queue.shift();
    Promise.resolve().then(f).then(res, rej).finally(() => {
      active--;
      next();
    });
  };
  return (f) => new Promise((res, rej) => {
    queue.push({ f, res, rej });
    next();
  });
}
Deno.serve(async (req) => {
  let origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return reply(405, { error: "POST only" }, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) return reply(403, { error: "origin not allowed" }, origin);
  let body;
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: "JSON body required" }, origin);
  }
  if (!Array.isArray(body.merchants)) return reply(400, { error: "merchants must be an array of names" }, origin);
  let names = [...new Set(body.merchants.filter((m) => typeof m == "string").map((m) => normaliseName(m).slice(0, MAX_LEN)).filter((m) => m.length >= 2))];
  if (names.length === 0) return reply(200, { results: [] }, origin);
  if (names.length > MAX_NAMES) return reply(413, { error: `at most ${MAX_NAMES} names per request` }, origin);
  // The bank's country (optional): answers are kept per country outside the UK.
  let country = typeof body.country == "string" && COUNTRIES.has(body.country.toUpperCase()) ? body.country.toUpperCase() : "GB";
  let today = (new Date()).toISOString().slice(0, 10), now = Date.now();
  let { data: usage } = await db.from("kys_lookup_usage").select("llm_calls, ch_calls").eq("day", today).maybeSingle();
  let { data: webRow } = await db.from("kys_usage_counts").select("count").eq("day", today).eq("event", "lookup_web").maybeSingle();
  let llmOk = !!env("MISTRAL_API_KEY"), chOk = !!env("COMPANIES_HOUSE_API_KEY") && (usage?.ch_calls ?? 0) < Number(env("DAILY_CH_CAP") || 5e3);
  // Shared by this request's look-ups: why the AI step is paused (today's limit, or the AI account out of credit), and
  // how many names it was asked about.
  let aiState = { paused: (usage?.llm_calls ?? 0) >= Number(env("DAILY_LLM_CAP") || 2e3) ? "today's limit for AI look-ups has been reached" : null, calls: 0 };
  // Web checks: two at a time, only in the first minute of a request, and up to DAILY_WEB_CAP a day.
  let webCap = Number(env("DAILY_WEB_CAP") || 200), webBefore = webRow?.count ?? 0, webAsked = 0, webUntil = now + WEB_WINDOW;
  let webOk = () => webBefore + webAsked < webCap && Date.now() < webUntil, webLimit = limiter(2);
  let webQueue = (f) => webLimit(() => {
    if (!webOk()) throw new Error("no web check: the daily limit or this request's time for it has run out");
    webAsked++;
    return f();
  });
  // Every outside call ends by 138 s (a register call after 20 s), so answers and counts are saved inside the host's
  // 150-second limit.
  let hardStop = now + 138e3, fetchImpl = (url, init = {}) => {
    let left = hardStop - Date.now();
    if (left < 1e3) return Promise.reject(new Error("no time left on this request"));
    let stop = AbortSignal.timeout(init.signal ? left : Math.min(2e4, left));
    return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, stop]) : stop });
  }, wikidata = new Wikidata(fetchImpl, { retries: 1 }), gleif = new Gleif(fetchImpl), ch = chOk && country === "GB" ? new CompaniesHouse(fetchImpl, env("COMPANIES_HOUSE_API_KEY")) : void 0;
  let keys = names.map((n) => cacheKey(n, country)), plain = names.map((n) => cacheKey(n)), { data: cachedRows } = await db.from("kys_lookup_cache").select("key, result, expires_at").in("key", keys), cached = new Map();
  for (let r of cachedRows ?? []) Date.parse(r.expires_at) > now && cached.set(r.key, r.result);
  let { data: refRows } = await db.from("kys_reference_entries").select("alias, entry").in("alias", plain), reference = new Map((refRows ?? []).map((r) => [r.alias, r.entry]));
  // New names start until 90 s; AI calls end by 125 s, so the request finishes inside the host's 150-second limit.
  let ai = new Map(), webMode = env("WEB_SEARCH") || AI_DEFAULTS.web, deadline = now + 9e4, aiDeadline = now + 125e3;
  let results = await mapLimit(
    names,
    4,
    (name) => Date.now() > deadline ? Promise.resolve({ query: name, status: "UNRESOLVED", trace: [{ step: "cache", status: "error", detail: "Ran out of time on this request; try again." }], looked_up_at: (new Date()).toISOString() }) : lookupName(name, {
      fetch: fetchImpl,
      wikidata,
      gleif,
      country,
      cache: { get: async (k) => cached.get(k) },
      referenceList: (n) => reference.get(cacheKey(n)),
      companiesHouseKey: chOk && country === "GB" ? env("COMPANIES_HOUSE_API_KEY") : void 0,
      ch,
      llm: llmOk ? { apiKey: env("MISTRAL_API_KEY"), options: { model: env("LLM_MODEL") || AI_DEFAULTS.model, web: webMode }, webOk, webQueue, state: aiState, deadline: aiDeadline, onResult: (a) => ai.set(a.name, a) } : void 0
    }).catch((e) => ({ query: name, status: "UNRESOLVED", trace: [{ step: "cache", status: "error", detail: `Lookup failed (${e.message}).` }], looked_up_at: (new Date()).toISOString() }))
  );
  let fresh = results.filter((r) => r.trace[0]?.step !== "cache" || r.trace[0]?.status !== "found");
  let ttl = (r) => {
    let t = TTL[r.entry?.tier ?? "NONE"] ?? TTL.NONE, a = ai.get(r.query);
    // The AI's answers (15 Oct 2026): a year when checked with the web, or agreed by all five answers and confirmed by a
    // register; 3 days when a web check was wanted but couldn't be had (today's limit, the request's time, or a
    // failure), so the check comes soon; otherwise ("not sure", "not a business", or no web check possible) 30 days, as
    // long as the app waits before asking again about a name with no answer.
    if (a && webMode !== "off") t = a.checked && r.via === "llm" ? 365 * DAY : a.webMissed ? 3 * DAY : 30 * DAY;
    return t;
  };
  let rows = fresh.filter((r) => !r.trace.some((s) => s.status === "error")).map((r) => ({
    key: cacheKey(r.query, country),
    status: r.status,
    via: r.via ?? null,
    tier: r.entry?.tier ?? null,
    result: r,
    updated_at: (new Date()).toISOString(),
    expires_at: new Date(now + ttl(r)).toISOString()
  }));
  rows.length && await db.from("kys_lookup_cache").upsert(rows, { onConflict: "key" });
  let llmCalls = aiState.calls, chCalls = ch?.calls ?? 0;
  await db.rpc("kys_bump_usage", { p_names: names.length, p_llm: llmCalls, p_ch: chCalls });
  for (let i = 0; i < webAsked; i++) await db.rpc("kys_count", { p_event: "lookup_web" });
  return reply(200, { results, sources: { companies_house: chOk && country === "GB", ai: llmOk && !aiState.paused, web: llmOk && !aiState.paused && webMode !== "off" && webBefore < webCap } }, origin);
});
