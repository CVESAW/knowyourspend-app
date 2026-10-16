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
  if (/^(description|details|transaction details|transaction|payment type and details|merchant|narrative|particulars)$/.test(s)) return "desc";
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
}

const NOISE = /(^page \d+( of \d+)?$|registered in england|financial conduct authority|prudential regulation|financial services compensation|fscs|generated on|continued (on|over)|brought forward|carried forward|^total\b|report lost or stolen|get help directly in app|scan the qr code)/i;
const SKIP_SECTION = /\b(pending|reverted|declined|failed)\b/i;
const OPEN_SECTION = /\b(account transactions|transactions from|your transactions|statement of account|transactions)\b/i;
const DROP_DETAIL = /^(card:|card number|reference:|ref:|payment reference|exchange rate|fx rate|fee:|revolut rate|ecb rate|•)/i;
const BALANCE_ROW = /^(opening|closing|start|end|brought|carried) balance|^balance (brought|carried) forward/i;

const BANKS: [RegExp, string, string][] = [
  [/\brevolut\b/i, "revolut", "Revolut"],
  [/\bmonzo\b/i, "monzo", "Monzo"],
  [/\bstarling\b/i, "starling", "Starling"],
  [/\bbarclays\b/i, "barclays", "Barclays"],
  [/\bhsbc\b/i, "hsbc", "HSBC"],
  [/\bfirst direct\b/i, "hsbc", "First Direct"],
  [/\blloyds\b/i, "lloyds", "Lloyds"],
  [/\bhalifax\b/i, "lloyds", "Halifax"],
  [/\bnatwest\b/i, "natwest", "NatWest"],
  [/\broyal bank of scotland\b/i, "natwest", "RBS"],
  [/\bsantander\b/i, "santander", "Santander"],
  [/\bnationwide\b/i, "nationwide", "Nationwide"],
  [/\bchase\b/i, "chase", "Chase UK"],
  [/\bwise\b/i, "wise", "Wise"],
  [/\bamerican express\b|\bamex\b/i, "amex", "American Express"],
  [/\btsb\b/i, "tsb", "TSB"],
  [/\bmetro bank\b/i, "metro", "Metro Bank"],
  [/\bvirgin money\b/i, "virgin", "Virgin Money"],
  [/\bco-operative bank\b/i, "coop", "Co-operative Bank"],
  [/\bn26\b/i, "n26", "N26"],
];

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
  const bankHit = BANKS.find(([re]) => re.test(firstPageText));
  const currency = /\bEUR\b|€/.test(firstPageText.slice(0, 400)) && !/\bGBP\b|£/.test(firstPageText.slice(0, 400)) ? "EUR" : "GBP";
  const period = periodEnd(allText);

  const rows: Row[] = [];
  let header: Header | null = null;
  let skipping = false;
  let carryDate: string | undefined;
  let detailLines = 0;

  const iso = (d: DateHit): string | undefined => {
    if (!validDate(d)) return undefined;
    let y = d.year;
    if (y === undefined) y = d.month > period.month ? period.year - 1 : period.year;
    return `${y}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  };

  for (const lines of allLines) {
    for (const line of lines) {
      const h = readHeader(line);
      if (h) {
        header = h;
        detailLines = 0;
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
      if (NOISE.test(line.text)) continue;

      const amountLeft = Math.min(...header.cols.map((c) => c.x)) - 4;
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
        const r: Row = { date: date ?? carryDate ?? "", payee: desc, details: "", type: typeCode && typeCode.length <= 12 ? typeCode : undefined };
        for (const a of amounts) {
          let best = header.cols[0]!;
          for (const col of header.cols) if (Math.abs(col.right - a.right) < Math.abs(best.right - a.right)) best = col;
          if (Math.abs(best.right - a.right) > 90) continue;
          if (best.kind === "out") r.out = Math.abs(a.v);
          else if (best.kind === "in") r.in = Math.abs(a.v);
          else if (best.kind === "balance") r.balance = a.v;
          else if (a.v < 0) r.out = -a.v;
          else r.in = a.v;
        }
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
  const csv = [head, ...rows.map((r) => [r.date, r.payee, r.details || r.payee, r.out, r.in, r.balance, currency, r.type ?? ""].map(csvCell).join(","))].join("\n");
  return {
    csv,
    mapping: { date: 0, payee: 1, description: 2, paidOut: 3, paidIn: 4, balance: 5, currency: 6, type: 7, dateOrder: "YMD" },
    rows: rows.length,
    currency,
    bank: bankHit ? { id: bankHit[1], name: bankHit[2] } : undefined,
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
