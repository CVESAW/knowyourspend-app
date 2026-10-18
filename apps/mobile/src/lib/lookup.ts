import { looksLikePerson } from "@kys/statement";
import { newId } from "./id";
import { store } from "./store";
import type { Disclosure, RequestLogEntry } from "./types";

/**
 * Online ownership lookup for shops the built-in list doesn't know. Only normalised shop names are sent —
 * never amounts, dates, account details, people's names or anything that looks sensitive — and every request
 * is recorded on the device (Privacy → request log) with its exact body.
 *
 * Service: Supabase Edge Function `kys-lookup` (EU, Ireland). It checks earlier answers, then Wikidata + GLEIF,
 * Companies House and an AI estimate, and keeps only the names and answers (no record of who asked).
 */
export const LOOKUP_URL = process.env.EXPO_PUBLIC_LOOKUP_URL ?? "https://cxvwngmnkxtweuwaxfmz.supabase.co/functions/v1/kys-lookup";
// The public "anon" key: identifies the app to Supabase, grants no access to any data (tables are locked).
export const LOOKUP_KEY =
  process.env.EXPO_PUBLIC_LOOKUP_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4dnduZ21ua3h0d2V1d2F4Zm16Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5ODg2MzgsImV4cCI6MjA5MDU2NDYzOH0.707IwxJpvRl_ffzp7Jpfro7LrAJJ5h_bvv77YC5avgc";
export const LOOKUP_HOST = "our lookup service (run on Supabase)";
const MAX_PER_REQUEST = 60;

export { requestBody, type LookupPlan } from "@kys/core/lookup-plan";
import { askedBefore, keepAnswers, mayLookUp, requestBody, type LookupAnswer } from "@kys/core/lookup-plan";

export interface LookupStep { step: string; status: string; detail: string }

/**
 * Which of these names may be sent: business-like, not set by the user, not already answered (unless an answer
 * came before its full check and its day to ask again has come, since 18 Oct 2026), not recently missed.
 */
export function sendable(names: string[]): string[] {
  const p = store.get().prefs;
  const now = Date.now();
  return [...new Set(names)].filter((n) => !!n && n.length >= 2 && !looksLikePerson(n) && mayLookUp(n, p, now)).sort();
}

/** Send names to the lookup service and keep the answers on the device. Returns the names actually sent. */
export async function lookUp(names: string[], itemId?: string): Promise<{ sent: string[]; found: number; error?: string }> {
  const todo = sendable(names);
  if (!todo.length) return { sent: [], found: 0 };
  // Names asked about before, now asked again for their full check: marked, so the look-up doesn't count this phone
  // asking again as someone else (since 18 Oct 2026).
  const again = askedBefore(todo, store.get().prefs);
  const sent: string[] = [];
  const answered: [string, LookupAnswer | undefined][] = [];
  const log: RequestLogEntry[] = [];
  let error: string | undefined;
  for (let i = 0; i < todo.length; i += MAX_PER_REQUEST) {
    const batch = todo.slice(i, i + MAX_PER_REQUEST);
    const body = requestBody(batch, again);
    try {
      const res = await fetch(LOOKUP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOOKUP_KEY}`, apikey: LOOKUP_KEY },
        body,
      });
      log.push({ id: newId("r_"), at: new Date().toISOString(), endpoint: LOOKUP_URL, purpose: "Find who owns shops we don't know", payload: body, itemId });
      sent.push(...batch);
      if (!res.ok) throw new Error(`the lookup service answered ${res.status}`);
      const json = (await res.json()) as { results?: LookupAnswer[] };
      const byQuery = new Map((json.results ?? []).map((r) => [r.query, r]));
      for (const n of batch) answered.push([n, byQuery.get(n) ?? [...byQuery.values()].find((x) => x.query === n.toUpperCase())]);
    } catch (e) {
      error = (e as Error).message || "the lookup service couldn't be reached";
      break;
    }
  }
  let found = 0;
  await store.update((d) => {
    const kept = keepAnswers(d.prefs, answered, new Date(), again);
    found = kept.found;
    return {
      prefs: {
        ...d.prefs,
        lookups: kept.lookups,
        lookupMisses: kept.lookupMisses,
        lookupLocal: kept.lookupLocal,
        lookupChecks: kept.lookupChecks ?? {},
        requestLog: [...log, ...d.prefs.requestLog].slice(0, 200),
      },
    };
  });
  return { sent, found, error };
}

/** The disclosure record for a submission: what was sent, what was held back and why. */
export function disclosureFor(plan: { candidates: string[]; sensitive: string[]; recognisedLocally: number; transfersExcluded: number; rowsRead: number }, sent: string[]): Disclosure {
  const s = new Set(sent);
  return {
    mode: sent.length ? "remote" : "off",
    sent: [...sent].sort(),
    notSent: plan.candidates.filter((n) => !s.has(n)),
    sensitiveHeld: plan.sensitive,
    recognisedLocally: plan.recognisedLocally,
    transfersExcluded: plan.transfersExcluded,
    rowsRead: plan.rowsRead,
    ...(sent.length ? { destination: LOOKUP_HOST, sentAt: new Date().toISOString() } : {}),
  };
}

/** Add names sent later (from the report) to an item's disclosure record. */
export async function recordSent(itemId: string, sent: string[]): Promise<void> {
  if (!sent.length) return;
  await store.update((d) => ({
    items: d.items.map((i) => {
      if (i.id !== itemId) return i;
      const all = [...new Set([...i.disclosure.sent, ...sent])].sort();
      return { ...i, disclosure: { ...i.disclosure, mode: "remote", sent: all, notSent: i.disclosure.notSent.filter((n) => !all.includes(n)), destination: LOOKUP_HOST, sentAt: new Date().toISOString() } };
    }),
  }));
}
