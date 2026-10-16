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
const run = async (name, m, opts = {}, country) => aiEstimate(name, { fetch: m.f, apiKey: "x", wikidata: wd, gleif, today: "2026-10-14", country }, opts);
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
