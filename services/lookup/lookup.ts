// @ts-nocheck — recovered bundle code (plain JavaScript), split out of kys-lookup on 14 Oct 2026.
// The look-up order for one name: cache → our list → Wikidata + GLEIF → Companies House → Wikidata alone → AI.
// Since 16 Oct 2026, when the AI step is connected, a Companies House answer that stops at a UK company and a
// Wikidata answer no register confirms are checked by the AI step first, and stand only if it isn't sure or can't
// answer: on the 170-name check they were wrong 17 times in 52, for shops that are UK arms of owners abroad, and for
// a person's name or a word (CAR PARK, INTEREST) that some UK company happens to be registered under. The same goes
// for an answer that stops at a holding company in a place companies are registered for tax (Caffè Nero's filings end
// in Luxembourg; Spotify's register entry is in Luxembourg too), which the AI step is told not to give as the owner.
// Since 17 Oct 2026 the AI step can also answer "a small local business" (status LOCAL_BUSINESS, no owner): the app
// counts those where they were paid, labelled "Local independent".
import { CompaniesHouse, Gleif, Wikidata, normaliseName, ownershipFromWikidata, slug, stripLegalSuffix } from "./registries.ts";
import { aiEstimate } from "./ai.ts";
// When the Mistral AI step went live: cached "no answer" decisions from before are looked up again.
export var AI_STEP_SINCE = "2026-10-14";
// Where holding companies are often registered rather than run from.
export var HOLDING_PLACES = new Set(["LU", "JE", "GG", "IM", "KY", "VG", "BM", "GI", "CY", "MT"]);
// Answers are kept per name; for a bank outside the UK (14 Oct 2026) per country and name, since "COOP" in Denmark
// is not the Co-op in Britain.
export var cacheKey = (name, country = "GB") => country && country !== "GB" ? `${country}:${stripLegalSuffix(name, true)}` : stripLegalSuffix(name), time = async (f) => {
  let t0 = Date.now();
  return [await f(), Date.now() - t0];
};
export async function lookupName(query, deps) {
  // looked_up_at is the day only (18 Oct 2026): the names one request sends aren't kept with the same exact time.
  let trace = [], today = deps.today ?? (new Date()).toISOString().slice(0, 10), name = normaliseName(query).slice(0, 80), result = (status, entry, via) => ({
    query: name,
    status,
    entry,
    via,
    trace,
    looked_up_at: today
  }), note = (step, status, detail, ms) => trace.push({ step, status, detail, ms }), abroad = (deps.country ?? "GB") !== "GB";
  if (name.length < 2)
    return note("cache", "skipped", "Name too short to look up."), result("UNRESOLVED");
  if (deps.cache) {
    let [hit, ms] = await time(() => deps.cache.get(cacheKey(name, deps.country)));
    if (hit && hit.status === "RESOLVED" && hit.entry)
      return note("cache", "found", `Looked up before (${hit.looked_up_at.slice(0, 10)}) via ${hit.via ?? "lookup"}.`, ms), { ...hit, query: name, trace: [...trace, ...hit.trace.filter((s) => s.step !== "cache")] };
    // The AI step's "not a business", "a small local business" or "not sure", kept for a few days, is served too, so the
    // same name isn't sent to Mistral again by everyone who has it (answers that failed part-way are never kept). Not
    // decisions of the earlier AI step, from before AI_STEP_SINCE.
    if (hit && hit.status !== "RESOLVED" && hit.looked_up_at >= AI_STEP_SINCE && (hit.status === "LOCAL_BUSINESS" || hit.trace?.some((s) => s.step === "llm" && s.status === "rejected")))
      return note("cache", "found", `Looked up before (${hit.looked_up_at.slice(0, 10)}): ${hit.status === "NOT_A_BUSINESS" ? "not a business the AI could identify" : hit.status === "LOCAL_BUSINESS" ? "a small local business" : "no owner found"}.`, ms), { ...hit, query: name, trace: [...trace, ...hit.trace.filter((s) => s.step !== "cache")] };
    note("cache", "not_found", "Not looked up before.", ms);
  }
  // Our list is built for UK statements: "COOP" in Denmark is not the Co-op.
  if (deps.referenceList && abroad) note("reference_list", "skipped", "Our list is for UK statements; not used for a bank outside the UK.");
  else if (deps.referenceList) {
    let e = deps.referenceList(name);
    if (e)
      return note("reference_list", "found", `In our list as ${e.display_name}.`), result("RESOLVED", e, "reference_list");
    note("reference_list", "not_found", "Not in our list.");
  }
  let wd = deps.wikidata ?? new Wikidata(deps.fetch), gleif = deps.gleif ?? new Gleif(deps.fetch), base = (aliases) => ({ id: `lookup-${slug(name)}`, display_name: titleCase(name), kind: "merchant", aliases, as_of: today, reviewed_by: null, reviewed_at: null }), wdCandidate, wdLabel = "", wdPart, fallback;
  try {
    let [found, ms] = await time(async () => {
      let variants = nameVariants(name, abroad);
      for (let variant of variants) {
        let hits = await wd.searchBusiness(variant, abroad);
        for (let h of hits.slice(0, 3)) {
          let o = await ownershipFromWikidata(wd, gleif, h.id);
          if (o) return { o, label: h.label, n: hits.length, part: variant !== variants[0] ? variant : void 0 };
        }
      }
    });
    // Matched on only part of the name (17 Oct 2026): "WARREN EVANS" found "Warren", a city in Ohio. Such a match is
    // used only through the AI step, after Companies House has been tried with the whole name.
    if (found?.part) {
      wdCandidate = found.o, wdLabel = found.label, wdPart = found.part;
      note("wikidata_gleif", "not_found", `Only part of the name (“${found.part}”) matches on Wikidata (${found.label}), which may be a different business.`, ms);
    } else if (found) {
      if (wdCandidate = found.o, wdLabel = found.label, found.o.tier === "EXACT_ID") {
        let entry = { ...base([name]), display_name: found.label, chain: found.o.chain, owner_country: found.o.owner_country, ...found.o.legal_country ? { legal_country: found.o.legal_country } : {}, tier: "EXACT_ID", technique: found.o.technique, sources: found.o.sources };
        if (!deps.llm || !HOLDING_PLACES.has(found.o.owner_country))
          return note("wikidata_gleif", "found", `${found.o.summary}.`, ms), result("RESOLVED", entry, "wikidata_gleif");
        fallback = { entry, via: "wikidata_gleif" };
        note("wikidata_gleif", "found", `${found.o.summary}. The top company is in ${found.o.owner_country}, where holding companies are often registered rather than run from, so the AI step checks it.`, ms);
      } else note("wikidata_gleif", "not_found", `Found ${found.label} on Wikidata, but the global register (GLEIF) can't confirm its owner.`, ms);
    } else note("wikidata_gleif", "not_found", "No business with exactly this name on Wikidata.", ms);
  } catch (e) {
    note("wikidata_gleif", "error", `Wikidata or GLEIF didn't answer (${e.message}).`);
  }
  // Companies House is the UK's register: for a bank elsewhere, a UK company with the same name is likely a different business.
  let chApi = deps.companiesHouseKey && (deps.country ?? "GB") === "GB" ? deps.ch ?? new CompaniesHouse(deps.fetch, deps.companiesHouseKey) : void 0;
  if (chApi && !fallback)
    try {
      let ch = chApi, [r, ms] = await time(async () => {
        let co = await ch.findActive(name);
        return co ? ch.chainFrom(co) : void 0;
      });
      if (r) {
        let entry = { ...base([name]), display_name: titleCase(stripLegalSuffix(r.chain[0].name)), chain: r.chain, owner_country: r.owner_country, tier: "NAME_MATCH", technique: "Found by exact name in the UK company register (Companies House); owner from its 'persons with significant control' filings.", sources: r.sources };
        // An owner abroad in the filings is taken as it is; a UK company, or a holding company registered in a place
        // like Luxembourg or Jersey, at the top goes to the AI step first.
        if (!deps.llm || (r.owner_country !== "GB" && !HOLDING_PLACES.has(r.owner_country)))
          return note("companies_house", "found", `${r.summary} (from the company's filings of who controls it).`, ms), result("RESOLVED", entry, "companies_house");
        fallback = { entry, via: "companies_house" };
        note("companies_house", "found", `${r.summary} (from the company's filings of who controls it). A UK company with this name may not be this shop, or may be the UK arm of an owner abroad, so the AI step checks it.`, ms);
      } else note("companies_house", "not_found", "No single active UK company with exactly this name.", ms);
    } catch (e) {
      note("companies_house", "error", `Companies House didn't answer (${e.message}).`);
    }
  else if (!fallback) note("companies_house", "skipped", (deps.country ?? "GB") === "GB" ? "Not connected yet." : "UK register; not used for a bank outside the UK.");
  if (wdCandidate && !fallback && wdPart) {
    // A match on part of the name never stands on its own: the AI step decides, and without one it isn't used.
    let entry = { ...base([name]), display_name: wdLabel, chain: wdCandidate.chain, owner_country: wdCandidate.owner_country, tier: "NAME_MATCH", technique: wdCandidate.technique, sources: wdCandidate.sources };
    if (!deps.llm) note("wikidata", "rejected", `Only part of the name matches on Wikidata (${wdLabel}), and there's no AI step to check it, so it isn't used.`);
    else fallback = { entry, via: "wikidata", part: wdPart }, note("wikidata", "found", `${wdCandidate.summary}. Only part of the name matches, so the AI step decides, and this isn't used on its own.`);
  } else if (wdCandidate && !fallback) {
    let entry = { ...base([name]), display_name: wdLabel, chain: wdCandidate.chain, owner_country: wdCandidate.owner_country, tier: "NAME_MATCH", technique: wdCandidate.technique, sources: wdCandidate.sources };
    if (!deps.llm) return note("wikidata", "found", `${wdCandidate.summary}. Open data, not confirmed by a register.`), result("RESOLVED", entry, "wikidata");
    fallback = { entry, via: "wikidata" };
    note("wikidata", "found", `${wdCandidate.summary}. Open data, not confirmed by a register, so the AI step checks it.`);
  } else if (!wdCandidate) note("wikidata", "not_found", "Nothing usable on Wikidata.");
  // The register's answer when the AI step can't settle it. Noted with an AI error, it isn't kept, so it's checked again.
  let standing = () => result("RESOLVED", fallback.entry, fallback.via), stands = !!fallback && !fallback.part;
  // A paused AI step (today's limit reached, or the AI account out of credit) is noted as an error, so neither our
  // cache nor the app records the name as unknown and it is tried again later.
  let paused = deps.llm?.state?.paused;
  if (deps.llm && paused) {
    note("llm", "error", `AI step paused (${paused}); try again later.`);
    if (stands) return standing();
  }
  else if (deps.llm)
    try {
      // 14 Oct 2026: Mistral AI (ai.ts): five answers that must agree and the owner looked up in Wikidata/GLEIF; unless
      // all five agree and the register confirms it, a web search whose answer wins.
      deps.llm.state && (deps.llm.state.calls = (deps.llm.state.calls ?? 0) + 1);
      let [a, ms] = await time(() => aiEstimate(name, { fetch: deps.fetch, apiKey: deps.llm.apiKey, wikidata: wd, gleif, ch: chApi, today, country: deps.country ?? "GB", webOk: deps.llm.webOk, webQueue: deps.llm.webQueue, deadline: deps.llm.deadline, seen: deps.seen }, deps.llm.options));
      deps.llm.onResult?.(a);
      let agreed = a.agree == null ? "checked with a web search" : `${Math.round(a.agree * 100)}% of answers agree${a.verified ? ", owner checked in Wikidata" : ""}`;
      if (a.decision === "found")
        return note("llm", "found", `AI estimate (${agreed}): ${a.reason || `${a.owner}, ${a.country}`}`, ms), result("RESOLVED", { ...base([name]), display_name: a.brand ?? titleCase(name), chain: a.chain, owner_country: a.country, tier: "LLM_GUESS", technique: a.technique, sources: a.sources }, "llm");
      if (a.decision === "not_business")
        return note("llm", "rejected", `AI: doesn't look like a business we can identify (${a.reason}).`, ms), result("NOT_A_BUSINESS");
      // checked: "web" tells the app a web search found no owner either (18 Oct 2026), so it can say so.
      if (a.decision === "local")
        return note("llm", "found", `AI: looks like a small local business, not a chain or company it can name${a.checked === "web" ? "; a web search found no owner either" : ""}${a.reason ? ` (${a.reason})` : ""}.`, ms), { ...result("LOCAL_BUSINESS", void 0, "llm"), ...(a.checked === "web" ? { checked: "web" } : {}) };
      note("llm", "rejected", `AI wasn't sure enough (${a.reason}).`, ms);
      if (stands) return note(fallback.via, "found", "The register's answer stands."), standing();
      if (fallback) note(fallback.via, "rejected", "Only part of the name matched, and the AI step couldn't confirm it, so it isn't used.");
    } catch (e) {
      // 402: Mistral's prepaid credit has run out; stop asking for the rest of this request
      if (e.status === 402 && deps.llm.state) deps.llm.state.paused = "the AI account is out of credit";
      note("llm", "error", `AI service didn't answer (${e.status === 402 ? "the AI account is out of credit" : e.status ? `HTTP ${e.status}` : e.message}).`);
      if (stands) return standing();
    }
  else note("llm", "skipped", "Not connected yet.");
  return result("UNRESOLVED");
}
export function nameVariants(name, abroad = false) {
  let words = stripLegalSuffix(name, abroad).split(" "), out = [words.join(" ")];
  for (let n = words.length - 1; n >= 1; n--) {
    let v = words.slice(0, n).join(" ");
    if (n === 1 && v.length < 6 || (out.push(v), out.length >= 3)) break;
  }
  return out;
}
export function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
