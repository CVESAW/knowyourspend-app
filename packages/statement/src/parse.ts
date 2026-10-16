/**
 * parse — statement file text → LocalTransaction[].
 *
 * Runs entirely on the device (browser main thread or Web Worker): no Node APIs, no network.
 * Everything in the file other than date, amount, currency, payee, type and balance (account
 * numbers, sort codes, holder names, addresses, preamble) is read past and dropped.
 */
import Papa from "papaparse";
import type { BankDefinition, ColumnRef, RawRecord } from "./banks/format";
import { toBankFormat } from "./banks/format";
import { classify } from "./classify";
import { OccurrenceCounter, transactionId } from "./dedupe";
import { normalisePayee } from "./normalise";
import { matchHeaderRow, matchTextFormat } from "./registry";
import { isSensitive } from "./sensitive";
import type { BankFormat, ColumnMapping, LocalTransaction, ParseResult } from "./types";
import { type DateOrder, guessDateOrder, headerKey, parseAmount, parseDate } from "./values";

export interface ParseOptions {
  /** User-supplied mapping from the generic mapper UI. Skips bank detection. */
  mapping?: ColumnMapping;
  /** Original file name; some unconfirmed formats (Chase UK) use it as a weak hint. */
  filename?: string;
}

/** How many leading rows to scan for a header row (Nationwide has a 4-line preamble). */
const HEADER_SCAN_ROWS = 20;
const PREVIEW_ROWS = 8;

// ---------------------------------------------------------------------------------------------
// Decoding & text preparation
// ---------------------------------------------------------------------------------------------

/**
 * Decode file bytes: strict UTF-8 first, then Windows-1252 (a superset of Latin-1 used by
 * Santander and Nationwide exports, where £ is 0xA3 and NBSP is 0xA0). A UTF-8 BOM is dropped.
 */
export function decodeFile(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Strip BOM, repair the commonest UTF-8-read-as-1252 mojibake, normalise newlines. */
function prepareText(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/Â(?=[£ ])/g, "")
    .replace(/â‚¬/g, "€")
    .replace(/\r\n?/g, "\n");
}

function leadingLines(text: string, n = 20): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim()) out.push(line);
    if (out.length >= n) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// CSV reading
// ---------------------------------------------------------------------------------------------

const DELIMITERS = [",", ";", "\t"] as const;

/**
 * Pick the delimiter that splits the first lines most consistently (most lines sharing the modal
 * field count, with that count > 1). Ties go to comma, then semicolon, then tab.
 */
export function sniffDelimiter(text: string): string {
  const sample = leadingLines(text, 30).join("\n");
  let best: { d: string; score: number } = { d: ",", score: -1 };
  for (const d of DELIMITERS) {
    const rows = Papa.parse<string[]>(sample, { delimiter: d, skipEmptyLines: true }).data;
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    let modal = 1;
    let modalCount = 0;
    for (const [len, c] of counts) {
      if (len > 1 && (c > modalCount || (c === modalCount && len > modal))) {
        modal = len;
        modalCount = c;
      }
    }
    const score = modal > 1 ? modalCount : 0;
    if (score > best.score) best = { d, score };
  }
  return best.d;
}

/**
 * Raw cells (untrimmed) — Barclays' unquoted commas must be re-joined before trimming, or the
 * space after the comma is lost. Use `cleanRow` for everything else.
 */
function readTable(text: string): string[][] {
  const delimiter = sniffDelimiter(text);
  const res = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false });
  return res.data.map((row) => (Array.isArray(row) ? row.map((c) => String(c ?? "")) : []));
}

function cleanRow(row: string[]): string[] {
  return row.map(cleanCell);
}

/** Trim spaces, tabs (Barclays padding) and NBSPs; drop Excel's leading apostrophe guard. */
function cleanCell(c: unknown): string {
  return String(c ?? "")
    .replace(/[ \t]/g, " ")
    .trim()
    .replace(/^'(?=\S)/, "");
}

function isBlankRow(row: string[] | undefined): boolean {
  return !row || row.every((c) => c === "");
}

// ---------------------------------------------------------------------------------------------
// Header location
// ---------------------------------------------------------------------------------------------

interface Located {
  bank: BankDefinition | null;
  /** Row index of the header; -1 for headerless files. */
  headerIdx: number;
  dataStart: number;
  headers: string[];
}

function locateBank(table: string[][], lines: string[], filename?: string): Located | null {
  const ctx = { filename };
  let firstNonBlank = -1;
  for (let i = 0; i < Math.min(HEADER_SCAN_ROWS, table.length); i++) {
    const row = table[i]!;
    if (isBlankRow(row)) continue;
    if (firstNonBlank < 0) firstNonBlank = i;
    const bank = matchHeaderRow(row, lines, ctx);
    if (!bank) continue;
    if (bank.headerless) {
      if (i !== firstNonBlank) continue; // a headerless format must start with data
      return { bank, headerIdx: -1, dataStart: i, headers: bank.displayHeaders ?? row.map((_, k) => `Column ${k + 1}`) };
    }
    return { bank, headerIdx: i, dataStart: i + 1, headers: row };
  }
  return null;
}

function looksLikeDataCell(c: string): boolean {
  return parseDate(c, "DMY") !== null || parseDate(c, "YMD") !== null || /^[-+(£€$]?\s?\d[\d,]*(\.\d+)?\)?$/.test(c);
}

/**
 * Generic header location for unknown formats: the first row (within the scan window) that has
 * the modal width of the file and no date/number cells. If the first modal-width row already
 * holds data, the file is treated as headerless and gets "Column N" headers.
 */
function locateGenericHeader(table: string[][]): Located {
  const window = table.slice(0, Math.max(HEADER_SCAN_ROWS * 3, 60));
  const widths = new Map<number, number>();
  for (const r of window) {
    const w = nonEmptyWidth(r);
    if (w >= 2) widths.set(w, (widths.get(w) ?? 0) + 1);
  }
  let modal = 0;
  let modalCount = 0;
  for (const [w, c] of widths) if (c > modalCount || (c === modalCount && w > modal)) [modal, modalCount] = [w, c];

  for (let i = 0; i < Math.min(HEADER_SCAN_ROWS, table.length); i++) {
    const row = table[i]!;
    if (nonEmptyWidth(row) < Math.max(2, modal - 1)) continue;
    if (row.some((c) => c && looksLikeDataCell(c))) {
      const width = Math.max(...table.slice(i, i + 20).map((r) => r.length));
      return { bank: null, headerIdx: -1, dataStart: i, headers: Array.from({ length: width }, (_, k) => `Column ${k + 1}`) };
    }
    return { bank: null, headerIdx: i, dataStart: i + 1, headers: row };
  }
  return { bank: null, headerIdx: -1, dataStart: 0, headers: [] };
}

function nonEmptyWidth(row: string[]): number {
  let last = row.length - 1;
  while (last >= 0 && row[last] === "") last--;
  return row.slice(0, last + 1).filter((c) => c !== "").length;
}

// ---------------------------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------------------------

/** Internal mapping: every role resolved to column indices (lists = per-row fallbacks). */
interface Resolved {
  date: number[];
  description: number[];
  payee: number[];
  amount?: number;
  paidOut?: number;
  paidIn?: number;
  balance?: number;
  currency?: number;
  type?: number;
  category?: number;
  sourceId?: number;
  state?: number;
  fee?: number;
  dateOrder: DateOrder;
}

function resolveRef(ref: ColumnRef | undefined, headers: string[], headerless: boolean): number[] {
  if (ref === undefined) return [];
  const refs = (Array.isArray(ref) ? ref : [ref]) as (string | number)[];
  const keys = headers.map(headerKey);
  const out: number[] = [];
  for (const r of refs) {
    const idx = typeof r === "number" ? (headerless || r < headers.length ? r : -1) : keys.indexOf(headerKey(r));
    if (idx >= 0 && !out.includes(idx)) out.push(idx);
  }
  return out;
}

function resolveBank(bank: BankDefinition, headers: string[], sample: string[][]): Resolved | null {
  if (bank.columns === "auto") {
    const guess = guessMapping(headers, sample);
    return fromColumnMapping({ ...guess, dateOrder: bank.dateOrder } as ColumnMapping, headers.length);
  }
  const c = bank.columns;
  const hl = !!bank.headerless;
  const one = (r: ColumnRef | undefined) => resolveRef(r, headers, hl)[0];
  const res: Resolved = {
    date: resolveRef(c.date, headers, hl),
    description: resolveRef(c.description, headers, hl),
    payee: resolveRef(c.payee, headers, hl),
    amount: one(c.amount),
    paidOut: one(c.paidOut),
    paidIn: one(c.paidIn),
    balance: one(c.balance),
    currency: one(c.currency),
    type: one(c.type),
    category: one(c.category),
    sourceId: one(c.sourceId),
    state: one(c.state),
    fee: one(c.fee),
    dateOrder: bank.dateOrder,
  };
  return isUsable(res) ? res : null;
}

function fromColumnMapping(m: Partial<ColumnMapping>, width: number): Resolved | null {
  const ok = (i: number | undefined) => (i !== undefined && i >= 0 && i < Math.max(width, 1) ? i : undefined);
  const date = ok(m.date);
  const description = ok(m.description);
  const payee = ok(m.payee);
  const res: Resolved = {
    date: date === undefined ? [] : [date],
    description: description === undefined ? [] : [description],
    payee: payee === undefined ? [] : [payee],
    amount: ok(m.amount),
    paidOut: ok(m.paidOut),
    paidIn: ok(m.paidIn),
    balance: ok(m.balance),
    currency: ok(m.currency),
    type: ok(m.type),
    dateOrder: m.dateOrder ?? "DMY",
  };
  return isUsable(res) ? res : null;
}

function isUsable(r: Resolved): boolean {
  return r.date.length > 0 && r.description.length > 0 && (r.amount !== undefined || r.paidOut !== undefined || r.paidIn !== undefined);
}

// ---------------------------------------------------------------------------------------------
// Mapping guesser (generic mapper UI pre-fill)
// ---------------------------------------------------------------------------------------------

/**
 * Best-effort column mapping for an unknown file, from header names first and cell contents
 * second. The UI shows it pre-filled; the user confirms. `dateOrder` is guessed from the data and
 * defaults to day-first (UK) when ambiguous — the UI should ask when it matters.
 */
export function guessMapping(headers: string[], rows: string[][]): Partial<ColumnMapping> {
  const keys = headers.map(headerKey);
  const used = new Set<number>();
  const find = (patterns: RegExp[]): number | undefined => {
    for (const re of patterns) {
      const i = keys.findIndex((k, idx) => !used.has(idx) && re.test(k));
      if (i >= 0) {
        used.add(i);
        return i;
      }
    }
    return undefined;
  };
  const m: Partial<ColumnMapping> = {};
  m.date = find([/^(transaction |booking |posting |completed |value )?date$/, /\bdate\b/, /^datum$/]);
  m.paidOut = find([/paid out|money out|^debits?\b|debit amount|withdrawals?|^out$/]);
  m.paidIn = find([/paid in|money in|^credits?\b|credit amount|deposits?|^in$/]);
  m.amount = find([/^amount$|^value$|^amount \(|^betrag/, /\bamount\b|\bvalue\b/]);
  m.balance = find([/balance|saldo/]);
  m.currency = find([/^currency$|^ccy$|currency$/]);
  m.type = find([/type|subcategory/]);
  m.payee = find([/^(merchant|payee|payee name|counter ?party|partner name|name)$/]);
  m.description = find([
    /^(description|details|transaction description|transaction details|memo|narrative|particulars)$/,
    /description|details|memo|narrative|reference|payee|merchant|name/,
  ]);

  // Content-based fallbacks (headerless files or unhelpful names).
  const width = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  const col = (i: number) => rows.map((r) => (r[i] ?? "").trim()).filter(Boolean);
  const share = (i: number, pred: (c: string) => boolean) => {
    const cells = col(i);
    return cells.length ? cells.filter(pred).length / cells.length : 0;
  };
  const isDate = (c: string) => parseDate(c, "DMY") !== null || parseDate(c, "MDY") !== null;
  const isNum = (c: string) => parseAmount(c) !== null && !isDate(c);
  if (m.date === undefined) {
    for (let i = 0; i < width; i++) if (!used.has(i) && share(i, isDate) >= 0.8) { m.date = i; used.add(i); break; }
  }
  if (m.amount === undefined && m.paidOut === undefined && m.paidIn === undefined) {
    for (let i = 0; i < width; i++) if (!used.has(i) && share(i, isNum) >= 0.8) { m.amount = i; used.add(i); break; }
  }
  if (m.description === undefined) {
    let bestI = -1;
    let bestLen = 0;
    for (let i = 0; i < width; i++) {
      if (used.has(i) || share(i, (c) => /[A-Za-z]/.test(c)) < 0.8) continue;
      const cells = col(i);
      const avg = cells.reduce((a, c) => a + c.length, 0) / (cells.length || 1);
      if (avg > bestLen) [bestI, bestLen] = [i, avg];
    }
    if (bestI >= 0) { m.description = bestI; used.add(bestI); }
  }
  if (m.description === undefined && m.payee !== undefined) [m.description, m.payee] = [m.payee, undefined];
  // Split columns win over a single amount only when both halves exist.
  if (m.paidOut !== undefined && m.paidIn !== undefined) delete m.amount;
  else if (m.amount !== undefined) {
    delete m.paidOut;
    delete m.paidIn;
  }
  if (m.date !== undefined) m.dateOrder = guessDateOrder(col(m.date)).order;
  for (const k of Object.keys(m) as (keyof ColumnMapping)[]) if (m[k] === undefined) delete m[k];
  return m;
}

// ---------------------------------------------------------------------------------------------
// Row → transaction
// ---------------------------------------------------------------------------------------------

const OPENING_BALANCE = /^(?:opening|closing|start(?:ing)?|end(?:ing)?) balance$|^balance (?:brought|carried) forward$|^(?:brought|carried) forward$/i;

function firstNonEmpty(cells: string[], cols: number[]): string {
  for (const i of cols) {
    const v = cells[i];
    if (v) return v;
  }
  return "";
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

interface BuildContext {
  table: string[][];
  dataStart: number;
  headers: string[];
  res: Resolved;
  bank: BankDefinition | null;
  defaultCurrency: string;
}

function buildTransactions(ctx: BuildContext): Pick<ParseResult, "transactions" | "skipped" | "warnings"> {
  const { table, dataStart, headers, res, bank } = ctx;
  const transactions: LocalTransaction[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const warnings: string[] = [];
  const counter = new OccurrenceCounter();
  const headerKeys = headers.map(headerKey);
  const width = headers.length;
  const overflowCol = res.description[0];
  let rejoined = 0;

  for (let r = dataStart; r < table.length; r++) {
    const rowNo = r + 1;
    let cells = [...(table[r] ?? [])];
    while (cells.length > width && cleanCell(cells[cells.length - 1]) === "") cells.pop();
    // Barclays: unquoted commas inside Memo → re-join the surplus (raw) fields into the description.
    if (width > 0 && cells.length > width && overflowCol !== undefined) {
      const extra = cells.length - width;
      const merged = cells.slice(overflowCol, overflowCol + extra + 1).join(",");
      cells = [...cells.slice(0, overflowCol), merged, ...cells.slice(overflowCol + extra + 1)];
      rejoined++;
    }
    cells = cleanRow(cells);
    if (isBlankRow(cells)) continue;
    if (width > 0 && cells.map(headerKey).join("|") === headerKeys.join("|")) {
      skipped.push({ row: rowNo, reason: "repeated header row" });
      continue;
    }
    if (cells.some((c) => OPENING_BALANCE.test(c))) {
      skipped.push({ row: rowNo, reason: "opening/closing balance row" });
      continue;
    }
    if (res.state !== undefined && bank?.acceptStates) {
      const st = (cells[res.state] ?? "").toUpperCase();
      if (st && !bank.acceptStates.includes(st)) {
        skipped.push({ row: rowNo, reason: `status ${st}` });
        continue;
      }
    }
    const date = parseDate(firstNonEmpty(cells, res.date), res.dateOrder);
    if (!date) {
      skipped.push({ row: rowNo, reason: nonEmptyWidth(cells) <= 1 ? "not a transaction row" : "unparseable date" });
      continue;
    }

    // Amount: single signed column, or unsigned paid-in / paid-out pair.
    let amount: number | null = null;
    let symbolCurrency: string | undefined;
    if (res.amount !== undefined) {
      const a = parseAmount(cells[res.amount] ?? "");
      if (a) [amount, symbolCurrency] = [a.value, a.currency];
    }
    if (amount === null && (res.paidOut !== undefined || res.paidIn !== undefined)) {
      const out = res.paidOut !== undefined ? parseAmount(cells[res.paidOut] ?? "") : null;
      const inn = res.paidIn !== undefined ? parseAmount(cells[res.paidIn] ?? "") : null;
      if (out || inn) {
        amount = Math.round((Math.abs(inn?.value ?? 0) - Math.abs(out?.value ?? 0)) * 100) / 100;
        symbolCurrency = out?.currency ?? inn?.currency;
      }
    }
    if (amount === null) {
      skipped.push({ row: rowNo, reason: "no amount" });
      continue;
    }
    if (bank?.invertSign) amount = amount === 0 ? 0 : -amount;

    const description = collapse(firstNonEmpty(cells, res.description));
    const payee = collapse(firstNonEmpty(cells, res.payee));
    const cur = res.currency !== undefined ? (cells[res.currency] ?? "").toUpperCase() : "";
    let rec: RawRecord = {
      date,
      description,
      payee,
      amount,
      currency: /^[A-Z]{3}$/.test(cur) ? cur : symbolCurrency,
      balance: res.balance !== undefined ? parseAmount(cells[res.balance] ?? "")?.value : undefined,
      typeLabel: res.type !== undefined ? cells[res.type] || undefined : undefined,
      category: res.category !== undefined ? cells[res.category] || undefined : undefined,
      sourceId: res.sourceId !== undefined ? cells[res.sourceId] || undefined : undefined,
    };
    if (bank?.transform) {
      const get = (h: string) => {
        const i = headerKeys.indexOf(headerKey(h));
        return i >= 0 ? (cells[i] ?? "") : "";
      };
      const out = bank.transform(rec, get);
      if (typeof out === "string") {
        skipped.push({ row: rowNo, reason: out });
        continue;
      }
      rec = out;
    }
    if (!rec.payee && !rec.description) {
      skipped.push({ row: rowNo, reason: "no description" });
      continue;
    }
    const currency = rec.currency ?? ctx.defaultCurrency;
    transactions.push(makeTransaction(rec, currency, counter));

    // Revolut-style separate fee column → its own "fee" row.
    if (res.fee !== undefined) {
      const fee = parseAmount(cells[res.fee] ?? "")?.value ?? 0;
      if (fee !== 0) {
        transactions.push(
          makeTransaction(
            { date, description: `${bank?.name ?? "Bank"} fee`, payee: `${bank?.name ?? "Bank"} fee`, amount: -Math.abs(fee), typeLabel: "FEE", kind: "fee" },
            currency,
            counter,
          ),
        );
      }
    }
  }
  if (rejoined > 0) warnings.push(`${rejoined} row(s) had unquoted commas in the description and were re-joined.`);
  return { transactions, skipped, warnings };
}

function makeTransaction(rec: RawRecord, currency: string, counter: OccurrenceCounter): LocalTransaction {
  const rawPayee = rec.payee || rec.description;
  const rawDescription = rec.description && rec.description !== rawPayee ? rec.description : undefined;
  const kind = rec.kind ?? classify({ amount: rec.amount, rawPayee, rawDescription, typeLabel: rec.typeLabel, category: rec.category });
  let norm = normalisePayee(rawPayee);
  if (!norm && rawDescription) norm = normalisePayee(rawDescription);
  const sensitive = isSensitive(norm) || (rawDescription !== undefined && isSensitive(normalisePayee(rawDescription)));
  const occurrence = counter.next(rec.date, rec.amount, rawPayee);
  const t: LocalTransaction = {
    id: transactionId(rec.date, rec.amount, rawPayee, rec.balance, occurrence),
    date: rec.date,
    amount: rec.amount,
    currency,
    rawPayee,
    // Privacy: only merchant rows carry a normalised payee. Transfers, income, cash, internal
    // moves and fees get "" so a person's name can never end up in a lookup request.
    normPayee: kind === "spend" || kind === "refund" ? norm : "",
    kind,
    sensitive,
  };
  if (rec.typeLabel) t.typeLabel = rec.typeLabel;
  if (rec.balance !== undefined) t.balance = rec.balance;
  if (rawDescription) t.rawDescription = rawDescription;
  if (rec.sourceId) t.sourceId = rec.sourceId;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------------------------

function finish(
  bank: BankFormat | null,
  built: Pick<ParseResult, "transactions" | "skipped" | "warnings">,
  headers: string[],
  previewRows: string[][],
  extraWarnings: string[] = [],
): ParseResult {
  const { transactions, skipped } = built;
  const dates = transactions.map((t) => t.date).sort();
  const warnings = [...extraWarnings, ...(built.warnings ?? [])];
  const result: ParseResult = {
    bank,
    transactions,
    skipped,
    dateRange: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    currencies: [...new Set(transactions.map((t) => t.currency))].sort(),
    needsMapping: false,
    headers,
    previewRows,
  };
  if (warnings.length) result.warnings = warnings;
  return result;
}

function needsMapping(loc: Located, table: string[][], warnings: string[] = []): ParseResult {
  const result: ParseResult = {
    bank: null,
    transactions: [],
    skipped: [],
    dateRange: null,
    currencies: [],
    needsMapping: true,
    headers: loc.headers,
    previewRows: preview(table, loc.dataStart),
  };
  if (warnings.length) result.warnings = warnings;
  return result;
}

function preview(table: string[][], start: number): string[][] {
  return table.slice(start).map(cleanRow).filter((r) => !isBlankRow(r)).slice(0, PREVIEW_ROWS);
}

/** Identify the bank without building transactions. */
export function detectBank(text: string, filename?: string): BankFormat | null {
  const prepared = prepareText(text);
  const lines = leadingLines(prepared);
  const textBank = matchTextFormat(lines, { filename });
  if (textBank) return toBankFormat(textBank);
  const loc = locateBank(readTable(prepared).map(cleanRow), lines, filename);
  return loc?.bank ? toBankFormat(loc.bank) : null;
}

/**
 * Parse a decoded statement file. Detects the bank by header fingerprint; if none matches (and no
 * `mapping` is given) returns `needsMapping: true` with headers and preview rows for the generic
 * mapper UI. Async so a future PDF path (pdf.js) fits the same signature.
 */
export async function parseStatement(text: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const prepared = prepareText(text);
  if (opts.mapping) return parseWithMapping(prepared, opts.mapping);
  const lines = leadingLines(prepared);

  // 1. Non-CSV text formats (Santander .txt).
  const textBank = matchTextFormat(lines, { filename: opts.filename });
  if (textBank?.parseText) {
    const { headers, rows } = textBank.parseText(prepared);
    const table = [headers, ...rows];
    const res = resolveBank(textBank, headers, rows.slice(0, 50));
    if (res) {
      const built = buildTransactions({ table, dataStart: 1, headers, res, bank: textBank, defaultCurrency: textBank.defaultCurrency });
      return finish(toBankFormat(textBank), built, headers, preview(table, 1));
    }
  }

  // 2. CSV with a known header fingerprint.
  const table = readTable(prepared);
  const loc = locateBank(table.map(cleanRow), lines, opts.filename);
  if (loc?.bank) {
    const sample = table.slice(loc.dataStart, loc.dataStart + 50).map(cleanRow);
    const res = resolveBank(loc.bank, loc.headers, sample);
    if (res) {
      const built = buildTransactions({
        table,
        dataStart: loc.dataStart,
        headers: loc.bank.headerless ? [] : loc.headers,
        res,
        bank: loc.bank,
        defaultCurrency: loc.bank.defaultCurrency,
      });
      return finish(toBankFormat(loc.bank), built, loc.headers, preview(table, loc.dataStart));
    }
  }

  // 3. Unknown: hand over to the generic mapper.
  return needsMapping(locateGenericHeader(table.map(cleanRow)), table);
}

/**
 * Parse with a user-supplied column mapping (generic mapper). Header location is the same one
 * used to produce `needsMapping` results, so indices line up with the headers the UI showed.
 * If `mapping.dateOrder` is missing it is guessed from the data (warning when ambiguous).
 */
export async function parseWithMapping(text: string, mapping: ColumnMapping): Promise<ParseResult> {
  const prepared = prepareText(text);
  const table = readTable(prepared);
  const clean = table.map(cleanRow);
  const loc = locateGenericHeader(clean);
  const warnings: string[] = [];
  let dateOrder = mapping.dateOrder;
  if (!dateOrder) {
    const samples = clean.slice(loc.dataStart).map((r) => r[mapping.date] ?? "").filter(Boolean);
    const g = guessDateOrder(samples);
    dateOrder = g.order;
    if (g.ambiguous) warnings.push("Date order is ambiguous in this file; assumed day-first (DD/MM/YYYY).");
  }
  const width = Math.max(loc.headers.length, ...table.slice(loc.dataStart, loc.dataStart + 20).map((r) => r.length));
  const res = fromColumnMapping({ ...mapping, dateOrder }, width);
  if (!res) {
    return needsMapping(loc, table, ["Mapping needs a date, a description and an amount (or paid in / paid out) column."]);
  }
  const headerless = loc.headerIdx < 0;
  const built = buildTransactions({
    table,
    dataStart: loc.dataStart,
    headers: headerless ? [] : loc.headers,
    res,
    bank: null,
    defaultCurrency: "GBP",
  });
  return finish(null, built, loc.headers, preview(table, loc.dataStart), warnings);
}
