/**
 * Cell-level parsers for dates and amounts. Pure functions, no Node APIs.
 */

export type DateOrder = "DMY" | "MDY" | "YMD";

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10,
  NOVEMBER: 11, DECEMBER: 12,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function expandYear(y: string): number {
  const n = Number(y);
  if (y.length === 4) return n;
  // Two-digit years: 00–69 → 2000s, 70–99 → 1900s.
  return n < 70 ? 2000 + n : 1900 + n;
}

function toIso(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Parse a statement date into ISO yyyy-mm-dd.
 *
 * Accepts `29/12/2024`, `29-12-2024`, `29.12.24`, `29-Dec-14`, `29 Dec 2024`, `2024-12-29`,
 * `2024-12-29 10:15:00`, `2024-12-29T10:15:00Z`. Month-name and 4-digit-year-first forms are
 * unambiguous; purely numeric forms use `order`, which the caller binds to the detected bank
 * (never inferred per row).
 */
export function parseDate(input: string, order: DateOrder = "DMY"): string | null {
  let s = input.trim().replace(/^["']|["']$/g, "").trim();
  if (!s) return null;
  // Drop a trailing time component.
  s = s.replace(/[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|AM|PM)?$/i, "").trim();

  // D Mon YY(YY) with -, /, space or . separators: 29-Dec-14, 29 Dec 2024, 1 January 2025
  let m = /^(\d{1,2})[-/ .]+([A-Za-z]{3,9})\.?[-/ .,]+(\d{4}|\d{2})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.toUpperCase()];
    return mon ? toIso(expandYear(m[3]!), mon, Number(m[1])) : null;
  }
  // Mon D, YYYY (rare, US-style exports)
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toUpperCase()];
    return mon ? toIso(Number(m[3]), mon, Number(m[2])) : null;
  }
  // Numeric forms
  m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(s);
  if (m) {
    const [a, b, c] = [m[1]!, m[2]!, m[3]!];
    if (a.length === 4) return toIso(Number(a), Number(b), Number(c)); // always Y-M-D
    if (order === "YMD") return null; // a 2-digit first part cannot be a YMD year here
    if (order === "DMY") return toIso(expandYear(c), Number(b), Number(a));
    return toIso(expandYear(c), Number(a), Number(b));
  }
  // Compact yyyymmdd
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return toIso(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

/**
 * Guess the numeric date order from a sample of cells. Used ONLY by the generic mapper when the
 * user has not said; bank formats bind their order explicitly.
 */
export function guessDateOrder(samples: string[]): { order: DateOrder; ambiguous: boolean } {
  let dmy = false;
  let mdy = false;
  let ymd = false;
  for (const raw of samples) {
    const m = /^\s*(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/.exec(raw);
    if (!m) continue;
    if (m[1]!.length === 4) {
      ymd = true;
      continue;
    }
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy = true;
    if (b > 12 && a <= 12) mdy = true;
  }
  if (ymd) return { order: "YMD", ambiguous: false };
  if (dmy && !mdy) return { order: "DMY", ambiguous: false };
  if (mdy && !dmy) return { order: "MDY", ambiguous: false };
  // Nothing decisive (or contradictory): UK default.
  const anyNumeric = samples.some((x) => /^\s*\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(x));
  return { order: "DMY", ambiguous: anyNumeric };
}

export interface ParsedAmount {
  value: number;
  /** ISO code when the cell carried a currency symbol or code. */
  currency?: string;
  /** The cell said which way the money went (`12.50 CR` / `12.50 DR`), so its sign is final. */
  marked?: "CR" | "DR";
}

const SYMBOLS: Record<string, string> = { "£": "GBP", "€": "EUR", $: "USD" };

/**
 * Parse a money cell. Handles `£1,234.56`, `-12.50`, `12.50-`, `(12.50)`, `12.50 CR`, `12.50DR`,
 * `-4.40 GBP`, `GBP 4.40`, `€1.234,56`, `-110000` (Barclays whole pounds), and mojibake such as
 * `Â£12.00` or a U+FFFD where a Latin-1 £ was decoded as UTF-8. Returns null for empty/non-numeric.
 */
export function parseAmount(input: string): ParsedAmount | null {
  let s = input.trim().replace(/^["']|["']$/g, "").replace(/[  \s]/g, "");
  if (!s) return null;
  let currency: string | undefined;
  let negative = false;
  let marked: "CR" | "DR" | undefined;

  const code = /(GBP|EUR|USD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|AUD|CAD|NZD|JPY)/i.exec(s);
  if (code) {
    currency = code[1]!.toUpperCase();
    s = s.replace(code[0], "");
  }
  for (const [sym, iso] of Object.entries(SYMBOLS)) {
    if (s.includes(sym)) {
      currency = currency ?? iso;
      s = s.split(sym).join("");
    }
  }
  // Credit/debit suffix or prefix.
  const crdr = /^(CR|DR)|(CR|DR)$/i.exec(s);
  if (crdr) {
    marked = (crdr[1] ?? crdr[2])!.toUpperCase() as "CR" | "DR";
    if (marked === "DR") negative = true;
    s = s.replace(/^(CR|DR)|(CR|DR)$/i, "");
  }
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  // Remove any other stray symbols (Â, U+FFFD, etc.) but keep digits, separators and signs.
  s = s.replace(/[^\d.,+-]/g, "");
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.endsWith("+")) {
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/\d/.test(s) || /[+-]/.test(s)) return null;

  // Decimal separator: if both present, the last one is the decimal point.
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    // Only commas: "12,50" is a decimal comma; "1,234" / "1,234,567" are thousands separators.
    const commas = s.split(",").length - 1;
    if (commas === 1 && /,\d{1,2}$/.test(s)) s = s.replace(",", ".");
    else s = s.replace(/,/g, "");
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // Round to cents to kill float noise (e.g. 0.1 + 0.2).
  const value = Math.round((negative ? -n : n) * 100) / 100;
  return { value: Object.is(value, -0) ? 0 : value, currency, ...(marked ? { marked } : {}) };
}

/** Normalise a header cell for comparison: lowercase, trimmed, BOM/quotes/NBSP removed. */
export function headerKey(h: string): string {
  return h
    .replace(/^﻿/, "")
    .replace(/[ \t]/g, " ")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}
