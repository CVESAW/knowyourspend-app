/**
 * Sensitive-merchant detection. A payee that reveals health, sexuality, beliefs, politics, union
 * membership, gambling or debt is special-category-adjacent data (report: CJEU *Lindenapotheke*,
 * ICO inferred-data guidance). Such rows are pre-unticked in the review step and excluded from
 * any sharing. Over-flagging only costs a lookup; under-flagging leaks — so the lists lean wide.
 *
 * Matching is on the NORMALISED payee, whole words, uppercase.
 */

export type SensitiveCategory =
  | "health"
  | "gambling"
  | "dating"
  | "politics"
  | "union"
  | "religion"
  | "debt"
  | "adult";

export const SENSITIVE_CATEGORY_LABELS: Readonly<Record<SensitiveCategory, string>> = {
  health: "Health & medical",
  gambling: "Gambling",
  dating: "Dating",
  politics: "Political parties",
  union: "Trade unions",
  religion: "Religious organisations",
  debt: "Payday lending & debt collection",
  adult: "Adult content",
};

/** Keywords matched as whole words anywhere in the normalised payee. Exported for UI display. */
export const SENSITIVE_KEYWORDS: Readonly<Record<SensitiveCategory, readonly string[]>> = {
  health: [
    "CLINIC", "DENTAL", "DENTIST", "DENTISTS", "DENTISTRY", "ORTHODONTIC", "ORTHODONTICS", "PHARMACY",
    "CHEMIST", "CHEMISTS", "GP", "GP SURGERY", "SURGERY", "MEDICAL CENTRE", "HEALTH CENTRE", "HOSPITAL",
    "NHS", "THERAPY", "THERAPIST", "PHYSIOTHERAPY", "PHYSIO", "COUNSELLING", "COUNSELING", "COUNSELLOR",
    "PSYCHOLOGIST", "PSYCHOLOGY", "PSYCHIATRIST", "PSYCHIATRY", "PSYCHOTHERAPY", "OSTEOPATH", "CHIROPRACTOR",
    "IVF", "FERTILITY", "SEXUAL HEALTH", "BPAS", "MSI REPRODUCTIVE", "OPTICIAN", "OPTICIANS", "BUPA",
    "HEALTHCARE", "SPIRE HEALTHCARE", "NUFFIELD HEALTH", "DOCTOR", "DOCTORS", "PUSH DOCTOR", "LIVI",
    "BETTERHELP", "TALKSPACE", "REHAB", "REHABILITATION", "DETOX", "PRESCRIPTION", "LLOYDSPHARMACY",
    "MEDICAL", "HOSPICE",
    // Support services: mental health, abuse, bereavement, addiction (added 2026-10-10)
    "SAMARITANS", "MIND", "REFUGE", "WOMENS AID", "RAPE CRISIS", "VICTIM SUPPORT", "CRUSE", "RELATE",
    "ALCOHOLICS ANONYMOUS", "NARCOTICS ANONYMOUS", "TURNING POINT", "CHILDLINE", "SHOUT 85258",
  ],
  gambling: [
    "BET365", "BET 365", "PADDY POWER", "PADDYPOWER", "WILLIAM HILL", "WILLIAMHILL", "SKYBET", "SKY BET",
    "LADBROKES", "CORAL", "BETFAIR", "BETFRED", "BETWAY", "UNIBET", "888", "888SPORT", "888CASINO",
    "BOYLESPORTS", "BETVICTOR", "SPORTING INDEX", "CASINO", "POKER", "POKERSTARS", "PARTYPOKER", "BINGO",
    "GALA", "GROSVENOR", "TOMBOLA", "JACKPOTJOY", "VIRGIN GAMES", "LOTTERY", "NATIONAL LOTTERY",
    "LOTTO", "EUROMILLIONS", "BETTING", "BOOKMAKER", "BOOKMAKERS", "SLOTS", "BETANO", "LOTTOLAND",
    "PUNTER", "SPREADEX", "GAMCARE", "GAMBLERS ANONYMOUS",
  ],
  dating: [
    "TINDER", "HINGE", "BUMBLE", "GRINDR", "MATCH COM", "MATCH GROUP", "FEELD", "PLENTY OF FISH",
    "PLENTYOFFISH", "POF", "OKCUPID", "EHARMONY", "BADOO", "RAYA", "ZOOSK", "ELITE SINGLES",
    "ELITESINGLES", "DATING", "HER APP", "LUXY", "INNER CIRCLE", "COFFEE MEETS BAGEL", "SCRUFF",
  ],
  politics: [
    "LABOUR PARTY", "CONSERVATIVE PARTY", "CONSERVATIVE AND UNIONIST", "CONSERVATIVES", "LIBERAL DEMOCRATS",
    "LIB DEMS", "LIBDEMS", "GREEN PARTY", "REFORM UK", "SNP", "SCOTTISH NATIONAL PARTY", "PLAID CYMRU",
    "SINN FEIN", "DUP", "UKIP", "ALLIANCE PARTY", "SDLP", "YOUR PARTY", "POLITICAL PARTY", "LABOUR",
    "MOMENTUM",
  ],
  union: [
    "TRADE UNION", "UNISON", "UNITE THE UNION", "GMB", "NEU", "NASUWT", "UCU", "PCS UNION", "RMT", "ASLEF",
    "CWU", "USDAW", "RCN", "ROYAL COLLEGE OF NURSING", "BMA", "PROSPECT UNION", "FBU", "NAHT", "EIS",
    "COMMUNITY UNION", "EQUITY UNION", "MUSICIANS UNION", "NUJ",
  ],
  religion: [
    "CHURCH", "MOSQUE", "SYNAGOGUE", "TEMPLE", "GURDWARA", "MANDIR", "PARISH", "DIOCESE", "CATHEDRAL",
    "CHAPEL", "ISLAMIC", "ISLAMIC RELIEF", "MUSLIM", "JEWISH", "CHRISTIAN", "MINISTRIES", "KINGDOM HALL",
    "QUAKER", "QUAKERS", "HINDU", "SIKH", "BUDDHIST", "TITHE", "ZAKAT", "SADAQAH", "TZEDAKAH",
    "SALVATION ARMY", "CHRISTIAN AID", "TEARFUND",
  ],
  debt: [
    "PAYDAY", "QUICKQUID", "WONGA", "LENDING STREAM", "LENDINGSTREAM", "MR LENDER", "DRAFTY", "CASHFLOAT",
    "PEACHY", "SATSUMA", "MONEYBOAT", "POLAR CREDIT", "BRIGHTHOUSE", "PROVIDENT", "LOWELL", "CABOT",
    "CABOT FINANCIAL", "INTRUM", "STEPCHANGE", "PAYPLAN", "DEBT", "DEBT COLLECTION", "BAILIFF", "BAILIFFS",
    "MARSTON", "ARROW GLOBAL", "HOIST", "PRA GROUP", "MOORCROFT", "LINK FINANCIAL", "CAPQUEST",
    "CREDIT RESOLVE", "RESOLVECALL", "BW LEGAL", "IVA", "DEBT MANAGEMENT",
  ],
  adult: [
    "ONLYFANS", "FANSLY", "PORNHUB", "BRAZZERS", "CHATURBATE", "STRIPCHAT", "LIVEJASMIN", "CAMSODA",
    "MANYVIDS", "ADULT", "XXX", "ANN SUMMERS", "LOVEHONEY", "SEX SHOP", "ESCORT", "ESCORTS", "ADULTWORK",
    "CLIPS4SALE", "XHAMSTER",
  ],
};

/**
 * Whole-string matches for keys the normaliser reduces to an ambiguous word
 * (MATCH.COM → MATCH, REFORM UK → REFORM, UNITE THE UNION may appear as UNITE).
 */
export const SENSITIVE_EXACT: Readonly<Record<string, SensitiveCategory>> = {
  MATCH: "dating",
  HER: "dating",
  REFORM: "politics",
  UNITE: "union",
  PCS: "union",
  PROSPECT: "union",
  EQUITY: "union",
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
}

const CATEGORY_RES: ReadonlyArray<[SensitiveCategory, RegExp]> = (
  Object.entries(SENSITIVE_KEYWORDS) as [SensitiveCategory, readonly string[]][]
).map(([cat, words]) => [
  cat,
  new RegExp(`(?:^|[^A-Z0-9])(?:${[...words].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![A-Z0-9])`),
]);

/** Which sensitive category (if any) a normalised payee falls into. */
export function sensitiveCategory(normPayee: string): SensitiveCategory | null {
  const s = (normPayee ?? "").toUpperCase().replace(/[.]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const exact = SENSITIVE_EXACT[s];
  if (exact) return exact;
  for (const [cat, re] of CATEGORY_RES) if (re.test(s)) return cat;
  return null;
}

export function isSensitive(normPayee: string): boolean {
  return sensitiveCategory(normPayee) !== null;
}
