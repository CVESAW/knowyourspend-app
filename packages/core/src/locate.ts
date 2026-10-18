import placesJson from "../data/places.json";
import { countries } from "@kys/ownership";

/**
 * Where was this payment made? Read from clues the bank already prints, on the device only:
 *  1. a country code or country name at the end ("… PARIS FR", "… BARCELONA ESP", "… UNITED STATES")
 *  2. a town or city at the end ("… MALAGA", "… LISBOA")
 *  3. the web address ending (".FR", ".DE", ".CO.UK")
 *  4. the currency the shop charged in, when it's mainly one country's ("THB 250.00"), since 18 Oct 2026
 *  5. otherwise the user's home country — card payments with nothing foreign printed are made at home.
 *
 * Used for shops we can't name an owner for: an unlisted café in Lewisham is almost certainly owned in the
 * UK, and an unlisted taverna in Malaga in Spain. Shown as "Estimated", never as a named owner.
 */

export type LocationEvidence = "country_code" | "country_name" | "place" | "web_domain" | "currency" | "home";

export interface Location {
  country: string; // ISO2
  evidence: LocationEvidence;
  /** the text that gave it away, e.g. "FR", "MALAGA", ".DE" */
  clue?: string;
}

const PLACES = (placesJson as unknown as { places: Record<string, string[]> }).places;

/** ISO 3166 alpha-3 → alpha-2 for codes terminals print. Codes that are everyday words (AND, ARE, COM, PER, MAR, CAN, GUY, BEN) are left out. */
const ALPHA3: Readonly<Record<string, string>> = {
  GBR: "GB", IRL: "IE", FRA: "FR", DEU: "DE", ESP: "ES", ITA: "IT", NLD: "NL", BEL: "BE", LUX: "LU", PRT: "PT",
  CHE: "CH", AUT: "AT", SWE: "SE", NOR: "NO", DNK: "DK", FIN: "FI", POL: "PL", CZE: "CZ", SVK: "SK", HUN: "HU",
  GRC: "GR", CYP: "CY", MLT: "MT", HRV: "HR", SVN: "SI", ROU: "RO", BGR: "BG", EST: "EE", LVA: "LV", LTU: "LT",
  ISL: "IS", TUR: "TR", USA: "US", MEX: "MX", BRA: "BR", ARG: "AR", AUS: "AU", NZL: "NZ", JPN: "JP", CHN: "CN",
  HKG: "HK", SGP: "SG", THA: "TH", IND: "IN", SAU: "SA", QAT: "QA", ISR: "IL", EGY: "EG", ZAF: "ZA",
  KOR: "KR", TWN: "TW", MYS: "MY", IDN: "ID", PHL: "PH", VNM: "VN", JEY: "JE", GGY: "GG", IMN: "IM",
  GIB: "GI",
};

/**
 * Two-letter codes trusted at the end of a descriptor even without padding. Codes that are common words or
 * brand endings (IT, AT, NO, BE, IS, IN, ME, AM, TO, AS, US, CO, DE, OR, MY, ID, SO, GO, HE, OK, PA, LA) need
 * padding (several spaces before them) or a known town before them.
 */
const SAFE_ALPHA2 = new Set([
  "GB", "IE", "FR", "ES", "NL", "PT", "LU", "CH", "SE", "DK", "FI", "PL", "GR", "CZ", "HR", "CY", "MT", "HU", "RO",
  "BG", "SK", "SI", "EE", "LV", "LT", "TR", "AU", "NZ", "JP", "CN", "HK", "SG", "TH", "AE", "SA", "QA", "IL", "ZA",
  "MX", "BR", "AR", "KR", "TW", "JE", "GG", "IM", "GI", "UK",
]);

const COUNTRY_NAMES: ReadonlyArray<[string, string]> = (() => {
  const out: [string, string][] = [];
  for (const [iso, info] of Object.entries(countries)) out.push([norm(info.name), iso]);
  out.push(["UNITED STATES OF AMERICA", "US"], ["UNITED STATES", "US"], ["UNITED KINGDOM", "GB"], ["GREAT BRITAIN", "GB"],
    ["ENGLAND", "GB"], ["SCOTLAND", "GB"], ["WALES", "GB"], ["NORTHERN IRELAND", "GB"], ["HOLLAND", "NL"], ["DEUTSCHLAND", "DE"],
    ["ESPANA", "ES"], ["ITALIA", "IT"], ["NEDERLAND", "NL"], ["SUISSE", "CH"], ["SCHWEIZ", "CH"], ["OSTERREICH", "AT"]);
  return out.filter(([n]) => n.length >= 4).sort((a, b) => b[0].length - a[0].length);
})();

const TLD_COUNTRY: Readonly<Record<string, string>> = {
  "CO.UK": "GB", UK: "GB", IE: "IE", FR: "FR", DE: "DE", ES: "ES", IT: "IT", NL: "NL", BE: "BE", LU: "LU", PT: "PT",
  AT: "AT", CH: "CH", SE: "SE", DK: "DK", NO: "NO", FI: "FI", PL: "PL", GR: "GR", CZ: "CZ", JP: "JP", AU: "AU",
  "COM.AU": "AU", NZ: "NZ", "CO.NZ": "NZ", CA: "CA", "COM.BR": "BR", MX: "MX", "COM.MX": "MX", IN: "IN", "CO.IN": "IN",
};

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/['‘’`]/g, "")
    .replace(/[^A-Z0-9&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip the tail noise banks add after the location: amounts, dates, card digits, references, "ON 12 MAR". */
function tailTokens(raw: string): { tokens: string[]; padded: boolean } {
  // Web addresses are read separately (step 3): "ZALANDO.CO.UK" must not look like the country code "UK". The address
  // stays as one word, as it's the shop's name: "WWW.EXAMPLETAXI.COM BANGKOK" was paid in Bangkok (18 Oct 2026). No
  // spaces are added round it, so they can't look like a terminal's padding.
  let s = raw.toUpperCase().replace(/(?:HTTPS?:\/\/)?(?:[A-Z0-9-]+\.)+[A-Z]{2,6}(?:\/\S*)?/g, "WEBADDRESS");
  s = s.replace(/\s+ON\s+\d{1,2}[\s-]?[A-Z]{3}.*$/, "").replace(/\s+ON\s+\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}.*$/, "");
  // Terminals pad fixed-width fields: "SHOP NAME        PARIS        FR". Padding before the last word makes
  // even a word-like two-letter code safe to read as a country.
  const padded = /\s{2,}[A-Z]{2}$/.test(s.replace(/[\s\d.,:/-]+$/, ""));
  const tokens = norm(s).split(" ").filter((t) => t && !/^\d+$/.test(t) && !/^\d+[A-Z]*\d*$/.test(t));
  // Drop trailing currency codes and bank codes that often follow the location ("… BANGKOK THB 250.00"). Codes that are
  // also words (PEN, TRY, MAD, COP) stay.
  const code = (t: string) => /^(?:GBP|EUR|USD|CR|DR|POS|VIS|DEB|BCC|CLP)$/.test(t) || (!!CURRENCY_COUNTRY[t] && !/^(?:PEN|TRY|MAD|COP)$/.test(t));
  while (tokens.length && code(tokens[tokens.length - 1]!)) tokens.pop();
  return { tokens, padded };
}

/** US state codes, read as the US when a US town comes before them ("SAN DIEGO CA", "NEW YORK NY"). */
const US_STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));
/** Words that can't be a shop name on their own: "THE ROYAL OAK" is a pub, not Royal Oak, Michigan. */
const FILLER = new Set(["THE", "A", "AN", "AND", "OF", "LE", "LA", "LES", "EL", "DE", "DA", "DI", "IL", "AT", "TO", "YE", "OLD", "NEW", "YE", "BAR", "CAFE", "PUB", "INN"]);

function placeCountry(name: string, home: string): string | undefined {
  const cs = PLACES[name];
  if (!cs?.length) return undefined;
  if (cs.includes(home)) return home;
  return cs.length === 1 ? cs[0] : undefined; // ambiguous across other countries: no clue
}

/** Look at the end of the descriptor for a town (up to 3 words), returning [country, place, wordsUsed]. */
function trailingPlace(tokens: string[], home: string, end = tokens.length): [string, string, number] | undefined {
  for (let n = Math.min(3, end - 1); n >= 1; n--) {
    // What's left before the town must look like a shop name, not just "THE" or "CAFE".
    if (!tokens.slice(0, end - n).some((t) => t.length >= 3 && !FILLER.has(t))) continue;
    const name = tokens.slice(end - n, end).join(" ");
    const c = placeCountry(name, home);
    if (c) return [c, name, n];
  }
  return undefined;
}

export function locate(texts: (string | undefined)[], home = "GB"): Location {
  for (const raw of texts) {
    if (!raw) continue;
    const { tokens, padded } = tailTokens(raw);
    if (tokens.length >= 2) {
      const last = tokens[tokens.length - 1]!;
      // 1a. alpha-3 code at the end
      const a3 = ALPHA3[last];
      if (a3) return { country: a3, evidence: "country_code", clue: last };
      // 1b. alpha-2 code at the end: trusted when safe, padded, or right after a town in that country
      if (/^[A-Z]{2}$/.test(last)) {
        const iso = last === "UK" ? "GB" : last;
        const known = (countries as Record<string, unknown>)[iso] !== undefined;
        const before = trailingPlace(tokens, home, tokens.length - 1);
        if (known && (SAFE_ALPHA2.has(last) || padded || (before && PLACES[before[1]]?.includes(iso)))) {
          return { country: iso, evidence: "country_code", clue: last };
        }
        if (US_STATES.has(last) && before && PLACES[before[1]]?.includes("US")) {
          return { country: "US", evidence: "place", clue: `${before[1]} ${last}` };
        }
      }
      // 1c. country name at the end ("… UNITED STATES", "… NETHERLANDS")
      const tail = ` ${tokens.slice(-4).join(" ")}`;
      for (const [name, iso] of COUNTRY_NAMES) {
        if (tail.endsWith(` ${name}`) && tokens.length > name.split(" ").length) return { country: iso, evidence: "country_name", clue: name };
      }
      // 2. town at the end (never the whole descriptor: "BRISTOL" alone may be the shop's name)
      const p = trailingPlace(tokens, home);
      if (p && p[2] < tokens.length) return { country: p[0], evidence: "place", clue: p[1] };
    }
    // 3. web address ending
    const dom = raw.toUpperCase().match(/[A-Z0-9-]+\.((?:CO|COM)\.[A-Z]{2}|[A-Z]{2})(?=$|[^A-Z0-9.])/);
    if (dom) {
      const iso = TLD_COUNTRY[dom[1]!];
      if (iso) return { country: iso, evidence: "web_domain", clue: `.${dom[1]!.toLowerCase()}` };
    }
  }
  // 4. the currency the shop charged in, when it's mainly one country's ("THB 250.00": Thailand). Euros don't say which
  // country, and pounds are home.
  for (const raw of texts) {
    const m = raw?.toUpperCase().match(PAID_IN_RE);
    const ccy = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4];
    if (ccy && CURRENCY_COUNTRY[ccy]) return { country: CURRENCY_COUNTRY[ccy]![0], evidence: "currency", clue: ccy };
  }
  return { country: home, evidence: "home" };
}

/** A currency → [the country it belongs to, its name]. Only currencies that are mainly one country's. */
export const CURRENCY_COUNTRY: Readonly<Record<string, readonly [string, string]>> = {
  USD: ["US", "US dollars"], CAD: ["CA", "Canadian dollars"], AUD: ["AU", "Australian dollars"], NZD: ["NZ", "New Zealand dollars"],
  JPY: ["JP", "Japanese yen"], CNY: ["CN", "Chinese yuan"], HKD: ["HK", "Hong Kong dollars"], SGD: ["SG", "Singapore dollars"],
  THB: ["TH", "Thai baht"], VND: ["VN", "Vietnamese dong"], IDR: ["ID", "Indonesian rupiah"], MYR: ["MY", "Malaysian ringgit"],
  PHP: ["PH", "Philippine pesos"], KRW: ["KR", "South Korean won"], TWD: ["TW", "Taiwan dollars"], INR: ["IN", "Indian rupees"],
  LKR: ["LK", "Sri Lankan rupees"], AED: ["AE", "UAE dirhams"], SAR: ["SA", "Saudi riyals"], QAR: ["QA", "Qatari riyals"],
  ILS: ["IL", "Israeli shekels"], EGP: ["EG", "Egyptian pounds"], MAD: ["MA", "Moroccan dirhams"], TRY: ["TR", "Turkish lira"],
  ZAR: ["ZA", "South African rand"], KES: ["KE", "Kenyan shillings"], MXN: ["MX", "Mexican pesos"], BRL: ["BR", "Brazilian reais"],
  ARS: ["AR", "Argentine pesos"], COP: ["CO", "Colombian pesos"], PEN: ["PE", "Peruvian soles"], CHF: ["CH", "Swiss francs"],
  NOK: ["NO", "Norwegian kroner"], SEK: ["SE", "Swedish kronor"], DKK: ["DK", "Danish kroner"], ISK: ["IS", "Icelandic krónur"],
  PLN: ["PL", "Polish złoty"], CZK: ["CZ", "Czech koruna"], HUF: ["HU", "Hungarian forint"], RON: ["RO", "Romanian lei"],
  RSD: ["RS", "Serbian dinars"],
};
/**
 * "THB 250.00", "THB250.00", "300.00 THB", "JPY 1,200": a currency code next to an amount with pence; whole amounts
 * (after a space) only for money that has no pence in practice (yen, won, dong…). So "TRY 100 DAYS", "MAD123456" and
 * "12.50 PEN-Y-BONT" (a code followed by more of a word) aren't.
 */
const DEC = "\\d[\\d,]*\\.\\d{2}";
const WHOLE = "(?:\\d{1,3}(?:,\\d{3})+|\\d{3,})";
const ALL_CCY = Object.keys(CURRENCY_COUNTRY).join("|");
const NO_PENCE = "JPY|KRW|VND|IDR|ISK|HUF|TWD";
const PAID_IN_RE = new RegExp(
  `\\b(?:(${ALL_CCY}) ?${DEC}|(${NO_PENCE}) ${WHOLE})(?![\\d.,])|(?<![\\d.,])(?:${DEC} ?(${ALL_CCY})|${WHOLE} (${NO_PENCE}))(?![\\w-])`,
);

export const EVIDENCE_LABEL: Readonly<Record<LocationEvidence, string>> = {
  country_code: "country code on your statement",
  country_name: "country named on your statement",
  place: "town named on your statement",
  web_domain: "the shop's web address",
  currency: "the currency the shop charged in",
  home: "paid at home (nothing foreign on the statement)",
};
