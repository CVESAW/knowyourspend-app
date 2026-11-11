/**
 * Coverage on REAL statements, run locally: share of spending that gets a country, and the payees to
 * hand-check. Nothing is sent anywhere and nothing is written inside the repo.
 *   npx tsx packages/core/bench/real-statements.ts <folder-with-statements> [--out <file.tsv>]
 * Reads every .csv/.txt/.tsv/.pdf in the folder. Prints totals only (no amounts per payee) unless --out
 * is given, which writes a TSV of payees by spend for checking: payee, spend, country, basis, owner.
 * Keep the folder and the TSV out of git (_private-test-data/ is ignored).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseStatement, parseWithMapping, type LocalTransaction } from "@kys/statement";
import { readPdfStatement, type PdfJsLike } from "../src/pdf-statement";
import { decodeStatementBytes } from "../src/decode";
import { attribute, DEFAULT_CONTEXT } from "../src/attribute";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) { console.error("Usage: real-statements.ts <folder> [--out payees.tsv]"); process.exit(1); }
const outIdx = args.indexOf("--out");
const pdfjs = { getDocument: (src) => getDocument({ ...src, useSystemFonts: true }) } as PdfJsLike;

const txns: LocalTransaction[] = [];
for (const f of readdirSync(dir).sort()) {
  const ext = extname(f).toLowerCase();
  if (![".csv", ".txt", ".tsv", ".pdf"].includes(ext)) continue;
  const buf = readFileSync(join(dir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try {
    const result = ext === ".pdf" ? (await readPdfStatement(pdfjs, ab, parseWithMapping)).result : await parseStatement(decodeStatementBytes(ab), { filename: f });
    const spend = result.transactions.filter((t) => t.kind === "spend");
    console.log(`✓ ${f}: ${result.bank?.name ?? "unknown bank"}, ${result.transactions.length} rows, ${spend.length} payments`);
    txns.push(...result.transactions);
  } catch (e) {
    console.log(`✗ ${f}: ${(e as Error).message}`);
  }
}

const spend = txns.filter((t) => t.kind === "spend" && t.amount < 0);
const total = spend.reduce((s, t) => s - t.amount, 0);
const byPayee = new Map<string, { spend: number; n: number; country?: string; basis?: string; owner?: string; tier?: string }>();
let named = 0, estimated = 0, none = 0;
for (const t of spend) {
  const a = attribute(t, DEFAULT_CONTEXT);
  const amt = -t.amount;
  if (a.basis === "owner") named += amt; else if (a.basis === "estimated") estimated += amt; else none += amt;
  const p = byPayee.get(t.normPayee) ?? { spend: 0, n: 0, country: a.country, basis: a.basis, owner: a.entry ? `${a.entry.display_name} → ${a.entry.chain.at(-1)?.name ?? ""}` : undefined, tier: a.entry?.tier };
  p.spend += amt; p.n++;
  byPayee.set(t.normPayee, p);
}
const pct = (x: number) => `${((100 * x) / Math.max(total, 0.01)).toFixed(1)}%`;
console.log(`\n${spend.length} payments to ${byPayee.size} payees`);
console.log(`Named owner:            ${pct(named)}`);
console.log(`Estimated from place:   ${pct(estimated)}`);
console.log(`Has a country (total):  ${pct(named + estimated)}`);
console.log(`No country:             ${pct(none)}`);
const top = [...byPayee.entries()].sort((a, b) => b[1].spend - a[1].spend);
const top50 = top.slice(0, 50).reduce((s, [, p]) => s + p.spend, 0);
console.log(`Top 50 payees cover ${pct(top50)} of spending.`);
if (outIdx >= 0) {
  const lines = ["payee\tpayments\tspend\tcountry\tbasis\ttier\towner\tcorrect_country", ...top.map(([k, p]) => [k, p.n, p.spend.toFixed(2), p.country ?? "", p.basis ?? "", p.tier ?? "", p.owner ?? "", ""].join("\t"))];
  writeFileSync(args[outIdx + 1]!, lines.join("\n") + "\n");
  console.log(`Wrote ${top.length} payees to ${args[outIdx + 1]}`);
}
