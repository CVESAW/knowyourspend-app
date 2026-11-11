import { classify, isSensitive, looksLikePerson, mayBePerson, normalisePayee, type TransactionKind } from "@kys/statement";
import type { OwnershipEntry } from "@kys/ownership";
import { attribute, type Attribution, type AttributionContext } from "./attribute";
import { explain, theCountry, type Why, type WhySection } from "./explain";
import type { LookupAnswer } from "./lookup-plan";

/**
 * The search box on knowyourspend.org (since 22 Oct 2026): one line someone typed or pasted — a shop, a company, a
 * line from a bank statement or a receipt — and who owns it, with how we got there. It uses the app's matching and
 * explanations unchanged (attribute.ts, explain.ts); only the wording differs, because that page has no app,
 * statement or Settings. Names in the built-in list are matched in the browser; only a name it doesn't know is sent to
 * the online look-up, and never one that looks like a person or something sensitive unless the person searching asks.
 */

export const MAX_QUERY = 140;

export type QuickStatus = "owner" | "local" | "person" | "not_shop" | "sensitive" | "unknown" | "not_business" | "empty";

export interface QuickQuery {
  /** what was typed, spaces tidied and cut to MAX_QUERY characters */
  text: string;
  /** the cleaned name: exactly what a look-up would send */
  name: string;
  /** ISO2 of the bank's (or the shop's) country, used for matching and sent with a look-up */
  home: string;
}

export interface QuickResult {
  query: QuickQuery;
  status: QuickStatus;
  why?: Why;
  /** send the name to the online look-up now: it isn't in the built-in list and nothing holds it back */
  canAsk: boolean;
  /** held back (looks like a person, or sensitive): the person searching can still choose to look it up */
  askAnyway?: boolean;
  /** what the online look-up checked, in its own words */
  steps?: LookupAnswer["trace"];
  /** the look-up couldn't finish (a step failed or it's paused): trying again later may work */
  retry?: boolean;
}

export function readQuery(text: string, home = "GB"): QuickQuery {
  const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY).trim();
  const h = (home ?? "").toUpperCase();
  return { text: t, name: t ? normalisePayee(t) : "", home: /^[A-Z]{2}$/.test(h) ? h : "GB" };
}

const txn = (q: QuickQuery) => ({ normPayee: q.name, rawPayee: q.text, rawDescription: q.text, kind: "spend" as const, currency: "" });
const ctx = (q: QuickQuery, lookups: Record<string, OwnershipEntry> = {}, locals: Record<string, string> = {}): AttributionContext => ({
  home: q.home,
  estimate: true,
  overrides: {},
  lookups,
  locals,
});

/** The built-in list only. Nothing leaves the browser. */
export function lookUpLocally(q: QuickQuery): QuickResult {
  if (!q.name) return { query: q, status: "empty", canAsk: false };
  const a = attribute(txn(q), ctx(q));
  const person = (): QuickResult => ({ query: q, status: "person", why: heldWhy(q, "person"), canAsk: false, askAnyway: q.name.length >= 2 });
  // "BP" first on a pasted line is usually the bank's code for a bill payment, not the fuel company (11 Nov 2026: "BP
  // PIPPA" was named as BP). When BP on its own was all that matched and the rest may be a person's name, hold it back;
  // "BP CONNECT …", "VIS BP …" and "BP 1234 LEEDS" stay BP.
  if (a.basis === "owner" && a.entry && a.alias === "BP" && BILL_CODE_FIRST.test(q.text) && mayBePerson({ amount: -1, rawPayee: q.text, rawDescription: q.text })) return person();
  if (a.basis === "owner" && a.entry) return { query: q, status: "owner", why: ownerWhy(q, a), canAsk: false };
  if (a.basis === "independent" && a.independent) return { query: q, status: "local", why: localWhy(q, a), canAsk: false };
  // Sensitive first: "MARIE STOPES" also looks like a person's name, but what matters is what it could say about you.
  if (isSensitive(q.name)) return { query: q, status: "sensitive", why: heldWhy(q, "sensitive"), canAsk: false, askAnyway: q.name.length >= 2 };
  // The statement reader's person rule (since 22 Oct 2026, found by the Python tool's parity check): a PayPal payment
  // to a name that could be a person's ("PAYPAL *JOHNSMITH" → JOHNSMITH), and a bill payment to a one-word name.
  if (mayBePerson({ amount: -1, rawPayee: q.text, rawDescription: q.text })) return person();
  // A line that isn't a payment to a shop (cash, money between your own accounts or to savings, money in, a bank fee,
  // a transfer): the statement reader's own classifier, so a pasted transfer to a friend is never sent.
  const kind = classify({ amount: -1, rawPayee: q.text, rawDescription: q.text });
  const notShop = (): QuickResult => ({ query: q, status: "not_shop", why: notShopWhy(q, kind), canAsk: false, askAnyway: q.name.length >= 2 });
  if (kind === "cash" || kind === "internal" || kind === "income" || kind === "fee") return notShop();
  // Anything that reads like a person's name, including after words like "TRANSFER TO" that the reader doesn't know
  // as a transfer ("BANK TRANSFER TO DAVID JONES").
  const after = TO_SOMEONE.exec(q.name)?.[1];
  if (looksLikePerson(q.text) || looksLikePerson(q.name) || (after && looksLikePerson(after))) return person();
  if (kind === "transfer") return notShop();
  return { query: q, status: "unknown", why: unknownWhy(q, "not_asked"), canAsk: q.name.length >= 2 };
}

/** The online look-up's answer for q.name, explained the same way. */
export function withAnswer(q: QuickQuery, answer: LookupAnswer, today = new Date()): QuickResult {
  const steps = answer.trace ?? [];
  const failed = steps.some((s) => s.status === "error");
  const check = { ...(answer.recheck_after ? { recheck: answer.recheck_after } : {}), ...(answer.checked === "web" ? { web: true } : {}) };
  const resolved = answer.status === "RESOLVED" && answer.entry?.owner_country ? { [q.name]: { ...answer.entry, aliases: answer.entry.aliases?.length ? answer.entry.aliases : [q.name] } } : {};
  const local = answer.status === "LOCAL_BUSINESS" ? { [q.name]: today.toISOString().slice(0, 10) } : {};
  // The built-in list still wins, as in the app (only names it doesn't know are sent, so this is a safety net).
  const a = attribute(txn(q), ctx(q, resolved, local));
  if (a.basis === "owner" && a.entry) return { query: q, status: "owner", why: ownerWhy(q, a, check), canAsk: false, steps };
  if (a.basis === "independent" && a.independent) return { query: q, status: "local", why: localWhy(q, a, check), canAsk: false, steps };
  if (answer.status === "NOT_A_BUSINESS") return { query: q, status: "not_business", why: notBusinessWhy(q), canAsk: false, steps };
  return { query: q, status: "unknown", why: unknownWhy(q, failed ? "failed" : "missed"), canAsk: false, steps, ...(failed ? { retry: true } : {}) };
}

/** The look-up couldn't be reached, or it's paused for the day: say so plainly. */
export function lookupUnavailable(q: QuickQuery, reason: "offline" | "paused" | "busy" | "error"): QuickResult {
  const line = {
    offline: "We couldn't reach our online look-up. Check your connection and try again.",
    paused: "Our online look-up has reached its limit for researching new names today. Names it already knows still work. Please try again tomorrow.",
    busy: "You've looked up a lot of new names today. Please try again tomorrow.",
    error: "Our online look-up had a problem with this name. Please try again in a little while.",
  }[reason];
  return {
    query: q,
    status: "unknown",
    canAsk: false,
    retry: true,
    why: { ...base(q), level: "none", label: "Not looked up yet", headline: "We couldn't look this up just now.", sections: [{ heading: "What happened", lines: [notInList(q), line] }] },
  };
}

/** A line that starts with the bank's bill-payment code ("BP PIPPA", as first direct and HSBC print it). */
const BILL_CODE_FIRST = /^BP\s/i;

/** "… TRANSFER TO <someone>", "… PAYMENT FROM <someone>": what follows is checked as a possible person's name. */
const TO_SOMEONE = /\b(?:TRANSFER|TFR|PAYMENT|PAYMENTS|PAYMT|PYMT|SENT|BACS|FPS|FPO|FPI|STO|ORDER)\s+(?:TO|FROM)\s+(.+)$/;

// ── Wording ──────────────────────────────────────────────────────────────────────────────────

const base = (q: QuickQuery): Pick<Why, "name" | "bankText" | "chain" | "sources" | "canLookUp"> => ({ name: q.name, bankText: q.text, chain: [], sources: [], canLookUp: false });
const notInList = (q: QuickQuery) => `“${q.name}” isn't in our built-in list of shops and brands.`;

/**
 * explain.ts speaks to someone using the app about their statement. Here the text is whatever was typed, the
 * look-up was asked by this page, and there are no Settings. Every phrase is changed in one place, and the tests
 * fail if any app wording gets through.
 */
const PAGE_WORDING: [RegExp, string][] = [
  [/the app's built-in list/g, "our built-in list"],
  [/so the app sent just the name (“[^”]*”) to our look-up service \(nothing else about you or the payment\)/g, "so this page sent just the name $1 to our online look-up (nothing else about you)"],
  [/Your bank's text contains/g, "The text contains"],
  [/Your bank's text is one letter different from/g, "The text is one letter different from"],
  [/Your bank printed (“[^”]*”) with the spaces missing, as banks often do\./g, "$1 is written with the spaces missing, as banks often do."],
  [/ in your bank's text means you paid with a/g, " means it was paid with a"],
  [/From ([^,]+), the app asks again when you add a statement with this shop; if nobody else has asked about it by then, the full check waits until someone does\./g, "That full check runs when someone asks about this name again, from $1."],
  [/You paid through ([^,]+), which puts its name before the shop's\. We looked through it to the shop you paid\./g, "$1 puts its name before the shop's. We looked through it to the shop."],
];
export function pageWording(s: string): string {
  return PAGE_WORDING.reduce((acc, [re, to]) => acc.replace(re, to), s);
}
const pageSections = (sections: WhySection[]): WhySection[] => sections.map((s) => ({ heading: s.heading, lines: s.lines.map(pageWording) }));

function ownerWhy(q: QuickQuery, a: Attribution, check?: { recheck?: string; web?: boolean }): Why {
  const w = explain({ a, payee: q.name, bankText: q.text, home: q.home, ...(check && Object.keys(check).length ? { lookupCheck: check } : {}) });
  return { ...w, headline: pageWording(w.headline), sections: pageSections(w.sections) };
}

function localWhy(q: QuickQuery, a: Attribution, check?: { recheck?: string; web?: boolean }): Why {
  const w = explain({ a, payee: q.name, bankText: q.text, home: q.home, ...(check && Object.keys(check).length ? { lookupCheck: check } : {}) });
  const how = w.sections[0]?.lines ?? [];
  const where = a.country ? theCountry(a.country) : "";
  return {
    ...w,
    label: "Local independent",
    headline: "This looks like a local independent business.",
    sections: [
      { heading: "How we recognised it", lines: how.map(pageWording) },
      {
        heading: "What that means",
        lines: [
          "We can't name an owner for it, so there's no ownership chain to show.",
          `Local independents are almost always owned in the country where you pay them${where ? `, here ${where}` : ""}.`,
        ],
      },
    ],
  };
}

function heldWhy(q: QuickQuery, why: "person" | "sensitive"): Why {
  const lines =
    why === "person"
      ? [notInList(q), "It looks like a person's name, so we haven't sent it to our online look-up. We only look up businesses.", "If it's a business, you can still look it up. Names that turn out to be a person's aren't kept."]
      : [notInList(q), "It could say something sensitive about you (health, money or similar), so we haven't sent it to our online look-up.", "You can still look it up if you're happy to. We keep a name and its answer, never who asked."];
  return { ...base(q), level: "none", label: "Not looked up", headline: why === "person" ? "This looks like a person's name." : "We've held this name back.", sections: [{ heading: "Why we stopped", lines }] };
}

function notShopWhy(q: QuickQuery, kind: TransactionKind): Why {
  const what: Partial<Record<TransactionKind, string>> = {
    transfer: "It reads like a transfer or a bill payment, which can be to a person, so we haven't sent it to our online look-up.",
    cash: "It reads like a cash withdrawal, so there's no shop to look up.",
    internal: "It reads like money moving between your own accounts, or to savings or investments, so there's no shop to look up.",
    income: "It reads like money coming in, so there's no shop to look up.",
    fee: "It reads like a fee or interest from your bank, so there's no shop to look up.",
  };
  return {
    ...base(q),
    level: "none",
    label: "Not looked up",
    headline: "This doesn't look like a payment to a shop.",
    sections: [{ heading: "Why we stopped", lines: [what[kind] ?? "It doesn't read like a payment to a shop.", "If it is a business, you can still look it up."] }],
  };
}

function unknownWhy(q: QuickQuery, state: "not_asked" | "missed" | "failed"): Why {
  const lines =
    state === "not_asked"
      ? [notInList(q), "Our online look-up can try: it checks company registers, then asks an AI to research it."]
      : state === "missed"
        ? [notInList(q), "Our online look-up checked company registers and asked an AI to research it, but couldn't find who owns it."]
        : [notInList(q), "Our online look-up didn't finish checking it. Please try again in a little while."];
  return { ...base(q), level: "none", label: state === "missed" ? "Owner not found" : "Not looked up yet", headline: state === "missed" ? "We couldn't find who owns this." : "We don't know who owns this yet.", sections: [{ heading: "What we checked", lines }] };
}

function notBusinessWhy(q: QuickQuery): Why {
  return {
    ...base(q),
    level: "none",
    label: "Not a business",
    headline: "This doesn't look like a business.",
    sections: [{ heading: "What we checked", lines: [notInList(q), "Our online look-up thinks it's a person's name or something other than a business, so it didn't look for an owner. Names like this aren't kept."] }],
  };
}
