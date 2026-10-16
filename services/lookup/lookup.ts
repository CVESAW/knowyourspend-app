// @ts-nocheck — recovered bundle code (plain JavaScript), split out of kys-lookup on 14 Oct 2026.
// The look-up order for one name: cache → our list → Wikidata + GLEIF → Companies House → Wikidata alone → AI.
import { CompaniesHouse, Gleif, Wikidata, normaliseName, ownershipFromWikidata, slug, stripLegalSuffix } from "./registries.ts";
import { aiEstimate } from "./ai.ts";
// When the Mistral AI step went live: cached "no answer" decisions from before are looked up again.
export var AI_STEP_SINCE = "2026-10-14";
// Answers are kept per name; for a bank outside the UK (14 Oct 2026) per country and name, since "COOP" in Denmark
// is not the Co-op in Britain.
export var cacheKey = (name, country = "GB") => country && country !== "GB" ? `${country}:${stripLegalSuffix(name, true)}` : stripLegalSuffix(name), time = async (f) => {
  let t0 = Date.now();
  return [await f(), Date.now() - t0];
};
export async function lookupName(query, deps) {
  let trace = [], today = deps.today ?? (new Date()).toISOString().slice(0, 10), name = normaliseName(query).slice(0, 80), result = (status, entry, via) => ({
    query: name,
    status,
    entry,
    via,
    trace,
    looked_up_at: (new Date()).toISOString()
  }), note = (step, status, detail, ms) => trace.push({ step, status, detail, ms }), abroad = (deps.country ?? "GB") !== "GB";
  if (name.length < 2)
    return note("cache", "skipped", "Name too short to look up."), result("UNRESOLVED");
  if (deps.cache) {
    let [hit, ms] = await time(() => deps.cache.get(cacheKey(name, deps.country)));
    if (hit && hit.status === "RESOLVED" && hit.entry)
      return note("cache", "found", `Looked up before (${hit.looked_up_at.slice(0, 10)}) via ${hit.via ?? "lookup"}.`, ms), { ...hit, query: name, trace: [...trace, ...hit.trace.filter((s) => s.step !== "cache")] };
    // The AI step's "not a business" or "not sure", kept for a few days, is served too, so the same name isn't sent to
    // Mistral again by everyone who has it (answers that failed part-way are never kept). Not decisions of the
    // earlier AI step, from before AI_STEP_SINCE.
    if (hit && hit.status !== "RESOLVED" && hit.looked_up_at >= AI_STEP_SINCE && hit.trace?.some((s) => s.step === "llm" && s.status === "rejected"))
      return note("cache", "found", `Looked up before (${hit.looked_up_at.slice(0, 10)}): ${hit.status === "NOT_A_BUSINESS" ? "not a business the AI could identify" : "no owner found"}.`, ms), { ...hit, query: name, trace: [...trace, ...hit.trace.filter((s) => s.step !== "cache")] };
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
  let wd = deps.wikidata ?? new Wikidata(deps.fetch), gleif = deps.gleif ?? new Gleif(deps.fetch), base = (aliases) => ({ id: `lookup-${slug(name)}`, display_name: titleCase(name), kind: "merchant", aliases, as_of: today, reviewed_by: null, reviewed_at: null }), wdCandidate, wdLabel = "";
  try {
    let [found, ms] = await time(async () => {
      for (let variant of nameVariants(name, abroad)) {
        let hits = await wd.searchBusiness(variant, abroad);
        for (let h of hits.slice(0, 3)) {
          let o = await ownershipFromWikidata(wd, gleif, h.id);
          if (o) return { o, label: h.label, n: hits.length };
        }
      }
    });
    if (found) {
      if (wdCandidate = found.o, wdLabel = found.label, found.o.tier === "EXACT_ID")
        return note("wikidata_gleif", "found", `${found.o.summary}.`, ms), result("RESOLVED", { ...base([name]), display_name: found.label, chain: found.o.chain, owner_country: found.o.owner_country, ...found.o.legal_country ? { legal_country: found.o.legal_country } : {}, tier: "EXACT_ID", technique: found.o.technique, sources: found.o.sources }, "wikidata_gleif");
      note("wikidata_gleif", "not_found", `Found ${found.label} on Wikidata, but the global register (GLEIF) can't confirm its owner.`, ms);
    } else note("wikidata_gleif", "not_found", "No business with exactly this name on Wikidata.", ms);
  } catch (e) {
    note("wikidata_gleif", "error", `Wikidata or GLEIF didn't answer (${e.message}).`);
  }
  // Companies House is the UK's register: for a bank elsewhere, a UK company with the same name is likely a different business.
  let chApi = deps.companiesHouseKey && (deps.country ?? "GB") === "GB" ? deps.ch ?? new CompaniesHouse(deps.fetch, deps.companiesHouseKey) : void 0;
  if (chApi)
    try {
      let ch = chApi, [r, ms] = await time(async () => {
        let co = await ch.findActive(name);
        return co ? ch.chainFrom(co) : void 0;
      });
      if (r)
        return note("companies_house", "found", `${r.summary} (from the company's filings of who controls it).`, ms), result("RESOLVED", { ...base([name]), display_name: titleCase(stripLegalSuffix(r.chain[0].name)), chain: r.chain, owner_country: r.owner_country, tier: "NAME_MATCH", technique: "Found by exact name in the UK company register (Companies House); owner from its 'persons with significant control' filings.", sources: r.sources }, "companies_house");
      note("companies_house", "not_found", "No single active UK company with exactly this name.", ms);
    } catch (e) {
      note("companies_house", "error", `Companies House didn't answer (${e.message}).`);
    }
  else note("companies_house", "skipped", (deps.country ?? "GB") === "GB" ? "Not connected yet." : "UK register; not used for a bank outside the UK.");
  if (wdCandidate)
    return note("wikidata", "found", `${wdCandidate.summary}. Open data, not confirmed by a register.`), result("RESOLVED", { ...base([name]), display_name: wdLabel, chain: wdCandidate.chain, owner_country: wdCandidate.owner_country, tier: "NAME_MATCH", technique: wdCandidate.technique, sources: wdCandidate.sources }, "wikidata");
  // A paused AI step (today's limit reached, or the AI account out of credit) is noted as an error, so neither our
  // cache nor the app records the name as unknown and it is tried again later.
  let paused = deps.llm?.state?.paused;
  if (note("wikidata", "not_found", "Nothing usable on Wikidata."), deps.llm && paused)
    note("llm", "error", `AI step paused (${paused}); try again later.`);
  else if (deps.llm)
    try {
      // 14 Oct 2026: Mistral AI (ai.ts): five answers that must agree and the owner looked up in Wikidata/GLEIF; unless
      // all five agree and the register confirms it, a web search whose answer wins.
      deps.llm.state && (deps.llm.state.calls = (deps.llm.state.calls ?? 0) + 1);
      let [a, ms] = await time(() => aiEstimate(name, { fetch: deps.fetch, apiKey: deps.llm.apiKey, wikidata: wd, gleif, ch: chApi, today, country: deps.country ?? "GB", webOk: deps.llm.webOk, webQueue: deps.llm.webQueue, deadline: deps.llm.deadline }, deps.llm.options));
      deps.llm.onResult?.(a);
      let agreed = a.agree == null ? "checked with a web search" : `${Math.round(a.agree * 100)}% of answers agree${a.verified ? ", owner checked in Wikidata" : ""}`;
      if (a.decision === "found")
        return note("llm", "found", `AI estimate (${agreed}): ${a.reason || `${a.owner}, ${a.country}`}`, ms), result("RESOLVED", { ...base([name]), display_name: a.brand ?? titleCase(name), chain: a.chain, owner_country: a.country, tier: "LLM_GUESS", technique: a.technique, sources: a.sources }, "llm");
      if (a.decision === "not_business")
        return note("llm", "rejected", `AI: doesn't look like a business we can identify (${a.reason}).`, ms), result("NOT_A_BUSINESS");
      note("llm", "rejected", `AI wasn't sure enough (${a.reason}).`, ms);
    } catch (e) {
      // 402: Mistral's prepaid credit has run out; stop asking for the rest of this request
      if (e.status === 402 && deps.llm.state) deps.llm.state.paused = "the AI account is out of credit";
      note("llm", "error", `AI service didn't answer (${e.status === 402 ? "the AI account is out of credit" : e.status ? `HTTP ${e.status}` : e.message}).`);
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
