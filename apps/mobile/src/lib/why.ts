import { attribute, type AttributionContext } from "@kys/core/attribute";
import { explain, type Why } from "@kys/core/explain";
import { entryById } from "./ownership";
import type { Prefs } from "./prefs";
import type { StoredTransaction } from "./types";
import type { Contribution } from "./aggregate";

/** The attribution settings from the user's preferences (all on this device). */
export function ctxFrom(p: Prefs): AttributionContext {
  return { home: p.home, estimate: p.estimate, overrides: p.overrides, lookups: p.lookups, locals: p.lookupLocal };
}

/**
 * "Why this country?" for a shop the user paid (by its normalised name), or for a brand from the list (by entry id).
 * Uses one of the user's own payments to quote what the bank wrote; that text is never sent to the look-up.
 */
export function whyFor(
  data: { txns: StoredTransaction[]; contribs: Contribution[] },
  prefs: Prefs,
  q: { payee?: string; entryId?: string; receipt?: { name: string; country: string } },
): (Why & { payee?: string }) | null {
  const ctx = ctxFrom(prefs);
  const isPayment = (t: StoredTransaction) => t.kind === "spend" || t.kind === "refund";
  let payee = q.payee;
  if (!payee && q.entryId) payee = data.contribs.find((c) => c.entryId === q.entryId && c.payee)?.payee;
  const txn = payee ? data.txns.find((t) => t.normPayee === payee && isPayment(t)) : undefined;
  if (txn) {
    const a = attribute(txn, ctx);
    const n = txn.normPayee;
    return { ...explain({ a, payee: n, bankText: txn.rawDescription ?? txn.rawPayee, home: ctx.home, lookupMissed: !!prefs.lookupMisses[n], lookupCheck: prefs.lookupChecks?.[n] }), payee: n };
  }
  const e = entryById(q.entryId);
  if (e) return explain({ a: { entry: e, country: e.owner_country, basis: "owner" }, payee: e.display_name, home: ctx.home });
  // A receipt from a shop we don't know, with no statement payment behind it: counted at home.
  if (q.receipt) return explain({ a: { country: q.receipt.country, basis: "estimated", evidence: "home" }, payee: q.receipt.name, home: ctx.home, receipt: true });
  return null;
}
