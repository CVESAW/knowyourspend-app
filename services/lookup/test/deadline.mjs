// The AI step's deadline: no Mistral call starts after it, and a slow one is cut short at it.
// Run: node services/lookup/test/deadline.mjs
import { aiEstimate } from "../ai.ts";
import { Wikidata, Gleif } from "../registries.ts";
const ok = (c, m) => { if (!c) process.exitCode = 1; console.log(c ? "ok  " : "FAIL", m); };
const wd = new Wikidata(fetch, { retries: 1 }), gleif = new Gleif(fetch);
let calls = 0;
const slow = async (url, init) => {
  if (!String(url).includes("api.mistral.ai")) return fetch(url, init);
  calls++;
  return new Promise((res, rej) => { const t = setTimeout(() => res(new Response("{}", { status: 200 })), 60000); init.signal?.addEventListener("abort", () => { clearTimeout(t); const e = new Error("aborted"); e.name = "AbortError"; rej(e); }); });
};
let t0 = Date.now(), err;
try { await aiEstimate("SOME SHOP", { fetch: slow, apiKey: "x", wikidata: wd, gleif, today: "2026-10-14", deadline: Date.now() + 5000 }, {}); } catch (e) { err = e; }
const took = Date.now() - t0;
ok(err && took < 9000, `slow Mistral, 5 s deadline: gave up after ${(took / 1000).toFixed(1)} s with "${err?.message}" (${calls} call(s))`);
calls = 0; err = null;
try { await aiEstimate("SOME SHOP", { fetch: slow, apiKey: "x", wikidata: wd, gleif, today: "2026-10-14", deadline: Date.now() + 1000 }, {}); } catch (e) { err = e; }
ok(err && calls === 0, `deadline already near: no call made ("${err?.message}")`);
