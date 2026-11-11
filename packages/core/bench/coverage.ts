/**
 * Coverage benchmark: what share of spending gets a country, and is it the right one?
 *   npx tsx packages/core/bench/coverage.ts [descriptors.tsv] [--old <path-to-old-ownership-src-index.ts>]
 * Rows are hand-written descriptors (bench/descriptors.tsv). "named" = a named owner; "country" = any country
 * (named, or estimated from where it was paid); "right" = the country matches the expected one.
 */
import { readFileSync } from "node:fs";
import { normalisePayee } from "@kys/statement";
import { attribute, DEFAULT_CONTEXT, type Attribution } from "../src/attribute";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && a.endsWith(".tsv")) ?? new URL("./descriptors.tsv", import.meta.url).pathname;
const oldIdx = args.indexOf("--old");

interface Row { raw: string; amount: number; expected: string; kind: string }
const rows: Row[] = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => {
  const [raw, amount, expected, kind] = l.split("\t");
  return { raw: raw!, amount: Number(amount), expected: expected!, kind: kind! };
});

type Fn = (raw: string, norm: string) => Attribution;
let fn: Fn = (raw, norm) => attribute({ rawPayee: raw, normPayee: norm, kind: "spend", currency: "GBP" }, DEFAULT_CONTEXT);
let label = "new";
if (oldIdx >= 0) {
  const mod = await import(args[oldIdx + 1]!);
  const r = mod.createResolver(mod.allEntries);
  label = "old";
  fn = (raw, norm) => {
    let res = r.resolve(norm);
    if (res.status !== "RESOLVED" && !/^(SQ|SUMUP|ZETTLE_?|IZETTLE|IZ|PAYPAL|PP|GOOGLE|CRV|SP|TST)\s*\*/i.test(raw)) {
      const x = r.resolve(raw);
      if (x.status === "RESOLVED") res = x;
    }
    return res.entry ? { entry: res.entry, country: res.entry.owner_country, basis: "owner" } : {};
  };
}

const kinds = [...new Set(rows.map((r) => r.kind)), "ALL"];
const stats = new Map<string, { n: number; spend: number; named: number; namedSpend: number; country: number; countrySpend: number; right: number; rightSpend: number }>();
const misses: string[] = [];
for (const r of rows) {
  const a = fn(r.raw, normalisePayee(r.raw));
  for (const k of [r.kind, "ALL"]) {
    const s = stats.get(k) ?? { n: 0, spend: 0, named: 0, namedSpend: 0, country: 0, countrySpend: 0, right: 0, rightSpend: 0 };
    s.n++; s.spend += r.amount;
    if (a.basis === "owner") { s.named++; s.namedSpend += r.amount; }
    if (a.country) { s.country++; s.countrySpend += r.amount; }
    if (a.country === r.expected) { s.right++; s.rightSpend += r.amount; }
    stats.set(k, s);
  }
  if (a.country !== r.expected) misses.push(`  ${r.raw.padEnd(44)} expected ${r.expected}, got ${a.country ?? "-"} ${a.basis ? `(${a.basis}${a.entry ? `: ${a.entry.display_name}` : a.evidence ? `: ${a.evidence}` : ""})` : ""}`);
}
const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(0)}%`.padStart(5);
console.log(`[${label}] ${rows.length} descriptors`);
console.log("kind      rows  named-owner  any-country  right-country   (share of spend)");
for (const k of kinds) {
  const s = stats.get(k)!;
  console.log(`${k.padEnd(8)} ${String(s.n).padStart(5)}  ${pct(s.namedSpend, s.spend)}        ${pct(s.countrySpend, s.spend)}        ${pct(s.rightSpend, s.spend)}`);
}
if (args.includes("--misses")) console.log(`\nWrong or missing (${misses.length}):\n${misses.join("\n")}`);
