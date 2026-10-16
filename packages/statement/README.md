# @kys/statement

Browser-only bank statement parser for KnowYourSpend. It turns a UK/EU bank export (CSV, OFX/QFX, QIF or Santander `.txt`) into typed transactions, classifies each row, and reduces merchant descriptors to a short normalised key. **It runs entirely on the user's device** (main thread or Web Worker). There are no Node APIs, no network calls and no Web Crypto dependency.

```ts
import { decodeFile, parseStatement, sendablePayees, mergeTransactions } from "@kys/statement";

const text = decodeFile(await file.arrayBuffer());        // UTF-8, falls back to Windows-1252
const result = await parseStatement(text, { filename: file.name });
if (result.needsMapping) {
  // show result.headers + result.previewRows in the generic mapper, pre-filled with
  // guessMapping(result.headers, result.previewRows), then:
  // await parseStatement(text, { mapping })
}
const { transactions, added, duplicates } = mergeTransactions(stored, result.transactions);
const toSend = sendablePayees(transactions, userExcluded); // the ONLY data that may leave the device
```

## Privacy boundary

A `LocalTransaction` holds the date, amount, balance, raw payee and raw descriptor. **None of these may leave the device.** Only `normPayee` may be sent, and only for rows the user approves. Several layers enforce this:

1. **The normaliser** (`normalisePayee`) removes locations, postcodes, dates, times, amounts, card numbers, references and bank boilerplate. For example, `CARD PAYMENT TO TESCO STORES 3456 LONDON GB ON 12 MAR` becomes `TESCO STORES`. It is deterministic and idempotent, and its output is capped at 40 characters. The backend mirror (`backend/services/normalise.py`) must produce identical output for every case in `test/fixtures/normalise-golden.json`.
2. **The classifier** (`classify`) marks payments to people as `transfer`. This covers Faster Payments, `TFR`/`FPO`, standing orders to names such as `J SMITH` or `D STEPHENS 18MAY19`, and Monzo-to-Monzo payments. When it is unsure, it chooses `transfer`, because a third party's name must never be sent.
3. **The parser** fills `normPayee` only for `spend` and `refund` rows. Every other kind gets `""`, so a mistake in the UI cannot send a person's name.
4. **Sensitive detection** (`isSensitive`) flags health, gambling, dating, politics, union, religion, payday/debt and adult merchants. The review step pre-unticks these rows, and `sendablePayees` excludes them.
5. **Dropped columns.** Account numbers, sort codes, holder names, addresses and preambles are never read into a transaction.

The normaliser strips locations and references, but it cannot hide the payee itself. A clinic is still a clinic. That is why the sensitive list and the per-row review step exist.

## Supported banks

The parser identifies each bank by its header row (the "fingerprint"). Date order is **tied to the detected bank** and never guessed row by row. A bank is marked `confirmed` only when the research notes cite a header row from an importer's source code or a primary source. **No format below has yet been tested against a file we exported ourselves.** In October 2026 they were run against about 85 published UK sample exports from open-source importers (not kept in this repo). Collect redacted samples of your own before relying on any of them.

| id | Bank | Confidence | Fingerprint / notes |
|---|---|---|---|
| `monzo` | Monzo | confirmed | `Transaction ID` + `Name` + `Amount`, plus `Emoji`, `Local amount` or `Category`; payee = `Name` (cleaned), raw = `Description` |
| `starling` | Starling | confirmed | `Counter Party` + `Amount (GBP)`; skips `Opening Balance` row; header from a 2019 business sample |
| `revolut` | Revolut | confirmed | `Started Date` + `Completed Date` + `State`; COMPLETED rows only; `Fee` → separate fee row |
| `wise` | Wise | confirmed | `TransferWise ID`; payee = `Merchant`, then payee/payer name; DD-MM-YYYY |
| `lloyds` | Lloyds / Halifax / Bank of Scotland | confirmed (Lloyds) | `Sort Code` + `Transaction Description` + `Debit Amount`; LBG type codes. That Halifax/BoS files are identical is unconfirmed |
| `barclays` | Barclays | confirmed | `Number,Date,Account,Amount,Subcategory,Memo`; re-joins unquoted commas, handles tab padding and whole-pound amounts |
| `nationwide` | Nationwide | confirmed | `Account Name:` preamble + `Paid out`/`Paid in`; `29-Dec-14` and `29 Dec 2024` dates (the latter unconfirmed); £ amounts, Windows-1252 |
| `nationwide-old` | Nationwide (older layout) | **unconfirmed** | `Account name:` preamble + `Transactions`/`Paid out`/`Paid in` |
| `natwest` | NatWest / RBS | confirmed | `Value` + `Account Name` + `Account Number` (column names are sourced, exact spelling is not) |
| `santander` | Santander (.txt) | confirmed | `From: … to …` + `Description:`/`Amount:` key:value blocks, Latin-1 with NBSPs. Santander CSV goes to the generic mapper |
| `n26` / `n26-legacy` | N26 | confirmed | New: `Booking Date` + `Partner Name`; old: `Payee` + `Amount (EUR)`; ISO dates |
| `amex` | American Express (UK) | **unconfirmed** | `Appears On Your Statement As` / `Extended Details`; sign inverted. The header comes from the US layout |
| `hsbc` | HSBC / First Direct | **unconfirmed** | Headerless 3 columns: date, details, amount. This matches *any* headerless file with that shape |
| `chase-uk` | Chase UK | **unconfirmed** | `Date,Time,Transaction Type,Description,Amount,Currency,Balance` (from two importers' samples), or any file whose name contains "chase"; columns come from `guessMapping` |
| `barclaycard` | Barclaycard | **unconfirmed** | `Transaction Date,Posting Date,Card Number,Description,Category,Amount` or `Card Holder Name,…,Merchant Name,Transaction Amount`; sign inverted, `CR`/`DR` marks respected |
| `mbna` | MBNA | **unconfirmed** | `Transaction Cleared Date` + `Transaction Description` + `Transaction Amount`; sign inverted |
| `tesco-bank` | Tesco Bank credit card | **unconfirmed** | `Billing Amount` + `Merchant`; £ amounts; sign inverted |
| `aqua` | Aqua | **unconfirmed** | `Date,Description,Note,Amount(GBP)`; raw = `Note`; sign inverted |
| `amex-short` | American Express (UK), short download | **unconfirmed** | Exactly `Date,Description,Amount` and a file name like `activity.csv` or containing "amex"; sign inverted |
| `curve` | Curve | **unconfirmed** | `Merchant` + `Txn Amount (Funding Card)`; ISO dates; sign inverted; Curve Cash (CPT) rows skipped |
| `ofx` | Any bank, OFX/QFX | confirmed | OFX 1.x SGML or 2.x XML `<STMTTRN>` blocks: `DTPOSTED`, `TRNAMT`, `NAME` + `MEMO`, `FITID`, `CURDEF` |
| `qif` | Any bank, QIF | confirmed | `!Type:Bank` / `CCard` / `Cash` records (`D`, `T`, `P`, `M`, `N`, ended by `^`); date order worked out over the whole file |

Before asking, the parser tries an unknown file by its column names alone. If the header names a date and a description, plus either paid out/paid in columns or one amount column where at least 60% of rows are negative, and the dates can only be read one way, it reads the file and adds a warning asking the user to check a few rows.

Any other file returns `needsMapping: true` with `headers` and up to 8 `previewRows`. The UI then asks the user for the date, description and amount columns (`ColumnMapping`). `guessMapping` pre-fills the form. It reads the date order from the data where the data settles it; if the data is ambiguous it assumes day-first and adds a warning. For card files, where charges are positive, the mapper has a sign switch (`invertSign`); `guessMapping` turns it on when at least 75% of the amounts are positive.

## Adding a bank

A bank is one mostly-declarative object in `src/banks/<id>.ts`. Add it to `BANKS` in `src/registry.ts`, where list order is detection priority: put distinctive fingerprints first. Then add a fixture and a row in `test/detect.test.ts`.

```ts
import { hasAll, type BankDefinition } from "./format";

export const examplebank: BankDefinition = {
  id: "examplebank",
  name: "Example Bank",
  confidence: "unconfirmed",            // "confirmed" only with a sourced header row
  source: "where the header came from",
  // headers: one candidate header row (raw cells); firstLines: first ~20 raw lines (for preambles)
  match: (headers, firstLines, ctx) => hasAll(headers, ["date", "narrative", "debit", "credit"]),
  columns: {
    date: "Date",                       // header name(s), case-insensitive; or a 0-based index
    description: "Narrative",           // raw descriptor (required)
    payee: ["Merchant", "Payee"],       // optional bank-cleaned name(s), tried in order
    paidOut: "Debit", paidIn: "Credit", // or `amount: "Amount"` for a signed column
    balance: "Balance",
    type: "Type",                       // optional: currency, category, sourceId, state, fee
  },
  dateOrder: "DMY",                     // tied to the bank, never guessed
  defaultCurrency: "GBP",
  // Optional: invertSign (card issuers), headerless + displayHeaders, acceptStates,
  // parseText(text) for non-CSV formats, transform(record, get) for per-row fix-ups.
};
```

The generic parser already handles the following for every bank: BOM, mojibake, delimiter sniffing (comma, semicolon, tab), preamble lines, repeated header rows, "Opening Balance" rows, unquoted commas in the description, tab padding, Excel `'` guards, and amounts written with £/€/GBP, thousands commas, decimal commas, parentheses, CR/DR or trailing minus.

## API

| Export | Purpose |
|---|---|
| `decodeFile(bytes: ArrayBuffer): string` | UTF-8 (strict), falling back to Windows-1252 |
| `parseStatement(text, { mapping?, filename? }): Promise<ParseResult>` | Detect the bank and parse, or return `needsMapping` |
| `parseWithMapping(text, mapping): Promise<ParseResult>` | Parse with a user `ColumnMapping` |
| `guessMapping(headers, rows): Partial<ColumnMapping>` | Pre-fill the generic mapper |
| `detectBank(text, filename?): BankFormat \| null` | Detection only |
| `normalisePayee(raw): string` | The privacy boundary (see above) |
| `classify(input): TransactionKind`, `UK_TYPE_CODES`, `looksLikePerson` | Row classification |
| `isSensitive(norm)`, `sensitiveCategory(norm)`, `SENSITIVE_KEYWORDS` | Sensitive-merchant detection |
| `transactionId(date, amount, rawPayee, balance?, occurrenceIndex)` | FNV-1a-64 dedupe key |
| `mergeTransactions(existing, incoming)` | Merge overlapping uploads: `{ transactions, added, duplicates }` |
| `sendablePayees(transactions, excluded?)` | Sorted, deduplicated list of strings that may be sent |
| `SUPPORTED_BANKS`, `BANKS`, `getBank` | Bank registry |

**Dedupe.** `id = hash(date, amount, rawPayee, balance ?? occurrenceIndex)`. `occurrenceIndex` counts identical (date, amount, payee) rows within one file, so two identical coffees on the same day stay two rows, and re-importing an overlapping export reproduces the same ids. One limit remains: an export that splits a day part-way through can still mis-merge that day.

## Development

```sh
pnpm --filter @kys/statement test       # vitest
pnpm --filter @kys/statement typecheck  # tsc --noEmit (strict)
```

All fixtures under `test/fixtures/` are synthetic. The tests use `node:fs` to read them; the library itself never does.

## Licence

MIT
