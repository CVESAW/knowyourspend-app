/**
 * normalisePayee — THE PRIVACY BOUNDARY.
 *
 * The normalised payee of a spend row is the only string that ever leaves the device. This
 * function turns a raw bank descriptor (`CARD PAYMENT TO TESCO STORES 3456 LONDON GB ON 12 MAR`)
 * into a merchant key (`TESCO STORES`) by removing everything that is location, time, amount,
 * card, reference or bank boilerplate.
 *
 * Contract (mirrored by backend/services/normalise.py; shared golden cases live in
 * test/fixtures/normalise-golden.json):
 * - deterministic, no locale dependence, no network;
 * - idempotent: normalisePayee(normalisePayee(x)) === normalisePayee(x);
 * - output is uppercase ASCII-ish, single-spaced, at most 40 characters;
 * - never strips a string down to nothing — if a rule would leave no letters, it is not applied.
 *
 * Implementation: one `pass` of ordered rules, repeated until the output stops changing (a fixed
 * point), which is what makes the function idempotent by construction.
 */
import { MORE_PLACES } from "./places-more";

export const MAX_PAYEE_LENGTH = 40;

const MONTHS = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC";

/** Bank-added prefixes (type words, not merchant). Longest first so multi-word forms win. */
export const BANK_PREFIXES: readonly string[] = [
  "DIRECT DEBIT PAYMENT TO", "DEBIT CARD PAYMENT TO", "CONTACTLESS PAYMENT TO", "STANDING ORDER TO",
  "FASTER PAYMENT TO", "BILL PAYMENT TO", "CARD PAYMENT TO", "DIRECT DEBIT TO", "DEBIT CARD PAYMENT",
  "CONTACTLESS PAYMENT", "CARD PAYMENT", "CARD PURCHASE", "VISA PURCHASE", "DIRECT DEBIT",
  "STANDING ORDER", "BILL PAYMENT", "FASTER PAYMENT", "PAYMENT TO", "CONTACTLESS", "APPLE PAY",
  "GOOGLE PAY", "PURCHASE", "VISA", "POS", "CRD", "DDR", "D/D", "DD", "S/O", "STO", "SO", "FPI", "FPO",
  "VIS", "BGC", "DEB", "CPT", "TFR", "BBP", "BP", "EFT", "OTR",
].sort((a, b) => b.length - a.length);

/**
 * Payment facilitators that prefix the real merchant: `SQ *THE COFFEE HOUSE` → `THE COFFEE HOUSE`.
 * Widely seen conventions, UNCONFIRMED from fetched samples (see research notes KQ2 gaps).
 * SQ = Square, SUMUP, ZETTLE_/IZ = Zettle (iZettle), PAYPAL/PP = PayPal, GOOGLE = Google Play,
 * CRV = Curve, SP = Shopify Payments, TST = Toast, KLARNA and CLEARPAY (pay later; since 18 Oct 2026, so
 * "KLARNA*ASOS" is ASOS, as the method page says, not Klarna).
 */
const FACILITATOR_RE = /^(SQ|SUMUP|ZETTLE_?|IZETTLE|IZ|PAYPAL|PP|GOOGLE|CRV|SP|TST|KLARNA|CLEARPAY)\s*\*\s*/;
const FACILITATOR_NAME: Record<string, string> = { PP: "PAYPAL", IZ: "ZETTLE", IZETTLE: "ZETTLE", ZETTLE_: "ZETTLE" };

/**
 * Well-known messy forms mapped to one canonical key. Anchored at the start; the whole string is
 * replaced (anything after is noise like order refs or URLs).
 */
const KNOWN_FORMS: ReadonlyArray<[RegExp, string]> = [
  [/^(?:AMZNMKTPLACE|AMZN\s*MKTP|AMAZON\s*MKTPL|AMAZON\s*MARKETPLACE|AMAZON\.CO\.UK|AMAZON\.COM|AMZN\.CO\.UK|WWW\.AMAZON|AMAZON\s+EU\b)/, "AMAZON"],
  [/^UBER\s*\*?\s*EATS\b|^UBEREATS\b/, "UBER EATS"],
  [/^UBER\s*\*?\s*(?:TRIP|RIDES?|HELP\.UBER|BV)\b/, "UBER"],
  [/^(?:TFL|TRANSPORT FOR LONDON)\b/, "TFL"],
];

/** ISO / common country codes and names that terminals append. */
const COUNTRIES_SAFE: readonly string[] = [
  "UNITED STATES OF AMERICA", "UNITED KINGDOM", "UNITED STATES", "GREAT BRITAIN", "ISLE OF MAN",
  "NETHERLANDS", "LUXEMBOURG", "SWITZERLAND", "AUSTRALIA", "GUERNSEY", "PORTUGAL", "IRELAND",
  "GERMANY", "BELGIUM", "DENMARK", "FINLAND", "AUSTRIA", "SWEDEN", "NORWAY", "POLAND", "CANADA",
  "FRANCE", "JERSEY", "SPAIN", "ITALY", "GBR", "USA", "IRL", "LUX", "NLD", "DEU", "FRA", "ESP",
  "ITA", "BEL", "PRT", "CHE", "SWE", "DNK", "NOR", "FIN", "POL", "AUT", "CAN", "AUS", "JEY", "GGY",
  "IMN", "GB", "UK", "IE", "NL", "LU", "FR",
];
/** Two-letter codes that are also English words / brand fragments: only stripped when padded. */
const COUNTRIES_PADDED_ONLY: readonly string[] = [
  "US", "DE", "ES", "IT", "BE", "AT", "CH", "SE", "DK", "NO", "FI", "PL", "CZ", "GR", "PT", "CA", "AU",
  "JE", "GG", "IM",
];

/**
 * ~150 UK/IE/EU towns, cities and London districts that terminals append after the merchant.
 * Deliberately excludes place names that are common words or brands (SALE, DEAL, BATH, WELLS,
 * HALIFAX, NICE, ROMA). Places are only ever stripped at the END of a string.
 */
export const PLACE_NAMES: readonly string[] = [
  // UK cities & large towns
  "LONDON", "MANCHESTER", "BIRMINGHAM", "LEEDS", "GLASGOW", "EDINBURGH", "LIVERPOOL", "BRISTOL",
  "SHEFFIELD", "NEWCASTLE UPON TYNE", "NEWCASTLE", "NOTTINGHAM", "LEICESTER", "CARDIFF", "BELFAST",
  "COVENTRY", "BRADFORD", "SOUTHAMPTON", "PORTSMOUTH", "PLYMOUTH", "READING", "DERBY", "WOLVERHAMPTON",
  "STOKE ON TRENT", "STOKE-ON-TRENT", "SUNDERLAND", "NORWICH", "SWANSEA", "ABERDEEN", "DUNDEE",
  "OXFORD", "CAMBRIDGE", "BRIGHTON", "HOVE", "MILTON KEYNES", "NORTHAMPTON", "LUTON", "YORK", "HULL",
  "PRESTON", "BOURNEMOUTH", "POOLE", "SWINDON", "PETERBOROUGH", "SOUTHEND ON SEA", "SOUTHEND",
  "IPSWICH", "EXETER", "GLOUCESTER", "CHELTENHAM", "WATFORD", "SLOUGH", "CRAWLEY", "GUILDFORD",
  "WOKING", "BASINGSTOKE", "MAIDSTONE", "CANTERBURY", "CHELMSFORD", "COLCHESTER", "BASILDON",
  "STEVENAGE", "ST ALBANS", "HIGH WYCOMBE", "AYLESBURY", "BEDFORD", "LINCOLN", "CHESTER", "WARRINGTON",
  "STOCKPORT", "BOLTON", "WIGAN", "OLDHAM", "ROCHDALE", "SALFORD", "BLACKPOOL", "BLACKBURN", "BURNLEY",
  "HUDDERSFIELD", "WAKEFIELD", "DONCASTER", "ROTHERHAM", "BARNSLEY", "MIDDLESBROUGH", "DARLINGTON",
  "DURHAM", "CARLISLE", "LANCASTER", "HARROGATE", "SCARBOROUGH", "WORCESTER", "HEREFORD", "SHREWSBURY",
  "TELFORD", "WALSALL", "DUDLEY", "SOLIHULL", "NUNEATON", "RUGBY", "LEAMINGTON SPA", "STRATFORD UPON AVON",
  "BANBURY", "WINCHESTER", "SALISBURY", "TAUNTON", "TORQUAY", "TRURO", "STIRLING", "INVERNESS", "PERTH",
  "PAISLEY", "NEWPORT", "WREXHAM", "DERRY", "LISBURN",
  // London districts / boroughs commonly appended
  "WESTMINSTER", "CAMDEN", "ISLINGTON", "HACKNEY", "GREENWICH", "LEWISHAM", "SOUTHWARK", "LAMBETH",
  "BRIXTON", "CLAPHAM", "CROYDON", "WIMBLEDON", "KINGSTON UPON THAMES", "KINGSTON", "RICHMOND",
  "HAMMERSMITH", "FULHAM", "CHELSEA", "KENSINGTON", "SHOREDITCH", "STRATFORD", "CANARY WHARF",
  "WEMBLEY", "EALING", "ROMFORD", "ILFORD", "BROMLEY", "SUTTON", "HARROW", "ENFIELD", "BARNET",
  "WOOLWICH", "PECKHAM", "WALTHAMSTOW", "HOUNSLOW", "UXBRIDGE", "HEATHROW", "GATWICK",
  // Ireland
  "DUBLIN", "CORK", "GALWAY", "LIMERICK",
  // EU (merchant billing seats and holiday spend)
  "AMSTERDAM", "BERLIN", "MUNICH", "MUENCHEN", "FRANKFURT", "HAMBURG", "PARIS", "LYON",
  "MADRID", "BARCELONA", "MALAGA", "LISBON", "LISBOA", "PORTO", "ROME", "MILAN", "MILANO",
  "BRUSSELS", "BRUXELLES", "VIENNA", "WIEN", "PRAGUE", "PRAHA", "COPENHAGEN", "STOCKHOLM", "OSLO",
  "HELSINKI", "ZURICH", "GENEVA", "LUXEMBOURG", "WARSAW", "BUDAPEST", "ATHENS",
  // Frequent non-EU billing seats (listed so "NETFLIX NEW YORK" does not become "NETFLIX NEW")
  "NEW YORK", "SAN FRANCISCO", "LOS ANGELES", "SEATTLE",
];

/** Trailing bank/terminal type codes (Barclays BCC/CLP, HSBC CR/DR…). */
const TRAILING_CODES = ["BCC", "CLP", "DDR", "POS", "VIS", "DEB", "CPT", "BGC", "STO", "FPO", "FPI", "TFR", "CR", "DR", "GBP", "EUR"];

/** A place/country is not stripped when it follows one of these (AIR FRANCE, BANK OF IRELAND). */
const CONNECTOR_BEFORE = /(?:^|\s)(?:OF|AIR|AND|&|THE|DE|DU|LA|LE|VON|VAN)$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "\\s+");
}

function alt(list: readonly string[]): string {
  return [...list].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
}

const PREFIX_RE = new RegExp(`^(?:${alt(BANK_PREFIXES)})(?=$|[\\s,:;\\-])[\\s,:;\\-]*`);
const PADDED_COUNTRY_RE = new RegExp(`\\s{2,}(?:${alt([...COUNTRIES_SAFE, ...COUNTRIES_PADDED_ONLY])})\\s*$`);
const TRAILING_COUNTRY_RE = new RegExp(`\\s(?:${alt(COUNTRIES_SAFE)})$`);
const TRAILING_PLACE_RE = new RegExp(`\\s(?:${alt(PLACE_NAMES)})$`);
const MORE_PLACE_RE = new RegExp(`\\s(?:${alt(MORE_PLACES)})$`);
const TRAILING_CODE_RE = new RegExp(`\\s(?:${alt(TRAILING_CODES)})$`);
const TLD = "CO\\.UK|ORG\\.UK|GOV\\.UK|AC\\.UK|LTD\\.UK|ME\\.UK|COM|NET|ORG|UK|IE|DE|FR|NL|IO|EU|ES|IT|BE|LU|APP|TV|CO";
const DOMAIN_TOKEN_RE = new RegExp(`^(?:HTTPS?://)?(?:WWW\\.)?(?:[A-Z0-9-]+\\.)*?([A-Z0-9-]*[A-Z][A-Z0-9-]*)\\.(?:${TLD})(?:/\\S*)?$`);

/** Apply `next` only if it still contains a letter — never normalise a payee to nothing. */
function keep(prev: string, next: string): string {
  const t = next.replace(/\s+/g, " ").trim();
  return /[A-Z]/.test(t) ? t : prev;
}

/** Repeatedly apply a trailing-strip regex until it stops matching. */
/** A town from the longer list comes off only when a word of the shop's name is left before it. */
function stripMorePlaces(s: string): string {
  const next = s.replace(MORE_PLACE_RE, "").trim();
  if (next === s || !/[A-Z].*[A-Z]|[A-Z]&[A-Z]/.test(next) || CONNECTOR_BEFORE.test(next)) return s;
  return next;
}

function stripTrailing(s: string, re: RegExp, guardConnector = false): string {
  for (;;) {
    const next = s.replace(re, "").trim();
    if (next === s) return s;
    if (guardConnector && CONNECTOR_BEFORE.test(next)) return s;
    const kept = keep(s, next);
    if (kept === s) return s;
    s = kept;
  }
}

/** One pass of every rule, in order. `normalisePayee` iterates this to a fixed point. */
function pass(input: string): string {
  let s = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents: CAFÉ → CAFE
    .toUpperCase()
    .replace(/[\u00A0\u2007\u202F\t\r\n]/g, " ")
    .replace(/[\u2018\u2019`']/g, "") // SAINSBURY'S → SAINSBURYS, leading NatWest apostrophe
    .replace(/[^\x20-\x7E]/g, " "); // anything else non-printable/non-ASCII (£ € etc.)

  // Padded trailing country (Barclays `DREAMHOST.COM         UNITED STATES`) — padding is the
  // signal that makes even ambiguous 2-letter codes safe to drop.
  s = keep(s, s.replace(PADDED_COUNTRY_RE, ""));
  s = s.replace(/\s+/g, " ").trim();

  // Santander FX clause: `,4.40 GBP, RATE 1.00/GBP ON 01-03-2018`
  s = keep(s, s.replace(/\s*,\s*[\d.,]+\s*[A-Z]{3}\s*,\s*RATE\s+[\d.]+\s*\/\s*[A-Z]{3}(?:\s+ON\s+\S+)?.*$/, ""));
  // `ON 12 MAR`, `ON 12MAR24`, `ON 01-03-2018` and everything after (Barclays memo tail codes).
  s = keep(s, s.replace(new RegExp(`\\s+ON\\s+(?:\\d{1,2}\\s?(?:${MONTHS})(?:\\s?\\d{2,4})?|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4})\\b.*$`), ""));
  // NatWest card+date prefix: `4298 11JAN19 C , TESCO …` / `7114 20DEC24 CD , SHOP …` / `4298 11JAN19 , …`
  // / `4321 01SEP26 TESCO …` (the code letters only count when a comma follows them).
  s = keep(s, s.replace(new RegExp(`^\\d{4}\\s+\\d{1,2}(?:${MONTHS})\\d{2}(?:\\s+[A-Z]{1,2}\\s*,|\\s*,|\\s+)`), ""));

  // Punctuation that is never part of a merchant key.
  s = s.replace(/[",;:!?()[\]{}<>|=~^]/g, " ").replace(/\)\)\)/g, " ").replace(/\s+/g, " ").trim();

  // Bank prefixes (may be stacked: `DD DIRECT DEBIT …`).
  for (let i = 0; i < 4; i++) {
    const next = keep(s, s.replace(PREFIX_RE, ""));
    if (next === s) break;
    s = next;
  }

  s = applyKnownForms(s);

  // Card suffixes and markers.
  s = keep(s, s.replace(/\*+\s?\d{4}\b/g, " "));
  s = keep(s, s.replace(/\bX{3,}\d{4}\b/g, " "));
  s = keep(s, s.replace(/\b(?:CARD\s+)?ENDING\s*(?:IN\s*)?\d{4}\b/g, " "));
  s = keep(s, s.replace(/\bCD\s?\d{4}\b/g, " "));

  // Facilitator prefix: keep the merchant after it, or the facilitator itself if nothing follows.
  const fac = FACILITATOR_RE.exec(s);
  if (fac) {
    const rest = s.slice(fac[0].length).trim();
    const name = FACILITATOR_NAME[fac[1]!] ?? fac[1]!;
    s = /[A-Z]/.test(rest) ? rest : name;
  }
  s = applyKnownForms(s);

  // `MERCHANT*DETAIL` → MERCHANT (non-facilitator star: the left side is the merchant).
  if (s.includes("*")) {
    const left = s.slice(0, s.indexOf("*")).trim();
    s = /[A-Z]/.test(left) ? left : s.replace(/\*/g, " ");
  }

  // Domains → brand label: NETFLIX.COM → NETFLIX, HELP.UBER.COM → UBER, WWW.HETZNER.DE → HETZNER.
  s = s
    .split(" ")
    .map((tok) => {
      const m = DOMAIN_TOKEN_RE.exec(tok);
      return m ? m[1]! : tok;
    })
    .join(" ");
  s = applyKnownForms(s);

  // Dates, times, amounts anywhere.
  s = keep(s, s.replace(new RegExp(`\\b\\d{1,2}\\s?(?:${MONTHS})\\s?\\d{2}(?:\\d{2})?\\b`, "g"), " "));
  s = keep(s, s.replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, " "));
  s = keep(s, s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " "));
  s = keep(s, s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " "));
  s = keep(s, s.replace(/(?:GBP|EUR|USD)\s?\d[\d,]*(?:\.\d{1,2})?\b/g, " "));
  s = keep(s, s.replace(/\b\d[\d,]*\.\d{2}\b(?:\s?(?:GBP|EUR|USD)\b)?/g, " "));
  s = keep(s, s.replace(/\bRATE\s+[\d.]+\S*/g, " "));

  // References: `REF 12345`, `REF:ABC`, and any token ≥ 8 chars containing digits (≥ 2, so that
  // brand tokens like 7-ELEVEN survive).
  s = keep(s, s.replace(/\bREF(?:ERENCE)?\b\.?\s*#?\s*\S*/g, " "));
  s = keep(s, s.replace(/\bMANDATE\s+(?:NO|NUMBER)\b\.?\s*\S*/g, " ")); // Santander DD mandate tails
  s = keep(s, s.replace(/(?<![A-Z0-9])(?=(?:[A-Z/-]*\d){2})[A-Z0-9/-]{8,}(?![A-Z0-9/-])/g, " "));
  s = keep(s, s.replace(/#\s*\d+/g, " "));

  // Full UK postcodes anywhere.
  s = keep(s, s.replace(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g, " "));
  s = s.replace(/\s+/g, " ").trim();

  // Trailing noise, repeated until stable: countries, places, outward postcodes, store/terminal
  // numbers, type codes, dangling punctuation.
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = stripTrailing(s, /[\s\-&/.*+#]+$/);
    s = stripTrailing(s, TRAILING_COUNTRY_RE, true);
    s = stripTrailing(s, TRAILING_PLACE_RE, true);
    s = stripMorePlaces(s);
    s = stripTrailing(s, /\s(?:[BEGLMNSW]|[A-Z]{2})\d[A-Z\d]?$/); // outward postcode: SE10, M1, EC1A
    s = stripTrailing(s, /\s#?\d+$/); // store / terminal numbers
    s = stripTrailing(s, TRAILING_CODE_RE);
    if (s === before) break;
  }
  s = s.replace(/^[\s\-&/.*+#]+/, "").trim();

  s = applyKnownForms(s);
  if (s.length > MAX_PAYEE_LENGTH) s = s.slice(0, MAX_PAYEE_LENGTH).trim();
  return s;
}

function applyKnownForms(s: string): string {
  for (const [re, canonical] of KNOWN_FORMS) if (re.test(s)) return canonical;
  return s;
}

/**
 * Normalise a raw payee/descriptor into the merchant key that may be sent for lookup.
 * Deterministic and idempotent. Returns "" only for blank input.
 */
export function normalisePayee(raw: string): string {
  let s = raw ?? "";
  if (!s.trim()) return "";
  for (let i = 0; i < 10; i++) {
    const next = pass(s);
    if (next === s) return next;
    s = next;
  }
  return s;
}
