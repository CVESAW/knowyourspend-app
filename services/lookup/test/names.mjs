// Shop and company names: letters such as Ø and Æ, legal forms written with dots or slashes ("S.A.", "A/S",
// "Sp. z o.o.") for banks outside the UK, and UK names that must not change. No network.
// Run: node services/lookup/test/names.mjs
import { countryFromText, normaliseName, stripLegalSuffix } from "../registries.ts";
import { coreName } from "../ai.ts";
import { cacheKey, nameVariants } from "../lookup.ts";
const ok = (c, m) => { if (!c) process.exitCode = 1; console.log(c ? "ok  " : "FAIL", m); };
// [input, normaliseName, UK rules, rules for a bank abroad]
const cases = [
  ["Østergaard A/S", "OSTERGAARD A S", "OSTERGAARD A S", "OSTERGAARD"], ["Zara España, S.A.", "ZARA ESPANA S A", "ZARA ESPANA S A", "ZARA ESPANA"],
  ["Lidl Polska Sp. z o.o.", "LIDL POLSKA SP Z O O", "LIDL POLSKA SP Z O O", "LIDL POLSKA"], ["Ferrero S.p.A.", "FERRERO S P A", "FERRERO S P A", "FERRERO"],
  ["REWE Markt GmbH", "REWE MARKT GMBH", "REWE MARKT", "REWE MARKT"], ["Aldi GmbH & Co. KG", "ALDI GMBH & CO KG", "ALDI GMBH & CO KG", "ALDI"],
  ["Ahold Delhaize N.V.", "AHOLD DELHAIZE N V", "AHOLD DELHAIZE N V", "AHOLD DELHAIZE"], ["Société Générale S.A.", "SOCIETE GENERALE S A", "SOCIETE GENERALE S A", "SOCIETE GENERALE"],
  ["Straßenbahn", "STRASSENBAHN", "STRASSENBAHN", "STRASSENBAHN"], ["Tim Hortons Ltée", "TIM HORTONS LTEE", "TIM HORTONS LTEE", "TIM HORTONS"],
  ["Alimentation Couche-Tard Inc.", "ALIMENTATION COUCHE TARD INC", "ALIMENTATION COUCHE TARD", "ALIMENTATION COUCHE TARD"], ["Æble Café", "AEBLE CAFE", "AEBLE CAFE", "AEBLE CAFE"],
  ["Łódź Market", "LODZ MARKET", "LODZ MARKET", "LODZ MARKET"], ["Carlsberg A/S", "CARLSBERG A S", "CARLSBERG A S", "CARLSBERG"],
  // UK names: the same as before 14 Oct under UK rules (initials at the end stay; "& CO" leaves "&")
  ["TESCO STORES LTD", "TESCO STORES LTD", "TESCO STORES", "TESCO STORES"], ["THE BODY SHOP UK", "THE BODY SHOP UK", "BODY SHOP", "BODY SHOP"],
  ["Marks & Spencer Group plc", "MARKS & SPENCER GROUP PLC", "MARKS & SPENCER", "MARKS & SPENCER"], ["B & Q", "B & Q", "B & Q", "B & Q"],
  ["K F C", "K F C", "K F C", "K F C"], ["SMITH & CO", "SMITH & CO", "SMITH &", "SMITH"], ["SELFRIDGES & CO", "SELFRIDGES & CO", "SELFRIDGES &", "SELFRIDGES"],
  ["EVANS S L", "EVANS S L", "EVANS S L", "EVANS"], ["SMITH A B", "SMITH A B", "SMITH A B", "SMITH"], ["LONDON ZOO", "LONDON ZOO", "LONDON ZOO", "LONDON ZOO"],
  ["A S", "A S", "A S", "A S"], ["McDonald’s", "MCDONALDS", "MCDONALDS", "MCDONALDS"], ["SQ *THE BEAN HOUSE", "SQ THE BEAN HOUSE", "SQ THE BEAN HOUSE", "SQ THE BEAN HOUSE"],
  ["J D SPORTS", "J D SPORTS", "J D SPORTS", "J D SPORTS"],
];
for (const [inp, n, uk, abroad] of cases) ok(normaliseName(inp) === n && stripLegalSuffix(inp) === uk && stripLegalSuffix(inp, true) === abroad, `${inp} → ${normaliseName(inp)} → UK ${stripLegalSuffix(inp)} | abroad ${stripLegalSuffix(inp, true)}`);
ok(coreName("Carlsberg A/S") === "CARLSBERG" && coreName("Inditex S.A.") === "INDITEX" && coreName("Marks & Spencer Group plc") === "MARKS & SPENCER GROUP", `coreName (company names): ${coreName("Carlsberg A/S")}, ${coreName("Inditex S.A.")}, ${coreName("Marks & Spencer Group plc")}`);
ok(cacheKey("NETTO A/S", "DK") === "DK:NETTO" && cacheKey("TESCO STORES LTD") === "TESCO STORES" && cacheKey("SMITH A S") === "SMITH A S" && cacheKey("SELFRIDGES & CO") === "SELFRIDGES &", `cacheKey: ${cacheKey("NETTO A/S", "DK")}, ${cacheKey("TESCO STORES LTD")}, ${cacheKey("SMITH A S")}, ${cacheKey("SELFRIDGES & CO")}`);
ok(JSON.stringify(nameVariants("EVANS S L")) === JSON.stringify(["EVANS S L", "EVANS S"]), `UK name variants keep the initials: ${JSON.stringify(nameVariants("EVANS S L"))}`);

// Countries named in Companies House filings of who controls a company (17 Oct 2026: every country, whole words, longest first).
for (const [text, iso] of [["Nigeria", "NG"], ["Federal Republic of Nigeria", "NG"], ["Niger", "NE"], ["Georgia, USA", "US"], ["Delaware, United States", "US"], ["New Jersey", "US"], ["Jersey", "JE"],
  ["Republic of Korea", "KR"], ["Korea, Republic Of", "KR"], ["Cayman Islands", "KY"], ["British Virgin Islands", "VG"], ["England And Wales", "GB"], ["Northern Ireland", "GB"], ["Ireland", "IE"],
  ["The Netherlands", "NL"], ["Luxembourg Business Registers", "LU"], ["Hong Kong Sar", "HK"], ["Bermuda", "BM"], ["Romania", "RO"], ["Oman", "OM"], ["Guinea", "GN"], ["Papua New Guinea", "PG"],
  // 18 Oct 2026: official forms that held a shorter name for another country
  ["Democratic People's Republic of Korea", "KP"], ["Korea, Democratic People's Republic of", "KP"], ["Macao, China", "MO"], ["Macau", "MO"], ["China", "CN"],
  ["Congo, The Democratic Republic of the", "CD"], ["Republic of the Congo", "CG"], ["Lao People's Democratic Republic", "LA"],
  ["Macau SAR, China", "MO"], ["Macao Special Administrative Region of China", "MO"], ["Congo (Democratic Republic)", "CD"], ["Hong Kong, China", "HK"],
  ["Taiwan, Province of China", "TW"], ["Northern Ireland, United Kingdom", "GB"], ["Jersey, Channel Islands", "JE"]]) {
  ok(countryFromText(text) === iso, `countryFromText("${text}") → ${countryFromText(text)} (want ${iso})`);
}
ok(countryFromText("Registrar of Companies") === undefined, `no country named: ${countryFromText("Registrar of Companies")}`);
