import { checkedEntries, receiptResolver } from "./ownership";

/**
 * Receipt text → shop, date, total and line items. Pure: the OCR itself lives in each app
 * (apps/web/src/lib/receipt.ts, apps/mobile/src/lib/ocr*.ts).
 */

export interface ParsedReceiptLine {
  text: string;
  price?: number;
  entryId?: string;
  brandName?: string;
  ownBrandRetailerId?: string;
}

export interface ParsedReceipt {
  storeText?: string;
  storeEntryId?: string;
  date?: string;
  total?: number;
  lines: ParsedReceiptLine[];
  rawText: string;
  confidence?: number;
}

/** How useful a parse looks: recognised brands and a readable total matter most. */
export function parseScore(p: ParsedReceipt): number {
  return p.lines.filter((l) => l.entryId).length * 2 + p.lines.length * 0.5 + (p.total != null ? 3 : 0) + (p.storeEntryId ? 2 : 0);
}

const PRICE_AT_END = /(-?[£$€]?\s?\d{1,4}[.,]\d{2})\s*[A-Z*]{0,2}(?:\s+\S{1,6}){0,2}\s*$/;
const PAYMENT_WORDS = /\b(VISA|MASTERCARD|MASTER CARD|MAESTRO|AMEX|CONTACTLESS|DEBIT CARD|CREDIT CARD|CARD PAYMENT|APPLE PAY|GOOGLE PAY)\b/;
const TOTAL_WORDS = /\b(TOTAL|BALANCE DUE|AMOUNT DUE|TO PAY|AMOUNT PAYABLE)\b/;
const NOT_ITEMS = /\b(SUB ?TOTAL|TOTAL|BALANCE|CHANGE|CASH|CARD|VISA|MASTERCARD|MAESTRO|AMEX|CONTACTLESS|DEBIT|CREDIT|VAT|TAX|SAVINGS?|CLUBCARD|NECTAR|POINTS|MULTIBUY|DISCOUNT|PROMOTION|TENDER|AUTH|MERCHANT|TERMINAL|APPROVED|PAYMENT)\b/;
const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

function toPrice(s: string): number {
  return Number(s.replace(/[£\s]/g, "").replace(",", "."));
}

function findDate(text: string): string | undefined {
  const m1 = text.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (m1) {
    const d = Number(m1[1]);
    const mo = Number(m1[2]);
    let y = Number(m1[3]);
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2015 && y <= 2100) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  const m2 = text.toUpperCase().match(/\b(\d{1,2})\s?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s?(\d{2,4})\b/);
  if (m2) {
    let y = Number(m2[3]);
    if (y < 100) y += 2000;
    return `${y}-${MONTHS[m2[2]!]}-${String(Number(m2[1])).padStart(2, "0")}`;
  }
  return undefined;
}

/** Pure text → receipt structure. Exported for tests and for the demo receipt. */
export function parseReceiptText(rawText: string): ParsedReceipt {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1);
  const upper = lines.map((l) => l.toUpperCase());

  // Shop: first line near the top that we recognise as a merchant, else the first wordy line.
  let storeText: string | undefined;
  let storeEntryId: string | undefined;
  for (const [i, l] of upper.slice(0, 6).entries()) {
    const r = receiptResolver.resolve(l);
    const raw = (r.matched_alias ?? "").toUpperCase();
    const alias = raw.replace(/[^A-Z0-9]/g, "");
    const lineAlnum = l.replace(/[^A-Z0-9]/g, "");
    if (alias.length < 4) {
      // Very short names ("EE", "M&S") only count when they are the whole line, near the very top —
      // otherwise OCR noise like "-Z RE Ee" or "EE ~~" turns into a shop.
      if (i >= 3 || l.replace(/\s/g, "") !== raw.replace(/\s/g, "")) continue;
    } else if (!lineAlnum.startsWith(alias) && alias.length / Math.max(1, lineAlnum.length) < 0.3) {
      // A shop name buried in a long line ("…survey.walmart.com - ln er" → LNER) is noise, not the header.
      continue;
    }
    if (r.status === "RESOLVED" && r.entry?.kind === "merchant") {
      storeText = r.entry.display_name;
      storeEntryId = r.entry.id;
      break;
    }
  }
  if (!storeText) {
    // OCR often garbles the logo line ("Sainsbury: g"). Try a close (edit-distance) match on the first few lines.
    const fuzzy = fuzzyStore(upper.slice(0, 6));
    if (fuzzy) {
      storeText = fuzzy.name;
      storeEntryId = fuzzy.id;
    }
  }
  if (!storeText) storeText = lines.find((l) => /[A-Za-z]{3,}/.test(l) && !PRICE_AT_END.test(l));

  // Total: vote between the TOTAL / BALANCE DUE line and the card-payment line (they should agree),
  // with the sum of item prices as a weak tie-breaker. OCR often garbles one of them but rarely both.
  const votes: { v: number; w: number }[] = [];
  for (let i = 0; i < upper.length; i++) {
    const l = upper[i]!;
    const m = l.match(PRICE_AT_END) ?? upper[i + 1]?.match(/^£?\s?(\d{1,4}[.,]\d{2})$/);
    if (!m) continue;
    const v = toPrice(m[1]!);
    if (!(v > 0) || v > 5000) continue;
    if (TOTAL_WORDS.test(l) && !/SUB ?TOTAL/.test(l)) votes.push({ v, w: 1.2 });
    else if (PAYMENT_WORDS.test(l)) votes.push({ v, w: 1 });
  }
  const items: ParsedReceiptLine[] = [];
  const headerEnd = Math.min(upper.length, 4);
  for (let i = 0; i < upper.length; i++) {
    const l = upper[i]!;
    if (NOT_ITEMS.test(l)) continue;
    const m = l.match(PRICE_AT_END);
    // Receipt prices are often mangled by OCR (the £ sign especially). A line with a recognisable
    // brand is still worth keeping without its price: its share is estimated from what's left.
    const rawText = m ? l.slice(0, m.index) : l.replace(/[£$€]?\s*[\d.,()]+\s*[A-Z]?\s*$/, "");
    const text = rawText.replace(/[^A-Z0-9&'% ]/g, " ").replace(/\s+/g, " ").trim();
    if (text.length < 2 || /^\d+$/.test(text)) continue;
    let price = m ? toPrice(m[1]!) : undefined;
    if (price !== undefined && (!(price > 0) || price > 1000)) price = undefined;
    const r = receiptResolver.resolveProduct(text);
    const branded = r.status === "RESOLVED";
    if (price === undefined && (!branded || i < headerEnd)) continue; // unpriced + unbranded = noise
    items.push({
      text,
      price,
      entryId: branded ? r.entry?.id : undefined,
      brandName: branded ? r.entry?.display_name : undefined,
      ownBrandRetailerId: r.own_brand_retailer?.id,
    });
  }

  const itemsSum = round2(items.reduce((s, x) => s + (x.price ?? 0), 0));
  if (itemsSum > 0) votes.push({ v: itemsSum, w: 0.5 });
  const tally = new Map<string, { v: number; w: number }>();
  for (const { v, w } of votes) {
    const k = v.toFixed(2);
    const t = tally.get(k) ?? { v, w: 0 };
    t.w += w;
    tally.set(k, t);
  }
  const total = [...tally.values()].sort((a, b) => b.w - a.w)[0]?.v;

  return { storeText, storeEntryId, date: findDate(rawText), total, lines: items, rawText };
}

const merchantAliases = checkedEntries
  .filter((e) => e.kind === "merchant")
  .flatMap((e) => e.aliases.map((a) => ({ key: a.toUpperCase().replace(/[^A-Z]/g, ""), id: e.id, name: e.display_name })))
  .filter((a) => a.key.length >= 4);

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

/** Closest merchant alias to a header line. Names of 7+ letters may have one OCR slip (two at 14+); shorter names must match exactly,
 * because short near-misses ("SELL"→Shell, "LORAL"→Coral) are common in receipt noise. */
export function fuzzyStore(headerLines: string[]): { id: string; name: string } | undefined {
  let best: { id: string; name: string; d: number } | undefined;
  for (const line of headerLines) {
    const words = line.replace(/[^A-Z ]/g, " ").split(/\s+/).filter(Boolean);
    // try the whole line and each 1–2 word window, letters only
    const cands = new Set<string>([words.join("")]);
    for (let i = 0; i < words.length; i++) {
      cands.add(words[i]!);
      if (i + 1 < words.length) cands.add(words[i]! + words[i + 1]!);
    }
    const whole = words.join("");
    for (const c of cands) {
      if (c.length < 4) continue;
      // same rule as exact matches: the name must start the line or be a real part of it
      if (!whole.startsWith(c) && c.length / whole.length < 0.3) continue;
      for (const a of merchantAliases) {
        if (Math.abs(a.key.length - c.length) > 2) continue;
        const d = editDistance(c, a.key);
        if (d <= Math.floor(a.key.length / 7) && (!best || d < best.d)) best = { id: a.id, name: a.name, d };
      }
    }
  }
  return best && { id: best.id, name: best.name };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
