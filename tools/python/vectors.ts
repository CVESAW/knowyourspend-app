/**
 * Parity vectors for kys.py: runs the real TypeScript engine over a corpus and writes tools/python/vectors.json, which
 * tools/python/test_kys.py checks the Python port against, case by case.
 *
 *   pnpm --filter @kys/ownership exec tsx ../../tools/python/vectors.ts            write vectors.json
 *   pnpm --filter @kys/ownership exec tsx ../../tools/python/vectors.ts --check    fail if vectors.json is stale
 *   ... vectors.ts --out /tmp/vectors.json                                       write somewhere else
 *
 * The corpus: the coverage bench's descriptors, the normaliser's golden cases, every row of the statement fixtures
 * (CSV and PDF, read by the app's own parsers), the strings in the engine's unit tests, a sample of the ownership
 * list's own names (as written, run together and one letter off), seeded random combinations of bank fragments, and
 * hand-picked tricky cases. Each payee is matched for the UK and, where the text names another country (or for a
 * rotating sample), for that country too.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  classify, decodeFile, guessMapping, isSensitive, looksLikePerson, mayBePerson, normalisePayee, parseAmount, parseStatement,
  parseWithMapping, sensitiveCategory, typeHint, UK_TYPE_CODES, type ClassifyInput, type ColumnMapping, type LocalTransaction,
} from "../../packages/statement/src/index";
import { allEntries, createResolver, domainsIn, openBrands, type OwnershipEntry, type Resolution } from "../../packages/ownership/src/index";
import { cardReader, matchLocal } from "../../packages/core/src/attribute";
import { explain } from "../../packages/core/src/explain";
import { locate } from "../../packages/core/src/locate";
import type { LookupAnswer } from "../../packages/core/src/lookup-plan";
import { readPdfStatement, type PdfJsLike } from "../../packages/core/src/pdf-statement";
import { lookUpLocally, lookupUnavailable, readQuery, withAnswer, type QuickResult } from "../../packages/core/src/quick-lookup";

// This file runs as CommonJS under tsx (nothing above tools/ says "type": "module"), so no top-level await or import.meta.
const here = dirname(resolve(process.argv[1]!));
const repo = resolve(here, "..", "..");
const args = process.argv.slice(2);
const outArg = args.indexOf("--out");
const OUT = outArg >= 0 ? resolve(args[outArg + 1]!) : join(here, "vectors.json");
const ts = createRequire(join(repo, "packages", "ownership", "package.json"))("typescript") as typeof import("typescript");
const resolver = createResolver(allEntries);

async function main(): Promise<void> {
  // ── The corpus ───────────────────────────────────────────────────────────────────────────────────────────────────
  const payees: [string, string?][] = []; // [text, extra country]
  const shapes = new Set<string>();
  const rows: ClassifyInput[] = [];
  const amounts: string[] = [];
  const typeLabels: string[] = [];
  // Texts that differ only in their digits ("... On 03 Jul", "... On 04 Jul") are one case; hand-picked ones are kept as they are.
  const add = (s: string | undefined, country?: string, exact = false) => {
    if (typeof s !== "string") return;
    const shape = `${country ?? ""}\u0000${exact ? s : s.replace(/[0-9]/g, "#")}`;
    if (!exact && shapes.has(shape)) return;
    shapes.add(shape);
    payees.push([s, country]);
  };
  const read = (p: string) => readFileSync(join(repo, p), "utf8");

  // 1. The coverage bench's descriptors
  for (const line of read("packages/core/bench/descriptors.tsv").split("\n")) {
    if (line.trim() && !line.startsWith("#")) add(line.split("\t")[0]);
  }
  // 2. The normaliser's golden cases
  for (const c of JSON.parse(read("packages/statement/test/fixtures/normalise-golden.json")) as { raw: string }[]) add(c.raw);

  // 3. Every row of the statement fixtures, read by the app's parsers
  const fromTxn = (t: LocalTransaction) => {
    rows.push({ amount: t.amount, rawPayee: t.rawPayee, ...(t.rawDescription !== undefined ? { rawDescription: t.rawDescription } : {}), ...(t.typeLabel !== undefined ? { typeLabel: t.typeLabel } : {}) });
    add(t.rawPayee);
    if (t.rawDescription) add(t.rawDescription);
    if (t.typeLabel) typeLabels.push(t.typeLabel);
  };
  const fixtures = join(repo, "packages/statement/test/fixtures");
  for (const name of readdirSync(fixtures).filter((f) => /\.(csv|txt|tsv)$/.test(f)).sort()) {
    const buf = readFileSync(join(fixtures, name));
    const text = decodeFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    let res = await parseStatement(text, { filename: name });
    if (res.needsMapping) res = await parseWithMapping(text, { dateOrder: "DMY", ...guessMapping(res.headers, res.previewRows) } as ColumnMapping);
    res.transactions.forEach(fromTxn);
  }
  const pdfjsPath = createRequire(join(repo, "packages", "core", "package.json")).resolve("pdfjs-dist/legacy/build/pdf.mjs");
  const { getDocument } = (await import(pathToFileURL(pdfjsPath).href)) as { getDocument: (src: unknown) => unknown };
  const pdfjs = { getDocument: (src: object) => getDocument({ ...src, useSystemFonts: true, verbosity: 0 }) } as unknown as PdfJsLike;
  const pdfDir = join(repo, "packages/core/test/fixtures");
  for (const name of readdirSync(pdfDir).filter((f) => f.endsWith(".pdf")).sort()) {
    const buf = readFileSync(join(pdfDir, name));
    const { result } = await readPdfStatement(pdfjs, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, parseWithMapping);
    result.transactions.forEach(fromTxn);
  }

  // 4. The strings in the engine's unit tests (not test titles), and the rows and amounts their calls are made with
  const TEST_FILES = [
    "packages/statement/test/normalise.test.ts", "packages/statement/test/classify.test.ts", "packages/statement/test/sensitive.test.ts",
    "packages/statement/test/values.test.ts", "packages/ownership/test/resolve.test.ts", "packages/ownership/test/resolve-v2.test.ts",
    "packages/core/test/quick-lookup.test.ts", "packages/core/test/explain.test.ts", "packages/core/test/locate.test.ts",
    "packages/core/test/prepare.test.ts", "packages/core/test/lookup-plan.test.ts",
  ];
  const TITLES = new Set(["describe", "it", "test", "each"]);
  const sentence = (s: string) => (s.match(/\b[a-z]{3,}\b/g) ?? []).length >= 3;
  for (const f of TEST_FILES) {
    if (!existsSync(join(repo, f))) continue;
    const sf = ts.createSourceFile(f, read(f), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const str = (n: ts.Node | undefined) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);
    const num = (n: ts.Node | undefined) =>
      n && ts.isNumericLiteral(n) ? Number(n.text) : n && ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand) ? -Number(n.operand.text) : undefined;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        const [a0, a1, a2, a3] = n.arguments;
        if (f.endsWith("classify.test.ts") && name === "c" && num(a0) !== undefined && str(a1) !== undefined) {
          rows.push({ amount: num(a0)!, rawPayee: str(a1)!, ...(str(a2) !== undefined ? { typeLabel: str(a2) } : {}), ...(str(a3) !== undefined ? { rawDescription: str(a3) } : {}) });
        }
        if (f.endsWith("classify.test.ts") && name === "p" && str(a0) !== undefined) {
          rows.push({ amount: -20, rawPayee: str(a0)!, ...(str(a1) !== undefined ? { typeLabel: str(a1) } : {}), ...(str(a2) !== undefined ? { rawDescription: str(a2) } : {}) });
        }
        if (name === "typeHint" && str(a0) !== undefined) typeLabels.push(str(a0)!);
        if (name === "parseAmount" && str(a0) !== undefined) amounts.push(str(a0)!);
        if (TITLES.has(name) && n.arguments.length) {
          n.arguments.slice(1).forEach(visit); // skip the title
          visit(n.expression);
          return;
        }
      }
      const s = str(n);
      if (s !== undefined && s.length >= 2 && s.length <= 140 && /[A-Z]/.test(s) && !sentence(s) && !/^\.{0,2}\/|^@kys\//.test(s)) {
        if (f.endsWith("values.test.ts")) amounts.push(s);
        else add(s);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // 5. Hand-picked cases: payment services, card readers, run-together and near names, venues, web addresses, brands that
  // only trade abroad, people, sensitive names, independents, bank wording, and Unicode and whitespace oddities.
  const NBSP = "\xa0";
  const cp = (...c: number[]) => String.fromCodePoint(...c);
  const TRICKY: [string, string?][] = [
    ["PAYPAL *NETFLIX"], ["PAYPAL *EBAY"], ["PAYPAL *STEAMGAMES"], ["PP*SPOTIFY"], ["PAYPAL *JOHNSMITH 35314369001 GBR"], ["PP*SARAHJONES"],
    ["PAYPAL *J SMITH"], ["PAYPAL *MR J A SMITH"], ["PAYPAL *J.SMITH"], ["PAYPAL *LEON SMITH"], ["PAYPAL *EXAMPLESHOP.CO.UK"],
    ["PAYPAL *ROSES FLORIST"], ["PAYPAL *"], ["PAYPAL"], ["CARD PAYMENT TO PAYPAL *NETFLIX ON 12 MAR"], ["PAYPAL *SHOP24"],
    ["VIS KLARNA*ZARA"], ["VIS KLARNA*ASOS"], ["KLARNA*ASOS.COM"], ["KLARNA *ZZQSHOP"], ["CLEARPAY*ASOS"], ["CLEARPAY UK"], ["KLARNA"],
    ["BT *THE EXAMPLE SHOP"], ["BT *MOBILE"], ["BT GROUP PLC"], ["GOOGLE *YOUTUBE"], ["GOOGLE *GOOGLE STORAGE"], ["GOOGLE *"],
    ["CRV*TESCO STORES"], ["SP * EXAMPLE STORE"], ["TST* THE PIZZA PLACE"], ["PP *ZZQ WIDGETS LTD"],
    ["SQ *THE BEAN HOUSE"], ["SQ *JOES CAFE"], ["SQ *COSTA COFFEE"], ["SUMUP *MARKET STALL"], ["SUMUP  *JOHN SMITH"], ["ZETTLE_*THE LITTLE BAKERY"],
    ["IZ *FARMERS MARKET"], ["IZETTLE *SOMEONE"], ["CARD PAYMENT TO SQ *THE OLD BAKEHOUSE"], ["SUM UP *TAXI 1234"], ["SQ*"], ["SQ *"],
    ["AMZN MKTP"], ["AMZN MKTP UK*2A3B45CD6"], ["AMZNMKTPLACE"], ["AMAZON.CO.UK*1A2B3C"], ["WWW.AMAZON.CO.UK"], ["AMAZON EU SARL"],
    ["AMZN Digital*AB12C"], ["PRIME VIDEO*AB12"], ["AMAZON PRIME*2B3C4D5E6"], ["AMZ*MUSIC"], ["Amazon.co.uk*RT5YU78K9 AMAZON.CO.UK LUX"],
    ["JDSPORTS"], ["TOBYCARVERY LEEDS"], ["PAY PAL"], ["SAINSBURRYS"], ["WAITROSSE 812"], ["XAITROSE"], ["MCDONALDSS"], ["PRIMARKK"],
    ["GREGGSS"], ["HOBBYCRAFTT"], ["SCREWFIXDIRECT"], ["MARKSANDSPENCER"], ["BURGERKING 22781"], ["FIVEGUYS LONDON"],
    ["RESTAURANTE ICELAND", "ES"], ["RESTAURANTE FOSTERS HOLLYWOOD", "ES"], ["PIZZERIA TELEPIZZA", "ES"], ["TRATTORIA DA TESCO"],
    ["RESTAURANT MCDONALDS"], ["RESTAURANTE LA ROMANA", "ES"], ["BRASSERIE BLANC"], ["TABERNA DEL ALABARDERO", "ES"], ["HOTEL IBIS LONDON"],
    ["CAFE NERO"], ["OSTERIA DEL CAMBIO", "IT"], ["RISTORANTE MCDONALDS", "IT"], ["CERVECERIA 100 MONTADITOS", "ES"],
    ["APPLE.COM/BILL"], ["NETFLIX.COM"], ["HELP.UBER.COM"], ["UBER *TRIP HELP.UBER.COM"], ["WWW.ZALANDO.CO.UK"], ["ZALANDO . CO . UK"],
    ["TFL TRAVEL CH TFL.GOV.UK/CP"], ["EXAMPLE.FM"], ["NOTEWISE.AI"], ["BOOKING.COM"], ["WWW.HETZNER.DE"], ["DREAMHOST.COM         UNITED STATES"],
    ["HTTPS://WWW.EXAMPLE-SHOP.CO.UK/ORDER"], ["SHOP.EXAMPLE.ORG.UK"], ["PAYPAL *SHOP.EXAMPLE.COM"], ["WWW.SCREWFIX.COM"], ["THETRAINLINE.COM"],
    ["ABC HELSINKI", "FI"], ["ABC NEWSAGENTS"], ["MERCADONA MALAGA", "ES"], ["MERCADONA"], ["CARREFOUR", "FR"], ["MONOPRIX PARIS FRA", "FR"],
    ["REWE MARKT", "DE"], ["EDEKA", "DE"], ["ALBERT HEIJN", "NL"], ["COOP", "CH"], ["PUMA 1234 LONDON"], ["PUMA ENERGY 1234", "ZA"],
    ["METRO CASH & CARRY", "DE"], ["METRO DE LISBOA", "PT"], ["CASA LUCIA", "ES"], ["EL RINCON DE PEPE", "ES"], ["WALMART", "US"],
    ["TARGET", "US"], ["7-ELEVEN", "US"], ["DUNNES STORES", "IE"], ["SPAR", "AT"], ["K-MARKET", "FI"], ["BIEDRONKA", "PL"], ["LIDL", "DE"],
    ["CONTINENTE", "PT"], ["PINGO DOCE", "PT"], ["ESSELUNGA", "IT"], ["DIA", "ES"], ["MIGROS", "CH"], ["ICA", "SE"], ["KAUFLAND", "DE"],
    ["J SMITH"], ["D STEPHENS 18MAY19"], ["Jane Smith"], ["MR J A SMITH"], ["To JOHN SMITH"], ["Max Mustermann"], ["JANE SMITH  DINNER"],
    ["Transfer to J Smith"], ["MRS. SMITH"], ["DR. PATEL"], ["PIPPA"], ["BP PIPPA"], ["FPO GREENFIELD"], ["FASTER PAYMENT TO JOHN SMITH"],
    ["SO M JONES RENT"], ["MONZO* ME A FRIEND"], ["MONZO.ME/AFRIEND"], ["STANDING ORDER VIA FASTER PAYMENT TO J SMITH REFERENCE RENT"],
    ["MARIE STOPES"], ["BET365"], ["PADDY POWER"], ["LLOYDS PHARMACY 1234 LONDON"], ["TINDER"], ["LABOUR PARTY"], ["UNISON"],
    ["ST MARYS CHURCH"], ["QUICKQUID"], ["ONLYFANS"], ["THE PRIORY"], ["PRIORY ROAD GARAGE"], ["MIND CHARITY SHOP"], ["BROOK STREET TAVERN"],
    ["MATCH.COM"], ["REFORM UK"], ["SAMARITANS"], ["NHS PRESCRIPTION"], ["TERRENCE HIGGINS TRUST"], ["GAMBLERS ANONYMOUS"], ["BOOTS PHARMACY"],
    ["SQ *THE DENTAL CLINIC"], ["PAYPAL *POKERSTARS"], ["JOE'S CAFE"], ["THE CORNER CAFE"], ["ALI'S KEBAB HOUSE"], ["VILLAGE BUTCHERS"],
    ["HIGH ST NEWSAGENTS"], ["THE FLORIST"], ["XYZ LTD 0000"], ["HAWTHORN AND RYE BAKEHOUSE"], ["COSTA COFFEE CAFE"], ["PAYPAL *JOES CAFE"],
    ["CARD PAYMENT TO TESCO STORES 3456 ON 12 MAR"], ["DIRECT DEBIT PAYMENT TO VODAFONE LTD REF 123456789, MANDATE NO 0012"],
    ["CARD PAYMENT TO STAGECOACH BUS,4.40 GBP, RATE 1.00/GBP ON 01-03-2018"], ["'4298 01MAR25 C , TESCO STORES 2468 , LONDON GB"],
    ["DD TERRENCE HIGGINS TRUST REF 1234567"], ["ALDI 12345 Receipt"], ["Hotelnet HOTELNET 55"], ["000*RAILFINDER"], ["123*REG LTD"],
    ["TO-GO SUSHI"], ["TOPSHOP"], ["24/7 FITNESS"], ["PIPPA 12/08"], ["REF1234567 TESCO"], ["INV1234567 ACME LTD"], ["NOM NOM"],
    ["TESCO STORES 3456 )))"], ["COSTA COFFEE )))  "], ["HSBC ATM 08MAR"], ["LINK ATM CD 1234"], ["NON-STERLING TRANSACTION FEE"],
    ["CAF\u{C9} NERO"], ["M\u{DC}LLER"], ["Sainsbury\u{2019}s"], [`TESCO${NBSP}STORES 3456`], [`PAYPAL${NBSP}*NETFLIX`], [`SQ${cp(0x3000)}*THE BEAN HOUSE`],
    [`${cp(0xfeff)}NETFLIX.COM`], ["COSTA COFFEE\nLONDON"], [cp(0xff2e, 0xff25, 0xff34, 0xff26, 0xff2c, 0xff29, 0xff38)], [`SHOP${cp(0x1f6d2)}US`],
    [`${cp(0x1f6d2)} TESCO`], [`TESCO ${cp(0x1f6d2)}${cp(0x1f6d2)}  GB`], ["\u{DF}-SHOP"], ["  "], [""], ["\u{395}\u{3BB}\u{3BB}\u{3B7}\u{3BD}\u{3B9}\u{3BA}\u{3AC}"],
    [`${cp(0xfb01)}nchley ${cp(0xfb01)}sh bar`], [`NETFLIX.COM${cp(0x2028)}`], [`J${cp(0x2003)}SMITH`], [`PAYPAL *JOHN${cp(0x85)}SMITH`],
    [`J SMITH REF 123\n`], [`MR\tJ\tSMITH`], ["A".repeat(150)], [`${"TESCO STORES ".repeat(12)}${cp(0x1f6d2)}`], [`x${cp(0x1f6d2)}`.repeat(80)],
    // lines that aren't payments to a shop, and people after "TRANSFER TO" and the like (quick-lookup.ts, 22 Oct 2026)
    ["BANK TRANSFER TO DAVID JONES"], ["CASH WITHDRAWAL"], ["VANGUARD ISA"], ["FASTER PAYMENT TO JOHN SMITH REF RENT"], ["PAYMENT FROM SARAH JONES"],
    ["STANDING ORDER TO M JONES"], ["TRANSFER TO SAVINGS"], ["INTEREST PAID"], ["MONTHLY ACCOUNT FEE"], ["ATM WITHDRAWAL LONDON"], ["TOP UP"],
    ["SENT TO ACME WIDGETS LTD"], ["FPS TO GRUNDLEBURG LTD"], ["BACS FROM EXAMPLE PAYROLL"], ["ORDER FROM ZZQ SHOP 1234"], ["BARCLAYCARD PAYMENT"],
    ["SALARY ACME WIDGETS"], ["REFUND FROM AMAZON"], ["OVERDRAFT FEE"], ["CARD PAYMENT TO TFR ACME"], ["TFR TO J BLOGGS"], ["PYMT FROM MRS A PATEL"],
    // where it was paid: towns, codes, country names, web addresses and currencies (locate.ts)
    ["CARD PAYMENT TO LE PETIT BISTRO PARIS FR"], ["CAFE DE FLORE PARIS FRA"], ["TAVERNA SOFIA MALAGA"], ["TRATTORIA DA MARIO ROMA"], ["TACO LOCO SAN DIEGO CA"],
    ["SOME SHOP          NEW YORK     US"], ["SHOP NAME UNITED STATES"], ["WWW.EXAMPLE.DE"], ["THE ROYAL OAK"], ["PERTH SHOP PERTH"], ["TOYS R US"],
    ["NOODLE CORNER BANGKOK THB 80.00"], ["EXAMPLE STALL THB 250.00"], ["SUSHI BAR JPY 1,200"], ["CAFE EXEMPLO EUR 6.50"], ["NETFLIX.COM CA"],
    ["MERCADONA SEVILLA ES"], ["K-MARKET HELSINKI"], ["ALBERT HEIJN AMSTERDAM NLD"], ["CARREFOUR MARKET LYON"], ["REWE BERLIN DE"], ["EDEKA MUENCHEN"],
    ["MONOPRIX PARIS"], ["SPAR WIEN AT"], ["WALMART DALLAS TX"], ["TARGET NEW YORK NY"], ["LIDL CORK IE"], ["DUNNES STORES DUBLIN"], ["KIOSK ZURICH CH"],
  ];
  for (const [s, c] of TRICKY) add(s, c, true);

  // 6. The list's own names: as written, run together, and one letter off
  const merchantsOnly = allEntries.filter((e) => !e.id.startsWith("osm-"));
  merchantsOnly.filter((_e, i) => i % 3 === 0).forEach((e) => add(e.aliases[0]));
  openBrands.filter((_e, i) => i % 150 === 0).forEach((e) => add(e.aliases[0]));
  const multi = merchantsOnly.flatMap((e) => e.aliases.filter((a) => / /.test(a))).filter((_a, i) => i % 10 === 0);
  multi.forEach((a) => add(a.replace(/ /g, "")));
  const long = allEntries.flatMap((e) => e.aliases.filter((a) => /^[A-Z]{8,}$/.test(a))).filter((_a, i) => i % 150 === 0);
  long.forEach((a, i) => {
    const k = 2 + (i % (a.length - 3));
    const variants = [a.slice(0, k) + a[k] + a.slice(k), a.slice(0, k) + a.slice(k + 1), a.slice(0, k) + a[k + 1] + a[k] + a.slice(k + 2), a.slice(0, k) + "Q" + a.slice(k + 1)];
    add(variants[i % 4]);
  });

  // 7. Seeded random combinations of bank fragments (the normaliser test's generator, with more fragments)
  const PARTS = [
    "CARD PAYMENT TO", "DD", "SQ *", "PAYPAL *", "TESCO STORES", "3456", "LONDON", "GB", "ON 12 MAR", "*1234", "AMAZON.CO.UK*AB12CD34E",
    "UBER *TRIP", "HELP.UBER.COM", "18MAY19", "REF 123456789", "LS1 1AA", "UNITED KINGDOM", ",4.40 GBP, RATE 1.00/GBP ON 01-03-2018", ")))",
    "COSTA COFFEE", "  ", "\t", "CAF\u{C9}", "O'NEILLS", "12.50", "&", "-", "AIR", "FRANCE", "BANK OF", "IRELAND", "7-ELEVEN", "EC1A", "X",
    "A VERY LONG MERCHANT NAME INDEED FOR TRUNCATION", "KLARNA*", "VIS", "RESTAURANTE", "WWW.", ".CO.UK", "JD", "SPORTS", "PRET", "A", "MANGER",
    "J SMITH", "BET365", "PHARMACY", "CAFE", "SUMUP *", "BT *", "MOBILE", "IZ *", "NETFLIX.COM", "WAITROSE", "MALAGA", "ES", "FR", "US",
    "CO-OP", "M&S", "SIMPLY FOOD", "RECEIPT", "000", "MR", "TO", "FROM", "GBP 4.40", "12/08", "2026-10-22", "14:05", "#77", "XXXX1234",
  ];
  let seed = 20261022; // mulberry32: a plain LCG in doubles loses its low bits and repeats after a few thousand
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 80; i++) {
    const n = 1 + Math.floor(rand() * 6);
    add(Array.from({ length: n }, () => PARTS[Math.floor(rand() * PARTS.length)]).join(" "));
  }

  // --fuzz N: N more seeded random texts, rows and amounts, with odd whitespace, accents, emoji and run-together or
  // misspelt names from the list. Not in the committed file; for a bigger one-off check (write it with --out).
  const fuzzAt = args.indexOf("--fuzz");
  const fuzz = fuzzAt >= 0 ? Number(args[fuzzAt + 1]) : 0;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const ODD = [0xa0, 0x2000, 0x2007, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0x85, 0x1c, 0x0b, 0x0c, 0x09, 0x0a, 0x0d, 0x2018,
    0x2019, 0x60, 0x301, 0xe9, 0xfc, 0xdf, 0x130, 0x131, 0x17f, 0xfb01, 0xff21, 0x1d400, 0x1f6d2, 0x1f600, 0x4e2d, 0x627, 0x212a, 0x2160, 0x2460,
    0xbd, 0x660, 0xb2, 0xa3, 0x20ac].map((c) => String.fromCodePoint(c));
  const ASCII = "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789     *.-/&'#,:;()!?+_@$";
  const SEPS = [" ", " ", " ", "", "*", "  ", " * ", ...ODD.slice(0, 10)];
  const allAliases = allEntries.flatMap((e) => e.aliases);
  const mutate = (a: string) => {
    const r = rand();
    const i = Math.floor(rand() * Math.max(1, a.length - 1));
    if (r < 0.2) return a.replace(/ /g, "");
    if (r < 0.35) return a.slice(0, i) + a.slice(i + 1);
    if (r < 0.5) return a.slice(0, i) + a[i] + a.slice(i);
    if (r < 0.6) return a.slice(0, i) + (a[i + 1] ?? "") + a[i] + a.slice(i + 2);
    if (r < 0.7) return a.toLowerCase();
    return a;
  };
  const fuzzText = () => {
    const r = rand();
    if (r < 0.35) return Array.from({ length: 1 + Math.floor(rand() * 7) }, () => pick(PARTS)).join(pick(SEPS));
    if (r < 0.7) {
      const pre = rand() < 0.4 ? pick(["CARD PAYMENT TO ", "PAYPAL *", "SQ *", "VIS KLARNA*", "DD ", "BP ", "FPO ", "RESTAURANTE ", "WWW.", "TO ", "MR "]) : "";
      const post = rand() < 0.5 ? pick([" 1234", " LONDON", " GB", " LEEDS LS6", ".COM", ".CO.UK", " ON 12 MAR", " )))", " *AB12CD34E", " LTD", " CAFE", " MALAGA ES"]) : "";
      return pre + mutate(pick(allAliases)) + post;
    }
    return Array.from({ length: 1 + Math.floor(rand() * 30) }, () => (rand() < 0.2 ? pick(ODD) : ASCII[Math.floor(rand() * ASCII.length)]!)).join("");
  };
  for (let i = 0; i < fuzz; i++) add(fuzzText(), rand() < 0.3 ? pick(["FR", "ES", "DE", "US", "FI", "IT", "NL", "IE", "PT", "SE"]) : undefined);
  const fuzzLabels = [...Object.keys(UK_TYPE_CODES), "Card payment", "CARD_PAYMENT", "Faster payment", "Direct Debit", "Standing order", "Pot transfer", "TOPUP", "EXCHANGE", "ATM", "INTEREST PAYMENT", "Visa purchase", "Transfer to"];
  for (let i = 0; i < fuzz / 4; i++) {
    const amount = rand() < 0.05 ? 0 : (rand() < 0.8 ? -1 : 1) * Math.round(rand() * 100000) / 100;
    rows.push({ amount, rawPayee: fuzzText(), ...(rand() < 0.6 ? { typeLabel: pick(fuzzLabels) } : {}), ...(rand() < 0.3 ? { rawDescription: fuzzText() } : {}) });
  }
  const AMT = "0123456789012345678901234567890123456789.,.,-+() CRDRcrdr\xa3$\u{20AC}GBPEURUSD'\" ";
  for (let i = 0; i < fuzz / 10; i++) amounts.push(Array.from({ length: 1 + Math.floor(rand() * 12) }, () => AMT[Math.floor(rand() * AMT.length)]!).join(""));

  // Rows of my own: type labels with names, and descriptions without a type column
  const ROWS: ClassifyInput[] = [
    { amount: -9.99, rawPayee: "ZIZZI LEEDS" }, { amount: -9.99, rawPayee: "ZIZZI LEEDS", typeLabel: "DEB" }, { amount: -50, rawPayee: "PIPPA", typeLabel: "BP" },
    { amount: -50, rawPayee: "PAYPAL *JOHNSMITH", typeLabel: "Card payment" }, { amount: -12, rawPayee: "John Smith", typeLabel: "Card payment", rawDescription: "PAYPAL *JOHNSMITH 35314369001 GBR" },
    { amount: -40, rawPayee: "LINK ATM", typeLabel: "Card payment" }, { amount: -100, rawPayee: "VANGUARD ISA 12345678", typeLabel: "DD" },
    { amount: -250, rawPayee: "BARCLAYCARD", typeLabel: "DD" }, { amount: 23.99, rawPayee: "AMAZON.CO.UK*AB12CD34E", typeLabel: "Card payment" },
    { amount: 2500, rawPayee: "ACME WIDGETS LTD", typeLabel: "BGC" }, { amount: -100, rawPayee: "Holiday", typeLabel: "Pot transfer" },
    { amount: -3, rawPayee: "ACCOUNT FEE", typeLabel: "CHG" }, { amount: -20, rawPayee: "OCTOPUS ENERGY LTD", typeLabel: "FPO" },
    { amount: -20, rawPayee: "GREENFIELD", typeLabel: "FPO" }, { amount: -12, rawPayee: "MONZO* ME A FRIEND", typeLabel: "MAS" },
    { amount: -30, rawPayee: "SQ *THE BEAN HOUSE", typeLabel: "CONTACTLESS" }, { amount: -8.49, rawPayee: "LLOYDS PHARMACY 1234 LONDON", typeLabel: "Card payment" },
    { amount: -20, rawPayee: "Bet365", typeLabel: "ONLINE PAYMENT", rawDescription: "BET365" }, { amount: -5, rawPayee: "Top-Up by *1234", typeLabel: "TOPUP" },
    { amount: -50, rawPayee: "Exchanged to EUR", typeLabel: "EXCHANGE" }, { amount: -4.5, rawPayee: "Card transaction of 4.50 GBP issued by Pret A Manger LONDON" },
    { amount: -50, rawPayee: "Sent money to John Smith" }, { amount: -12.3, rawPayee: "TESCO STORES 3456 )))" }, { amount: -10, rawPayee: "  " },
    { amount: 0, rawPayee: "TESCO", typeLabel: "DEB" }, { amount: Number.NaN, rawPayee: "TESCO" }, { amount: -1, rawPayee: "X", typeLabel: "constructor" },
    { amount: -1, rawPayee: "CHURCH OF ENGLAND", typeLabel: "SO" }, { amount: -1, rawPayee: "MRS. PIPPA", typeLabel: "STANDING ORDER" },
  ];
  rows.push(...ROWS);
  for (const s of ["", " ", "1.005", "-0.125", "0.125", "£", "12,345.678", "1.234.567,89", "(1,234.50)", "1.5e3", "١٢٣", "0", "-0", "DR", "CR 12.50",
    "12.50 cr", "GBP", "12 . 50", `${NBSP}12.50${NBSP}`, "'12.50'", "\"-3.40\"", "€5", "$-2", "5.", ".5", "+-3", "USD 1,000", "12,5", "1,23,456"]) amounts.push(s);
  typeLabels.push(...Object.keys(UK_TYPE_CODES), "Card payment", "CARD_PAYMENT", "Faster payment", "Bacs (Direct Credit)", "Visa purchase", "Transfer to",
    "Contactless Card Purchase", "Counter Credit", "Cash Machine", "OTH", "MasterCard Payment", "Outgoing Transfer", "Presentment", "Debit Transfer",
    "Credit Transfer", "STARLING TRANSFER", "INTEREST PAYMENT", "ONLINE PAYMENT", "constructor", "  dd  ", "d/d", "", "unknown thing");

  // ── Answers ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const usedEntries = new Map<string, OwnershipEntry>();
  const res = (r: Resolution) => {
    if (r.entry) usedEntries.set(r.entry.id, r.entry);
    const o: Record<string, unknown> = { status: r.status, via: r.via };
    if (r.reason !== undefined) o.reason = r.reason;
    if (r.entry) o.id = r.entry.id;
    if (r.method !== undefined) o.method = r.method;
    if (r.matched_alias !== undefined) o.alias = r.matched_alias;
    if (r.cleaned !== undefined) o.cleaned = r.cleaned;
    return o;
  };
  const ROTATE = ["FR", "ES", "DE", "US", "IE", "NL", "FI", "IT", "PT", "PL", "SE", "AU"];
  // Why a name isn't looked up, as the website says it (kys.py lookup prints the same sentence): the first line for a
  // payment that isn't to a shop, the line after "isn't in our built-in list" for a person's name or a sensitive one.
  const reasonLine = (r: QuickResult): string | null => {
    const lines = r.why?.sections[0]?.lines ?? [];
    return r.status === "not_shop" ? (lines[0] ?? null) : r.status === "person" || r.status === "sensitive" ? (lines[1] ?? null) : null;
  };
  const payeeCases: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let k = 0;
  for (const [text, extra] of payees) {
    const countries = new Set(["GB"]);
    if (extra) countries.add(extra);
    const elsewhere = locate([text], "GB").country;
    if (elsewhere !== "GB") countries.add(elsewhere);
    if (k++ % 15 === 3) countries.add(ROTATE[k % ROTATE.length]!);
    for (const country of countries) {
      const id = `${country}\u0000${text}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const q = readQuery(text, country);
      const m = matchLocal({ normPayee: q.name, rawPayee: q.text, rawDescription: q.text, kind: "spend", currency: "" }, q.home);
      const person = { text: looksLikePerson(q.text), name: looksLikePerson(q.name), maybe: mayBePerson({ amount: -1, rawPayee: q.text }) };
      const loc = locate([q.text, q.text], q.home);
      // the website's search box (packages/core/src/quick-lookup.ts), which kys.py lookup follows
      const quick = lookUpLocally(q);
      payeeCases.push({
        input: text, country, text: q.text, name: q.name, norm: normalisePayee(text), sensitive: sensitiveCategory(q.name), person,
        card_reader: cardReader(text)?.prefix ?? null, domains: domainsIn(text), match: res(m), resolve: res(resolver.resolve(text, { country })),
        where: { country: loc.country, evidence: loc.evidence, clue: loc.clue ?? null },
        status: quick.status,
        owner: quick.status === "owner" ? (quick.why?.name ?? null) : null,
        line: reasonLine(quick),
      });
    }
  }
  const rowKeys = new Set<string>();
  const uniqueRows = rows.filter((r) => {
    const fold = (s: string | undefined) => s?.replace(/[0-9]/g, "#");
    const key = JSON.stringify([Math.sign(r.amount), fold(r.rawPayee), fold(r.rawDescription), r.typeLabel]);
    return rowKeys.has(key) ? false : (rowKeys.add(key), true);
  });
  const rowCases = uniqueRows.map((row) => {
    const kind = classify(row);
    let norm = normalisePayee(row.rawPayee);
    if (!norm && row.rawDescription) norm = normalisePayee(row.rawDescription);
    const spendish = kind === "spend" || kind === "refund";
    const held = isSensitive(norm) || (row.rawDescription !== undefined && isSensitive(normalisePayee(row.rawDescription))) || (spendish && mayBePerson(row));
    const where = locate([row.rawDescription, row.rawPayee], "GB").country; // as attribute.ts does, for a UK bank
    return {
      row: { ...row, amount: Number.isFinite(row.amount) ? row.amount : null }, type_hint: typeHint(row.typeLabel), kind, may_be_person: mayBePerson(row), norm, held,
      where,
      match: spendish && norm ? res(matchLocal({ normPayee: norm, rawPayee: row.rawPayee, rawDescription: row.rawDescription, kind, currency: "GBP" }, where)) : null,
    };
  });
  const amountCases = [...new Set(amounts)].map((s) => {
    const a = parseAmount(s);
    return { input: s, value: a ? a.value : null, currency: a?.currency ?? null, marked: a?.marked ?? null };
  });
  const typeCases = [...new Set(typeLabels)].map((s) => ({ input: s, hint: typeHint(s) }));
  const entries = [...usedEntries.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((e) => {
    const why = explain({ a: { entry: e, country: e.owner_country, basis: "owner", method: "exact", alias: "X" }, payee: "X", home: "GB" });
    return {
      id: e.id, display_name: e.display_name, kind: e.kind, owner_country: e.owner_country, tier: e.tier, as_of: e.as_of, category: e.category ?? null,
      trades_in: e.trades_in ?? null, intermediary: e.intermediary ?? null, chain: e.chain.map((h) => [h.name, h.relation, h.country]),
      sources: (e.sources ?? []).map((s) => [s.label, s.url]), how: [why.level, why.label], headline: why.headline,
      roles: why.chain.map((h) => [h.name, h.country, h.role]),
    };
  });

  // Answers from the online look-up (ids "lookup-..."), as explain.ts labels them; kys.py shows them the same way.
  const lookupEntry = (over: Partial<OwnershipEntry>): OwnershipEntry => ({
    id: "lookup-obscure-widgets", display_name: "Obscure Widgets", kind: "merchant", aliases: [],
    chain: [
      { name: "Obscure Widgets Ltd", relation: "brand_of", country: "GB", source: "companies_house" },
      { name: "Widget Holdings SE", relation: "ultimate_parent", country: "DE", source: "gleif" },
    ],
    owner_country: "DE", tier: "EXACT_ID", technique: "Found in Wikidata and GLEIF", sources: [{ label: "GLEIF record", url: "https://search.gleif.org/" }],
    as_of: "2026-10-20", reviewed_by: null, reviewed_at: null, ...over,
  });
  const ONLINE: OwnershipEntry[] = [
    lookupEntry({}),
    lookupEntry({ tier: "LLM_GUESS", technique: "AI vote: 5 of 5 answers agree; matches Wikidata/GLEIF" }),
    lookupEntry({ tier: "LLM_GUESS", technique: "Checked with a web search" }),
    lookupEntry({ tier: "NAME_MATCH", technique: "Companies House: one active company with exactly this name, PSC filings followed" }),
    lookupEntry({ tier: "LLM_GUESS", technique: "From Companies House, then an AI vote" }),
    lookupEntry({ tier: "NAME_MATCH", technique: "Wikidata name search" }),
    lookupEntry({ tier: "CURATED", technique: "Reviewed", reviewed_by: "A Reviewer", reviewed_at: "2026-10-01" }),
    lookupEntry({ display_name: "Solo", chain: [{ name: "Solo Ltd", relation: "ultimate_parent", country: "GB", source: "companies_house" }], owner_country: "GB" }),
    lookupEntry({ chain: [{ name: "Obscure Widgets", relation: "brand_of", country: "GB", source: "wikidata" }, { name: "Q2836957", relation: "ultimate_parent", country: "FR", source: "wikidata" }], owner_country: "FR" }),
    lookupEntry({ id: "lookup-x", display_name: "Widget Holdings SE", technique: "" }),
  ];
  const onlineCases = ONLINE.map((e) => {
    const why = explain({ a: { entry: e, country: e.owner_country, basis: "owner", method: "lookup" }, payee: "OBSCURE WIDGETS", home: "GB" });
    return { entry: e, how: [why.level, why.label], headline: why.headline, roles: why.chain.map((h) => [h.name, h.country, h.role]) };
  });

  // The look-up's answers as the website reads them (quick-lookup.ts withAnswer; apps/site/src/lookup.ts says the AI step
  // is paused when an unfinished answer comes with sources.ai false). kys.py's status "retry" is the website's unknown
  // with retry. reason: for an owner, the line saying when the web search will run (if any); for a local independent,
  // "How we recognised it"; otherwise the line after "isn't in our built-in list".
  const aq = readQuery("CARD PAYMENT TO GRUNDLEBURG HOLDINGS LTD ON 12 OCT", "GB");
  const answer = (over: Partial<LookupAnswer>): LookupAnswer => ({ query: aq.name, status: "UNRESOLVED", trace: [], ...over });
  const RECHECK = "2026-10-25";
  const ANSWERS: [LookupAnswer, boolean][] = [
    [answer({ status: "RESOLVED", entry: lookupEntry({ id: "lookup-grundleburg" }), trace: [{ step: "wikidata", status: "found", detail: "Found." }] }), true],
    [answer({ status: "RESOLVED", entry: lookupEntry({ tier: "LLM_GUESS", technique: "AI vote: 3 of 5 answers agree" }), recheck_after: RECHECK }), true],
    [answer({ status: "RESOLVED", entry: lookupEntry({ tier: "LLM_GUESS", technique: "Checked with a web search" }), recheck_after: RECHECK }), true],
    [answer({ status: "RESOLVED", entry: lookupEntry({ tier: "LLM_GUESS", technique: "AI vote; a web search couldn't confirm it" }), recheck_after: RECHECK }), true],
    [answer({ status: "RESOLVED", entry: lookupEntry({ tier: "EXACT_ID" }), recheck_after: RECHECK }), true],
    [answer({ status: "RESOLVED", entry: lookupEntry({ id: "tesco" }) }), true],
    [answer({ status: "RESOLVED", entry: { ...lookupEntry({}), owner_country: "" } }), true],
    [answer({ status: "LOCAL_BUSINESS", checked: "web" }), true],
    [answer({ status: "LOCAL_BUSINESS", recheck_after: RECHECK }), false],
    [answer({ status: "LOCAL_BUSINESS" }), true],
    [answer({ status: "NOT_A_BUSINESS" }), false],
    [answer({ trace: [{ step: "llm", status: "not_found", detail: "No owner named." }] }), true],
    [answer({ trace: [{ step: "llm", status: "not_found", detail: "No owner named." }] }), false],
    [answer({ trace: [{ step: "cache", status: "error", detail: "Ran out of time on this request; try again." }] }), true],
    [answer({ trace: [{ step: "llm", status: "error", detail: "AI step paused (today's limit for AI look-ups has been reached); try again later." }] }), false],
  ];
  const answerCases = ANSWERS.map(([a, ai]) => {
    let r = withAnswer(aq, a, new Date("2026-10-22T12:00:00Z"));
    if (r.retry && ai === false) r = lookupUnavailable(aq, "paused");
    const lines = r.why?.sections.flatMap((s) => s.lines) ?? [];
    const reason =
      r.status === "owner"
        ? (lines.find((l) => l.startsWith("It hasn't been checked with a web search yet.")) ?? null)
        : r.status === "local"
          ? (r.why?.sections[0]?.lines.join(" ") ?? null)
          : (r.why?.sections[0]?.lines[1] ?? null);
    return {
      answer: a, ai, name: aq.name, status: r.status === "unknown" && r.retry ? "retry" : r.status,
      brand: r.status === "owner" ? (r.why?.name ?? null) : null, headline: r.status === "owner" ? (r.why?.headline ?? null) : null, reason,
    };
  });

  const meta = { entries: allEntries.length, aliases: resolver.size().aliases, open_brands: openBrands.length };
  const line = (o: unknown) => JSON.stringify(o);
  const section = (xs: unknown[]) => `[\n${xs.map(line).join(",\n")}\n]`;
  const json = `{\n"about": ${line("Made by tools/python/vectors.ts from the TypeScript engine; checked by tools/python/test_kys.py. Regenerate, don't edit.")},\n"meta": ${line(meta)},\n"payees": ${section(payeeCases)},\n"rows": ${section(rowCases)},\n"amounts": ${section(amountCases)},\n"type_hints": ${section(typeCases)},\n"entries": ${section(entries)},\n"online_entries": ${section(onlineCases)},\n"online_answers": ${section(answerCases)}\n}\n`;

  if (args.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== json) {
      console.error(`${OUT} is out of date. Run: pnpm --filter @kys/ownership exec tsx ../../tools/python/vectors.ts`);
      process.exit(1);
    }
    console.log(`${OUT} is up to date.`);
  } else {
    writeFileSync(OUT, json);
    console.log(`Wrote ${OUT}: ${payeeCases.length} payees, ${rowCases.length} rows, ${amountCases.length} amounts, ${typeCases.length} type labels, ${entries.length} entries, ${onlineCases.length} online entries, ${answerCases.length} online answers (${(json.length / 1024).toFixed(0)} KB).`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
