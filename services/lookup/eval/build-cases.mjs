/**
 * Builds the AI look-up test set (eval/cases.json): UK shops whose owner country we already know,
 * plus names that aren't businesses. Run from the repo root:  node services/lookup/eval/build-cases.mjs
 *  - 60 hand-checked chains from packages/ownership/data/merchants.json (tier EXACT_ID: Wikidata + GLEIF agree)
 *  - 90 UK-trading brands from the open list that have a parent company, skipping any that the UK
 *    re-check corrected or dropped (so the expected owner is the one the review kept)
 *  - 20 people and generic words, where the right answer is "not a business I can name"
 * Deterministic: a fixed seed picks the same names every time.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const data = join(here, "..", "..", "..", "packages", "ownership", "data");
let seed = 20261011;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr, n) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
};

const merchants = JSON.parse(readFileSync(join(data, "merchants.json"), "utf8"));
const famous = pick(merchants.filter((m) => m.tier === "EXACT_ID" && /^[A-Z]{2}$/.test(m.owner_country ?? "")), 60)
  .map((m) => ({ name: m.aliases?.[0] ?? m.display_name.toUpperCase(), expected: m.owner_country, set: "known-chains", owner: m.chain.at(-1)?.name }));

const open = JSON.parse(readFileSync(join(data, "open-brands.json"), "utf8")).brands;
const corr = JSON.parse(readFileSync(join(data, "open-brand-corrections.json"), "utf8")).corrections;
const touched = new Set((Array.isArray(corr) ? corr : Object.values(corr)).map((c) => c.id ?? c.brand_id ?? c.qid).filter(Boolean));
const usedNames = new Set(famous.map((f) => f.name));
const owned = open.filter((b) => (b.loc ?? []).includes("gb") && b.chain.length >= 2 && !touched.has(b.id) && !touched.has(b.qid) && !usedNames.has(b.aliases?.[0]));
const tail = pick(owned, 90).map((b) => ({ name: b.aliases?.[0] ?? b.name.toUpperCase(), expected: b.oc, set: "owned-brands", owner: b.chain.at(-1)?.[0] }));

const negatives = [
  "JANE SMITH", "MR A PATEL", "J OKONKWO", "SARAH JONES RENT", "D WILLIAMS", "MUM", "K HUSSAIN", "TOM BROWN",
  "CORNER SHOP", "CAFE", "CAR PARK", "NEWSAGENT", "TAXI", "MARKET STALL", "LAUNDRETTE", "BARBERS",
  "CASH WITHDRAWAL", "TRANSFER TO SAVINGS", "INTEREST", "STANDING ORDER",
].map((name) => ({ name, expected: null, set: "not-a-business" }));

const cases = [...famous, ...tail, ...negatives];
writeFileSync(join(here, "cases.json"), JSON.stringify({ built: "2026-10-11", note: "Expected = owner country in our list (Wikidata/GLEIF); null = should not name an owner.", cases }, null, 1) + "\n");
console.log(`${cases.length} cases: ${famous.length} known chains, ${tail.length} owned brands, ${negatives.length} not businesses`);
const byC = {}; for (const c of [...famous, ...tail]) byC[c.expected] = (byC[c.expected] ?? 0) + 1;
console.log("expected countries:", Object.entries(byC).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));
