import type { LocalTransaction } from "@kys/statement";
import type { MatchMethod, OwnershipEntry } from "@kys/ownership";
import { locate, type LocationEvidence } from "./locate";
import { entryById, ownershipVersion, registerEntries, resolver } from "./ownership";

/**
 * Decides which country each payment counts towards, strongest answer first:
 *   1. "you"         — the user said which country this payee is (their fix wins over everything)
 *   2. "owner"       — the owner is known: built-in list, else an online lookup answer saved on the device
 *   3. "independent" — a small local business, not a company we can name: paid through a card reader small
 *                      businesses use (Square, SumUp, Zettle), named like one ("… CAFE"), or our look-up said so.
 *                      Counted in the country it was paid in, like an estimate, but we say why.
 *   4. "estimated"   — no owner known: the country the payment was made in (see locate.ts)
 * Everything here runs on the device. explain.ts turns an Attribution into the words the app shows.
 */

export type Basis = "owner" | "you" | "independent" | "estimated";

/** Why a payment counts as a local independent business. */
export type IndependentReason =
  | { kind: "card_reader"; prefix: string; provider: string }
  | { kind: "keyword"; word: string }
  | { kind: "lookup"; at?: string };

export interface AttributionContext {
  /** ISO2 of the user's home country; card payments with no foreign clue are taken as made here. */
  home: string;
  /** Count shops we can't name an owner for under the country they were paid in. */
  estimate: boolean;
  /** normalised payee → ISO2 the user picked ("Which country is this?") */
  overrides: Record<string, string>;
  /** normalised payee → entry found by the online lookup */
  lookups: Record<string, OwnershipEntry>;
  /** normalised payee → when our look-up said it's a small local business rather than a company it could name */
  locals?: Record<string, string>;
}

export const DEFAULT_CONTEXT: AttributionContext = { home: "GB", estimate: true, overrides: {}, lookups: {} };

export interface Attribution {
  entry?: OwnershipEntry;
  country?: string;
  basis?: Basis;
  /** how the name was matched, when the owner came from the built-in list */
  method?: MatchMethod | "lookup";
  /** the name in the bank text that matched the built-in list ("TESCO STORES", "tesco.com") */
  alias?: string;
  evidence?: LocationEvidence;
  clue?: string;
  /** set when basis is "independent" */
  independent?: IndependentReason;
}

/**
 * Payment facilitators put their own name in front of the real shop ("PAYPAL *TCGPLAYER", "SQ *THE OLD BAKEHOUSE"). The
 * bank may print words first ("CARD PAYMENT TO PAYPAL *…", "VIS KLARNA*…"; 18 Oct 2026: those counted as the facilitator).
 */
export const FACILITATOR = /(?:^|[^A-Z0-9])(SQ|SUMUP|ZETTLE_?|IZETTLE|IZ|PAYPAL|PP|GOOGLE|CRV|SP|TST|KLARNA|CLEARPAY|BT)\s*\*/i;

/**
 * Card readers small businesses use, by the prefix they put in the bank text ("SQ *THE BEAN HOUSE"). A payment
 * through one, to a name we don't know, is almost always a local independent business: a market stall, café,
 * salon or tradesperson. The bank may print words first ("CARD PAYMENT TO SQ *…").
 */
const CARD_READER_RE = /(?:^|[^A-Z0-9])(SQ|SUM ?UP|I?ZETTLE|IZ)\s*_?\s*\*/;
const CARD_READERS: Readonly<Record<string, string>> = { SQ: "Square", SUMUP: "SumUp", "SUM UP": "SumUp", ZETTLE: "Zettle by PayPal", IZETTLE: "Zettle by PayPal", IZ: "Zettle by PayPal" };
export function cardReader(raw: string | undefined): { prefix: string; provider: string } | undefined {
  const m = raw?.toUpperCase().match(CARD_READER_RE);
  if (!m) return undefined;
  const prefix = m[1]!;
  return { prefix, provider: CARD_READERS[prefix] ?? prefix };
}

type Txn = Pick<LocalTransaction, "normPayee" | "rawPayee" | "rawDescription" | "kind" | "currency">;

/** Built-in list only: the normalised payee first, then the raw bank text (keeps web addresses and run-together names). */
export function matchLocal(t: Txn, where?: string) {
  const w = where ? { country: where } : undefined;
  let r = resolver.resolve(t.normPayee, w);
  if (r.status !== "RESOLVED") {
    const rawText = t.rawDescription ?? t.rawPayee;
    if (!FACILITATOR.test(t.rawPayee.trim()) && !FACILITATOR.test(rawText.trim())) {
      const raw = resolver.resolve(rawText, w);
      if (raw.status === "RESOLVED") r = raw;
    }
    // The clean-up drops "SQ *" from the name, so look for the card reader in what the bank wrote.
    if (r.status === "UNRESOLVED") {
      const reader = cardReader(t.rawPayee) ?? cardReader(rawText);
      if (reader) r = { ...r, status: "LIKELY_INDEPENDENT", via: "local_list", reason: `acquirer:${reader.prefix}` };
    }
  }
  return r;
}

/** Why a payee counts as a local independent business, if it does. */
function independentReason(r: ReturnType<typeof matchLocal>, t: Txn, lookedUpLocal: string | undefined): IndependentReason | undefined {
  if (r.status === "LIKELY_INDEPENDENT" && r.reason) {
    const [kind, value] = r.reason.split(":") as [string, string];
    if (kind === "acquirer") {
      const reader = cardReader(t.rawPayee) ?? cardReader(t.rawDescription) ?? { prefix: value, provider: CARD_READERS[value] ?? value };
      return { kind: "card_reader", ...reader };
    }
    if (kind === "keyword") return { kind: "keyword", word: value };
  }
  if (lookedUpLocal !== undefined) return { kind: "lookup", at: lookedUpLocal || undefined };
  return undefined;
}

const cache = new Map<string, ReturnType<typeof matchLocal>>();
let cacheVersion = -1;
function matchLocalCached(t: Txn, where: string) {
  if (cacheVersion !== ownershipVersion()) {
    cache.clear(); // the list grew (web loads the generated brands after first paint)
    cacheVersion = ownershipVersion();
  }
  const k = `${where}\u0000${t.normPayee}\u0000${t.rawDescription ?? t.rawPayee}`;
  let r = cache.get(k);
  if (!r) {
    r = matchLocal(t, where);
    if (cache.size > 20_000) cache.clear();
    cache.set(k, r);
  }
  return r;
}

let registered = new WeakSet<Record<string, OwnershipEntry>>();
export function attribute(t: Txn, ctx: AttributionContext): Attribution {
  const user = ctx.overrides[t.normPayee];
  // Where it was paid decides which brands can match (a brand that only trades in Finland can't be in Lewisham).
  const loc = locate([t.rawDescription, t.rawPayee], ctx.home);
  const local = matchLocalCached(t, loc.country);
  const lookedUp = local.status === "RESOLVED" ? undefined : ctx.lookups[t.normPayee];
  if (lookedUp && !registered.has(ctx.lookups)) {
    registerEntries(Object.values(ctx.lookups));
    registered.add(ctx.lookups);
  }
  const entry = local.entry ?? (lookedUp ? entryById(lookedUp.id) ?? lookedUp : undefined);
  const alias = local.entry ? local.matched_alias : undefined;
  if (user) return { entry, country: user, basis: "you", ...(entry ? { method: local.entry ? local.method : "lookup", alias } : {}) };
  if (entry) return { entry, country: entry.owner_country, basis: "owner", method: local.entry ? local.method : "lookup", alias };
  const independent = independentReason(local, t, ctx.locals?.[t.normPayee]);
  // With estimates off nothing is counted, but a local independent still says so (18 Oct 2026), so the app doesn't
  // offer to look it up: card-reader and café-type names are never sent.
  if (!ctx.estimate) return independent ? { independent } : {};
  if (independent) return { country: loc.country, basis: "independent", evidence: loc.evidence, clue: loc.clue, independent };
  return { country: loc.country, basis: "estimated", evidence: loc.evidence, clue: loc.clue };
}

/** For tests: forget cached matches (the built-in list is fixed at run time, so this is never needed in the app). */
export function _resetAttributionCache(): void {
  cache.clear();
  registered = new WeakSet();
}
