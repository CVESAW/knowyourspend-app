/**
 * Validates data/*.json against the schema and the tier rules in README.md.
 * Run: pnpm --filter @kys/ownership validate   (or: npx tsx scripts/validate.ts)
 * Exit code 1 on any error. Warnings (e.g. alias collisions) do not fail the run unless --strict.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalise, isPublishable, FRESHNESS_DAYS } from "../src/resolve";
import type { OwnershipEntry } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const load = (f: string): unknown => JSON.parse(readFileSync(join(dataDir, f), "utf8"));

const strict = process.argv.includes("--strict");
const today = new Date();

const TIERS = ["CURATED", "EXACT_ID", "NAME_MATCH", "LLM_GUESS"];
const RELATIONS = ["operator", "brand_of", "owned_by", "ultimate_parent"];
const SOURCE_KINDS = ["wikidata", "gleif", "companies_house", "company_filing", "company_website", "press", "llm", "manual"];
const KINDS = ["merchant", "product_brand"];

const errors: string[] = [];
const warnings: string[] = [];
const err = (id: string, m: string) => errors.push(`[${id}] ${m}`);
const warn = (id: string, m: string) => warnings.push(`[${id}] ${m}`);

const countries = load("countries.json") as Record<string, { name: string; flag: string }>;
const files = ["merchants.json", "product-brands.json"];
const entries: (OwnershipEntry & { __file: string })[] = [];
for (const f of files) {
  const arr = load(f);
  if (!Array.isArray(arr)) { errors.push(`${f}: not an array`); continue; }
  for (const e of arr) entries.push({ ...(e as OwnershipEntry), __file: f });
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isIsoDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isCountry = (v: unknown): boolean => typeof v === "string" && /^[A-Z]{2}$/.test(v) && v in countries;
const isUrl = (v: unknown): boolean => typeof v === "string" && /^https?:\/\/\S+$/.test(v);

const ids = new Set<string>();
const aliasOwners = new Map<string, string[]>();

for (const e of entries) {
  const id = isStr(e.id) ? e.id : `<no id in ${e.__file}>`;
  // ---- required fields ----
  if (!isStr(e.id) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id)) err(id, "id must be a kebab-case slug");
  if (ids.has(id)) err(id, "duplicate id"); ids.add(id);
  if (!isStr(e.display_name)) err(id, "display_name required");
  if (!KINDS.includes(e.kind)) err(id, `kind must be one of ${KINDS.join("|")}`);
  const expectedKind = e.__file === "merchants.json" ? "merchant" : "product_brand";
  if (e.kind !== expectedKind) err(id, `kind ${e.kind} in ${e.__file}`);
  if (!TIERS.includes(e.tier)) err(id, `tier must be one of ${TIERS.join("|")}`);
  if (!isStr(e.technique)) err(id, "technique required");
  if (!Array.isArray(e.sources)) err(id, "sources must be an array");
  else e.sources.forEach((s, i) => { if (!isStr(s?.label) || !isUrl(s?.url)) err(id, `sources[${i}] needs label + http(s) url`); });
  if (!isIsoDate(e.as_of)) err(id, `as_of must be a valid YYYY-MM-DD date (got ${String(e.as_of)})`);
  else if (Date.parse(`${e.as_of}T00:00:00Z`) > today.getTime() + 86_400_000) err(id, "as_of is in the future");
  if (!(e.reviewed_by === null || isStr(e.reviewed_by))) err(id, "reviewed_by must be null or a name");
  if (!(e.reviewed_at === null || isIsoDate(e.reviewed_at))) err(id, "reviewed_at must be null or YYYY-MM-DD");
  if ((e.reviewed_by === null) !== (e.reviewed_at === null)) err(id, "reviewed_by and reviewed_at must be set together");

  // ---- aliases ----
  if (!Array.isArray(e.aliases) || e.aliases.length === 0) err(id, "at least one alias required");
  else for (const a of e.aliases) {
    if (!isStr(a)) { err(id, "empty alias"); continue; }
    if (a !== a.toUpperCase()) err(id, `alias not upper-case: "${a}"`);
    if (/\s{2,}/.test(a) || a !== a.trim()) err(id, `alias not single-spaced/trimmed: "${a}"`);
    if (/\d{4,}/.test(a)) warn(id, `alias contains a long number (store number?): "${a}"`);
    const key = normalise(a);
    if (key.length < 2) err(id, `alias too short after normalisation: "${a}"`);
    const owners = aliasOwners.get(key) ?? [];
    if (!owners.includes(id)) owners.push(id);
    aliasOwners.set(key, owners);
  }

  // ---- chain ----
  if (!Array.isArray(e.chain) || e.chain.length === 0) { err(id, "chain required"); continue; }
  e.chain.forEach((h, i) => {
    if (!isStr(h.name)) err(id, `chain[${i}].name required`);
    if (!RELATIONS.includes(h.relation)) err(id, `chain[${i}].relation invalid: ${h.relation}`);
    if (!isCountry(h.country)) err(id, `chain[${i}].country not an ISO2 code in countries.json: ${h.country}`);
    if (h.legal_country !== undefined && !isCountry(h.legal_country)) err(id, `chain[${i}].legal_country invalid: ${h.legal_country}`);
    if (!SOURCE_KINDS.includes(h.source)) err(id, `chain[${i}].source invalid: ${h.source}`);
    if (h.source_url !== undefined && !isUrl(h.source_url)) err(id, `chain[${i}].source_url invalid`);
    if (h.source === "wikidata" && h.source_id !== undefined && !/^Q\d+$/.test(h.source_id)) err(id, `chain[${i}] bad QID ${h.source_id}`);
    if (h.source === "gleif" && h.source_id !== undefined && !/^[A-Z0-9]{20}$/.test(h.source_id)) err(id, `chain[${i}] bad LEI ${h.source_id}`);
    if (h.relation === "ultimate_parent" && i !== e.chain.length - 1) err(id, `ultimate_parent must be the last hop (found at ${i})`);
  });
  const last = e.chain[e.chain.length - 1]!;
  if (last.relation !== "ultimate_parent") err(id, "last hop must have relation ultimate_parent");
  if (!isCountry(e.owner_country)) err(id, `owner_country not in countries.json: ${e.owner_country}`);
  if (e.owner_country !== last.country) err(id, `owner_country ${e.owner_country} != last hop country ${last.country}`);
  if (e.legal_country !== undefined) {
    if (!isCountry(e.legal_country)) err(id, `legal_country invalid: ${e.legal_country}`);
    const lastLegal = last.legal_country ?? last.country;
    if (e.legal_country !== lastLegal) err(id, `legal_country ${e.legal_country} != last hop legal country ${lastLegal}`);
  }

  // ---- JV / co-owners ----
  if (e.co_owners !== undefined) {
    if (!e.shared_ownership) err(id, "co_owners set but shared_ownership is not true");
    e.co_owners.forEach((c, i) => {
      if (!isStr(c.name) || !isCountry(c.country)) err(id, `co_owners[${i}] needs name + ISO2 country`);
      if (c.legal_country !== undefined && !isCountry(c.legal_country)) err(id, `co_owners[${i}].legal_country invalid`);
      if (c.share !== undefined && (c.share <= 0 || c.share > 100)) err(id, `co_owners[${i}].share out of range`);
    });
    const total = e.co_owners.reduce((s, c) => s + (c.share ?? 0), 0);
    if (total > 100.5) err(id, `co_owners shares sum to ${total} > 100`);
  }
  if (e.intermediary !== undefined && !["psp", "marketplace"].includes(e.intermediary)) err(id, "intermediary must be psp|marketplace");

  // ---- tier rules ----
  const hasWikidataId = e.chain.some((h) => h.source === "wikidata" && isStr(h.source_id));
  const hasGleifId = e.chain.some((h) => h.source === "gleif" && isStr(h.source_id));
  switch (e.tier) {
    case "CURATED": {
      if (!isStr(e.reviewed_by) || !isStr(e.reviewed_at)) err(id, "CURATED requires reviewed_by and reviewed_at (a named human review)");
      if (!Array.isArray(e.sources) || e.sources.length === 0) err(id, "CURATED requires source URLs");
      const unsourced = e.chain.filter((h) => h.relation !== "brand_of" && !isUrl(h.source_url) && h.source !== "manual");
      if (unsourced.length) err(id, `CURATED: every owner hop needs a source_url (missing: ${unsourced.map((h) => h.name).join(", ")})`);
      if (e.chain.some((h) => h.source === "llm")) err(id, "CURATED chain may not contain source 'llm' hops; confirm them and set a real source");
      if (!isPublishable(e, today)) err(id, `CURATED but outside the ${FRESHNESS_DAYS}-day freshness window; re-review or demote`);
      break;
    }
    case "EXACT_ID":
      if (!hasWikidataId || !hasGleifId) err(id, "EXACT_ID requires both a wikidata and a gleif source_id in the chain");
      if (!e.sources.length) err(id, "EXACT_ID requires registry source URLs");
      if (e.reviewed_by !== null) warn(id, "reviewed but not CURATED; promote or clear reviewer");
      break;
    case "NAME_MATCH":
      if (!hasWikidataId && !hasGleifId && !e.sources.length) err(id, "NAME_MATCH requires at least one open-data identifier or source");
      break;
    case "LLM_GUESS":
      break;
  }
}

// ---- alias collisions across entries ----
const collisions = [...aliasOwners.entries()].filter(([, owners]) => owners.length > 1);
for (const [key, owners] of collisions) (strict ? errors : warnings).push(`alias collision "${key}": ${owners.join(", ")}`);

// ---- summary ----
const count = <K extends string>(xs: K[]) => xs.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
const byTier = count(entries.map((e) => e.tier));
const byKindTier = count(entries.map((e) => `${e.kind}/${e.tier}`));
const byCountry = Object.entries(count(entries.map((e) => e.owner_country))).sort((a, b) => b[1] - a[1]);
const needsReview = entries.filter((e) => !isPublishable(e, today));
const jv = entries.filter((e) => e.shared_ownership);
const legalDiffers = entries.filter((e) => e.legal_country && e.legal_country !== e.owner_country);

console.log(`Ownership data: ${entries.length} entries (${entries.filter((e) => e.kind === "merchant").length} merchants, ${entries.filter((e) => e.kind === "product_brand").length} product brands), ${Object.keys(countries).length} countries`);
console.log("\nBy tier:");
for (const t of TIERS) console.log(`  ${t.padEnd(11)} ${byTier[t] ?? 0}`);
console.log("By kind/tier:", JSON.stringify(byKindTier));
console.log("\nBy owner_country:");
console.log("  " + byCountry.map(([c, n]) => `${countries[c]?.flag ?? ""} ${c} ${n}`).join("   "));
console.log(`\nShared ownership / JV entries: ${jv.length} (${jv.map((e) => e.id).join(", ")})`);
console.log(`legal_country differs from owner_country: ${legalDiffers.map((e) => `${e.id} ${e.owner_country}->${e.legal_country}`).join(", ")}`);
console.log(`\nEntries needing human review before any public use (not CURATED+fresh): ${needsReview.length}/${entries.length}`);
const llm = entries.filter((e) => e.tier === "LLM_GUESS");
console.log(`  Priority, LLM_GUESS merchants (${llm.filter((e) => e.kind === "merchant").length}): ${llm.filter((e) => e.kind === "merchant").map((e) => e.id).join(", ")}`);
console.log(`  LLM_GUESS product brands: ${llm.filter((e) => e.kind === "product_brand").length}`);

// ---- Generated list (open-brands.json + corrections) ----
{
  const { openBrands } = await import("../src/index");
  const ids = new Set<string>();
  for (const e of openBrands) {
    if (ids.has(e.id)) err(e.id, "duplicate generated id");
    ids.add(e.id);
    if (!countries[e.owner_country]) err(e.id, `generated owner_country ${e.owner_country} not in countries.json`);
    if (!e.aliases.length) err(e.id, "generated entry without aliases");
  }
  const fixed = openBrands.filter((e) => e.tier === "LLM_GUESS").length;
  console.log(`\nGenerated (OpenStreetMap + Wikidata): ${openBrands.length} brands, ${fixed} with owners corrected by review`);
}

if (warnings.length) { console.log(`\nWarnings (${warnings.length}):`); warnings.forEach((w) => console.log("  - " + w)); }
if (errors.length) { console.log(`\nERRORS (${errors.length}):`); errors.forEach((x) => console.log("  - " + x)); process.exit(1); }
console.log("\nOK: no schema or tier-rule errors.");
