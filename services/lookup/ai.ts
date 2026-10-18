// @ts-nocheck — plain JavaScript in a .ts file, like the rest of the look-up (Deno runs it live; Node runs the tests).
/**
 * KnowYourSpend — the AI step of the ownership look-up, run on Mistral AI (Paris, France).
 * Shared by kys-lookup (live) and kys-llm-eval (the test bench), so the bench measures what ships.
 *
 * Only shop names the registers couldn't place get here. For each one it:
 *  1. asks Mistral Large for five answers in one call (`samples`, Mistral's `n`), as JSON fitting ANSWER_SCHEMA,
 *     and keeps an answer only when at least three name the same owner's country (`minAgree`); this vote is also
 *     what says a name isn't a business;
 *  2. looks the voted owner up in Wikidata (+ GLEIF) by exact name: if all five answers agree and the register
 *     confirms the owner's country, that is the answer;
 *  3. otherwise (`web: "unsure"`, the live setting) asks Mistral Medium once more with Mistral's web search, and that
 *     answer wins, with its owner looked up in Wikidata/GLEIF for the ownership chain and sources. Without a web
 *     search (the daily limit, the request's time for it, or a failure) the vote stands, unless the register puts
 *     the owner in another country. Names any answer took for a person or not a business aren't searched.
 * Since 17 Oct 2026 each answer also says what kind of business it is (`scale`). A small local business (most answers
 * say so, and it isn't owned from abroad) is the decision "local", which the app counts where it was paid. On the first
 * request for a name (`ctx.seen`), a local business, or a name the answers can't place, gets no web search: the answer
 * is kept for a few days, and a later request gets the full check, since a name more than one person pays may be a
 * small chain. A local business is also "local" when the full check finds no owner.
 * Only the shop name (and the bank's country, when the app sends it) goes to Mistral — never anything about the
 * person who paid.
 */
import {
  COUNTRIES, NOT_A_BUSINESS, chUrl, dropLetterForm, normaliseName, ownershipFromWikidata, stripLegalSuffix, walkOwnership, wikidataUrl,
} from "./registries.ts";

export const MISTRAL_API = "https://api.mistral.ai/v1";
export const PROMPT_VERSION = "2026-10-17";

/** The configuration the live look-up uses (kys-lookup); the bench can override any of it. */
export const AI_DEFAULTS = {
  model: "mistral-large-4",
  samples: 5, // answers per call; the prompt is billed once
  temperature: 0.7, // varied answers, so agreement means something
  minAgree: 0.6, // share of answers that must name the same country
  evidence: false, // Wikidata + Companies House matches in the prompt (off: it didn't help on the test set)
  verify: true, // check the named owner in Wikidata/GLEIF
  onConflict: "ask", // register and model disagree on the owner's country: "ask" (show the model both) | "registry" | "decline" | "model"
  reasoning: "none", // reasoning_effort for models that think first (Large 4, Medium 3.5); null to leave it out
  // Web search (Mistral's web_search tool, about $0.03 a search). "unsure" = only when the five answers don't all
  // agree or no register confirms the owner (157 right, 3 wrong of 164 on the test set, with web searches for 48 of 170
  // names, about $18 per 1,000 names); "always" = for every business (158 right, 2 wrong; 147 of 170, about $47);
  // "check" = only when a register doesn't confirm the answer (155, 5); "fallback" = only when there's no answer; "off"
  // (138, 7). The look-up caps it per day (DAILY_WEB_CAP) and runs two at a time, as the tool's rate limit is tighter
  // than chat's. "unsure" since 14 Oct 2026 (Sam chose it over "always" for the cost).
  web: "unsure",
  webModel: "mistral-medium-latest",
  maxTokens: 400,
  seed: null,
  timeoutMs: 25000,
  system: null, // bench only: a different system prompt
  hideExact: false, // bench only: drop Wikidata matches with exactly this name (as if the shop weren't on Wikidata)
  local: true, // a small local business (most answers say so) is the decision "local": no register check or web search
};
const webMode = (opts) => (["unsure", "check", "always", "fallback"].includes(opts.web) ? opts.web : opts.webSearch === true ? "fallback" : "off");
// Whether a vote wants the web check, by mode (see webStep).
const wantsWeb = (mode, v, confirmed, disagrees) => mode === "always" || (mode === "unsure" ? !(confirmed && v.agree === 1) : mode === "check" ? !confirmed : mode === "fallback" ? v.kind !== "found" || disagrees : false);

export const OWNER_TYPES = ["listed_company", "private_company", "private_equity", "family_or_person", "state", "cooperative_or_mutual", "employee_owned", "unknown"];

// The bank's country, when the app sends it (Europe and Canada); the UK wording is the one on the test bench.
export const COUNTRY_NAMES = {
  GB: "the United Kingdom", IE: "Ireland", FR: "France", DE: "Germany", NL: "the Netherlands", BE: "Belgium", LU: "Luxembourg",
  ES: "Spain", PT: "Portugal", IT: "Italy", AT: "Austria", CH: "Switzerland", SE: "Sweden", DK: "Denmark", NO: "Norway",
  FI: "Finland", PL: "Poland", CZ: "Czechia", GR: "Greece", HU: "Hungary", RO: "Romania", CA: "Canada", US: "the United States",
  AU: "Australia", NZ: "New Zealand",
};
const statementFrom = (cc) => (cc === "GB" ? "a UK bank statement" : `a bank statement from ${COUNTRY_NAMES[cc] ?? cc}`);
const localOwners = (cc) => (cc === "GB" ? "A UK business whose owners are UK people or UK companies is GB." : `A business in ${COUNTRY_NAMES[cc] ?? cc} whose owners are people or companies there is ${cc}.`);

export function systemPrompt(today, country = "GB") {
  return `You identify the business behind a merchant name from ${statementFrom(country)}, and who ultimately owns it. Today is ${today}.

The name is how a card payment appeared on the statement, cleaned up. It can be shortened or run together, or include a town, a store number, a web address or a payment-provider prefix (SQ, SUMUP, ZETTLE, IZ, SP, PAYPAL, CRV and similar: the business is the part after the prefix). First work out the trading brand, then its ultimate owner.

Ultimate owner, as of today:
- follow the controlling shareholders up to the top: the top company that no other company controls;
- owned by private equity: name the private-equity firm, not a fund or holding company it set up;
- a family holding company, a person, a co-operative or mutual, an employee-ownership trust or a government can be the top;
- a franchise (most fast-food outlets, many hotels and estate agents): name the brand owner (franchisor), not the local franchisee;
- a listed company with no controlling shareholder is its own ultimate owner;
- take recent takeovers, mergers and sales into account, but only completed ones: a deal that has been agreed but hasn't completed doesn't change the owner yet.

owner_country: the ISO 3166-1 alpha-2 code of the country the ultimate owner is run from (its head office), not where a holding company is registered for tax (so not Jersey, the Cayman Islands, Luxembourg or Delaware unless it is really run from there). Hong Kong is HK, not CN. ${localOwners(country)}

Not a business (is_business false): a person's name, a transfer, a cash or banking term, or a generic word that could be any business ("CAFE", "TAXI", "CORNER SHOP").

scale — what kind of business it is:
- "local": a single independent shop, café, pub, restaurant, salon, trader or other small business with one or a few sites in one area, that you wouldn't find in other towns;
- "chain": a brand with branches in many towns (shops, restaurants, hotels, petrol stations, gyms), including franchises;
- "online": a business people mostly pay online or by subscription (apps, streaming, web shops, utilities, phone and broadband, insurers, banks, travel);
- "unknown": you can't tell, or it isn't a business.
A small local business you don't know is "local" with confidence "low".

confidence:
- "high": you know which business this is and who owns it today;
- "medium": you are fairly sure of both;
- "low": you can't tell which business it is, or you'd be guessing the owner; then ultimate_owner and owner_country are null. Small local businesses you don't know are "low".
Never make up a company or an owner. A wrong owner is much worse than "low".

You may be given possible matches from public registers (Wikidata, and the UK's Companies House), found by searching the name. They can be a different business with a similar name, and registers can lag behind recent sales. Use one only if it is clearly this business, and put its id (like "C1" or "W2") in match; otherwise match is null.

reason: one short sentence, at most 20 words.

Reply with the JSON object only.

Examples:
MCDONALDS → {"is_business":true,"brand":"McDonald's","ultimate_owner":"McDonald's Corporation","owner_type":"listed_company","owner_country":"US","confidence":"high","scale":"chain","match":null,"reason":"Franchised restaurants; the brand owner is McDonald's Corporation, run from Chicago."}
SUBWAY 12345 → {"is_business":true,"brand":"Subway","ultimate_owner":"Roark Capital","owner_type":"private_equity","owner_country":"US","confidence":"high","scale":"chain","match":null,"reason":"Franchise brand; Subway was bought by the US private-equity firm Roark Capital in 2024."}
HAMLEYS → {"is_business":true,"brand":"Hamleys","ultimate_owner":"Reliance Industries","owner_type":"listed_company","owner_country":"IN","confidence":"high","scale":"chain","match":null,"reason":"Owned by Reliance Retail, part of India's Reliance Industries, since 2019."}
SQ *THE BEAN HOUSE → {"is_business":true,"brand":"The Bean House","ultimate_owner":null,"owner_type":"unknown","owner_country":null,"confidence":"low","scale":"local","match":null,"reason":"A small business paid through Square; can't tell which one or who owns it."}
R PATEL → {"is_business":false,"brand":null,"ultimate_owner":null,"owner_type":"unknown","owner_country":null,"confidence":"high","scale":"unknown","match":null,"reason":"A person's name."}`;
}

export function userPrompt(name, evidence = []) {
  let s = `Merchant name: ${JSON.stringify(String(name).slice(0, 80))}`;
  if (evidence.length) {
    s += "\n\nPossible matches from public registers, found by searching the name (they may be a different business, or out of date):\n";
    s += evidence.map((e) => `[${e.id}] ${e.text}`).join("\n");
  }
  return s;
}

const nullable = (t) => ({ type: [t, "null"] });
export const SCALES = ["local", "chain", "online", "unknown"];
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    is_business: { type: "boolean" },
    brand: nullable("string"),
    ultimate_owner: nullable("string"),
    owner_type: { type: "string", enum: OWNER_TYPES },
    owner_country: nullable("string"),
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    scale: { type: "string", enum: SCALES },
    match: nullable("string"),
    reason: { type: "string" },
  },
  required: ["is_business", "brand", "ultimate_owner", "owner_type", "owner_country", "confidence", "scale", "match", "reason"],
  additionalProperties: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeLeft = (ctx) => (ctx.deadline ? ctx.deadline - Date.now() : Infinity);

/**
 * POST to Mistral with retries on rate limits (429), server errors and timeouts. ctx.deadline (a time in ms, set by
 * the live look-up so a request ends within the host's time limit): no call starts after it, and none runs past it.
 */
export async function mistral(ctx, path, body, opts = {}) {
  const retries = opts.retries ?? 3;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const left = ctx.deadline ? ctx.deadline - Date.now() : Infinity;
    if (left < 3000) throw lastErr ?? new Error("no time left for the AI step on this request");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(opts.timeoutMs ?? 25000, left));
    try {
      const res = await ctx.fetch(`${MISTRAL_API}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const after = Number(res.headers.get("retry-after"));
        await res.body?.cancel();
        lastErr = new Error(`Mistral HTTP ${res.status}`);
        // the web check is tried again only when it was turned away (429): after a server error it may already
        // have run (and been charged for) its searches
        if (opts.retryOnly429 && res.status !== 429) throw lastErr;
        if (attempt < retries) await sleep(after > 0 ? Math.min(after * 1000, 10000) : (res.status === 429 ? 2000 : 700) * 2 ** attempt + Math.random() * 500);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        const e = new Error(`Mistral HTTP ${res.status}: ${text.slice(0, 300)}`);
        e.status = res.status;
        e.body = text;
        throw e;
      }
      return await res.json();
    } catch (e) {
      if (e.status) throw e; // a 4xx: retrying won't help
      lastErr = e.name === "AbortError" ? new Error("Mistral took too long to answer") : e;
      if (opts.retryOnly429) throw lastErr;
      if (attempt < retries) await sleep(700 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const noSchema = new Set(); // models that turned down json_schema: fall back to JSON mode
const noReasoning = new Set(); // models that turned down reasoning_effort

async function chat(ctx, opts, messages, n) {
  const temperature = n > 1 ? opts.temperature : 0;
  const body = {
    model: opts.model,
    messages,
    n,
    max_tokens: opts.maxTokens,
    temperature,
    ...(temperature === 0 ? { top_p: 1 } : {}), // Mistral wants top_p 1 with greedy sampling
    ...(opts.seed != null ? { random_seed: opts.seed } : {}),
    ...(opts.reasoning && !noReasoning.has(opts.model) ? { reasoning_effort: opts.reasoning } : {}),
    response_format: noSchema.has(opts.model)
      ? { type: "json_object" }
      : { type: "json_schema", json_schema: { name: "merchant_owner", schema: ANSWER_SCHEMA, strict: true } },
  };
  try {
    return await mistral(ctx, "/chat/completions", body, opts);
  } catch (e) {
    if (e.status === 400 && body.reasoning_effort && /reasoning/i.test(e.body ?? "")) {
      noReasoning.add(opts.model);
      return chat(ctx, opts, messages, n);
    }
    if (e.status === 400 && body.response_format?.type === "json_schema" && /response_format|json_schema|schema/i.test(e.body ?? "")) {
      noSchema.add(opts.model);
      return chat(ctx, opts, messages, n);
    }
    throw e;
  }
}

export function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === "text").map((c) => c.text ?? "").join("");
  return "";
}

const EMPTY = /^(null|none|unknown|n\/a|not known|-)$/i;
export function parseAnswer(text) {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const str = (v, max = 120) => (typeof v === "string" && v.trim() && !EMPTY.test(v.trim()) ? v.trim().slice(0, max) : null);
  let cc = str(o.owner_country, 3)?.toUpperCase() ?? null;
  if (cc === "UK") cc = "GB";
  return {
    is_business: o.is_business === true,
    brand: str(o.brand),
    owner: str(o.ultimate_owner),
    owner_type: OWNER_TYPES.includes(o.owner_type) ? o.owner_type : "unknown",
    country: cc && COUNTRIES.has(cc) ? cc : null,
    confidence: ["high", "medium", "low"].includes(o.confidence) ? o.confidence : "low",
    scale: SCALES.includes(o.scale) ? o.scale : "unknown",
    match: str(o.match, 8),
    reason: str(o.reason, 240) ?? "",
  };
}

function groupBy(xs, key) {
  const m = new Map();
  for (const x of xs) {
    const k = key(x);
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}
const confRank = (g) => g.filter((s) => s.confidence === "high").length;
export const sameName = (a, b) => !!a && !!b && normaliseName(stripLegalSuffix(a, true)) === normaliseName(stripLegalSuffix(b, true));

/** The kind of business most answers say it is ("local", "chain", "online"), or "unknown" when fewer than minAgree agree. */
export function scaleOf(samples, n, minAgree) {
  const total = Math.max(n || 0, samples.length, 1);
  const top = [...groupBy(samples.filter((s) => s.is_business), (s) => s.scale ?? "unknown").entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return top && top[0] !== "unknown" && top[1].length / total >= minAgree ? top[0] : "unknown";
}

/** Combine the samples: not a business, a country most of them agree on, or no answer. */
export function vote(samples, n, minAgree) {
  const total = Math.max(n || 0, samples.length, 1);
  const notBiz = samples.filter((s) => !s.is_business);
  if (notBiz.length / total > 0.5) return { kind: "not_business", agree: notBiz.length / total, total, reason: notBiz[0].reason, scale: "unknown" };
  const scale = scaleOf(samples, n, minAgree);
  const usable = samples.filter((s) => s.is_business && s.country && s.owner && s.confidence !== "low");
  const ranked = [...groupBy(usable, (s) => s.country).entries()].sort((a, b) => b[1].length - a[1].length || confRank(b[1]) - confRank(a[1]));
  const split = ranked.map(([c, g]) => `${c} ${g.length}`).join(", ");
  const unsure = total - usable.length;
  if (!ranked.length) return { kind: "declined", agree: 0, total, split, scale, reason: samples.find((s) => s.reason)?.reason || "no confident answer" };
  const [country, group] = ranked[0];
  const agree = group.length / total;
  if (agree < minAgree) {
    return { kind: "declined", agree, total, split, scale, reason: `the answers didn't agree (${split}${unsure ? `, ${unsure} unsure` : ""})` };
  }
  const owners = [...groupBy(group, (s) => normaliseName(stripLegalSuffix(s.owner, true))).values()].sort((a, b) => b.length - a.length || confRank(b) - confRank(a))[0];
  const rep = owners.find((s) => s.confidence === "high") ?? owners[0];
  const brands = [...groupBy(group.filter((s) => s.brand), (s) => normaliseName(s.brand)).values()].sort((a, b) => b.length - a.length)[0];
  const matches = [...groupBy(group.filter((s) => s.match), (s) => s.match).entries()].sort((a, b) => b[1].length - a[1].length)[0];
  return {
    kind: "found",
    agree,
    total,
    split,
    scale,
    country,
    owner: rep.owner,
    owner_type: rep.owner_type,
    brand: brands?.[0]?.brand ?? rep.brand,
    confidence: rep.confidence,
    reason: rep.reason,
    match: matches && matches[1].length * 2 > group.length ? matches[0] : null,
  };
}

// --- Evidence: what the registers find when searching the name -------------------------------------------
// Only companies whose name is the shop's name plus generic words ("WELCOME BREAK GROUP LIMITED" for
// "WELCOME BREAK"): looser matches brought in unrelated firms ("DAVID LLOYD ACCOUNTANCY") and made answers worse.
const GENERIC = new Set(["THE", "AND", "&", "OF", "UK", "GB", "LTD", "LIMITED", "PLC", "LLP", "LLC", "INC", "CO", "COMPANY", "GROUP", "HOLDING", "HOLDINGS", "STORE", "STORES", "SHOP", "SHOPS", "RETAIL", "TRADING", "SERVICES", "INTERNATIONAL", "EUROPE", "ENGLAND", "BRITAIN", "GREAT"]);
const core = (s) => normaliseName(s).split(" ").filter((w) => w && !GENERIC.has(w)).join(" ");
const sameCore = (a, b) => { const x = core(a); return x.length > 1 && x === core(b); };

export async function gatherEvidence(name, ctx, opts = {}) {
  const q = stripLegalSuffix(name);
  const want = normaliseName(q);
  const fromWikidata = async () => {
    const ids = await ctx.wikidata.searchIds(q, 10);
    const ents = await ctx.wikidata.entities(ids);
    const picked = ids.map((id) => ents.get(id)).filter((e) => e && e.hasBusinessFacts && !e.instanceOf.some((c) => NOT_A_BUSINESS.has(c)))
      .filter((e) => [e.label, ...e.aliases].some((n) => sameCore(n, q)))
      .filter((e) => !opts.hideExact || ![e.label, ...e.aliases].some((n) => normaliseName(stripLegalSuffix(n)) === want))
      .slice(0, 2);
    return Promise.all(picked.map(async (e) => {
      const hops = (await walkOwnership(ctx.wikidata, e.id, 4)).hops;
      const chain = hops.map((h) => `${h.label}${h.country ? ` (${h.country})` : ""}`).join(" → ");
      const about = hops.length > 1 ? `Owned through: ${chain}.` : hops[0]?.country ? `Country: ${hops[0].country}; no owner recorded.` : "No owner or country recorded.";
      return { kind: "wikidata", ref: e.id, label: e.label, url: wikidataUrl(e.id), text: `Wikidata ${e.id}: "${e.label}"${e.description ? ` (${e.description})` : ""}. ${about}` };
    }));
  };
  const fromCompaniesHouse = async () => {
    if (!ctx.ch) return [];
    const hits = (await ctx.ch.searchAll(q)).filter((i) => i.company_number && i.title && sameCore(i.title, q));
    hits.sort((a, b) => (a.company_status === "active" ? 0 : 1) - (b.company_status === "active" ? 0 : 1));
    return Promise.all(hits.slice(0, 3).map(async (i, k) => {
      let ctl = "";
      if (i.company_status === "active" && k < 2) {
        const first = await ctx.ch.controller(i.company_number).catch(() => null);
        if (first === "people") ctl = " Its persons with significant control are individuals.";
        else if (first) {
          const r = await ctx.ch.chainFrom({ number: i.company_number, title: i.title }, 4).catch(() => null);
          if (r?.chain.length > 1) ctl = ` Controlled by: ${r.chain.slice(1).map((h) => `${h.name} (${h.country})`).join(" → ")}.`;
        }
      }
      const parts = (i.address_snippet ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const town = parts.length >= 2 ? parts[parts.length - 2] : "";
      return {
        kind: "companies_house",
        ref: i.company_number,
        label: i.title,
        url: chUrl(i.company_number),
        text: `Companies House ${i.company_number}: ${i.title} (${i.company_status ?? "status unknown"}${i.date_of_creation ? `, since ${String(i.date_of_creation).slice(0, 4)}` : ""}${town ? `, ${town}` : ""}).${ctl}`,
      };
    }));
  };
  const [w, c] = await Promise.allSettled([fromWikidata(), fromCompaniesHouse()]);
  const items = [];
  (w.status === "fulfilled" ? w.value : []).forEach((e, i) => items.push({ ...e, id: `W${i + 1}` }));
  (c.status === "fulfilled" ? c.value : []).forEach((e, i) => items.push({ ...e, id: `C${i + 1}` }));
  return items;
}

// --- Checking the named owner in the registers -------------------------------------------------------------
// Only legal forms come off for the comparison (unlike stripLegalSuffix, which also drops GROUP, HOLDINGS and UK).
const LEGAL_FORMS = new Set(["LIMITED", "LTD", "PLC", "LLP", "LLC", "INC", "INCORPORATED", "CORP", "CORPORATION", "GMBH", "AG", "SA", "SAS", "SARL", "SPA", "BV", "NV", "AB", "AS", "ASA", "OY", "OYJ", "SE", "PTY", "CO", "COMPANY", "KK", "KGAA",
  "APS", "PUBL", "KG", "OHG", "SRL", "SL", "SAU", "SRO", "SNC", "SASU", "LDA", "LTEE", "ULC", "DAC", "&"]);
export function coreName(s) {
  let w = normaliseName(s).split(" ").filter(Boolean);
  if (w[0] === "THE" && w.length > 1) w.shift();
  for (;;) {
    const shorter = dropLetterForm(w); // "S A", "A S", "S P A" and the like
    if (shorter !== w) w = shorter;
    else if (w.length > 1 && LEGAL_FORMS.has(w[w.length - 1])) w.pop();
    else break;
  }
  return w.join(" ");
}

/** Find the named owner on Wikidata by exact name, walk up to its top company, and confirm with GLEIF. */
export async function checkOwner(owner, ctx) {
  const bare = owner.replace(/\s*\([^)]*\)/g, "").trim();
  const names = [...new Set([owner, bare, coreName(bare)])];
  for (const name of names) {
    const want = coreName(name);
    if (want.length < 2) continue;
    const ids = await ctx.wikidata.searchIds(name, 10, true);
    const ents = await ctx.wikidata.entities(ids);
    const exact = ids.map((id) => ents.get(id)).filter((e) => e && e.hasBusinessFacts && !e.instanceOf.some((c) => NOT_A_BUSINESS.has(c)) && [e.label, ...e.aliases].some((n) => coreName(n) === want));
    for (const h of exact.slice(0, 2)) {
      const o = await ownershipFromWikidata(ctx.wikidata, ctx.gleif, h.id);
      if (o?.owner_country) return { qid: h.id, label: h.label, country: o.owner_country, chain: o.chain, sources: o.sources, top: o.chain[o.chain.length - 1] };
    }
  }
  return null;
}

/** When the register and the AI disagree: show the model both and let it decide (three answers, two must agree). */
export function reconcilePrompt(name, v, chk) {
  const chain = chk.chain.map((h) => `${h.name}${h.country ? ` (${h.country})` : ""}`).join(" → ");
  return `${userPrompt(name)}

Earlier answer: ${v.brand ?? name} is ultimately owned by ${v.owner} (${v.country}).
Public registers (Wikidata, GLEIF) record this ownership chain for ${chk.label}: ${chain}.
Registers can be out of date, because companies are bought and sold, and the country they give is sometimes where a company is legally registered rather than where it is run from. Taking both into account, who ultimately owns this business today, and which country is that owner run from? If you can't tell which is right, use confidence "low".`;
}

async function reconcile(name, v, chk, ctx, opts, today) {
  const j = await chat(ctx, opts, [{ role: "system", content: opts.system ?? systemPrompt(today, ctx.country ?? "GB") }, { role: "user", content: reconcilePrompt(name, v, chk) }], 3);
  const samples = (j.choices ?? []).map((c) => parseAnswer(textOf(c.message?.content))).filter(Boolean);
  return { samples, vote: vote(samples, 3, 0.6), usage: j.usage ?? {} };
}

function buildChain(brand, country, owner, ownerHops, matched) {
  const hops = [];
  if (matched?.kind === "companies_house") {
    hops.push({ name: matched.label, relation: "operator", country: "GB", source: "companies_house", source_id: matched.ref, source_url: matched.url });
  } else if (brand && !sameName(brand, owner)) {
    hops.push({ name: brand, relation: "brand_of", country, source: "llm" });
  }
  if (ownerHops?.length) hops.push(...ownerHops.map((h) => ({ ...h, relation: "owned_by" })));
  else hops.push({ name: owner, relation: "owned_by", country, source: "llm" });
  // The same company twice in a row (a register's legal name after its everyday name): keep one, preferring the
  // register's hop over the AI's, and its everyday name.
  const out = [];
  for (const h of hops) {
    const prev = out[out.length - 1];
    if (prev && sameName(prev.name, h.name)) {
      const keep = prev.source === "llm" && h.source !== "llm" ? h : prev;
      out[out.length - 1] = { ...keep, relation: prev.relation === "operator" ? "operator" : h.relation };
      continue;
    }
    out.push(h);
  }
  if (out.length > 1 || out[0]?.relation !== "operator") out[out.length - 1] = { ...out[out.length - 1], relation: "ultimate_parent" };
  if (out.length > 1 && out[0].relation === "owned_by") out[0] = { ...out[0], relation: "brand_of" };
  return out;
}

// --- Web search (Mistral's Conversations API with the web_search tool) ---------------------------------------
export async function askWithWebSearch(name, ctx, opts, today) {
  const body = {
    model: opts.webModel,
    instructions: `${opts.system ?? systemPrompt(today, ctx.country ?? "GB")}\n\nUse the web_search tool to check which business this is and who owns it today before answering; search at most twice. Then reply with the JSON object only.`,
    inputs: [{ role: "user", content: userPrompt(name, []) }],
    tools: [{ type: "web_search" }],
    completion_args: { temperature: 0, max_tokens: 900 },
    store: false,
  };
  const j = await mistral(ctx, "/conversations", body, { ...opts, timeoutMs: Math.max(opts.timeoutMs ?? 0, 45000), retries: 3, retryOnly429: true });
  const outputs = j.outputs ?? [];
  const msg = [...outputs].reverse().find((o) => o.type === "message.output");
  const chunks = Array.isArray(msg?.content) ? msg.content : [{ type: "text", text: msg?.content ?? "" }];
  const text = chunks.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  const refs = [];
  const seen = new Set();
  const collect = (x, depth = 0) => {
    if (!x || typeof x !== "object" || depth > 6) return;
    if (Array.isArray(x)) return x.forEach((y) => collect(y, depth + 1));
    const url = typeof x.url === "string" ? x.url : typeof x.link === "string" ? x.link : null;
    if (url && /^https?:\/\//.test(url) && !seen.has(url)) {
      seen.add(url);
      refs.push({ title: String(x.title ?? x.source ?? url).slice(0, 140), url });
    }
    for (const v of Object.values(x)) if (v && typeof v === "object") collect(v, depth + 1);
  };
  collect(outputs);
  return {
    answer: parseAnswer(text),
    refs,
    searches: outputs.filter((o) => o.type === "tool.execution").length,
    usage: { in: j.usage?.prompt_tokens ?? 0, out: j.usage?.completion_tokens ?? 0, connectors: j.usage?.connectors ?? null },
    raw: text.slice(0, 600),
  };
}

// --- The step itself ----------------------------------------------------------------------------------------
/**
 * ctx: { fetch, apiKey, wikidata, gleif, ch?, today?, country? (the bank's, default GB), webOk?(), webQueue?(f), deadline?,
 *        seen? (how many requests have asked about this name, this one included) }.
 * Returns { decision: "found" | "not_business" | "local" | "declined", ... } with everything the bench needs; for
 * "found" also chain, country, owner, brand, technique and sources for the app. `checked` ("web" or "register") and
 * `webMissed` (a web check was wanted but couldn't be had, or waits for a later request) set how long the look-up keeps
 * the answer.
 */
export async function aiEstimate(name, ctx, options = {}) {
  const opts = { ...AI_DEFAULTS, ...options };
  const t0 = Date.now();
  const today = ctx.today ?? new Date().toISOString().slice(0, 10);
  const bank = ctx.country ?? "GB";
  const r = { name, decision: "declined", model: opts.model, country: null, evidence: [], samples: [], usage: { in: 0, out: 0, calls: 0, web: 0, searches: 0 }, notes: [] };
  const n = Math.max(1, Math.floor(opts.samples) || 1);
  const done = (decision) => Object.assign(r, { decision, ms: Date.now() - t0 });
  if (opts.evidence) {
    try {
      r.evidence = await gatherEvidence(name, ctx, opts);
    } catch (e) {
      r.notes.push(`evidence: ${e.message}`);
    }
  }
  const messages = [{ role: "system", content: opts.system ?? systemPrompt(today, bank) }, { role: "user", content: userPrompt(name, r.evidence) }];
  const j = await chat(ctx, opts, messages, n);
  r.usage.calls++;
  r.usage.in += j.usage?.prompt_tokens ?? 0;
  r.usage.out += j.usage?.completion_tokens ?? 0;
  r.samples = (j.choices ?? []).map((c) => parseAnswer(textOf(c.message?.content))).filter(Boolean);
  let v = vote(r.samples, n, opts.minAgree);
  r.vote = { kind: v.kind, agree: v.agree, split: v.split, scale: v.scale };
  r.reason = v.reason;
  r.scale = v.scale;
  if (v.kind === "not_business") return done("not_business");
  const mode = webMode(opts);
  // The first request for a name (ctx.seen counts the requests that have asked about it, this one included; unknown
  // counts as a later request): no paid web search yet for a small local business or a name the answers can't place,
  // as most such names are one person's local shop. The answer is kept for only a few days (webMissed), so if someone
  // else asks about the name later, it gets the full check: a name more than one person pays may be a small chain.
  const firstAsk = ctx.seen != null && ctx.seen < 2;
  // Most answers say it's a small local business, and none of them confidently puts its owner abroad (18 Oct 2026: also
  // when the answers don't agree on an owner, as two sure answers naming a chain abroad were ignored).
  const abroad = r.samples.some((s) => s.is_business && s.owner && s.country && s.country !== bank && s.confidence !== "low");
  const localVote = opts.local && v.scale === "local" && !abroad && (v.kind !== "found" || v.country === bank);
  if (localVote && firstAsk) {
    r.country = bank;
    if (mode !== "off") {
      r.webMissed = true;
      r.notes.push("no web search yet: first request for this name, and the answers say it's a small local business");
    }
    return done("local");
  }
  // If any answer took the name for a person or not a business, it isn't searched on the web (it may be someone's name).
  const doubt = r.samples.some((s) => !s.is_business);
  if (doubt && mode !== "off") r.notes.push("no web search: an answer took this for a person or not a business");
  const waitForWeb = firstAsk && v.scale === "unknown";
  if (waitForWeb && mode !== "off" && !doubt) r.notes.push("no web search yet: first request for this name, and the answers couldn't tell what kind of business it is");
  let webAvailable = mode !== "off" && !doubt && !waitForWeb && (!ctx.webOk || ctx.webOk());
  // The web search's owner isn't used when it still calls the business small and local, or, for a name the five answers
  // called local, when it doesn't say it's a chain or an online business: on a made-up local name it once named an
  // unrelated company. The name is then counted as a local business (below), or, when the answers named an owner abroad,
  // not answered, as the web search and the answers disagree.
  let webRejected = false;
  const webUsable = (w) => {
    const s = r.web?.answer?.scale;
    if (s === "local" || (localVote && s !== "chain" && s !== "online")) {
      r.notes.push(`web search named ${w.owner} (${w.country}) but didn't find a chain or online business; not used`);
      webRejected = true;
      return false;
    }
    return true;
  };
  if (mode === "always" && webAvailable) {
    const w = await webStep(name, r, v, { always: true }, ctx, opts, today);
    if (w?.kind === "not_business") {
      r.reason = w.reason;
      return done("not_business");
    }
    if (w && webUsable(w)) return finishWithWeb(r, w, ctx, opts, t0);
    // the web couldn't answer: fall back to the AI's own answer, checked against the registers below as if
    // there were no web search
    webAvailable = false;
  }
  let country = v.country, owner = v.owner, ownerHops = null, sources = [];
  let disagrees = false; // the register puts the owner in another country, and that wasn't settled here
  let chk = null;
  if (v.kind === "found" && opts.verify && timeLeft(ctx) > 5000) {
    try {
      chk = await checkOwner(v.owner, ctx);
    } catch (e) {
      r.notes.push(`verify: ${e.message}`); // a register that doesn't answer leaves the answer unchecked
    }
  }
  if (chk) {
    r.registry = { qid: chk.qid, label: chk.label, country: chk.country, top: chk.top.name, hops: chk.chain.length };
    const useRegister = () => {
      r.verified = true;
      country = chk.country;
      owner = chk.top.name;
      ownerHops = chk.chain;
      sources = chk.sources;
    };
    if (chk.country === v.country) useRegister();
    else {
      r.conflict = { model: v.country, registry: chk.country };
      if (opts.onConflict === "registry") useRegister();
      else if (opts.onConflict === "ask" && !webAvailable) {
        // The second look. If it can't be had (out of credit, out of time), the error goes up, so the name isn't
        // answered or cached now and is tried again later.
        const rc = await reconcile(name, v, chk, ctx, opts, today);
        r.usage.calls++;
        r.usage.in += rc.usage.prompt_tokens ?? 0;
        r.usage.out += rc.usage.completion_tokens ?? 0;
        r.reconcile = { kind: rc.vote.kind, country: rc.vote.country ?? null, samples: rc.samples.map((x) => ({ o: x.owner, c: x.country, k: x.confidence })) };
        if (rc.vote.kind === "found" && rc.vote.country === chk.country) {
          useRegister();
          r.resolved = "registry";
        } else if (rc.vote.kind === "found" && rc.vote.country === v.country) r.resolved = "model";
        else disagrees = true;
      } else if (opts.onConflict !== "model") disagrees = true;
    }
  }
  if (disagrees) r.reason = `the AI's answer (${v.owner}, ${v.country}) doesn't match the register (${r.registry.top}, ${r.registry.country})`;
  const confirmed = v.kind === "found" && !!r.verified && !r.conflict;
  // All five answers agree and a register confirms the owner: as good as a web check (kept as long).
  if (confirmed && v.agree === 1) r.checked = "register";
  if (mode !== "always" && webAvailable && !r.web) {
    const w = await webStep(name, r, v, { confirmed, disagrees }, ctx, opts, today);
    if (w?.kind === "not_business") {
      r.reason = w.reason;
      return done("not_business");
    }
    if (w && webUsable(w)) return finishWithWeb(r, w, ctx, opts, t0);
  }
  // The web check was wanted but no answer came back (today's limit, the request's time for it, or a failure): the
  // look-up keeps this answer only a few days, so the name gets its check soon.
  if (mode !== "off" && !doubt && !r.web && wantsWeb(mode, v, confirmed, disagrees)) r.webMissed = true;
  // No owner from the web search either (or none could be had), and the answers, or the web search, say it's a small
  // local business: counted where it was paid, rather than naming an owner nothing confirmed.
  // (18 Oct 2026: not when an answer is sure the owner is abroad, unless the web search also found a local business.)
  const localWeb = r.web?.answer?.is_business && r.web.answer.scale === "local";
  if (opts.local && ((v.scale === "local" && !abroad) || localWeb) && !disagrees && (v.kind !== "found" || (v.country === bank && !r.verified))) {
    r.country = bank;
    if (r.web) r.checked = "web";
    return done("local");
  }
  // The answers named an owner abroad, and the web search found a small local business instead, with or without an
  // owner (18 Oct 2026: the answers' owner was kept, with no word of the web search).
  if ((webRejected || localWeb) && v.kind === "found" && v.country !== bank) {
    r.reason = `a web search found a small local business, not ${v.owner} (${v.country})`;
    return done("declined");
  }
  if (v.kind !== "found" || disagrees) return done("declined");
  return finish(r, v, { country, owner, ownerHops, sources }, opts, t0);
}

/** A web-checked answer: its owner is looked up in the registers for the chain and sources. */
async function finishWithWeb(r, w, ctx, opts, t0) {
  r.resolved = "web";
  r.checked = "web";
  r.verified = false;
  delete r.conflict;
  let owner = w.owner, ownerHops = null, sources = [];
  try {
    const chk = timeLeft(ctx) > 5000 ? await checkOwner(w.owner, ctx) : null;
    if (chk) {
      r.registry = { qid: chk.qid, label: chk.label, country: chk.country, top: chk.top.name, hops: chk.chain.length };
      if (chk.country === w.country) {
        r.verified = true;
        owner = chk.top.name;
        ownerHops = chk.chain;
        sources = chk.sources;
      }
    }
  } catch (e) {
    r.notes.push(`verify: ${e.message}`);
  }
  return finish(r, w, { country: w.country, owner, ownerHops, sources }, opts, t0);
}

/**
 * The web check. "unsure": unless all five answers agree and a register confirms the owner. "check": when the answer
 * isn't confirmed by a register (no agreement, owner not on Wikidata, or the register disagrees). "always": for every
 * business. "fallback": only when there's no answer or the register disagrees.
 */
async function webStep(name, r, v, { always, confirmed, disagrees }, ctx, opts, today) {
  const wanted = always || wantsWeb(webMode(opts), v, confirmed, disagrees);
  if (!wanted) return null;
  const run = ctx.webQueue ?? ((f) => f());
  try {
    const w = await run(() => askWithWebSearch(name, ctx, opts, today));
    r.usage.web++;
    r.usage.searches += w.searches ?? 0;
    r.usage.in += w.usage.in;
    r.usage.out += w.usage.out;
    r.web = { answer: w.answer, refs: w.refs.slice(0, 5), searches: w.searches, raw: w.answer ? undefined : w.raw };
    const a = w.answer;
    if (a && !a.is_business && v.kind !== "found") return { kind: "not_business", reason: a.reason };
    if (a?.is_business && a.country && a.owner && a.confidence !== "low") {
      return { kind: "found", agree: null, total: v.total, split: v.split, country: a.country, owner: a.owner, owner_type: a.owner_type, brand: a.brand ?? v.brand, confidence: a.confidence, reason: a.reason, match: null, web: true };
    }
  } catch (e) {
    if (e.status === 402) throw e; // out of credit: the look-up pauses the AI step
    r.notes.push(`web: ${e.message}`);
  }
  return null;
}

function finish(r, v, found, opts, t0) {
  let { country, owner, ownerHops, sources } = found;
  const matched = v.match ? r.evidence.find((e) => e.id === v.match) : null;
  if (matched) sources = [{ label: `${matched.kind === "companies_house" ? "Companies House" : "Wikidata"} ${matched.ref} (${matched.label})`, url: matched.url }, ...sources];
  if (v.web && r.web?.refs?.length) sources = [...sources, ...r.web.refs.slice(0, 3).map((x) => ({ label: x.title, url: x.url }))];
  const parts = [v.web ? `AI estimate by Mistral (${opts.webModel}), checked with a web search` : `AI estimate by Mistral (${opts.model}): ${Math.round(v.agree * v.total)} of ${v.total} answers agree`];
  // A web search ran but didn't settle it, so the answers' owner stands (18 Oct 2026: the app said no web search ran).
  if (!v.web && r.web) parts.push("a web search couldn't confirm it");
  if (r.resolved === "model") parts.push("kept after weighing it against Wikidata/GLEIF, which may be out of date");
  else if (r.verified) parts.push(r.conflict && r.resolved !== "web" ? "the owner's country is taken from Wikidata/GLEIF" : "the owner's country matches Wikidata/GLEIF");
  if (matched) parts.push(`matched to ${matched.kind === "companies_house" ? "Companies House" : "Wikidata"} ${matched.ref}`);
  const chain = buildChain(v.brand, country, owner, ownerHops, matched);
  Object.assign(r, {
    decision: "found",
    country,
    owner: chain[chain.length - 1]?.name ?? owner,
    brand: v.brand,
    owner_type: v.owner_type,
    confidence: v.confidence,
    agree: v.agree,
    match: v.match,
    chain,
    technique: `${parts.join("; ")}. Not checked by a person.`,
    sources,
    ms: Date.now() - t0,
  });
  return r;
}

// --- Bench helpers ------------------------------------------------------------------------------------------
export async function mistralModels(fetchImpl, apiKey) {
  const res = await fetchImpl(`${MISTRAL_API}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
  const j = await res.json().catch(() => ({}));
  return {
    status: res.status,
    models: (j.data ?? []).map((m) => ({ id: m.id, name: m.name, aliases: m.aliases, caps: m.capabilities, deprecation: m.deprecation, ctx: m.max_context_length })),
  };
}

export async function mistralProbe(fetchImpl, apiKey, model) {
  const res = await fetchImpl(`${MISTRAL_API}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "Say OK." }] }),
  });
  const headers = {};
  for (const [k, v] of res.headers) if (/ratelimit|retry|tier|limit/i.test(k)) headers[k] = v;
  return { status: res.status, headers, body: (await res.text()).slice(0, 300) };
}
