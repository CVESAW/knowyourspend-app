// The order of the look-up for one name (lookup.ts), with stand-ins for Wikidata, Companies House and Mistral:
// since 16 Oct 2026 a Companies House answer that stops at a UK company goes to the AI step first, and stands only
// if the AI isn't sure or can't answer. No network.
// Run: node services/lookup/test/pipeline.mjs
import { lookupName } from "../lookup.ts";
const ok = (c, m) => { if (!c) process.exitCode = 1; console.log(c ? "ok  " : "FAIL", m); };

const wikidata = { searchBusiness: async () => [], searchIds: async () => [], entities: async () => [] };
const gleif = { ultimateParent: async () => ({ kind: "none" }), record: async () => null };
const ukCo = { summary: "Companies House: ZZQ SHOP LIMITED", owner_country: "GB", chain: [{ name: "ZZQ SHOP LIMITED", relation: "ultimate_parent", country: "GB" }], sources: [] };
const usCo = { summary: "Companies House: ZZQ UK LIMITED → Zzq Inc", owner_country: "US", chain: [{ name: "ZZQ UK LIMITED", relation: "operator", country: "GB" }, { name: "Zzq Inc", relation: "ultimate_parent", country: "US" }], sources: [] };
const ch = (r) => ({ findActive: async () => ({ number: "00000000", title: "ZZQ" }), chainFrom: async () => r, searchAll: async () => [] });

const say = (o) => JSON.stringify({ is_business: true, brand: "Zzq", ultimate_owner: null, owner_type: "unknown", owner_country: null, confidence: "low", match: null, reason: "r", ...o });
function mistral(answer) {
  const calls = { chat: 0 };
  const fetch = async (url, init) => {
    if (!String(url).endsWith("/chat/completions")) throw new Error(`unexpected request to ${url}`);
    calls.chat++;
    if (answer === "down") return new Response("{}", { status: 503 });
    const b = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: Array.from({ length: b.n }, () => ({ message: { content: answer } })), usage: {} }), { status: 200 });
  };
  return { fetch, calls };
}
const run = (r, answer, llm = {}) => {
  const m = mistral(answer);
  const deps = { fetch: m.fetch, wikidata, gleif, today: "2026-10-16", companiesHouseKey: "x", ch: ch(r), llm: answer === undefined ? undefined : { apiKey: "x", options: { web: "off" }, ...llm } };
  return lookupName("ZZQ", deps).then((x) => ({ ...x, chat: m.calls.chat, steps: x.trace.map((s) => `${s.step}:${s.status}`).join(" ") }));
};

let x = await run(usCo, say({}));
ok(x.via === "companies_house" && x.entry.owner_country === "US" && x.chat === 0, `owner abroad in the filings: taken, no AI (${x.via} ${x.entry?.owner_country}, ${x.chat} AI calls)`);

const luCo = { ...usCo, owner_country: "LU", chain: [{ name: "ZZQ UK LIMITED", relation: "operator", country: "GB" }, { name: "Zzq Holdings Sarl", relation: "ultimate_parent", country: "LU" }] };
x = await run(luCo, say({ ultimate_owner: "Zzq Family", owner_type: "family_or_person", owner_country: "GB", confidence: "high" }));
ok(x.via === "llm" && x.entry.owner_country === "GB" && x.chat === 1, `filings end at a Luxembourg holding company: the AI step decides (${x.via} ${x.entry?.owner_country})`);

x = await run(ukCo, undefined);
ok(x.via === "companies_house" && x.entry.owner_country === "GB", `UK company, no AI step connected: taken as before (${x.via} ${x.entry?.owner_country})`);

x = await run(ukCo, say({ is_business: false, brand: null, confidence: "high", reason: "A person's name." }));
ok(x.status === "NOT_A_BUSINESS" && x.chat === 1, `UK company with a person's name: the AI says not a business (${x.status})`);

x = await run(ukCo, say({ ultimate_owner: "Zzq Holdings Inc", owner_type: "listed_company", owner_country: "US", confidence: "high" }));
ok(x.via === "llm" && x.entry.owner_country === "US", `UK arm of an owner abroad: the AI's answer (${x.via} ${x.entry?.owner_country}) | ${x.steps}`);

x = await run(ukCo, say({}));
ok(x.status === "RESOLVED" && x.via === "companies_house" && x.entry.owner_country === "GB" && !x.trace.some((s) => s.status === "error"), `AI not sure: the register's answer stands, and can be kept (${x.via}) | ${x.steps}`);

x = await run(ukCo, "down");
ok(x.via === "companies_house" && x.trace.some((s) => s.step === "llm" && s.status === "error"), `AI down: the register's answer, marked so it isn't kept (${x.via}) | ${x.steps}`);

x = await run(ukCo, say({}), { state: { paused: "today's limit reached" } });
ok(x.via === "companies_house" && x.chat === 0 && x.trace.some((s) => s.step === "llm" && s.status === "error"), `AI paused: the register's answer, not kept (${x.via}, ${x.chat} AI calls)`);

// Wikidata + GLEIF ending at a company in Luxembourg (Spotify's register entry, for example): the AI step decides.
const wdLu = { ...wikidata, searchBusiness: async () => [{ id: "Q1", label: "Zzq" }], entity: async () => ({ id: "Q1", label: "Zzq", instanceOf: [], parents: [], lei: "ZZQ0000000000000000Z", ignoredOwners: 0 }), countryOf: async () => "LU" };
const gleifLu = { ultimateParent: async () => ({ kind: "top", reason: "no parent filed" }), record: async () => ({ lei: "ZZQ0000000000000000Z", name: "Zzq S.A.", legalCountry: "LU", hqCountry: "LU" }) };
for (const [label, answer, want] of [["the AI's answer", say({ ultimate_owner: "Zzq", owner_type: "listed_company", owner_country: "SE", confidence: "high" }), ["llm", "SE"]], ["AI not sure: the register's", say({}), ["wikidata_gleif", "LU"]]]) {
  const m = mistral(answer);
  const y = await lookupName("ZZQ", { fetch: m.fetch, wikidata: wdLu, gleif: gleifLu, today: "2026-10-16", companiesHouseKey: "x", ch: ch(ukCo), llm: { apiKey: "x", options: { web: "off" } } });
  ok(y.via === want[0] && y.entry?.owner_country === want[1], `Wikidata + GLEIF top company in Luxembourg, ${label} (${y.via} ${y.entry?.owner_country}) | ${y.trace.map((s) => `${s.step}:${s.status}`).join(" ")}`);
}
const m2 = mistral(say({}));
const y2 = await lookupName("ZZQ", { fetch: m2.fetch, wikidata: { ...wdLu, countryOf: async () => "SE" }, gleif: { ...gleifLu, record: async () => ({ lei: "ZZQ0000000000000000Z", name: "Zzq AB", legalCountry: "SE", hqCountry: "SE" }) }, today: "2026-10-16", llm: { apiKey: "x", options: { web: "off" } } });
ok(y2.via === "wikidata_gleif" && y2.entry.owner_country === "SE" && m2.calls.chat === 0, `Wikidata + GLEIF top company elsewhere: taken, no AI (${y2.via} ${y2.entry?.owner_country})`);
