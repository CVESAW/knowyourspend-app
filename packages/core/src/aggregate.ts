import type { Item, ReceiptLine, StoredTransaction } from "./types";
import { entryById } from "./ownership";
import { attribute, type Attribution, type AttributionContext, type Basis, type IndependentReason } from "./attribute";
import type { LocationEvidence } from "./locate";

/**
 * Turns local transactions and receipt lines into the numbers the app shows.
 * Runs entirely on the device. Amounts are GBP only for now; other currencies are
 * counted separately and reported, never converted with invented FX rates.
 */

export type Period = "1m" | "3m" | "12m" | "all";

export interface Contribution {
  /** ownership entry id, or undefined when not matched */
  entryId?: string;
  /** label shown for unmatched spending */
  label: string;
  country?: string; // owner_country of the entry
  amount: number; // positive = spend
  date: string; // yyyy-mm-dd
  itemId: string;
  source: "statement" | "receipt";
  /** why this counts towards `country`: a known owner, the user's own fix, a local independent, or where it was paid (estimated) */
  basis?: Basis;
  evidence?: LocationEvidence;
  /** why it counts as a local independent business (basis "independent") */
  independent?: IndependentReason;
  /** normalised payee (statement rows), so the user can fix the country for every payment to it */
  payee?: string;
}

export interface CountrySlice {
  iso: string;
  amount: number;
  share: number; // of spend with a country (named owners + estimates)
  /** part of `amount` that is estimated from where it was paid, or set by the user */
  estimated: number;
  /** entryId is the ownership entry, or "est:<label>" / "you:<label>" for estimated / user-set rows; payee is a
   *  normalised payee behind the row, when it has one (statement payments), for "Why this country?" */
  entries: { entryId: string; name: string; amount: number; basis: Basis; payee?: string }[];
}

export interface Breakdown {
  totalSpend: number;
  /** spend with a named owner */
  matchedSpend: number;
  /** spend counted by where it was paid, or by the user's own fix */
  estimatedSpend: number;
  unmatchedSpend: number;
  countries: CountrySlice[]; // sorted desc
  unmatched: { label: string; amount: number; count: number }[];
  scores: {
    ukShare: number;
    countryCount: number;
    /** share of spend with a named owner */
    identified: number;
    /** share of spend linked to a country at all (named owners + estimates + user fixes) */
    withCountry: number;
  };
  months: { month: string; byCountry: Record<string, number>; total: number }[];
  otherCurrencyCount: number;
  dateRange: { from: string; to: string } | null;
  contributionCount: number;
}

const RECEIPT_MATCH_DAYS = 3;

function daysBetween(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

/** Find the statement transaction a receipt describes: same shop, same total, within ±3 days. */
export function findReceiptMatch(item: Item, txns: StoredTransaction[]): StoredTransaction | undefined {
  const r = item.receipt;
  if (!r?.storeEntryId || r.total == null) return undefined;
  const date = r.date ?? item.createdAt.slice(0, 10);
  return txns.find(
    (t) =>
      t.kind === "spend" &&
      t.entryId === r.storeEntryId &&
      Math.abs(Math.abs(t.amount) - r.total!) < 0.011 &&
      daysBetween(t.date, date) <= RECEIPT_MATCH_DAYS,
  );
}

/** Build per-purchase contributions. A receipt matched to a statement transaction splits it into brands instead of adding a second purchase. */
/**
 * Without `ctx` the stored match (entryId) is used as is and unknown shops stay unmatched. With `ctx` every
 * payment is re-matched against today's built-in list, online answers and the user's fixes, and unknown
 * shops are estimated from where they were paid (when ctx.estimate is on).
 */
export function contributions(items: Item[], txns: StoredTransaction[], lines: ReceiptLine[], ctx?: AttributionContext): { list: Contribution[]; otherCurrency: number } {
  const list: Contribution[] = [];
  let otherCurrency = 0;
  const receiptsByTxn = new Map<string, Item>();
  const receipts = items.filter((i) => i.kind === "receipt");
  for (const r of receipts) {
    const m = r.receipt?.matchedTransactionId ?? findReceiptMatch(r, txns)?.id;
    if (m) receiptsByTxn.set(m, r);
  }
  const linesByItem = new Map<string, ReceiptLine[]>();
  for (const l of lines) {
    if (!l.included) continue;
    const arr = linesByItem.get(l.itemId) ?? [];
    arr.push(l);
    linesByItem.set(l.itemId, arr);
  }

  function receiptContributions(r: Item, total: number, date: string, paid?: Attribution, payee?: string): Contribution[] {
    const out: Contribution[] = [];
    const rl = linesByItem.get(r.id) ?? [];
    const storeEntry = entryById(r.receipt?.storeEntryId) ?? paid?.entry;
    const priced = rl.filter((l) => l.price && l.price > 0);
    const linesSum = priced.reduce((s, l) => s + (l.price ?? 0), 0);
    const scale = linesSum > 0 && total > 0 && linesSum > total ? total / linesSum : 1;
    let branded = 0;
    for (const l of priced) {
      const e = entryById(l.entryId);
      if (!e) continue; // own-brand / unrecognised lines fall to the shop below
      const amt = (l.price ?? 0) * scale;
      branded += amt;
      out.push({ entryId: e.id, label: e.display_name, country: e.owner_country, amount: amt, date, itemId: r.id, source: "receipt" });
    }
    // Branded lines whose price couldn't be read: give each an equal share of what's unaccounted for,
    // alongside the unreadable lines, so they're counted without inventing precise prices.
    const unpricedBranded = rl.filter((l) => !(l.price && l.price > 0) && entryById(l.entryId));
    if (unpricedBranded.length) {
      const unaccounted = Math.max(0, total - linesSum * scale);
      const each = unaccounted / (unpricedBranded.length + 1);
      for (const l of unpricedBranded) {
        const e = entryById(l.entryId)!;
        branded += each;
        out.push({ entryId: e.id, label: e.display_name, country: e.owner_country, amount: each, date, itemId: r.id, source: "receipt" });
      }
    }
    const rest = Math.max(0, total - branded);
    if (rest > 0.005) {
      // Items we couldn't match to a brand are counted under the shop you paid.
      const est = !storeEntry && ctx?.estimate ? paid?.country ?? ctx.home : undefined;
      out.push({
        entryId: storeEntry?.id,
        label: storeEntry?.display_name ?? r.receipt?.storeText ?? "Receipt",
        country: storeEntry?.owner_country ?? est,
        amount: rest,
        date,
        itemId: r.id,
        source: "receipt",
        basis: storeEntry ? "owner" : est ? (paid?.basis === "you" || paid?.basis === "independent" ? paid.basis : "estimated") : undefined,
        ...(est ? { evidence: paid?.evidence ?? "home" } : {}),
        // the statement payment this receipt splits, so the app can explain the shop part
        ...(payee ? { payee } : {}),
      });
    }
    return out;
  }

  for (const t of txns) {
    if (t.currency !== "GBP") {
      if (t.kind === "spend") otherCurrency++;
      continue;
    }
    if (t.kind !== "spend" && t.kind !== "refund") continue;
    const a: Attribution = ctx
      ? attribute(t, ctx)
      : (() => {
          const e = entryById(t.entryId);
          return e ? { entry: e, country: e.owner_country, basis: "owner" as const } : {};
        })();
    const e = a.entry;
    const sign = t.kind === "refund" ? -1 : 1;
    const amount = Math.abs(t.amount) * sign;
    const r = receiptsByTxn.get(t.id);
    if (r && sign > 0) {
      list.push(...receiptContributions(r, amount, t.date, a, t.normPayee || undefined));
      continue;
    }
    list.push({
      entryId: e?.id,
      label: e?.display_name ?? (t.normPayee || t.rawPayee),
      country: a.country,
      amount,
      date: t.date,
      itemId: t.itemId,
      source: "statement",
      basis: a.basis,
      ...(a.evidence ? { evidence: a.evidence } : {}),
      ...(a.independent ? { independent: a.independent } : {}),
      payee: t.normPayee,
    });
  }
  const matchedReceiptIds = new Set([...receiptsByTxn.values()].map((r) => r.id));
  for (const r of receipts) {
    if (matchedReceiptIds.has(r.id)) continue;
    const total = r.receipt?.total ?? (linesByItem.get(r.id) ?? []).reduce((s, l) => s + (l.price ?? 0), 0);
    if (!total) continue;
    list.push(...receiptContributions(r, total, r.receipt?.date ?? r.createdAt.slice(0, 10)));
  }
  return { list, otherCurrency };
}

export function periodStart(period: Period, latest: string | undefined): string | undefined {
  if (!latest || period === "all") return undefined;
  const d = new Date(latest + "T00:00:00");
  const months = period === "1m" ? 1 : period === "3m" ? 3 : 12;
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

export function breakdown(list: Contribution[], otherCurrency = 0, period: Period = "all"): Breakdown {
  const latest = list.reduce<string | undefined>((m, c) => (!m || c.date > m ? c.date : m), undefined);
  const start = periodStart(period, latest);
  const rows = start ? list.filter((c) => c.date > start) : list;

  const byCountry = new Map<string, Map<string, { name: string; amount: number; basis: Basis; payee?: string }>>();
  const unmatched = new Map<string, { amount: number; count: number }>();
  const months = new Map<string, { byCountry: Record<string, number>; total: number }>();
  let unmatchedSum = 0;
  let from: string | undefined;
  let to: string | undefined;

  for (const c of rows) {
    if (!from || c.date < from) from = c.date;
    if (!to || c.date > to) to = c.date;
    const basis: Basis | undefined = c.country ? c.basis ?? (c.entryId ? "owner" : undefined) : undefined;
    if (c.country && basis && (basis !== "owner" || c.entryId)) {
      const key = basis === "owner" ? c.entryId! : `${basis === "you" ? "you" : "est"}:${c.label}`;
      const m = byCountry.get(c.country) ?? new Map();
      const cur = m.get(key) ?? { name: c.label, amount: 0, basis };
      cur.amount += c.amount;
      if (!cur.payee && c.payee) cur.payee = c.payee;
      m.set(key, cur);
      byCountry.set(c.country, m);
      const mk = c.date.slice(0, 7);
      const mo = months.get(mk) ?? { byCountry: {}, total: 0 };
      mo.byCountry[c.country] = (mo.byCountry[c.country] ?? 0) + c.amount;
      mo.total += c.amount;
      months.set(mk, mo);
    } else {
      unmatchedSum += c.amount;
      const u = unmatched.get(c.label) ?? { amount: 0, count: 0 };
      u.amount += c.amount;
      u.count += 1;
      unmatched.set(c.label, u);
    }
  }

  const countries: CountrySlice[] = [...byCountry.entries()]
    .map(([iso, m]) => {
      const entries = [...m.entries()]
        .map(([entryId, v]) => ({ entryId, name: v.name, amount: v.amount, basis: v.basis, ...(v.payee ? { payee: v.payee } : {}) }))
        .filter((e) => e.amount > 0.005)
        .sort((a, b) => b.amount - a.amount);
      const amount = entries.reduce((s, e) => s + e.amount, 0);
      const estimated = entries.filter((e) => e.basis !== "owner").reduce((s, e) => s + e.amount, 0);
      return { iso, amount, share: 0, estimated, entries };
    })
    .filter((c) => c.amount > 0.005)
    .sort((a, b) => b.amount - a.amount);
  const matchedPos = countries.reduce((s, c) => s + c.amount, 0);
  for (const c of countries) c.share = matchedPos > 0 ? c.amount / matchedPos : 0;

  const withCountryPos = countries.reduce((s, c) => s + c.amount, 0);
  const estimatedPos = countries.reduce((s, c) => s + c.estimated, 0);
  const namedPos = withCountryPos - estimatedPos;
  const total = withCountryPos + Math.max(0, unmatchedSum);
  const uk = countries.find((c) => c.iso === "GB");
  return {
    totalSpend: total,
    matchedSpend: namedPos,
    estimatedSpend: estimatedPos,
    unmatchedSpend: Math.max(0, unmatchedSum),
    countries,
    unmatched: [...unmatched.entries()]
      .map(([label, v]) => ({ label, ...v }))
      .filter((u) => u.amount > 0.005)
      .sort((a, b) => b.amount - a.amount),
    scores: {
      ukShare: uk?.share ?? 0,
      countryCount: countries.filter((c) => c.share >= 0.001).length,
      identified: total > 0 ? namedPos / total : 0,
      withCountry: total > 0 ? withCountryPos / total : 0,
    },
    months: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, ...v })),
    otherCurrencyCount: otherCurrency,
    dateRange: from && to ? { from, to } : null,
    contributionCount: rows.length,
  };
}

/** Top N countries plus an "Other" bucket, for pie/legend. UK is always kept if present. */
export function topSlices(countries: CountrySlice[], n = 6): { iso: string; share: number; amount: number }[] {
  const keep: CountrySlice[] = [];
  for (const c of countries) {
    if (keep.length < n || c.iso === "GB") keep.push(c);
  }
  const trimmed = keep.length > n ? keep.filter((c, i) => c.iso === "GB" || i < n - 1) : keep;
  const rest = countries.filter((c) => !trimmed.includes(c));
  const out = trimmed.map((c) => ({ iso: c.iso, share: c.share, amount: c.amount }));
  if (rest.length) {
    out.push({ iso: "OTHER", share: rest.reduce((s, c) => s + c.share, 0), amount: rest.reduce((s, c) => s + c.amount, 0) });
  }
  return out;
}
