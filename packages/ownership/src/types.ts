/**
 * Ownership data model. See packages/ownership/README.md for the tier rules.
 *
 * Tiers describe HOW an answer was obtained, from strongest to weakest:
 *  - CURATED    a named human reviewed the chain against primary sources and it is within its freshness window
 *  - EXACT_ID   derived from registry identifiers (Wikidata QID / GLEIF LEI / Companies House number) that agree
 *  - NAME_MATCH found by name search in an open dataset, identifiers not cross-confirmed
 *  - LLM_GUESS  proposed by a language model or analyst knowledge; unverified
 * Only CURATED entries may appear in anything a user shares or that we publish (DESIGN-pivot §11.2 #2, §12.5).
 */
export type Tier = "CURATED" | "EXACT_ID" | "NAME_MATCH" | "LLM_GUESS";

export type Relation = "operator" | "brand_of" | "owned_by" | "ultimate_parent";

export type SourceKind =
  | "wikidata" | "gleif" | "companies_house" | "company_filing" | "company_website" | "press" | "llm" | "manual";

export interface Hop {
  name: string;
  relation: Relation;
  /** ISO 3166-1 alpha-2 of where this entity is run from (operational HQ). */
  country: string;
  /** Where this entity is legally incorporated, if known and different. */
  legal_country?: string;
  source: SourceKind;
  source_id?: string;
  source_url?: string;
}

export interface Source { label: string; url: string }

export interface OwnershipEntry {
  /** stable slug, e.g. "costa-coffee" */
  id: string;
  display_name: string;
  kind: "merchant" | "product_brand";
  /** Normalised (upper-case, single-spaced) phrases that identify this merchant/brand in statement or receipt text. */
  aliases: string[];
  /** Brand → … → ultimate parent. Last hop is the ultimate parent. */
  chain: Hop[];
  /** ISO2: country the ultimate owner is run from. Drives the main pie chart. */
  owner_country: string;
  /** ISO2: where the ultimate parent is incorporated (GLEIF preferred). Used only by the gated "where registered" view. */
  legal_country?: string;
  tier: Tier;
  /** Plain description of the technique that produced this entry. */
  technique: string;
  sources: Source[];
  /** ISO date the chain was last checked. */
  as_of: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  /** True when the owner is a joint venture / consortium and the country is a simplification. */
  shared_ownership?: boolean;
  notes?: string;
  // ---- additions (optional; see README) ----
  /** Coarse spend category for grouping in the UI, e.g. "supermarket", "fuel", "grocery_household". */
  category?: string;
  /** For joint ventures / consortia (shared_ownership: true): the parents and their stakes, so the UI can split the pie slice. */
  co_owners?: CoOwner[];
  /** Set on payment intermediaries (PayPal, Klarna, Clearpay): the resolver prefers any other match in the same string. */
  intermediary?: "psp" | "marketplace";
  /** Web domains the business takes payments on ("tesco.com"); matched against domains in the raw bank text. */
  domains?: string[];
  /** Single-word aliases that are also everyday words: these only match at the start of the payee ("NEXT RETAIL", not "THE NEXT CHAPTER"). */
  strict_aliases?: string[];
  /** Wikidata ID of the brand itself, when known. */
  qid?: string;
  /**
   * ISO2 countries the brand trades in, set only for brands that don't trade in the UK/Ireland: such a brand only
   * matches a payment made in one of these countries (a Finnish "ABC" must not match "ABC NEWSAGENTS" in London).
   */
  trades_in?: string[];
}

/** A parent of a joint venture / consortium. Natural persons may appear here (never as chain hops). */
export interface CoOwner {
  name: string;
  /** ISO2 operating country. */
  country: string;
  legal_country?: string;
  /** Percentage 0-100, when published. */
  share?: number;
}

export type ResolutionStatus = "RESOLVED" | "LIKELY_INDEPENDENT" | "UNRESOLVED";

export interface Resolution {
  status: ResolutionStatus;
  entry?: OwnershipEntry;
  /** Which resolver tier produced it (local list today; remote lookup later). */
  via: "local_list" | "remote" | "none";
  matched_alias?: string;
  /** resolveProduct() only: the line matched a retailer (merchant) alias but no product brand, i.e. probably a retailer own-brand line. */
  own_brand_retailer?: OwnershipEntry;
  /** Why the heuristic fired (LIKELY_INDEPENDENT), e.g. "keyword:CAFE" or "acquirer:SUMUP". */
  reason?: string;
  /**
   * How the name was matched: "exact" (an alias appears word-for-word), "domain" (a web address in the
   * bank text), "joined" (the bank ran the words together: JDSPORTS), "near" (one letter off, long names only).
   */
  method?: MatchMethod;
  /** The text after clean-up (store numbers, references and bank shorthand handled) that was matched. */
  cleaned?: string;
}

export type MatchMethod = "exact" | "domain" | "joined" | "near";
