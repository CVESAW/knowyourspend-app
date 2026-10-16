import type { LocalTransaction } from "@kys/statement";
import type { MatchMethod, OwnershipEntry } from "@kys/ownership";
import { locate, type LocationEvidence } from "./locate";
import { entryById, ownershipVersion, registerEntries, resolver } from "./ownership";

/**
 * Decides which country each payment counts towards, strongest answer first:
 *   1. "you"        — the user said which country this payee is (their fix wins over everything)
 *   2. "owner"      — the owner is known: built-in list, else an online lookup answer saved on the device
 *   3. "estimated"  — no owner known: the country the payment was made in (see locate.ts)
 * Everything here runs on the device.
 */

export type Basis = "owner" | "you" | "estimated";

export interface AttributionContext {
  /** ISO2 of the user's home country; card payments with no foreign clue are taken as made here. */
  home: string;
  /** Count shops we can't name an owner for under the country they were paid in. */
  estimate: boolean;
  /** normalised payee → ISO2 the user picked ("Which country is this?") */
  overrides: Record<string, string>;
  /** normalised payee → entry found by the online lookup */
  lookups: Record<string, OwnershipEntry>;
}

export const DEFAULT_CONTEXT: AttributionContext = { home: "GB", estimate: true, overrides: {}, lookups: {} };

export interface Attribution {
  entry?: OwnershipEntry;
  country?: string;
  basis?: Basis;
  /** how the name was matched, when the owner came from the built-in list */
  method?: MatchMethod | "lookup";
  evidence?: LocationEvidence;
  clue?: string;
}

/** Payment facilitators put their own name in front of the real shop ("PAYPAL *TCGPLAYER", "SQ *THE OLD BAKEHOUSE"). */
export const FACILITATOR = /^(SQ|SUMUP|ZETTLE_?|IZETTLE|IZ|PAYPAL|PP|GOOGLE|CRV|SP|TST)\s*\*/i;

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
  }
  return r;
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
  if (user) return { entry, country: user, basis: "you" };
  if (entry) return { entry, country: entry.owner_country, basis: "owner", method: local.entry ? local.method : "lookup" };
  if (!ctx.estimate) return {};
  return { country: loc.country, basis: "estimated", evidence: loc.evidence, clue: loc.clue };
}

/** For tests: forget cached matches (the built-in list is fixed at run time, so this is never needed in the app). */
export function _resetAttributionCache(): void {
  cache.clear();
  registered = new WeakSet();
}
