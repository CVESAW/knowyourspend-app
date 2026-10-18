// The AI step's decisions with a stand-in for Mistral (web search on or off, failing, disagreeing with the
// register, the daily limit reached, a bank outside the UK). Looks owners up on Wikidata and GLEIF for real.
// Run: node services/lookup/test/ai-step.mjs
import { aiEstimate, systemPrompt } from "../ai.ts";
import { Wikidata, Gleif } from "../registries.ts";
const wd = new Wikidata(fetch, { retries: 2 }), gleif = new Gleif(fetch);
const ok = (c, m) => { if (!c) process.exitCode = 1; console.log(c ? "ok  " : "FAIL", m); };
const ans = (o, c, k = "high", b = true) => JSON.stringify({ is_business: b, brand: "X", ultimate_owner: o, owner_type: "listed_company", owner_country: c, confidence: k, match: null, reason: "r" });
function mock({ chat, web }) {
  const calls = { chat: 0, web: 0, prompts: [] };
  const f = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/chat/completions")) { calls.chat++; const b = JSON.parse(init.body); calls.prompts.push(b.messages[0].content); return new Response(JSON.stringify({ choices: Array.from({ length: b.n }, () => ({ message: { content: chat } })), usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }); }
    if (u.endsWith("/conversations")) { calls.web++; if (web === "fail") return new Response("{}", { status: 400 }); return new Response(JSON.stringify({ outputs: [{ type: "tool.execution", name: "web_search" }, { type: "message.output", content: [{ type: "text", text: web }, { type: "tool_reference", title: "Example", url: "https://example.com/a" }] }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 }); }
    return fetch(url, init);
  };
  return { f, calls };
}
const run = async (name, m, opts = {}, country, seen) => aiEstimate(name, { fetch: m.f, apiKey: "x", wikidata: wd, gleif, today: "2026-10-14", country, seen }, opts);
// (a) register agrees → no web in "check" mode
let m = mock({ chat: ans("Frasers Group", "GB"), web: ans("Someone", "US") });
let r = await run("FLANNELS", m, { web: "check" });
ok(r.decision === "found" && r.country === "GB" && m.calls.web === 0 && r.verified, `a: confirmed by register, no web (${r.decision} ${r.country} web=${m.calls.web})`);
// (b) owner not on Wikidata → web answer replaces it
m = mock({ chat: ans("Zzq Made Up Holdings", "GB"), web: ans("Frasers Group", "GB") });
r = await run("SOME SHOP", m, { web: "check" });
ok(r.decision === "found" && r.resolved === "web" && m.calls.web === 1 && r.sources.some((s) => s.url === "https://example.com/a"), `b: unconfirmed → web (${r.decision} ${r.country} ${r.owner} | ${r.technique})`);
// (c) register disagrees → web decides
m = mock({ chat: ans("Frasers Group", "US"), web: ans("Frasers Group", "GB") });
r = await run("FLANNELS", m, { web: "check" });
ok(r.decision === "found" && r.country === "GB" && r.resolved === "web", `c: disagreement → web (${r.decision} ${r.country})`);
// (d) web fails: an unconfirmed answer stands, a disagreement is declined
m = mock({ chat: ans("Zzq Made Up Holdings", "GB"), web: "fail" });
r = await run("SOME SHOP", m, { web: "check" });
ok(r.decision === "found" && r.country === "GB" && !r.verified, `d1: web fails, unconfirmed stands (${r.decision} ${r.country}) notes=${r.notes.join(";")}`);
m = mock({ chat: ans("Frasers Group", "US"), web: "fail" });
r = await run("FLANNELS", m, { web: "check" });
ok(r.decision === "declined", `d2: web fails on a disagreement → declined (${r.decision}: ${r.reason})`);
// (e) web off → old behaviour (ask)
m = mock({ chat: ans("Frasers Group", "US"), web: ans("x", "GB") });
r = await run("FLANNELS", m, { web: "off" });
ok(m.calls.web === 0 && m.calls.chat === 2, `e: web off → second look (${r.decision} ${r.country}, chat calls ${m.calls.chat})`);
// (f) not a business; country in the prompt
m = mock({ chat: ans(null, null, "high", false), web: ans("x", "GB") });
r = await run("JANE SMITH", m, {}, "DE");
ok(r.decision === "not_business" && m.calls.web === 0, `f: not a business, no web (${r.decision})`);
ok(m.calls.prompts[0].includes("a bank statement from Germany") && m.calls.prompts[0].includes("is DE."), "f: German bank → prompt says Germany");
ok(systemPrompt("2026-10-14").includes("a UK bank statement") && systemPrompt("2026-10-14").includes("A UK business whose owners are UK people or UK companies is GB."), "UK prompt unchanged");
// (g) "always" mode asks the web even when confirmed
m = mock({ chat: ans("Frasers Group", "GB"), web: ans("Frasers Group", "GB") });
r = await run("FLANNELS", m, { web: "always" });
ok(m.calls.web === 1 && r.country === "GB", `g: always → web even when confirmed (${r.country}, web=${m.calls.web})`);

// (h) "always": the web answer wins over a confirmed one; web failure falls back to the AI's answer
m = mock({ chat: ans("Frasers Group", "GB"), web: ans("TDR Capital", "GB") });
r = await run("SOMETHING", m, { web: "always" });
ok(r.resolved === "web" && r.owner === "TDR Capital" && m.calls.web === 1, `h1: always → web wins (${r.owner} ${r.country}, verified=${r.verified})`);
m = mock({ chat: ans("Frasers Group", "GB"), web: "fail" });
r = await run("FLANNELS", m, { web: "always" });
ok(r.decision === "found" && r.country === "GB" && r.verified && !r.resolved, `h2: web fails → the AI's register-checked answer (${r.decision} ${r.country} verified=${r.verified})`);
m = mock({ chat: ans("Frasers Group", "GB"), web: ans("TDR Capital", "GB") });
r = await aiEstimate("FLANNELS", { fetch: m.f, apiKey: "x", wikidata: wd, gleif, today: "2026-10-14", webOk: () => false }, {});
ok(m.calls.web === 0 && r.decision === "found" && r.verified, `h3: cap reached → no web, AI answer (${r.country})`);
// (h4) "always", the web fails and the register disagrees → a second look, as with no web search
m = mock({ chat: ans("Frasers Group", "US"), web: "fail" });
r = await run("FLANNELS", m, { web: "always" });
ok(m.calls.web === 1 && m.calls.chat === 2 && !!r.reconcile, `h4: always, web fails on a disagreement → second look (${r.decision} ${r.country}, chat calls ${m.calls.chat})`);

// --- Added after the review of 14 Oct ---------------------------------------------------------------------------
// A stand-in that can give different answers per sample, a different reply to each chat call, and a status for the web.
function mock2({ chats, web, webStatus }) {
  const calls = { chat: 0, web: 0 };
  const f = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/chat/completions")) {
      const c = chats[Math.min(calls.chat++, chats.length - 1)];
      if (typeof c === "number") return new Response(JSON.stringify({ message: "stand-in error" }), { status: c });
      const b = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: Array.from({ length: b.n }, (_, i) => ({ message: { content: Array.isArray(c) ? c[i % c.length] : c } })), usage: {} }), { status: 200 });
    }
    if (u.endsWith("/conversations")) {
      calls.web++;
      if (webStatus) return new Response("{}", { status: webStatus });
      return new Response(JSON.stringify({ outputs: [{ type: "message.output", content: [{ type: "text", text: web }] }], usage: {} }), { status: 200 });
    }
    return fetch(url, init);
  };
  return { f, calls };
}
// (i) the register disagrees, and the second look fails → an error (tried again later), not the contradicted answer
m = mock2({ chats: [ans("Frasers Group", "US"), 402] });
let err = null;
try { r = await run("FLANNELS", m, { web: "off" }); } catch (e) { err = e; }
ok(err?.status === 402 && m.calls.chat === 2, `i: second look out of credit → error, not "found US" (${err ? `HTTP ${err.status}` : `${r.decision} ${r.country}`})`);
m = mock2({ chats: [ans("Frasers Group", "US"), ans("Frasers Group", "US")] });
r = await aiEstimate("FLANNELS", { fetch: m.f, apiKey: "x", wikidata: wd, gleif, today: "2026-10-14", deadline: Date.now() + 4500 }, { web: "off" });
ok(r.decision === "found" && !r.verified && !r.registry && m.calls.chat === 1, `i: no time left for the register check → the vote stands, unchecked (${r.decision} ${r.country ?? ""}, verified=${!!r.verified})`);
// (ii) the web check out of credit → an error, so the look-up pauses the AI step
m = mock2({ chats: [ans("Frasers Group", "GB")], webStatus: 402 });
err = null;
try { r = await run("FLANNELS", m, { web: "always" }); } catch (e) { err = e; }
ok(err?.status === 402, `ii: web check out of credit → error (${err ? `HTTP ${err.status}` : r.decision})`);
// (iii) one answer of five takes it for a person → no web search for it
m = mock2({ chats: [[ans(null, null, "high", false), ans("Zzq Holdings", "GB", "low"), ans("Zzq Holdings", "GB", "low"), ans("Zzq Holdings", "GB", "low"), ans("Zzq Holdings", "GB", "low")]], web: ans("Someone", "GB") });
r = await run("ROGER PLATT", m);
ok(m.calls.web === 0 && r.decision === "declined" && r.notes.some((n) => /no web search/.test(n)), `iii: an answer says "not a business" → no web search (${r.decision}, web calls ${m.calls.web})`);
// (iv) the web check fails with a server error → not tried again (it may already have been charged for its searches)
m = mock2({ chats: [ans("Frasers Group", "GB")], webStatus: 503 });
r = await run("FLANNELS", m, { web: "always" });
ok(m.calls.web === 1 && r.decision === "found" && r.notes.some((n) => /web: Mistral HTTP 503/.test(n)), `iv: web 503 → one try, then the vote (${r.decision} ${r.country}, web calls ${m.calls.web})`);

// --- "unsure" (the default since 14 Oct): the web only when the five answers don't all agree or no register confirms
// (j1) all five agree and the register confirms → no web search, kept as long as a web check
m = mock2({ chats: [ans("Frasers Group", "GB")], web: ans("Someone", "US") });
r = await run("FLANNELS", m);
ok(m.calls.web === 0 && r.decision === "found" && r.country === "GB" && r.verified && r.checked === "register", `j1: unanimous and confirmed → no web (${r.country}, checked=${r.checked})`);
// (j2) all five agree, but the owner isn't on Wikidata → web search, whose answer wins
m = mock2({ chats: [ans("Zzq Made Up Holdings", "GB")], web: ans("Frasers Group", "GB") });
r = await run("SOME SHOP", m);
ok(m.calls.web === 1 && r.resolved === "web" && r.checked === "web", `j2: owner not confirmed → web (${r.owner} ${r.country})`);
// (j3) four of five agree and the register confirms → web search
m = mock2({ chats: [[ans("Frasers Group", "GB"), ans("Frasers Group", "GB"), ans("Frasers Group", "GB"), ans("Frasers Group", "GB"), ans("Frasers Group", "US")]], web: ans("Frasers Group", "GB") });
r = await run("FLANNELS", m);
ok(m.calls.web === 1 && r.resolved === "web", `j3: 4 of 5 agree → web (${r.country}, web calls ${m.calls.web})`);
// (j4) the register disagrees → web search; if the web can't answer, declined
m = mock2({ chats: [ans("Frasers Group", "US")], web: ans("Frasers Group", "GB") });
r = await run("FLANNELS", m);
ok(m.calls.web === 1 && r.country === "GB" && r.resolved === "web", `j4: register disagrees → web decides (${r.country})`);
m = mock2({ chats: [ans("Frasers Group", "US")], webStatus: 503 });
r = await run("FLANNELS", m);
ok(m.calls.web === 1 && r.decision === "declined", `j4: …and when the web fails → declined (${r.decision})`);
// (j5) today's web limit reached: the confirmed unanimous answer still counts as checked; an unconfirmed one doesn't
m = mock2({ chats: [ans("Zzq Made Up Holdings", "GB")], web: ans("x", "GB") });
r = await aiEstimate("SOME SHOP", { fetch: m.f, apiKey: "x", wikidata: wd, gleif, today: "2026-10-14", webOk: () => false }, {});
ok(m.calls.web === 0 && r.decision === "found" && !r.checked, `j5: no web left → the unconfirmed vote stands, not marked checked (${r.decision}, checked=${r.checked ?? "no"})`);

// --- How long the look-up keeps an answer (15 Oct): webMissed marks a web check that was wanted but didn't happen ---
// (k1) the web check fails → webMissed (kept 3 days, so the check comes soon)
m = mock2({ chats: [ans("Zzq Made Up Holdings", "GB")], webStatus: 503 });
r = await run("SOME SHOP", m);
ok(m.calls.web === 1 && r.decision === "found" && !r.checked && r.webMissed === true, `k1: web fails → webMissed (${r.decision}, webMissed=${r.webMissed})`);
// (k2) the web search answers but isn't sure → it had its check: not webMissed (kept 30 days)
m = mock2({ chats: [ans("Zzq Made Up Holdings", "GB")], web: ans(null, null, "low") });
r = await run("SOME SHOP", m);
ok(m.calls.web === 1 && r.decision === "found" && !r.checked && !r.webMissed, `k2: web not sure → not webMissed (${r.decision}, webMissed=${!!r.webMissed})`);
// (k3) today's web limit reached → webMissed; all five agree and the register confirms → checked, not webMissed
m = mock2({ chats: [ans("Zzq Made Up Holdings", "GB")], web: ans("x", "GB") });
r = await aiEstimate("SOME SHOP", { fetch: m.f, apiKey: "x", wikidata: wd, gleif, today: "2026-10-14", webOk: () => false }, {});
ok(m.calls.web === 0 && r.webMissed === true, `k3: web limit reached → webMissed (${r.webMissed})`);
m = mock2({ chats: [ans("Frasers Group", "GB")], web: ans("x", "GB") });
r = await run("FLANNELS", m);
ok(m.calls.web === 0 && r.checked === "register" && !r.webMissed, `k3: unanimous and confirmed → checked=${r.checked}, not webMissed`);
// (k4) an answer took it for a person → never searched on the web, so not webMissed (kept 30 days)
m = mock2({ chats: [[ans(null, null, "high", false), ans("Zzq Holdings", "GB"), ans("Zzq Holdings", "GB"), ans("Zzq Holdings", "GB"), ans("Zzq Holdings", "GB")]], web: ans("Someone", "GB") });
r = await run("ROGER PLATT", m);
ok(m.calls.web === 0 && r.decision === "found" && !r.webMissed, `k4: an answer says "not a business" → no web, not webMissed (${r.decision})`);

// --- What kind of business (17 Oct): on the first request for a name, "local" answers aren't checked or searched, and
// the web waits for a later request when the answers can't tell what kind of business it is
const scaled = (o, c, scale, k = "high", b = true) => JSON.stringify({ ...JSON.parse(ans(o, c, k, b)), scale });
const localish = [scaled(null, null, "local", "low"), scaled(null, null, "local", "low"), scaled(null, null, "local", "low"), scaled(null, null, "unknown", "low"), scaled(null, null, "chain", "low")];
// (l1) first request, most answers say a small local business → "local": no register check, no web search, kept briefly
m = mock2({ chats: [localish], web: ans("Someone", "GB") });
r = await run("THE BEAN HOUSE", m, {}, undefined, 1);
ok(r.decision === "local" && r.country === "GB" && m.calls.web === 0 && !r.registry && r.webMissed === true, `l1: local, first request → decision local, no web, kept briefly (${r.decision} ${r.country}, web calls ${m.calls.web}, webMissed=${r.webMissed})`);
// (l1b) a later request: the web search runs, and finds no owner either → "local", checked (kept a year)
m = mock2({ chats: [localish], web: scaled(null, null, "local", "low") });
r = await run("THE BEAN HOUSE", m, {}, undefined, 2);
ok(r.decision === "local" && r.country === "GB" && m.calls.web === 1 && r.checked === "web" && !r.webMissed, `l1b: local, later request → web finds no owner → local, checked (${r.decision}, web ${m.calls.web}, checked=${r.checked})`);
// (l1c) a later request, and the web search finds a chain owned abroad → that owner
m = mock2({ chats: [localish], web: scaled("Rexel", "FR", "chain") });
r = await run("ZZQ ELECTRICAL", m, {}, undefined, 2);
ok(r.decision === "found" && r.country === "FR" && r.resolved === "web", `l1c: local, later request → web finds a chain abroad (${r.decision} ${r.country})`);
// (l1d) a later request; the answers named a UK owner nothing confirms, and the web search finds none → "local"
m = mock2({ chats: [scaled("Zzq Garden Trust", "GB", "local", "medium")], web: scaled(null, null, "local", "low") });
r = await run("ZZQ GARDENS", m, {}, undefined, 2);
ok(r.decision === "local" && m.calls.web === 1, `l1d: unconfirmed UK owner, web finds none → local (${r.decision}, web ${m.calls.web})`);
// (l1f) a later request, and the web search names an owner but still calls it a small local business → not used: local
m = mock2({ chats: [localish], web: scaled("Zzq Leisure Group", "GB", "local", "medium") });
r = await run("THE ZZQ SPOON BISTRO", m, {}, undefined, 2);
ok(r.decision === "local" && m.calls.web === 1 && r.notes.some((n) => /not used/.test(n)), `l1f: web names an owner but says local → local (${r.decision} ${r.owner ?? ""})`);
// (l1g) the answers couldn't tell what it is; the web search says local and names an owner → local too
m = mock2({ chats: [scaled(null, null, "unknown", "low")], web: scaled("Zzq Leisure Group", "GB", "local", "medium") });
r = await run("ZZQ SPOON", m, {}, undefined, 2);
ok(r.decision === "local" && m.calls.web === 1, `l1g: unclear, web says local with an owner → local (${r.decision})`);
// (l1e) no count (the counter didn't answer) → treated as a later request: the full check
m = mock2({ chats: [localish], web: scaled(null, null, "local", "low") });
r = await run("THE BEAN HOUSE", m);
ok(r.decision === "local" && m.calls.web === 1, `l1e: no count → full check (${r.decision}, web ${m.calls.web})`);
// (l2) local, but the answers agree on an owner abroad → not "local": the usual checks run
m = mock2({ chats: [scaled("Zzq Investments", "QA", "local", "high")], web: ans("Zzq Investments", "QA") });
r = await run("THE ZZQ HOTEL", m, {}, undefined, 1);
ok(r.decision === "found" && r.country === "QA" && m.calls.web === 1, `l2: local but owned abroad → checked like any other (${r.decision} ${r.country}, web ${m.calls.web})`);
// (l3) a bank in Spain: a local business there counts in Spain
m = mock2({ chats: [scaled(null, null, "local", "low")], web: ans("x", "ES") });
r = await run("TAVERNA SOFIA", m, {}, "ES", 1);
ok(r.decision === "local" && r.country === "ES", `l3: local, Spanish bank → ES (${r.country})`);
// (l4) the setting off (bench comparison) → the old behaviour
m = mock2({ chats: [scaled(null, null, "local", "low")], web: ans(null, null, "low") });
r = await run("THE BEAN HOUSE", m, { local: false });
ok(r.decision !== "local" && m.calls.web === 1, `l4: local off → searched as before (${r.decision}, web ${m.calls.web})`);
// --- After the review of 18 Oct ---------------------------------------------------------------------------------
// (l5) first request; most answers say local, but two are sure it's a chain abroad → not "local" straight away: the
// web search runs
const splitLocal = [scaled(null, null, "local", "low"), scaled(null, null, "local", "low"), scaled(null, null, "local", "low"), scaled("Zzq Burger Corp", "US", "chain"), scaled("Zzq Burger Corp", "US", "chain")];
m = mock2({ chats: [splitLocal], web: scaled("Zzq Burger Corp", "US", "chain") });
r = await run("ZZQ BURGER", m, {}, undefined, 1);
ok(r.decision === "found" && r.country === "US" && m.calls.web === 1, `l5: local, but sure answers abroad → web on the first request (${r.decision} ${r.country}, web ${m.calls.web})`);
// (l5b) …and the web search finds a small local business with no owner → local, checked
m = mock2({ chats: [splitLocal], web: scaled(null, null, "local", "low") });
r = await run("ZZQ BURGER", m, {}, undefined, 1);
ok(r.decision === "local" && m.calls.web === 1 && r.checked === "web", `l5b: …web finds it's local → local, checked (${r.decision}, checked=${r.checked})`);
// (l6) the answers agree on a chain abroad, and the web search calls it a small local business → no answer, rather
// than the answers' owner with no word of the web search
m = mock2({ chats: [scaled("Zzq Burger Corp", "US", "chain")], web: scaled("Zzq Family Ltd", "GB", "local", "medium") });
r = await run("ZZQ BURGER", m, {}, undefined, 2);
ok(r.decision === "declined" && m.calls.web === 1 && /small local business/.test(r.reason ?? ""), `l6: owner abroad, web says local → declined (${r.decision}: ${r.reason})`);
m = mock2({ chats: [scaled("Zzq Burger Corp", "US", "chain")], web: scaled("Zzq Family Ltd", "GB", "local", "medium") });
r = await run("ZZQ BURGER", m, { web: "always" }, undefined, 2);
ok(r.decision === "declined" && m.calls.web === 1, `l6b: the same with the web always on → declined (${r.decision})`);
// (l6c) the answers' owner is in the UK and the web search says local → local (the country is the same)
m = mock2({ chats: [scaled("Zzq Family Ltd", "GB", "chain", "medium")], web: scaled("Zzq Family Ltd", "GB", "local", "medium") });
r = await run("ZZQ BURGER", m, {}, undefined, 2);
ok(r.decision === "local" && r.country === "GB", `l6c: UK owner, web says local → local (${r.decision})`);
// (l6d) the same with a web search that calls it local but names no owner it's sure of → no answer either
m = mock2({ chats: [scaled("Zzq Burger Corp", "US", "chain")], web: scaled(null, null, "local", "low") });
r = await run("ZZQ BURGER", m, {}, undefined, 2);
ok(r.decision === "declined" && m.calls.web === 1, `l6d: owner abroad, web says local with no owner → declined (${r.decision})`);
// (l7) most answers local but two sure it's a chain abroad, and no web search to settle it (today's limit) → not
// counted as a local business: no answer, kept briefly so it's checked soon
m = mock2({ chats: [splitLocal], web: scaled(null, null, "local", "low") });
r = await aiEstimate("ZZQ BURGER", { fetch: m.f, apiKey: "x", wikidata: wd, gleif, today: "2026-10-18", seen: 2, webOk: () => false }, {});
ok(r.decision === "declined" && r.webMissed === true && m.calls.web === 0, `l7: local but sure answers abroad, no web → declined, kept briefly (${r.decision}, webMissed=${r.webMissed})`);
// (l7b) …and when one answer took it for a person (no web search at all) → no answer, not a local business
const splitDoubt = [scaled(null, null, "local", "low"), scaled(null, null, "local", "low"), scaled(null, null, "local", "low"), scaled("Zzq Burger Corp", "US", "chain"), scaled(null, null, "unknown", "high", false)];
m = mock2({ chats: [splitDoubt], web: scaled(null, null, "local", "low") });
r = await run("ZZQ BURGER", m, {}, undefined, 1);
ok(r.decision === "declined" && m.calls.web === 0, `l7b: local, one sure answer abroad, one "not a business" → declined (${r.decision})`);
// (l8) a web search runs but isn't sure, so the answers' owner stands: the technique says the web search couldn't confirm it
m = mock2({ chats: [[ans("Zzq Holdings", "IE"), ans("Zzq Holdings", "IE"), ans("Zzq Holdings", "IE"), ans("Zzq Holdings", "IE"), ans("Other", "GB")]], web: ans(null, null, "low") });
r = await run("ZZQ SHOP", m, {}, undefined, 2);
ok(r.decision === "found" && m.calls.web === 1 && /a web search couldn't confirm it/.test(r.technique) && !/checked with a web search/.test(r.technique), `l8: web not sure → the vote, and says so (${r.technique})`);
// (m1) the answers can't tell what kind of business it is, and it's the first request for the name → no web yet
m = mock2({ chats: [scaled("Zzq Made Up Holdings", "GB", "unknown")], web: ans("Frasers Group", "GB") });
r = await aiEstimate("SOME SHOP", { fetch: m.f, apiKey: "x", wikidata: wd, gleif, today: "2026-10-17", seen: 1 }, {});
ok(m.calls.web === 0 && r.webMissed === true && r.notes.some((n) => /first request/.test(n)), `m1: unknown kind, first request → web waits, kept briefly (webMissed=${r.webMissed})`);
// (m2) …asked about again → the web search runs
m = mock2({ chats: [scaled("Zzq Made Up Holdings", "GB", "unknown")], web: ans("Frasers Group", "GB") });
r = await aiEstimate("SOME SHOP", { fetch: m.f, apiKey: "x", wikidata: wd, gleif, today: "2026-10-17", seen: 2 }, {});
ok(m.calls.web === 1 && r.resolved === "web", `m2: second request → web (${r.owner} ${r.country})`);
// (m3) a chain, first request → the web search runs (only "unknown" waits)
m = mock2({ chats: [scaled("Zzq Made Up Holdings", "GB", "chain")], web: ans("Frasers Group", "GB") });
r = await aiEstimate("SOME SHOP", { fetch: m.f, apiKey: "x", wikidata: wd, gleif, today: "2026-10-17", seen: 1 }, {});
ok(m.calls.web === 1, `m3: chain, first request → web (${r.country})`);
ok(systemPrompt("2026-10-17").includes('"local": a single independent shop') && systemPrompt("2026-10-17").includes('"scale":"local"'), "prompt explains scale, with an example");
