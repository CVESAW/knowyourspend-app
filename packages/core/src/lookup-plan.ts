import type { OwnershipEntry } from "@kys/ownership";

/** What an online ownership lookup would need for one submission. */
export interface LookupPlan {
  rowsRead: number;
  recognisedLocally: number;
  transfersExcluded: number;
  /** unrecognised, non-sensitive names that an online lookup would need */
  candidates: string[];
  /** unrecognised names held back because they look sensitive (unticked by default) */
  sensitive: string[];
}

/**
 * The exact request body we would send. Shown to the user before anything is sent. `again`: names among them the app
 * asked about before, whose answer came before its full check (since 18 Oct 2026), so the look-up doesn't count the
 * same phone asking again as someone else.
 */
export function requestBody(names: string[], again: string[] = []): string {
  const re = again.filter((n) => names.includes(n));
  return JSON.stringify({ merchants: [...names].sort(), ...(re.length ? { again: [...re].sort() } : {}) }, null, 2);
}

// --- What the device keeps about look-ups (since 18 Oct 2026, shared here so it can be tested) -----------------

/** More about a look-up answer. */
export interface LookupCheck {
  /** ISO date: the answer came before its full check (no web search yet), so ask again on or after this day */
  recheck?: string;
  /** a web search checked this "small local business" answer */
  web?: boolean;
  /** the look-up failed part-way, so asking again is a fresh try rather than the same question again */
  retry?: boolean;
}

/** One name's answer from the look-up service. */
export interface LookupAnswer {
  query: string;
  /** LOCAL_BUSINESS: a small local business, not a chain or company it could name (since 17 Oct 2026) */
  status: "RESOLVED" | "UNRESOLVED" | "NOT_A_BUSINESS" | "LOCAL_BUSINESS";
  entry?: OwnershipEntry;
  via?: string;
  trace: { step: string; status: string; detail: string }[];
  /** the answer came before its full check: ask again on or after this day (ISO date) */
  recheck_after?: string;
  /** "web": a web search checked this "small local business" answer */
  checked?: string;
}

/** The look-up answers kept on the device, in the user's preferences. */
export interface LookupMemory {
  /** the user's own choices: never sent */
  overrides: Record<string, string>;
  lookups: Record<string, OwnershipEntry>;
  /** asked about with no answer (when), so not asked again for 30 days */
  lookupMisses: Record<string, string>;
  /** said to be a small local business (the day) */
  lookupLocal: Record<string, string>;
  lookupChecks?: Record<string, LookupCheck>;
}

export const LOOKUP_MISS_DAYS = 30;

/**
 * Whether a name may be asked about again: not one the user set themselves, not answered already (unless that
 * answer came before its full check and its day to ask again has come), and not asked about with no answer in the
 * last 30 days.
 */
export function mayLookUp(name: string, m: LookupMemory, now: number): boolean {
  if (m.overrides[name]) return false;
  const recheck = m.lookupChecks?.[name]?.recheck;
  if (recheck && now >= Date.parse(recheck)) return true;
  if (m.lookups[name] || m.lookupLocal[name]) return false;
  const missed = m.lookupMisses[name];
  return !(missed && now - Date.parse(missed) < LOOKUP_MISS_DAYS * 86_400_000);
}

/** Of the names about to be sent, those the app asked about before and is now asking again for the full check. */
export function askedBefore(names: string[], m: LookupMemory): string[] {
  return names.filter((n) => {
    const c = m.lookupChecks?.[n];
    return !!c?.recheck && !c.retry;
  });
}

const RECHECK_AGAIN_DAYS = 30;

/**
 * Keep what the look-up said about each name sent. The newest answer for a name replaces whatever was kept about
 * it before; a name it couldn't answer this time (a step failed) keeps what it had. `again`: names sent as asked
 * before; if one still hasn't had its full check (nobody else has asked about it), the app waits 30 days before
 * asking again.
 */
export function keepAnswers(m: LookupMemory, answers: [string, LookupAnswer | undefined][], now = new Date(), again: string[] = []): Omit<LookupMemory, "overrides"> & { found: number } {
  const lookups = { ...m.lookups };
  const lookupMisses = { ...m.lookupMisses };
  const lookupLocal = { ...m.lookupLocal };
  const lookupChecks = { ...(m.lookupChecks ?? {}) };
  let found = 0;
  for (const [n, r] of answers) {
    if (!r) continue;
    const failed = r.trace.some((s) => s.status === "error");
    const resolved = r.status === "RESOLVED" && !!r.entry?.owner_country;
    if (!resolved && r.status !== "LOCAL_BUSINESS" && failed) continue;
    delete lookups[n];
    delete lookupMisses[n];
    delete lookupLocal[n];
    delete lookupChecks[n];
    if (resolved) {
      lookups[n] = { ...r.entry!, aliases: r.entry!.aliases?.length ? r.entry!.aliases : [n] };
      found++;
    } else if (r.status === "LOCAL_BUSINESS") lookupLocal[n] = now.toISOString().slice(0, 10);
    else lookupMisses[n] = now.toISOString();
    let recheck = r.recheck_after;
    if (recheck && !failed && again.includes(n)) {
      const later = new Date(now.getTime() + RECHECK_AGAIN_DAYS * 86_400_000).toISOString().slice(0, 10);
      if (later > recheck) recheck = later;
    }
    const check: LookupCheck = { ...(recheck ? { recheck } : {}), ...(r.status === "LOCAL_BUSINESS" && r.checked === "web" ? { web: true } : {}), ...(recheck && failed ? { retry: true } : {}) };
    if (Object.keys(check).length) lookupChecks[n] = check;
  }
  return { lookups, lookupMisses, lookupLocal, lookupChecks, found };
}
