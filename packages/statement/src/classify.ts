/**
 * classify — decide what kind of movement a row is. Only "spend" rows are ever candidates for
 * sending (and even then the user reviews them). The classifier is deliberately conservative:
 * anything that might be a payment to a person is a "transfer", because a person's name must
 * never leave the device (report §12.6: Lloyds `TFR  D STEPHENS 18MAY19`).
 */
import { normalisePayee } from "./normalise";
import type { TransactionKind } from "./types";

export interface ClassifyInput {
  amount: number;
  /** Payee as stored (bank-cleaned name when available). */
  rawPayee: string;
  /** Raw bank descriptor, if different from rawPayee. */
  rawDescription?: string;
  /** Bank type code/label: "DEB", "Card payment", "CARD_PAYMENT", "Direct Debit"… */
  typeLabel?: string;
  /** Bank category (Monzo/Starling/N26), used only as a weak hint. */
  category?: string;
}

/** What a type code implies before looking at the sign. "bill" = DD/SO/bill payment. */
export type TypeHint = "card" | "refund" | "dd" | "bill" | "transfer" | "income" | "cash" | "fee" | "internal" | "other";

export interface TypeCodeInfo {
  meaning: string;
  hint: TypeHint;
  source: "LBG" | "MSE" | "MoneySorted" | "Revolut PDF" | "unconfirmed";
}

/**
 * UK statement type codes. Lloyds Banking Group's official list (Bank of Scotland payment codes
 * page) is the backbone; MSE's cross-bank glossary and MoneySorted add the rest. There is no
 * cross-bank standard ("CHAPS" at Barclays vs "CHP" at NatWest).
 */
export const UK_TYPE_CODES: Readonly<Record<string, TypeCodeInfo>> = {
  // Lloyds Banking Group (Lloyds / Halifax / Bank of Scotland) — official
  BGC: { meaning: "Bank Giro Credit", hint: "income", source: "LBG" },
  BNS: { meaning: "Bonus", hint: "income", source: "LBG" },
  BP: { meaning: "Bill Payment", hint: "bill", source: "LBG" },
  CHG: { meaning: "Charge", hint: "fee", source: "LBG" },
  CHQ: { meaning: "Cheque", hint: "transfer", source: "LBG" },
  COM: { meaning: "Commission", hint: "fee", source: "LBG" },
  COR: { meaning: "Correction", hint: "other", source: "LBG" },
  CPT: { meaning: "Cashpoint", hint: "cash", source: "LBG" },
  CSH: { meaning: "Cash", hint: "cash", source: "LBG" },
  CSQ: { meaning: "Cash/Cheque", hint: "other", source: "LBG" },
  DD: { meaning: "Direct Debit", hint: "dd", source: "LBG" },
  DEB: { meaning: "Debit Card", hint: "card", source: "LBG" },
  DEP: { meaning: "Deposit", hint: "income", source: "LBG" },
  EFT: { meaning: "EFTPOS", hint: "card", source: "LBG" },
  EUR: { meaning: "Euro Cheque", hint: "other", source: "LBG" },
  FE: { meaning: "Foreign Exchange", hint: "other", source: "LBG" },
  FEE: { meaning: "Fixed Service Charge", hint: "fee", source: "LBG" },
  FPC: { meaning: "Faster Payment Charge", hint: "fee", source: "LBG" },
  FPI: { meaning: "Faster Payment Incoming", hint: "transfer", source: "LBG" },
  FPO: { meaning: "Faster Payment Outgoing", hint: "transfer", source: "LBG" },
  IB: { meaning: "Internet Banking", hint: "transfer", source: "LBG" },
  INT: { meaning: "Interest", hint: "income", source: "LBG" },
  MPI: { meaning: "Mobile Payment Incoming", hint: "transfer", source: "LBG" },
  MPO: { meaning: "Mobile Payment Outgoing", hint: "transfer", source: "LBG" },
  MTG: { meaning: "Mortgage", hint: "dd", source: "LBG" },
  NS: { meaning: "National Savings Dividend", hint: "internal", source: "LBG" },
  NSC: { meaning: "National Savings Certificates", hint: "internal", source: "LBG" },
  OTH: { meaning: "Other", hint: "other", source: "LBG" },
  PAY: { meaning: "Payment", hint: "other", source: "LBG" },
  PSB: { meaning: "Premium Savings Bonds", hint: "internal", source: "LBG" },
  PSV: { meaning: "Paysave", hint: "internal", source: "LBG" },
  SAL: { meaning: "Salary", hint: "income", source: "LBG" },
  SPB: { meaning: "Cashpoint", hint: "cash", source: "LBG" },
  SO: { meaning: "Standing Order", hint: "bill", source: "LBG" },
  STK: { meaning: "Stocks/Shares", hint: "internal", source: "LBG" },
  TD: { meaning: "Dep Term Dec", hint: "internal", source: "LBG" },
  TDG: { meaning: "Term Deposit Gross Interest", hint: "income", source: "LBG" },
  TDI: { meaning: "Dep Term Inc", hint: "internal", source: "LBG" },
  TDN: { meaning: "Term Deposit Net Interest", hint: "income", source: "LBG" },
  TFR: { meaning: "Transfer", hint: "transfer", source: "LBG" },
  UT: { meaning: "Unit Trust", hint: "internal", source: "LBG" },
  SUR: { meaning: "Excess Reject", hint: "other", source: "LBG" },
  // MoneySavingExpert cross-bank glossary
  BBP: { meaning: "Bill Payment", hint: "bill", source: "MSE" },
  BAC: { meaning: "BACS payment", hint: "other", source: "MSE" },
  BACS: { meaning: "BACS payment", hint: "other", source: "MSE" },
  BSP: { meaning: "Branch Single Payment", hint: "transfer", source: "MSE" },
  CDM: { meaning: "Cash & Deposit Machine", hint: "cash", source: "MSE" },
  CHAPS: { meaning: "CHAPS payment", hint: "transfer", source: "MSE" },
  CHP: { meaning: "CHAPS payment", hint: "transfer", source: "MSE" },
  CRE: { meaning: "Credit", hint: "income", source: "MSE" },
  CUI: { meaning: "Centralised Unpaid In", hint: "other", source: "MSE" },
  "D/D": { meaning: "Direct Debit", hint: "dd", source: "MSE" },
  DDR: { meaning: "Direct Debit", hint: "dd", source: "MSE" },
  DIV: { meaning: "Dividend", hint: "income", source: "MSE" },
  DR: { meaning: "Debit / overdrawn", hint: "other", source: "MSE" },
  DWP: { meaning: "Department for Work and Pensions", hint: "income", source: "MSE" },
  ERTF: { meaning: "Exchange Rate Transaction Fee", hint: "fee", source: "MSE" },
  FP: { meaning: "Faster Payment", hint: "transfer", source: "MSE" },
  IBP: { meaning: "Inter-Branch Payment", hint: "transfer", source: "MSE" },
  IMO: { meaning: "International Money Order", hint: "transfer", source: "MSE" },
  ITL: { meaning: "International", hint: "other", source: "MSE" },
  NDC: { meaning: "Non Dividend Counterfoil", hint: "other", source: "MSE" },
  OTR: { meaning: "Online Banking Transaction", hint: "transfer", source: "MSE" },
  POC: { meaning: "Post Office Counters", hint: "cash", source: "MSE" },
  POS: { meaning: "Point of Sale (debit card)", hint: "card", source: "MSE" },
  REV: { meaning: "Reversal", hint: "refund", source: "MSE" },
  "S/O": { meaning: "Standing Order", hint: "bill", source: "MSE" },
  STO: { meaning: "Standing Order", hint: "bill", source: "MSE" },
  SBT: { meaning: "Screen Based Transaction", hint: "transfer", source: "MSE" },
  TEL: { meaning: "Telephone Banking", hint: "transfer", source: "MSE" },
  TLR: { meaning: "Teller", hint: "cash", source: "MSE" },
  UNP: { meaning: "Unpaid", hint: "other", source: "MSE" },
  // Secondary / unconfirmed per-bank codes
  VIS: { meaning: "Visa card transaction", hint: "card", source: "MoneySorted" },
  ATM: { meaning: "Cash machine", hint: "cash", source: "MoneySorted" },
  CR: { meaning: "Credit", hint: "income", source: "MoneySorted" },
  CDR: { meaning: "Credit (Halifax credit card)", hint: "income", source: "MoneySorted" },
  OD: { meaning: "Overdrawn", hint: "other", source: "MoneySorted" },
  "C/L": { meaning: "Cashline (NatWest/RBS ATM)", hint: "cash", source: "unconfirmed" },
  DPC: { meaning: "Digital Banking Payment (NatWest)", hint: "transfer", source: "unconfirmed" },
  ")))": { meaning: "Contactless (HSBC)", hint: "card", source: "unconfirmed" },
  // Revolut PDF statements (the code column; legend printed at the end of the statement)
  CAR: { meaning: "Card payment (Revolut)", hint: "card", source: "Revolut PDF" },
  MOS: { meaning: "Money sent (Revolut)", hint: "transfer", source: "Revolut PDF" },
  MOR: { meaning: "Money received (Revolut)", hint: "income", source: "Revolut PDF" },
  MOA: { meaning: "Money added (Revolut)", hint: "income", source: "Revolut PDF" },
  EXC: { meaning: "Currency exchange (Revolut)", hint: "internal", source: "Revolut PDF" },
  CRF: { meaning: "Card refund (Revolut)", hint: "refund", source: "Revolut PDF" },
};

/**
 * Spelled-out type labels (Monzo, Starling, Revolut, Barclays, Nationwide, N26, Wise), tested in
 * order. Codes are looked up in UK_TYPE_CODES first.
 */
const TYPE_LABEL_RULES: ReadonlyArray<[RegExp, TypeHint]> = [
  [/POT TRANSFER|\bPOT\b|SAVINGS|STARLING TRANSFER|INTERNAL TRANSFER|TOP.?UP|EXCHANGE|CONVERSION|^BALANCE$/, "internal"],
  [/REFUND|REVERSAL/, "refund"],
  [/\bATM\b|CASH/, "cash"],
  [/\bFEES?\b|CHARGE/, "fee"],
  [/CARD|CONTACTLESS|VISA|MASTERCARD|PRESENTMENT|CHIP ?(?:&|AND) ?PIN|ONLINE PAYMENT|APPLE PAY|GOOGLE PAY|^PURCHASE$|^DEBIT$/, "card"],
  [/DIRECT DEBIT/, "dd"],
  [/STANDING ORDER|BILL PAYMENT|^PAYMENT TO$|^PAYMENT$/, "bill"],
  [/TRANSFER|FASTER PAYMENT|CHAPS|SENT MONEY|MONZO-TO-MONZO|P2P|^PAYMENT FROM$/, "transfer"],
  [/SALARY|INTEREST|INCOME|CREDIT|DEPOSIT|DIVIDEND|^BACS/, "income"],
];

/** Look up what a bank type code / label implies. */
export function typeHint(typeLabel: string | undefined): TypeHint | null {
  if (!typeLabel) return null;
  const t = typeLabel.trim().toUpperCase().replace(/\s+/g, " ");
  if (!t) return null;
  const code = UK_TYPE_CODES[t];
  if (code) return code.hint;
  const words = t.replace(/_/g, " "); // CARD_PAYMENT → CARD PAYMENT
  for (const [re, hint] of TYPE_LABEL_RULES) if (re.test(words)) return hint;
  return null;
}

/** Hints from the start of a raw descriptor when the file has no type column (HSBC, Santander). */
const DESCRIPTION_PREFIX_RULES: ReadonlyArray<[RegExp, TypeHint]> = [
  [/^(?:CARD PAYMENT|CARD PURCHASE|VISA PURCHASE|DEBIT CARD|CONTACTLESS|VIS|POS|DEB|PURCHASE)\b/, "card"],
  [/^(?:DIRECT DEBIT|DD|DDR|D\/D)\b/, "dd"],
  [/^(?:STANDING ORDER|SO|STO|S\/O|BILL PAYMENT|BP|BBP)\b/, "bill"],
  [/^(?:FASTER PAYMENT|FPO|FPI|TFR|TRANSFER|BANK TRANSFER|TO A\/C|SENT MONEY TO|RECEIVED MONEY FROM|MOBILE PAYMENT)\b/, "transfer"],
  [/^(?:CASH WITHDRAWAL|CASHPOINT|ATM|CPT|LINK)\b/, "cash"],
  [/^(?:CARD TRANSACTION OF)\b/, "card"], // Wise
  [/^(?:REFUND|REVERSAL)\b/, "refund"],
];

// Money moving between the user's own accounts / e-money wallets / card repayments.
const INTERNAL_TEXT =
  /\bPOTS?\b|TO SAVINGS|FROM SAVINGS|SAVINGS (?:POT|ACCOUNT|SPACE)|\bTOP[- ]?UP\b|\bTOPUP\b|\bEXCHANGED?\s+(?:TO|FROM)\b|\bCONVERTED\b|PAYMENT RECEIVED|THANK YOU|OWN ACCOUNT|\bADD TO BAL(?:ANCE)?\b/;
const CARD_REPAYMENT = /\b(?:CREDIT CARD|BARCLAYCARD|AMERICAN EXPRESS|AMEX|MBNA|CAPITAL ONE|VANQUIS|AQUA CARD)\b/;
// Money moved into the user's own wallets (a bank transfer to PayPal funds their PayPal balance; card payments via PayPal still count as spend)
const OWN_WALLET = /^(?:REVOLUT|MONZO|TRANSFERWISE|WISE|CURVE|PAYPAL)\b/;
const CASH_TEXT = /\bATM\b|CASH WITHDRAWAL|CASH MACHINE|CASHPOINT|NOTEMACHINE|\bCPT\b/;
const FEE_TEXT =
  /\b(?:ACCOUNT FEE|MONTHLY FEE|MONTHLY ACCOUNT FEE|OVERDRAFT (?:FEE|INTEREST|CHARGE)|NON[- ]STERLING|FOREIGN (?:TRANSACTION|EXCHANGE) FEE|TRANSACTION FEE|ARRANGED OVERDRAFT|UNARRANGED OVERDRAFT|INTEREST CHARGED|BANK CHARGES?|SERVICE CHARGE|DEBIT INTEREST)\b/;
const REFUND_TEXT = /\bREFUND\b|\bREVERSAL\b|\bREFD\b/;
// Descriptor text that means "payment to a person/account" whatever the type column says.
const TRANSFER_TEXT = /FASTER PAYMENTS?|\bFPO\b|\bTFR\b|TRANSFER TO|BANK TRANSFER|MOBILE PAYMENT|SENT MONEY TO|MONZO-TO-MONZO/;
const CARD_MARKERS = /\)\)\)|\*|\.COM\b|\.CO\.UK\b|\bWWW\.|\s\d{3,}\b|\b(?:GB|GBR|UK|IRL|USA|LUX)$/;

/**
 * Words that mark an organisation. A Faster Payment / transfer / standing order payee containing
 * one of these may be classified as spend; without one it stays a transfer.
 */
const ORG_WORDS =
  /\b(?:LTD|LIMITED|PLC|LLP|INC|CORP|CO|COMPANY|GROUP|HOLDINGS|SERVICES|COUNCIL|BOROUGH|HMRC|DVLA|TV LICEN[CS]E|ENERGY|ELECTRIC|GAS|WATER|POWER|INSURANCE|ASSURANCE|MORTGAGE|LETTINGS|ESTATES?|PROPERTY|HOUSING|ASSOCIATION|SOCIETY|TRUST|CHARITY|FOUNDATION|UNIVERSITY|COLLEGE|SCHOOL|NURSERY|GYM|FITNESS|CLUB|BANK|BUILDING SOCIETY|TELECOM|MOBILE|BROADBAND|STORES?|SHOP|SUPERMARKETS?|MARKET|COFFEE|CAFE|RESTAURANT|KITCHEN|PIZZA|PUB|BAR|HOTEL|TRAVEL|RAIL|TRAINS?|AIRWAYS|AIRLINES|TAXIS?|CARS|MOTORS|GARAGE|PHARMACY|DENTAL|CLINIC|SURGERY|NHS|FOODS?|BAKERY|BUTCHERS?|DELI|SALON|BARBERS?)\b/;

/** Brands likely to appear without an org word; used to stop "COSTA", "PRET A MANGER" looking like people. */
export const COMMON_BRANDS: readonly string[] = [
  "TESCO", "SAINSBURYS", "SAINSBURY", "ASDA", "MORRISONS", "WAITROSE", "ALDI", "LIDL", "ICELAND", "COOP", "CO-OP",
  "MARKS", "M&S", "BOOTS", "SUPERDRUG", "GREGGS", "COSTA", "STARBUCKS", "PRET", "NERO", "MCDONALDS", "KFC",
  "NANDOS", "SUBWAY", "DOMINOS", "DELIVEROO", "JUST EAT", "UBER", "NETFLIX", "SPOTIFY", "AMAZON", "APPLE",
  "GOOGLE", "MICROSOFT", "DISNEY", "SKY", "VIRGIN", "BT", "EE", "O2", "VODAFONE", "THREE", "TFL", "TRAINLINE",
  "SHELL", "BP", "ESSO", "TEXACO", "ARGOS", "CURRYS", "IKEA", "PRIMARK", "NEXT", "ZARA", "H&M", "UNIQLO",
  "JOHN LEWIS", "WILKO", "B&Q", "HOMEBASE", "SCREWFIX", "WICKES", "HALFORDS", "EBAY", "PAYPAL", "ETSY",
  "ASOS", "BOOHOO", "SHEIN", "TEMU", "ALIEXPRESS", "EASYJET", "RYANAIR", "BRITISH AIRWAYS", "PREMIER INN",
  "TRAVELODGE", "AIRBNB", "BOOKING", "WETHERSPOON", "LEON", "WASABI", "ITSU", "FIVE GUYS", "BURGER KING",
  "PIZZA EXPRESS", "WAGAMAMA", "DUNELM", "POUNDLAND", "SPECSAVERS", "HOLLAND", "SCREWFIX",
];
const BRAND_RE = new RegExp(`^(?:${COMMON_BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&")).join("|")})\\b`);

const HONORIFICS = /^(?:MR|MRS|MS|MISS|MX|DR|PROF|SIR)\.?\s+/;
const MONTHS = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC";

/**
 * Does this look like a person's name? "J SMITH", "D STEPHENS 18MAY19", "Jane Smith",
 * "MR J A SMITH". Two to four alphabetic tokens (initials allowed), no organisation words, not a
 * known brand. Used only for transfer-ish rows; card payments are never re-routed by it.
 */
export function looksLikePerson(raw: string): boolean {
  let s = raw
    .toUpperCase()
    .replace(/[‘’']/g, "")
    .replace(new RegExp(`\\b\\d{1,2}(?:${MONTHS})\\d{2,4}\\b`, "g"), " ") // 18MAY19
    .replace(/\b(?:REF|REFERENCE)\b.*$/, " ")
    .replace(/[^A-Z&\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:TO|FROM)\s+/, "")
    .replace(HONORIFICS, "");
  if (!s) return false;
  if (ORG_WORDS.test(s) || BRAND_RE.test(s)) return false;
  const tokens = s.split(" ");
  if (tokens.length < 2 || tokens.length > 4) return false;
  if (!tokens.every((t) => /^[A-Z][A-Z-]{0,19}$/.test(t))) return false;
  // At least one token must be a plausible surname (≥ 2 letters).
  return tokens.some((t) => t.length >= 2);
}

function hasOrgMarker(s: string): boolean {
  return ORG_WORDS.test(s) || BRAND_RE.test(s);
}

/** Classify one row. Deterministic; no network. */
export function classify(row: ClassifyInput): TransactionKind {
  const amount = row.amount;
  const payee = (row.rawPayee ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  const desc = (row.rawDescription ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  const text = `${payee} ${desc}`.trim();
  const category = (row.category ?? "").toUpperCase().trim();
  let hint = typeHint(row.typeLabel);
  if (!hint || hint === "other") {
    const src = desc || payee;
    hint = DESCRIPTION_PREFIX_RULES.find(([re]) => re.test(src))?.[1] ?? hint;
  }

  if (!Number.isFinite(amount) || amount === 0) return "unknown";
  if ((hint === null || hint === "other" || hint === "bill" || hint === "income") && TRANSFER_TEXT.test(text)) {
    hint = "transfer";
  }

  // Own-money movements first, for both signs (pots, savings, top-ups, conversions, card repayments).
  if (hint === "internal" || INTERNAL_TEXT.test(text) || category === "SAVINGS") return "internal";

  if (amount > 0) {
    if (hint === "refund" || hint === "card" || REFUND_TEXT.test(text)) return "refund";
    return "income";
  }

  // amount < 0
  const personish = looksLikePerson(payee) || looksLikePerson(normalisePayee(payee));
  // Cash beats card: Monzo/Revolut report ATM withdrawals as card transactions.
  if (hint === "cash" || category === "CASH" || (hint !== "dd" && CASH_TEXT.test(text))) return "cash";
  if (hint === "fee" || FEE_TEXT.test(text)) return "fee";
  if ((hint === "dd" || hint === "transfer" || hint === "bill") && CARD_REPAYMENT.test(payee)) return "internal";
  if (hint !== "card" && hint !== "dd" && OWN_WALLET.test(payee)) return "internal";

  switch (hint) {
    case "card":
    case "refund":
      return "spend";
    case "dd":
      return "spend"; // Direct Debits can only be set up by organisations.
    case "bill":
      return personish ? "transfer" : "spend";
    case "transfer":
      // Conservative: a Faster Payment / transfer is only spend with a clear organisation marker.
      return hasOrgMarker(payee) && !personish ? "spend" : "transfer";
    case "income":
      return personish ? "transfer" : "spend";
    default:
      break;
  }

  // No usable type information (HSBC-style files): fall back to the descriptor.
  if (category === "TRANSFERS") return "transfer";
  if (CASH_TEXT.test(text)) return "cash";
  if (CARD_MARKERS.test(desc || payee)) return "spend";
  if (personish) return "transfer";
  if (hasOrgMarker(payee)) return "spend";
  const tokens = payee.split(" ").filter((t) => /[A-Z]/.test(t));
  // Single-word payees (NETFLIX, SPOTIFY) are merchants; other unknown multi-word strings could
  // be a person — stay conservative.
  return tokens.length <= 1 ? "spend" : "transfer";
}
