/**
 * PDF bank statements → the same rows a CSV export gives, on the device.
 *
 * pdf.js (loaded by each app from its own origin — never a CDN) gives us every piece of text on
 * each page with its position. From that we rebuild the transaction table: group text into lines
 * by height on the page, find the column headings (Date / Description / Money out / Money in /
 * Balance, or a single Amount column), then read each row, using a date to start a transaction and
 * the heading positions to decide which column an amount belongs to. Detail lines under a row
 * ("To: TESCO STORES 3456, London") are kept as the bank's raw descriptor; card numbers and payment
 * references are dropped. Pending and reverted sections are skipped.
 *
 * The result is CSV text plus the column mapping, so @kys/statement does the rest (normalising,
 * classifying, de-duplicating) exactly as it does for CSV files.
 */
import type { ColumnMapping } from "@kys/statement";

export interface PdfTextItem {
  str: string;
  x: number; // left, PDF units
  y: number; // baseline, PDF units from the bottom of the page
  w: number;
  h: number;
}
export interface PdfPage {
  items: PdfTextItem[];
  width: number;
  height: number;
}

/** The subset of a pdf.js document we use (so this file has no pdf.js dependency). */
export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number };
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
}

export interface PdfStatementResult {
  csv: string;
  mapping: ColumnMapping;
  rows: number;
  currency: string;
  bank?: { id: string; name: string };
  /** true when no transaction table was found — probably a scanned (image-only) PDF or an unusual layout */
  noTable: boolean;
  scanned: boolean;
  warnings: string[];
}

/** Pull positioned text out of every page. */
export async function extractPdfPages(doc: PdfDocLike, maxPages = 60): Promise<PdfPage[]> {
  const pages: PdfPage[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const raw of tc.items) {
      const it = raw as { str?: string; transform?: number[]; width?: number; height?: number };
      if (!it.str || !it.transform || !it.str.trim()) continue;
      const [a, b, , d, e, f] = it.transform as [number, number, number, number, number, number];
      const h = it.height || Math.hypot(b, d) || Math.abs(a) || 10;
      items.push({ str: it.str, x: e, y: f, w: it.width ?? it.str.length * h * 0.5, h });
    }
    pages.push({ items, width: vp.width, height: vp.height });
  }
  return pages;
}

// ── lines and cells ──────────────────────────────────────────────────────────

interface Cell {
  text: string;
  x: number;
  right: number;
  h: number;
}
interface Line {
  y: number;
  cells: Cell[];
  text: string;
}

function toLines(page: PdfPage): Line[] {
  const items = [...page.items].sort((p, q) => q.y - p.y || p.x - q.x);
  const groups: PdfTextItem[][] = [];
  for (const it of items) {
    const g = groups[groups.length - 1];
    const tol = Math.max(1.5, it.h * 0.45);
    if (g && Math.abs(g[0]!.y - it.y) <= tol) g.push(it);
    else groups.push([it]);
  }
  return groups.map((g) => {
    g.sort((p, q) => p.x - q.x);
    const cells: Cell[] = [];
    for (const it of g) {
      const c = cells[cells.length - 1];
      const gap = c ? it.x - c.right : Infinity;
      if (c && gap < Math.max(2, it.h * 0.9)) {
        c.text += (gap > it.h * 0.12 && !c.text.endsWith(" ") && !it.str.startsWith(" ") ? " " : "") + it.str;
        c.right = Math.max(c.right, it.x + it.w);
      } else cells.push({ text: it.str, x: it.x, right: it.x + it.w, h: it.h });
    }
    for (const c of cells) c.text = c.text.replace(/\s+/g, " ").trim();
    const kept = cells.filter((c) => c.text);
    return { y: g[0]!.y, cells: kept, text: kept.map((c) => c.text).join(" ") };
  });
}

// ── dates ────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?";
const RE_DMY_WORD = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}(?:\\s+(\\d{2,4}))?\\b`, "i");
const RE_MDY_WORD = new RegExp(`^${MON}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i");
const RE_NUM = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/;
const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})\b/;

interface DateHit {
  iso?: string;
  month: number;
  day: number;
  year?: number;
  len: number;
}

function readDate(s: string): DateHit | null {
  const t = s.trim();
  let m = t.match(RE_ISO);
  if (m) return { month: +m[2]!, day: +m[3]!, year: +m[1]!, len: m[0].length };
  m = t.match(RE_NUM);
  if (m) {
    let y = +m[3]!;
    if (y < 100) y += 2000;
    return { day: +m[1]!, month: +m[2]!, year: y, len: m[0].length };
  }
  m = t.match(RE_DMY_WORD);
  if (m) {
    let y = m[3] ? +m[3] : undefined;
    if (y !== undefined && y < 100) y += 2000;
    return { day: +m[1]!, month: MONTHS[m[2]!.toLowerCase().slice(0, 4).replace(/t$/, "")] ?? MONTHS[m[2]!.toLowerCase().slice(0, 3)]!, year: y, len: m[0].length };
  }
  m = t.match(RE_MDY_WORD);
  if (m) return { month: MONTHS[m[1]!.toLowerCase().slice(0, 3)]!, day: +m[2]!, year: +m[3]!, len: m[0].length };
  return null;
}

function validDate(d: DateHit): boolean {
  return d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31 && (d.year === undefined || (d.year >= 2000 && d.year <= 2100));
}

/** Statement period, for dates printed without a year ("3 Jul"). */
function periodEnd(allText: string): { year: number; month: number } {
  const re = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}\\s+(20\\d{2})|(\\d{1,2})[/.-](\\d{1,2})[/.-](20\\d{2})`, "gi");
  let best: { year: number; month: number } | null = null;
  for (const m of allText.matchAll(re)) {
    const year = +(m[3] ?? m[6]!);
    const month = m[2] ? MONTHS[m[2].toLowerCase().slice(0, 3)]! : +m[5]!;
    if (!best || year > best.year || (year === best.year && month > best.month)) best = { year, month };
  }
  if (!best) {
    const years = [...allText.matchAll(/\b(20\d{2})\b/g)].map((m) => +m[1]!);
    if (years.length) best = { year: Math.max(...years), month: 12 };
  }
  if (!best) {
    // no year printed anywhere: assume the most recent past date
    const now = new Date();
    best = { year: now.getFullYear(), month: now.getMonth() + 1 };
  }
  return best;
}

// ── amounts ──────────────────────────────────────────────────────────────────

// "£1,234.56", "£1 234.56" (Revolut groups thousands with a space), "- £12.00", "(12.00)", "12.00 CR"
const AMOUNT = /^([-−–]?)\s?\(?(([£$€])?\s?-?\d{1,3}(?:[, \u00a0\u202f]\d{3})*\.\d{2}|([£$€])?\s?-?\d+\.\d{2})\)?\s?(CR|DR|-)?$/i;
const SYMBOL: Record<string, string> = { "£": "GBP", $: "USD", "€": "EUR" };

/** An amount in the statement's currency, or null. Amounts in another currency (the "$63.42" under an FX line) are ignored. */
function readAmount(s: string, currency = "GBP"): number | null {
  const m = s.replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim().match(AMOUNT);
  if (!m) return null;
  const sym = m[3] ?? m[4];
  if (sym && SYMBOL[sym] !== currency) return null;
  let v = Number(m[2]!.replace(/[£$€,\s]/g, ""));
  if (!isFinite(v)) return null;
  const suffix = m[5] ?? "";
  const neg = !!m[1] || s.trim().startsWith("(") || /DR|-$/i.test(suffix) || v < 0;
  v = Math.abs(v);
  if (/CR/i.test(suffix)) return v;
  return neg ? -v : v;
}

// ── header ───────────────────────────────────────────────────────────────────

type ColKind = "out" | "in" | "amount" | "balance";
interface Header {
  dateX: number;
  descX: number;
  cols: { kind: ColKind; x: number; right: number }[];
}

function headerKind(t: string): ColKind | "date" | "desc" | null {
  const s = t.toLowerCase().replace(/[£$€()]/g, " ").replace(/\b(gbp|eur|usd)\b/g, " ").replace(/\s+/g, " ").trim();
  if (/^(transaction |posting |value |completed )?date( utc| gmt)?$/.test(s)) return "date";
  // (HSBC and first direct PDFs space out some letters: "Paym ent t ype and det ails")
  if (/^(description|details|transaction details|transaction|payment type and details|merchant|narrative|particulars)$/.test(s) || s.replace(/\s/g, "") === "paymenttypeanddetails") return "desc";
  if (/^(money out|paid out|out|withdrawals?|debits?|payments? out|spent|outgoings?)$/.test(s)) return "out";
  if (/^(money in|paid in|in|deposits?|credits?|payments? in|received|incomings?)$/.test(s)) return "in";
  if (/^(amount|value|transaction amount)$/.test(s)) return "amount";
  if (/^(balance|running balance|closing balance)$/.test(s)) return "balance";
  return null;
}

function readHeader(line: Line): Header | null {
  let dateX: number | undefined;
  let descX: number | undefined;
  const cols: Header["cols"] = [];
  for (const c of line.cells) {
    // a heading cell sometimes merges two words that are separate columns ("Date Description")
    const parts = c.text.split(/\s{2,}/);
    const k = headerKind(c.text) ?? (parts.length > 1 ? headerKind(parts[0]!) : null);
    if (k === "date") dateX = c.x;
    else if (k === "desc") descX = c.x;
    else if (k) cols.push({ kind: k, x: c.x, right: c.right });
    else if (/^date description$/i.test(c.text)) {
      dateX = c.x;
      descX = c.x + c.h * 3;
    }
  }
  if (dateX === undefined) return null;
  const hasOut = cols.some((c) => c.kind === "out");
  const hasIn = cols.some((c) => c.kind === "in");
  const hasAmt = cols.some((c) => c.kind === "amount");
  if (!((hasOut && hasIn) || hasAmt || (hasOut && cols.some((c) => c.kind === "balance")))) return null;
  const firstCol = Math.min(...cols.map((c) => c.x));
  return { dateX, descX: descX ?? dateX + (firstCol - dateX) * 0.25, cols };
}

// ── rows ─────────────────────────────────────────────────────────────────────

interface Row {
  type?: string;
  date: string;
  payee: string;
  details: string;
  out?: number;
  in?: number;
  balance?: number;
  currency: string;
  /** what the shop charged in another currency, "THB 300.00": added to the end of the description (18 Oct 2026) */
  charged?: string;
}

const NOISE = /(^page \d+( of \d+)?$|registered in england|financial conduct authority|prudential regulation|financial services compensation|fscs|generated on|continued (on|over)|brought forward|carried forward|^total\b|report lost or stolen|get help directly in app|scan the qr code|^©|your funds have been transferred from your e-money account|transition has been managed in the background|transition to revolut bank)/i;
const SKIP_SECTION = /\b(pending|reverted|declined|failed)\b/i;
const OPEN_SECTION = /\b(account transactions|transactions from|your transactions|statement of account|transactions)\b/i;
const DROP_DETAIL = /^(card:|card number|reference:|ref:|payment reference|exchange rate|fx rate|fee:|revolut rate|ecb rate|•)/i;
const BALANCE_ROW = /^(opening|closing|start|end|brought|carried) balance|^balance (brought|carried) forw\s?ard/i;
/** "1 July to 31 July 2026" above the table on every first direct page: the statement's period, not a payment date */
const PERIOD_LINE = /^\d{1,2}(?:st|nd|rd|th)? [a-z]+(?: \d{2,4})? to \d{1,2}(?:st|nd|rd|th)? [a-z]+ \d{2,4}$/i;
// A statement with one section per currency (Revolut: "Currency EUR", then "Currency GBP"…, 18 Oct 2026: only the first
// page's currency was read, so a GBP section after an empty EUR one came out with no rows).
const SECTION_CURRENCY = /\bCurrency\s+([A-Z]{3})\b/;
// HSBC and first direct (18 Oct 2026) print a payment over several lines: its type code (")))", "MAS", "VIS", "DD",
// "BP", "CR", "SO", "TFR"…) and payee on the first, then the place or reference, any exchange-rate lines, and the
// amount on the last line. Other banks print the amount on the first line and details under it.
const TYPE_CODE = /^(\)\)\)|[A-Z]{2,4})$/;
const FX_LINE = /^[A-Z]{3}\s?[\d,]+\.\d{2}(\s*@\s*[\d.]+)?$|^@\s?[\d.]+\s*(MAS|VIS|VISA)?\s*rate$|^(MAS|VIS|VISA)\s+rate$/i;
// "INT'L 0012345678" and "CASH 0012345680" start a payment abroad; the reference is a long number, so "CASH CONVERTERS",
// "CASH 4U" and "INTL BOOKS" stay shop names
const INTL_LINE = /^INT'?L\s+\d{4,}$/i;
const CASH_LINE = /^CASH\s+\d{4,}$/i;

/**
 * Banks by what their statements print about themselves: `strong` is the bank's legal name or web address, which a
 * payment line almost never has; `weak` is the name alone, which can also be a payee, a person or a street ("REVOLUT LTD"
 * top-ups, "John Wise", "Chase Road"). first direct comes before HSBC: its statements say "first direct is a division of
 * HSBC UK Bank plc".
 */
const BANKS: { id: string; name: string; strong: RegExp; weak: RegExp }[] = [
  { id: "revolut", name: "Revolut", strong: /\brevolut (?:ltd|bank uk)\b|\brevolut\.com\b/i, weak: /\brevolut\b/i },
  { id: "monzo", name: "Monzo", strong: /\bmonzo bank limited\b|\bmonzo\.com\b/i, weak: /\bmonzo\b/i },
  { id: "starling", name: "Starling", strong: /\bstarling bank\b|\bstarlingbank\.com\b/i, weak: /\bstarling\b/i },
  { id: "barclays", name: "Barclays", strong: /\bbarclays bank (?:uk )?plc\b|\bbarclays\.co\.uk\b/i, weak: /\bbarclays\b/i },
  { id: "hsbc", name: "first direct", strong: /\bfirst direct is a division\b|\bfirstdirect\.com\b/i, weak: /\bfirst direct\b/i },
  { id: "hsbc", name: "HSBC", strong: /\bhsbc uk bank plc\b|\bhsbc\.co\.uk\b/i, weak: /\bhsbc\b/i },
  { id: "lloyds", name: "Lloyds", strong: /\blloyds bank plc\b|\blloydsbank\.com\b/i, weak: /\blloyds\b/i },
  { id: "lloyds", name: "Halifax", strong: /\bhalifax is a division of bank of scotland\b|\bhalifax\.co\.uk\b/i, weak: /\bhalifax\b/i },
  { id: "natwest", name: "NatWest", strong: /\bnational westminster bank\b|\bnatwest\.com\b/i, weak: /\bnatwest\b/i },
  { id: "natwest", name: "RBS", strong: /\broyal bank of scotland plc\b|\brbs\.co\.uk\b/i, weak: /\broyal bank of scotland\b/i },
  { id: "santander", name: "Santander", strong: /\bsantander uk plc\b|\bsantander\.co\.uk\b/i, weak: /\bsantander\b/i },
  { id: "nationwide", name: "Nationwide", strong: /\bnationwide building society\b|\bnationwide\.co\.uk\b/i, weak: /\bnationwide\b/i },
  { id: "chase", name: "Chase UK", strong: /\bj\.?\s?p\.? morgan europe\b|\bchase\.co\.uk\b/i, weak: /\bchase\b/i },
  { id: "wise", name: "Wise", strong: /\bwise payments\b|\bwise\.com\b/i, weak: /\bwise\b/i },
  { id: "amex", name: "American Express", strong: /\bamerican express services europe\b|\bamericanexpress\.co\.uk\b/i, weak: /\bamerican express\b|\bamex\b/i },
  { id: "tsb", name: "TSB", strong: /\btsb bank plc\b|\btsb\.co\.uk\b/i, weak: /\btsb\b/i },
  { id: "metro", name: "Metro Bank", strong: /\bmetro bank plc\b|\bmetrobankonline\.co\.uk\b/i, weak: /\bmetro bank\b/i },
  { id: "virgin", name: "Virgin Money", strong: /\bvirgin money uk plc\b|\bvirginmoney\.com\b/i, weak: /\bvirgin money\b/i },
  { id: "coop", name: "Co-operative Bank", strong: /\bco-operative bank p\.?l\.?c\b|\bco-operativebank\.co\.uk\b/i, weak: /\bco-operative bank\b/i },
  { id: "n26", name: "N26", strong: /\bn26 bank\b|\bn26\.com\b/i, weak: /\bn26\b/i },
];

/**
 * The bank, from the first page (18 Oct 2026), never from the table of payments: its legal name or web address below
 * the table (the footer), then above it; failing that, its name below the table. The table runs from its heading to
 * the last line with a date or an amount. So a payee ("MONZO* ME A FRIEND", a "Revolut Ltd" top-up) or the holder's name
 * and address ("John Wise", "Chase Road") don't decide it. No bank found: the app says "Your bank".
 */
function whichBank(lines: Line[]): (typeof BANKS)[number] | undefined {
  const find = (ls: Line[], kind: "strong" | "weak") => {
    const text = ls.map((l) => l.text).join("\n");
    return BANKS.find((b) => b[kind].test(text));
  };
  const top = lines.findIndex((l) => readHeader(l));
  if (top < 0) return find(lines, "strong"); // no table on this page
  let end = top;
  for (let i = lines.length - 1; i > top; i--) {
    if (/\d\.\d{2}\b/.test(lines[i]!.text) || readDate(lines[i]!.cells[0]?.text ?? "")) {
      end = i;
      break;
    }
  }
  const below = lines.slice(end + 1);
  return find(below, "strong") ?? find(lines.slice(0, top), "strong") ?? find(below, "weak");
}

function csvCell(v: string | number | undefined): string {
  if (v === undefined) return "";
  const s = typeof v === "number" ? v.toFixed(2) : v;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function pdfToStatementCsv(pages: PdfPage[]): PdfStatementResult {
  const warnings: string[] = [];
  const allLines = pages.map(toLines);
  const allText = allLines.flat().map((l) => l.text).join("\n");
  const scanned = pages.length > 0 && pages.every((p) => p.items.length < 5);
  const firstPageText = allLines[0]?.map((l) => l.text).join("\n") ?? "";
  const bankHit = whichBank(allLines[0] ?? []);
  let currency = /\bEUR\b|€/.test(firstPageText.slice(0, 400)) && !/\bGBP\b|£/.test(firstPageText.slice(0, 400)) ? "EUR" : "GBP";
  const period = periodEnd(allText);

  const rows: Row[] = [];
  let header: Header | null = null;
  let skipping = false;
  let carryDate: string | undefined;
  let detailLines = 0;
  // HSBC-style layout (amount on a payment's last line), and the payment being read in it
  let amountLast = false;
  let block: { date?: string; code?: string; lines: string[] } | null = null;

  const iso = (d: DateHit): string | undefined => {
    if (!validDate(d)) return undefined;
    let y = d.year;
    if (y === undefined) y = d.month > period.month ? period.year - 1 : period.year;
    return `${y}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  };

  /** Money out / in / balance from the amounts on a line, by the nearest column heading. */
  const placeAmounts = (r: Pick<Row, "out" | "in" | "balance">, amounts: { v: number; right: number }[]) => {
    for (const a of amounts) {
      let best = header!.cols[0]!;
      for (const col of header!.cols) if (Math.abs(col.right - a.right) < Math.abs(best.right - a.right)) best = col;
      if (Math.abs(best.right - a.right) > 90) continue;
      if (best.kind === "out") r.out = Math.abs(a.v);
      else if (best.kind === "in") r.in = Math.abs(a.v);
      else if (best.kind === "balance") r.balance = a.v;
      else if (a.v < 0) r.out = -a.v;
      else r.in = a.v;
    }
  };

  for (const lines of allLines) {
    // a payment's detail lines are on its own page: what's at the top of the next one ("Balance summary") isn't one. A
    // first direct payment still open at a page break carries on below the next page's table heading; the account
    // lines above that heading (the holder's name…) are skipped
    detailLines = 3;
    let aboveHeading = amountLast && lines.some((l) => readHeader(l));
    for (const line of lines) {
      const sectionCurrency = line.text.match(SECTION_CURRENCY)?.[1];
      if (sectionCurrency && line.text.length < 90) {
        currency = sectionCurrency;
        continue;
      }
      const h = readHeader(line);
      if (h) {
        header = h;
        detailLines = 0;
        // first direct / HSBC: known by the table's heading, not the bank's name (a payee can name a bank)
        amountLast = /paymenttypeanddetails/i.test(line.text.replace(/\s/g, ""));
        aboveHeading = false;
        continue;
      }
      const amountsInLine = line.cells.some((c) => readAmount(c.text, currency) !== null);
      if (!amountsInLine && !readDate(line.text)) {
        if (SKIP_SECTION.test(line.text) && line.text.length < 90) {
          skipping = true;
          continue;
        }
        if (OPEN_SECTION.test(line.text) && line.text.length < 90 && !/\bpending\b/i.test(line.text)) {
          skipping = false;
          continue;
        }
      }
      if (!header || skipping) continue;
      if (NOISE.test(line.text) || PERIOD_LINE.test(line.text.trim())) continue;

      const amountLeft = Math.min(...header.cols.map((c) => c.x)) - 4;

      if (amountLast) {
        if (aboveHeading) continue;
        // Split the line into date, type code, description and amounts.
        const amounts: { v: number; right: number }[] = [];
        const text: Cell[] = [];
        for (const c of line.cells) {
          const a = c.x >= amountLeft - 30 ? readAmount(c.text, currency) : null;
          if (a !== null && c.right > amountLeft) amounts.push({ v: a, right: c.right });
          else if (c.x < amountLeft) text.push(c);
        }
        let i = 0;
        let dateHit: DateHit | null = null;
        let code: string | undefined;
        if (text[0] && text[0].x < header.descX - 2) {
          const d = readDate(text[0].text);
          if (d) {
            dateHit = d;
            const rest = text[0].text.slice(d.len).trim();
            if (TYPE_CODE.test(rest)) code = rest;
            i = 1;
          }
        }
        // the type code sits in its own column at the left of the description heading
        const c = text[i];
        if (!code && c && c.x < header.descX + 8 && TYPE_CODE.test(c.text) && text[i + 1] && text[i + 1]!.x - c.right > 4) {
          code = c.text;
          i++;
        }
        const date = dateHit ? iso(dateHit) : undefined;
        const desc = text.slice(i).map((x) => x.text).join(" ").trim();
        if (BALANCE_ROW.test(desc)) {
          if (date) carryDate = date;
          continue;
        }
        if (code) {
          // a new payment starts here (one before it that never reached an amount is dropped)
          block = { date: date ?? carryDate, code, lines: desc ? [desc] : [] };
        } else if (date && desc && !block) {
          block = { date, lines: [desc] };
        } else if (block && desc) {
          block.lines.push(desc);
        }
        if (date) carryDate = date;
        if (!amounts.length || !block) continue;
        // the amount line ends the payment: payee first, then the place or reference
        let parts = block.lines.filter((l) => !FX_LINE.test(l));
        // what the shop charged abroad ("THB 300.00 @ 41.5"): the currency says where it was paid when the bank prints
        // nothing else (18 Oct 2026)
        const abroad = block.lines.map((l) => /^([A-Z]{3})\s?([\d,]+\.\d{2})\b/.exec(l)).find((m) => m && m[1] !== currency);
        let type = block.code;
        if (parts[0] && INTL_LINE.test(parts[0])) parts = parts.slice(1);
        else if (parts[0] && CASH_LINE.test(parts[0])) {
          parts = parts.slice(1);
          type = "ATM";
        }
        const r: Row = { date: block.date ?? "", payee: (parts[0] ?? "").trim(), details: parts.join(" ").trim(), type, currency };
        if (abroad) r.charged = `${abroad[1]} ${abroad[2]}`;
        placeAmounts(r, amounts);
        block = null;
        if (r.date && (r.out || r.in) && r.payee) rows.push(r);
        continue;
      }
      // date: text starting at the left edge of the table, before the description column
      const leadCells = line.cells.filter((c) => c.x < header!.descX - 2);
      const lead = leadCells.map((c) => c.text).join(" ");
      let dateHit = lead ? readDate(lead) : null;
      // anything after the date but left of the description is a transaction-type code (Revolut: CAR, MOA, MOS, TRF)
      const typeCode = dateHit ? lead.slice(dateHit.len).trim() : "";
      let descStart = 0;
      if (!dateHit) {
        // some layouts merge the date into the description cell ("01 Jul 2026 Tesco")
        const first = line.cells[0];
        const d = first && first.x < header.descX + 4 ? readDate(first.text) : null;
        if (d) {
          dateHit = d;
          descStart = d.len;
        }
      }
      const date = dateHit ? iso(dateHit) : undefined;

      const descParts: string[] = [];
      const amounts: { v: number; right: number }[] = [];
      for (const c of line.cells) {
        if (c.x < header.descX - 2 && dateHit && !descStart) continue; // the date cell
        const a = c.x >= amountLeft - 30 ? readAmount(c.text, currency) : null;
        if (a !== null && c.right > amountLeft) amounts.push({ v: a, right: c.right });
        else if (c.x < amountLeft) descParts.push(c === line.cells[0] && descStart ? c.text.slice(descStart).trim() : c.text);
      }
      // strip payment references Revolut appends after a bullet ("Paypal Uk • 5G92…", "SHOPIFY INC •")
      const desc = descParts.filter(Boolean).join(" ").replace(/\s*•.*$/, "").trim();

      if (amounts.length) {
        const r: Row = { date: date ?? carryDate ?? "", payee: desc, details: "", type: typeCode && typeCode.length <= 12 ? typeCode : undefined, currency };
        placeAmounts(r, amounts);
        if (date) carryDate = date;
        // zero rows are summary tables (Revolut's "Card payments (CAR) £0.00" legend), not transactions
        if (!r.date || !(r.out || r.in) || BALANCE_ROW.test(desc) || !desc) {
          if (date) carryDate = date;
          continue;
        }
        rows.push(r);
        detailLines = 0;
      } else if (date) {
        carryDate = date; // a date on its own line (some banks print the day as a sub-heading)
      } else if (desc && rows.length && detailLines < 3 && /^fx rate\b/i.test(desc)) {
        // Revolut: "FX Rate GBP 1 = USD 1.3400", with what the shop charged in the amount column ("$1 340.00"), kept as
        // "USD 1340.00": the currency says where it was paid when nothing else does (18 Oct 2026)
        const ccy = /=\s*([A-Z]{3})\b/.exec(desc)?.[1];
        const amount = line.cells
          .filter((c) => c.x >= amountLeft - 30)
          .map((c) => c.text.replace(/[^\d.,]/g, "").replace(/,(?=\d{3}\b)/g, ""))
          .find((t) => /\d/.test(t));
        const last = rows[rows.length - 1]!;
        if (ccy && ccy !== currency && amount && !last.charged) last.charged = `${ccy} ${amount}`;
      } else if (desc && rows.length && detailLines < 3 && !DROP_DETAIL.test(desc)) {
        const last = rows[rows.length - 1]!;
        const clean = desc.replace(/^(to|from|paid to|received from):\s*/i, "").trim();
        if (!clean) continue;
        if (!last.details) last.details = clean;
        detailLines++;
      }
    }
  }

  if (!rows.length) warnings.push(scanned ? "This PDF looks like a scan (no text in it). Try the bank's CSV export instead." : "We couldn't find a transaction table in this PDF.");
  const head = "Date,Payee,Description,Paid out,Paid in,Balance,Currency,Type";
  const describe = (r: Row) => [r.details || r.payee, r.charged].filter(Boolean).join(" ");
  const csv = [head, ...rows.map((r) => [r.date, r.payee, describe(r), r.out, r.in, r.balance, r.currency, r.type ?? ""].map(csvCell).join(","))].join("\n");
  return {
    csv,
    mapping: { date: 0, payee: 1, description: 2, paidOut: 3, paidIn: 4, balance: 5, currency: 6, type: 7, dateOrder: "YMD" },
    rows: rows.length,
    // the currency most rows are in (a statement can have a section per currency)
    currency: [...rows.reduce((m, r) => m.set(r.currency, (m.get(r.currency) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? currency,
    bank: bankHit ? { id: bankHit.id, name: bankHit.name } : undefined,
    noTable: rows.length === 0,
    scanned,
    warnings,
  };
}

/** The bits of the pdf.js module we call (each app loads pdf.js from its own origin). */
export interface PdfJsLike {
  getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; disableFontFace?: boolean; useSystemFonts?: boolean; verbosity?: number }): { promise: Promise<PdfDocLike & { destroy?: () => Promise<void> }> };
}

/**
 * Read a PDF statement into the same result a CSV import gives. `parseWithMapping` is passed in
 * from @kys/statement so this stays a pure function of its inputs.
 */
export async function readPdfStatement<R extends { bank: unknown; warnings?: string[] }>(
  pdfjs: PdfJsLike,
  bytes: ArrayBuffer,
  parseWithMapping: (csv: string, mapping: ColumnMapping) => Promise<R>,
): Promise<{ result: R; pdf: PdfStatementResult }> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  try {
    const pdf = pdfToStatementCsv(await extractPdfPages(doc));
    const result = await parseWithMapping(pdf.csv, pdf.mapping);
    if (pdf.bank) result.bank = { id: pdf.bank.id, name: pdf.bank.name, confidence: "unconfirmed" } as R["bank"];
    result.warnings = [...(result.warnings ?? []), ...pdf.warnings];
    return { result, pdf };
  } finally {
    await doc.destroy?.();
  }
}
