/**
 * On-device resolver: statement payee / receipt line -> OwnershipEntry.
 * Pure and browser-safe: no I/O, no Node APIs. The text never leaves the device.
 */
import type { MatchMethod, OwnershipEntry, Resolution, Tier } from "./types";

/** Freshness window for CURATED entries (days since as_of / reviewed_at). */
export const FRESHNESS_DAYS = 180;

/**
 * Normalise free text for matching:
 * - strip diacritics (MÜLLER -> MULLER, NESTLÉ -> NESTLE)
 * - upper-case
 * - delete apostrophes without a space (SAINSBURY'S -> SAINSBURYS)
 * - turn every other char except A-Z, 0-9 and & into a space (TESCO.COM -> TESCO COM, UBER *EATS -> UBER EATS)
 * - collapse runs of spaces
 * Aliases are normalised with the same function, so "COCA-COLA" and "COCA COLA" are the same key.
 */
export function normalise(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/['‘’`]/g, "")
    .replace(/[^A-Z0-9&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Card acquirers whose prefix means "small merchant, name follows" (SQ *JOES CAFE, SUMUP *…, ZETTLE_*…). */
export const ACQUIRER_PREFIXES = ["SQ", "SUMUP", "SUM UP", "ZETTLE", "IZ", "IZETTLE"] as const;

/**
 * Conservative independent-business keywords. Applied ONLY when nothing in the local list matched.
 * Deliberately excludes words that chains use in their own names (COFFEE, PIZZA, EXPRESS, CAFFE…).
 */
export const INDEPENDENT_KEYWORDS = [
  "CAFE", "DELI", "BAKERY", "BUTCHER", "BUTCHERS", "BARBER", "BARBERS", "FISH BAR", "KEBAB",
  "FLORIST", "NEWSAGENT", "NEWSAGENTS", "OFF LICENCE", "TAKEAWAY",
] as const;

const TIER_RANK: Record<Tier, number> = { CURATED: 4, EXACT_ID: 3, NAME_MATCH: 2, LLM_GUESS: 1 };

/** Higher = stronger evidence. CURATED 4 > EXACT_ID 3 > NAME_MATCH 2 > LLM_GUESS 1. */
export function tierRank(tier: Tier): number {
  return TIER_RANK[tier];
}

function parseIsoDate(s: string | null | undefined): number | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * Only CURATED entries with a named reviewer, and whose as_of AND reviewed_at are within FRESHNESS_DAYS of `today`, may be
 * published or appear in anything a user shares.
 */
export function isPublishable(entry: OwnershipEntry, today: Date | string = new Date()): boolean {
  if (entry.tier !== "CURATED") return false;
  if (!entry.reviewed_by || !entry.reviewed_by.trim()) return false;
  const now = typeof today === "string" ? parseIsoDate(today) : today.getTime();
  const asOf = parseIsoDate(entry.as_of);
  const reviewed = parseIsoDate(entry.reviewed_at);
  if (now === null || asOf === null || reviewed === null) return false;
  const windowMs = FRESHNESS_DAYS * 86_400_000;
  return now - asOf <= windowMs && now - reviewed <= windowMs && asOf <= now + 86_400_000;
}

export type BadgeLabel = "Checked" | "Matched" | "Unverified";

export function badgeFor(tier: Tier): { label: BadgeLabel; description: string } {
  switch (tier) {
    case "CURATED":
      return { label: "Checked", description: "A person checked this ownership chain against primary sources in the last 180 days." };
    case "EXACT_ID":
      return { label: "Matched", description: "Matched through company registry identifiers (Wikidata and GLEIF agree). Not yet checked by a person." };
    case "NAME_MATCH":
      return { label: "Matched", description: "Found in open company data, but the identifiers were not cross-checked. Not yet checked by a person." };
    case "LLM_GUESS":
      return { label: "Unverified", description: "A best guess from AI/analyst knowledge. It may be out of date and has not been checked." };
  }
}

interface IndexedAlias {
  key: string; // normalised alias
  tokens: string[];
  entry: OwnershipEntry;
  /** only matches at the start of the payee (everyday-word brand names) */
  strict: boolean;
}

interface Match {
  alias: string;
  entry: OwnershipEntry;
  method: MatchMethod;
}

export interface Resolver {
  /**
   * Resolve a bank-statement payee. Pass the normalised payee, or the raw bank text (on the device only):
   * web addresses in the raw text ("APPLE.COM/BILL", "WWW.ZALANDO.CO.UK") are matched before normalising.
   */
  resolve(payee: string, where?: ResolveWhere): Resolution;
  /** Resolve a till-receipt line to a product brand. Retailer own-brand lines return UNRESOLVED + own_brand_retailer. */
  resolveProduct(receiptLine: string): Resolution;
  /** Number of entries and alias keys indexed (for diagnostics). */
  size(): { entries: number; aliases: number };
}

/**
 * Bank shorthand → the word shops use. Applied token by token before matching, so "AMZN MKTP" finds AMAZON and
 * "SAINSBURY S/MKT" finds SAINSBURYS. Only unambiguous forms; the original text is also tried.
 */
export const SHORTHAND: Readonly<Record<string, string>> = {
  AMZN: "AMAZON", AMZ: "AMAZON", MKTP: "MARKETPLACE", MKTPL: "MARKETPLACE", MKTPLACE: "MARKETPLACE",
  SMKT: "SUPERMARKET", SMKTS: "SUPERMARKET", SPRMKT: "SUPERMARKET", SUPERMKT: "SUPERMARKET", SPMKT: "SUPERMARKET",
  SAINSBURY: "SAINSBURYS", SAINSBURYSS: "SAINSBURYS", MORRISON: "MORRISONS", MCDONALD: "MCDONALDS",
  MCD: "MCDONALDS", MACDONALDS: "MCDONALDS", WETHERSPOON: "WETHERSPOONS", JDWETHERSPOON: "WETHERSPOONS",
  NFLX: "NETFLIX", SPOTIFYUK: "SPOTIFY", GOOGLEPLAY: "GOOGLE PLAY", PRIMEVIDEO: "PRIME VIDEO",
  INTL: "INTERNATIONAL", SVCS: "SERVICES", SVC: "SERVICE", STN: "STATION", RSTRNT: "RESTAURANT", RESTRNT: "RESTAURANT",
};

/** Words that never identify a shop on their own and are dropped from the cleaned text when they trail. */
const NOISE_TAIL = new Set([
  "LTD", "LIMITED", "PLC", "LLP", "UK", "GB", "GBR", "LONDON", "STORE", "STORES", "SHOP", "ONLINE", "CONTACTLESS",
  "PAYMENT", "PURCHASE", "CARD", "DEBIT", "CREDIT", "REF", "REFERENCE", "TXN", "POS", "WWW", "COM", "CO", "HTTPS", "HTTP",
]);

/**
 * Remove what banks add around the shop name: store/terminal numbers ("TESCO STORES 2041"), references
 * with digits ("AB12CD34E"), and expand shorthand. Digits that are the shop's name ("7 ELEVEN", "BET365",
 * "3 STORE" when first) are kept.
 */
export function cleanPayee(text: string): string {
  const toks = normalise(text).split(" ").filter(Boolean);
  const out: string[] = [];
  toks.forEach((t, i) => {
    if (i > 0 && /^\d{3,}$/.test(t)) return; // store / terminal numbers
    if (/\d/.test(t) && /[A-Z]/.test(t) && t.replace(/[^0-9]/g, "").length >= 3 && t.length >= 6) return; // refs like AB12CD34E
    const sh = SHORTHAND[t];
    if (sh) out.push(...sh.split(" "));
    else out.push(t);
  });
  while (out.length > 1 && NOISE_TAIL.has(out[out.length - 1]!)) out.pop();
  return out.join(" ");
}

/** Optimal string alignment distance, capped: returns >max as soon as it is certain. */
function editDistance(a: string, b: string, max = 1): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n]!;
}

const DOMAIN_RE = /(?:^|[^A-Z0-9-])((?:[A-Z0-9-]+\.)+(?:CO\.UK|ORG\.UK|COM|NET|ORG|UK|IE|DE|FR|NL|ES|IT|BE|LU|EU|IO|APP|TV|CO|SE|DK|NO|FI|AT|CH|PL|PT|US|CA|AU))(?=$|[^A-Z0-9.-]|\.(?![A-Z]))/g;

/** Web domains in raw bank text, reduced to the registrable part ("help.uber.com" → "uber.com"). */
export function domainsIn(raw: string): string[] {
  const up = raw.toUpperCase().replace(/\s*\.\s*(?=(?:CO\.UK|COM|NET|ORG)\b)/g, ".");
  const out = new Set<string>();
  for (const m of up.matchAll(DOMAIN_RE)) {
    let host = m[1]!.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".");
    if (parts.length >= 3 && ["co", "com", "org", "net", "ac", "gov", "ltd", "me"].includes(parts[parts.length - 2]!) && parts[parts.length - 1]!.length === 2) {
      host = parts.slice(-3).join(".");
    } else host = parts.slice(-2).join(".");
    if (/[a-z]/.test(host.split(".")[0]!)) out.add(host);
  }
  return [...out];
}

/** Longest alias wins; ties broken by match method, `preferKind`, stronger tier, then id for determinism. */
const METHOD_RANK: Record<MatchMethod, number> = { exact: 3, domain: 2, joined: 1, near: 0 };
function pickBest(matches: Match[], preferKind: OwnershipEntry["kind"]): Match | undefined {
  return [...matches].sort((a, b) => {
    const mr = METHOD_RANK[b.method] - METHOD_RANK[a.method];
    if (mr !== 0 && (a.method === "near" || b.method === "near")) return mr; // a near-miss never beats a real match
    if (b.alias.length !== a.alias.length) return b.alias.length - a.alias.length;
    if (mr !== 0) return mr;
    const ka = a.entry.kind === preferKind ? 1 : 0;
    const kb = b.entry.kind === preferKind ? 1 : 0;
    if (kb !== ka) return kb - ka;
    const tr = tierRank(b.entry.tier) - tierRank(a.entry.tier);
    if (tr !== 0) return tr;
    return a.entry.id.localeCompare(b.entry.id);
  })[0];
}

function stripAcquirer(text: string): { rest: string; acquirer?: string } {
  for (const p of ACQUIRER_PREFIXES) {
    if (text === p) return { rest: "", acquirer: p };
    if (text.startsWith(`${p} `)) return { rest: text.slice(p.length + 1), acquirer: p };
  }
  return { rest: text };
}

function independentKeyword(text: string): string | undefined {
  const padded = ` ${text} `;
  return INDEPENDENT_KEYWORDS.find((k) => padded.includes(` ${k} `));
}

class AliasIndex {
  /** first token → aliases starting with it */
  private byFirst = new Map<string, IndexedAlias[]>();
  /** multi-word aliases with the spaces removed (≥6 letters) → aliases, for "JDSPORTS" */
  private joined = new Map<string, IndexedAlias[]>();
  /** single-word aliases of 7+ letters, bucketed by first letter, for one-letter-off matching */
  private long = new Map<string, IndexedAlias[]>();
  /** every single-word alias, to recognise run-together pairs ("PAY PAL" → PAYPAL) */
  private single = new Map<string, IndexedAlias[]>();
  count = 0;

  add(a: IndexedAlias): void {
    this.count++;
    const push = (m: Map<string, IndexedAlias[]>, k: string) => {
      const arr = m.get(k);
      if (arr) arr.push(a);
      else m.set(k, [a]);
    };
    push(this.byFirst, a.tokens[0]!);
    if (a.tokens.length > 1) {
      const j = a.tokens.join("");
      if (j.length >= 6) push(this.joined, j);
    } else {
      push(this.single, a.key);
      if (a.key.length >= 7 && !a.strict && /^[A-Z]+$/.test(a.key)) push(this.long, a.key[0]!);
    }
  }

  find(text: string, fuzzy: boolean, keep: (m: Match) => boolean = () => true): Match[] {
    const toks = text.split(" ").filter(Boolean);
    const out: Match[] = [];
    const add = (m: Match) => {
      if (keep(m)) out.push(m);
    };
    for (let i = 0; i < toks.length; i++) {
      for (const a of this.byFirst.get(toks[i]!) ?? []) {
        if (a.strict && i !== 0) continue;
        if (a.tokens.length > toks.length - i) continue;
        let ok = true;
        for (let k = 1; k < a.tokens.length; k++) if (toks[i + k] !== a.tokens[k]) { ok = false; break; }
        if (ok) add({ alias: a.key, entry: a.entry, method: "exact" });
      }
    }
    if (!fuzzy || out.length) return out;
    // Run-together words: a payee token that is a multi-word alias without spaces ("JDSPORTS"), or two
    // payee tokens that together make a one-word alias ("PAY PAL").
    for (let i = 0; i < toks.length; i++) {
      for (const a of this.joined.get(toks[i]!) ?? []) add({ alias: a.key, entry: a.entry, method: "joined" });
      if (i + 1 < toks.length) {
        const pair = toks[i]! + toks[i + 1]!;
        for (const a of this.joined.get(pair) ?? []) add({ alias: a.key, entry: a.entry, method: "joined" });
        if (pair.length >= 6) for (const a of this.single.get(pair) ?? []) if (!a.strict || i === 0) add({ alias: a.key, entry: a.entry, method: "joined" });
      }
    }
    if (out.length) return out;
    // One letter off, long names only, first letter must agree: "SAINSBURRYS", "WAITROSSE".
    for (const t of toks) {
      if (t.length < 7 || !/^[A-Z]+$/.test(t)) continue;
      for (const a of this.long.get(t[0]!) ?? []) {
        if (Math.abs(a.key.length - t.length) > 1) continue;
        if (editDistance(a.key, t, 1) <= 1) add({ alias: a.key, entry: a.entry, method: "near" });
      }
    }
    return out;
  }
}

export interface ResolveWhere {
  /** ISO2 of where the payment was made (default: the home country). Brands that only trade elsewhere are ignored. */
  country?: string;
}

export interface ResolverOptions {
  /** ISO2 of the users' home country (default "GB"). */
  home?: string;
  /** run-together and one-letter-off matching for statement payees (default true). Receipt OCR uses false. */
  fuzzy?: boolean;
}

export function createResolver(entries: OwnershipEntry[], opts: ResolverOptions = {}): Resolver {
  const fuzzy = opts.fuzzy !== false;
  const home = opts.home ?? "GB";
  const merchantIndex = new AliasIndex();
  const productIndex = new AliasIndex();
  const allIndex = new AliasIndex();
  const byDomain = new Map<string, OwnershipEntry>();
  for (const entry of entries) {
    const seen = new Set<string>();
    const strict = new Set((entry.strict_aliases ?? []).map(normalise));
    for (const a of entry.aliases) {
      const key = normalise(a);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const ia: IndexedAlias = { key, tokens: key.split(" "), entry, strict: strict.has(key) };
      (entry.kind === "product_brand" ? productIndex : merchantIndex).add(ia);
      allIndex.add(ia);
    }
    if (entry.kind === "merchant") for (const d of entry.domains ?? []) if (!byDomain.has(d)) byDomain.set(d.toLowerCase(), entry);
  }

  function resolveText(text: string, raw: string, where: string): Resolution {
    const here = (m: Match) => !m.entry.trades_in || m.entry.trades_in.includes(where);
    const { rest, acquirer } = stripAcquirer(text);
    const body = rest || text;
    const cleaned = cleanPayee(body);
    let matches = allIndex.find(body, false, here);
    if (!matches.length && cleaned !== body) matches = allIndex.find(cleaned, false, here);
    if (!matches.length && fuzzy) {
      for (const d of domainsIn(raw)) {
        const e = byDomain.get(d);
        if (e) matches.push({ alias: d.toUpperCase(), entry: e, method: "domain" });
      }
    }
    if (!matches.length && fuzzy) matches = allIndex.find(cleaned, true, here);
    // Intermediaries (PayPal, Klarna…) lose to any real merchant in the same string: "PAYPAL *NETFLIX" -> Netflix.
    const direct = matches.filter((m) => !m.entry.intermediary);
    const best = pickBest(direct.length ? direct : matches, "merchant");
    if (best && !(best.entry.intermediary && rest && independentKeyword(rest))) {
      return { status: "RESOLVED", entry: best.entry, via: "local_list", matched_alias: best.alias, method: best.method, cleaned };
    }
    const kw = independentKeyword(body);
    if (kw) return { status: "LIKELY_INDEPENDENT", via: "local_list", reason: `keyword:${kw}`, cleaned };
    if (acquirer && rest) return { status: "LIKELY_INDEPENDENT", via: "local_list", reason: `acquirer:${acquirer}`, cleaned };
    return { status: "UNRESOLVED", via: "none", cleaned };
  }

  function resolve(payee: string, where?: ResolveWhere): Resolution {
    const text = normalise(payee);
    if (!text) return { status: "UNRESOLVED", via: "none" };
    return resolveText(text, payee, where?.country ?? home);
  }

  function resolveProduct(receiptLine: string): Resolution {
    const text = normalise(receiptLine);
    if (!text) return { status: "UNRESOLVED", via: "none" };
    // Receipt lines stay strict: exact aliases only (OCR noise makes fuzzy brand matches unreliable).
    const productHit = pickBest(productIndex.find(text, false).filter((m) => !m.entry.trades_in), "product_brand");
    if (productHit) {
      return { status: "RESOLVED", entry: productHit.entry, via: "local_list", matched_alias: productHit.alias, method: "exact" };
    }
    // No brand: if a retailer name is on the line ("TESCO BAKED BEANS", "BY SAINSBURYS"), it is probably own-brand,
    // which is attributed to the retailer on the receipt header, not resolved here.
    const retailer = pickBest(merchantIndex.find(text, false).filter((m) => !m.entry.id.startsWith("osm-")), "merchant");
    if (retailer) return { status: "UNRESOLVED", via: "none", own_brand_retailer: retailer.entry, matched_alias: retailer.alias };
    return { status: "UNRESOLVED", via: "none" };
  }

  return { resolve, resolveProduct, size: () => ({ entries: entries.length, aliases: allIndex.count }) };
}
