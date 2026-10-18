import type { Hop, OwnershipEntry } from "./types";
import { normalise } from "./resolve";

/**
 * The generated part of the built-in list: brands from OpenStreetMap's name-suggestion-index, each linked
 * to Wikidata, with the owner and country found by walking Wikidata's ownership statements.
 * Built by scripts/build_open_brands.py. Stored slim (≈1/4 the size of full entries) and expanded on load.
 */
export interface OpenBrandRecord {
  id: string;
  name: string;
  qid: string;
  aliases: string[];
  strict?: string[];
  cat: string;
  /** ISO2 country the top owner is run from */
  oc: string;
  /** [label, qid, ISO2] from the brand up to its top owner */
  chain: [string, string, string][];
  dom?: string[];
  /** NSI location codes where the brand trades ("gb", "001" = worldwide) */
  loc: string[];
}

export interface OpenBrandsFile {
  version: number;
  generated: string;
  sources: string[];
  brands: OpenBrandRecord[];
}

const wd = (q: string) => `https://www.wikidata.org/wiki/${q}`;

/** NSI location codes meaning "UK/Ireland or wider": brands with any of these may match anywhere. */
const BROAD = new Set(["gb", "ie", "001", "150", "154", "155", "039", "151", "eu"]);

/** null = trades in the UK/Ireland or broadly; otherwise the ISO2 countries it trades in. */
export function tradesIn(loc: string[]): string[] | null {
  if (loc.some((l) => BROAD.has(l) || l.startsWith("gb-"))) return null;
  const out = new Set<string>();
  for (const l of loc) {
    const c = l === "fx" ? "fr" : l.split("-")[0]!;
    if (/^[a-z]{2}$/.test(c)) out.add(c.toUpperCase());
  }
  return out.size ? [...out] : null;
}

export const OPEN_BRANDS_TECHNIQUE =
  "Name and web address from OpenStreetMap's brand list (name-suggestion-index), linked to Wikidata; owner from Wikidata's " +
  "'parent organisation' / 'owned by' statements (current, controlling stakes only). Not checked by a person or a company register.";

/**
 * A company the list knows only by its Wikidata id (it had no English name when the list was built): the brand's own
 * name for the brand, otherwise words, not a bare id like "Q2836957" (18 Oct 2026).
 */
function hopName(name: string, q: string, r: OpenBrandRecord): string {
  if (!/^Q\d+$/.test(name)) return name;
  return q === r.qid ? r.name : `a company Wikidata lists without an English name (${q})`;
}

export function expandOpenBrand(r: OpenBrandRecord, asOf: string): OwnershipEntry {
  const n = r.chain.length;
  const chain: Hop[] = r.chain.map(([name, q, country], i) => ({
    name: hopName(name, q, r),
    relation: n === 1 ? "ultimate_parent" : i === 0 ? "brand_of" : i === n - 1 ? "ultimate_parent" : "owned_by",
    country,
    source: "wikidata",
    source_id: q,
    source_url: wd(q),
  }));
  return {
    id: r.id,
    display_name: r.name,
    kind: "merchant",
    aliases: r.aliases,
    ...(r.strict?.length ? { strict_aliases: r.strict } : {}),
    chain,
    owner_country: r.oc,
    tier: "NAME_MATCH",
    technique: OPEN_BRANDS_TECHNIQUE,
    sources: [
      ...r.chain.map(([name, q]) => ({ label: /^Q\d+$/.test(name) ? `Wikidata ${q}` : `Wikidata ${q} (${name})`, url: wd(q) })),
      { label: "OpenStreetMap name-suggestion-index", url: "https://nsi.guide/" },
    ],
    as_of: asOf,
    reviewed_by: null,
    reviewed_at: null,
    category: r.cat,
    qid: r.qid,
    ...(r.dom?.length ? { domains: r.dom } : {}),
    ...(() => {
      const t = tradesIn(r.loc);
      return t ? { trades_in: t } : {};
    })(),
  };
}

export interface OpenBrandCorrection {
  qid: string;
  name: string;
  action: "fix" | "drop";
  owner?: string;
  owner_country?: string;
  reason: string;
}
export interface OpenBrandCorrectionsFile {
  version: number;
  reviewed: string;
  method: string;
  corrections: OpenBrandCorrection[];
}

/** Apply a reviewed correction: the brand keeps its names, the owner and country are replaced and marked unverified. */
function applyCorrection(e: OwnershipEntry, c: OpenBrandCorrection, reviewed: string): OwnershipEntry {
  const country = c.owner_country!;
  const brandHop: Hop = { ...e.chain[0]!, relation: "brand_of", country: e.chain[0]!.country || country };
  return {
    ...e,
    chain: [brandHop, { name: c.owner!, relation: "ultimate_parent", country, source: "llm" }],
    owner_country: country,
    tier: "LLM_GUESS",
    technique: `Wikidata's owner looked out of date and was replaced after an AI review (${reviewed}): ${c.reason}`,
    notes: `Wikidata said: ${e.chain.map((h) => `${h.name} (${h.country})`).join(" → ")}`,
    as_of: reviewed,
  };
}

/**
 * Expand the generated brands, leaving out any brand the hand-checked list already covers (same Wikidata ID
 * anywhere in its chain, or any shared alias) — the hand-checked answer always wins.
 */
export function openBrandEntries(file: OpenBrandsFile, handChecked: OwnershipEntry[], corrections?: OpenBrandCorrectionsFile): OwnershipEntry[] {
  const fix = new Map((corrections?.corrections ?? []).map((c) => [c.qid, c]));
  const qids = new Set<string>();
  const aliases = new Set<string>();
  for (const e of handChecked) {
    for (const h of e.chain) if (h.source === "wikidata" && h.source_id) qids.add(h.source_id);
    if (e.qid) qids.add(e.qid);
    for (const a of e.aliases) aliases.add(normalise(a));
  }
  const out: OwnershipEntry[] = [];
  for (const r of file.brands) {
    if (qids.has(r.qid)) continue;
    if (r.aliases.some((a) => aliases.has(normalise(a)))) continue;
    const c = fix.get(r.qid);
    if (c?.action === "drop") continue;
    const e = expandOpenBrand(r, file.generated);
    out.push(c?.action === "fix" && c.owner && c.owner_country ? applyCorrection(e, c, corrections!.reviewed) : e);
  }
  return out;
}
