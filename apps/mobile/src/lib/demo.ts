import { parseStatement } from "@kys/statement";
import { prepareStatement, saveReceipt, saveStatement, newItemId } from "./ingest";
import { parseReceiptText } from "./receipt";
import { store } from "./store";
import { ensureOpenBrands } from "@kys/core/ownership";
import type { Disclosure } from "./types";

/**
 * Demo data: a made-up Monzo-format statement and one supermarket receipt, run through the
 * exact same on-device pipeline as real files. Nothing is fetched — it is all in this file.
 */

type Row = [name: string, desc: string, type: string, amount: number];

const MONTHLY: Row[] = [
  ["Tesco", "TESCO STORES 3456 LONDON GBR", "Card payment", -64.2],
  ["Tesco", "TESCO STORES 3456 LONDON GBR", "Card payment", -38.75],
  ["Sainsbury's", "SAINSBURYS S/MKTS LONDON GBR", "Card payment", -42.1],
  ["Lidl", "LIDL GB LONDON GBR", "Card payment", -27.3],
  ["Aldi", "ALDI 84 GREENWICH GBR", "Card payment", -31.6],
  ["Costa Coffee", "COSTA COFFEE 43012 LONDON GBR", "Card payment", -3.4],
  ["Costa Coffee", "COSTA COFFEE 43012 LONDON GBR", "Card payment", -3.4],
  ["Pret A Manger", "PRET A MANGER LONDON GBR", "Card payment", -6.85],
  ["Greggs", "GREGGS 1234 LONDON GBR", "Card payment", -4.1],
  ["Starbucks", "STARBUCKS 0456 LONDON GBR", "Card payment", -4.25],
  ["Deliveroo", "DELIVEROO LONDON GBR", "Card payment", -24.9],
  ["Uber", "UBER *TRIP HELP.UBER.COM GBR", "Card payment", -14.3],
  ["TfL", "TFL TRAVEL CH TFL.GOV.UK/CP GBR", "Card payment", -38.4],
  ["Amazon", "AMAZON.CO.UK*AB12CD34E AMAZON.CO.UK GBR", "Card payment", -29.99],
  ["Amazon", "AMZNMKTPLACE AMAZON.CO.UK GBR", "Card payment", -17.49],
  ["Netflix", "NETFLIX.COM AMSTERDAM NLD", "Card payment", -12.99],
  ["Spotify", "SPOTIFY STOCKHOLM SWE", "Card payment", -11.99],
  ["Apple", "APPLE.COM/BILL CORK IRL", "Card payment", -2.99],
  ["EE", "EE LIMITED", "Direct Debit", -25],
  ["Octopus Energy", "OCTOPUS ENERGY", "Direct Debit", -96],
  ["Thames Water", "THAMES WATER", "Direct Debit", -38.5],
  ["PureGym", "PUREGYM LTD", "Direct Debit", -24.99],
  ["Shell", "SHELL GREENWICH GBR", "Card payment", -52.4],
  ["Boots", "BOOTS 1182 LONDON GBR", "Card payment", -11.75],
  ["Primark", "PRIMARK LONDON GBR", "Card payment", -22],
  ["The Old Bakehouse", "SQ *THE OLD BAKEHOUSE LONDON GBR", "Card payment", -7.2],
  ["Wetherspoon", "J D WETHERSPOON LONDON GBR", "Card payment", -18.6],
  ["Nando's", "NANDOS LONDON GBR", "Card payment", -26.45],
  ["Jane Smith", "JANE SMITH DINNER", "Faster payment", -25],
  ["Holiday", "pot_0000AbCdEf", "Pot transfer", -100],
  ["Acme Ltd", "ACME LTD SALARY", "Faster payment", 2450],
];

const EXTRA_BY_MONTH: Row[][] = [
  [["IKEA", "IKEA LTD WEMBLEY GBR", "Card payment", -84], ["Ryanair", "RYANAIR DUBLIN IRL", "Card payment", -79.98]],
  [["Zara", "ZARA UK LONDON GBR", "Card payment", -45.99], ["H&M", "H&M 123 LONDON GBR", "Card payment", -19.99], ["Currys", "CURRYS LONDON GBR", "Card payment", -129]],
  [["easyJet", "EASYJET LUTON GBR", "Card payment", -64.5], ["Airbnb", "AIRBNB * HMXYZ123 LONDON GBR", "Card payment", -212], ["Uniqlo", "UNIQLO LONDON GBR", "Card payment", -34.9]],
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function demoStatementCsv(today = new Date()): string {
  const header =
    "Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In";
  const out = [header];
  let n = 1;
  for (let m = 3; m >= 1; m--) {
    const base = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const rows = [...MONTHLY, ...(EXTRA_BY_MONTH[3 - m] ?? [])];
    rows.forEach((r, i) => {
      const day = 1 + ((i * 7 + m * 3) % 27);
      const date = `${pad(day)}/${pad(base.getMonth() + 1)}/${base.getFullYear()}`;
      const [name, desc, type, amount] = r;
      const amt = amount.toFixed(2);
      out.push(
        [`tx_demo_${n++}`, date, "12:00:00", type, name, "", "", amt, "GBP", amt, "GBP", "", "", "", desc, "", amount < 0 ? amt : "", amount > 0 ? amt : ""]
          .map((v) => (v.includes(",") ? `"${v}"` : v))
          .join(","),
      );
    });
  }
  return out.join("\n");
}

export const DEMO_RECEIPT_TEXT = `TESCO
Greenwich Superstore
VAT No. GB 220 4302 31
COCA COLA ZERO 2L 2.15
CADBURY DAIRY MILK 200G 2.50
HEINZ BEANZ 4PK 3.20
WARBURTONS TOASTIE 1.45
TESCO SEMI SKIMMED 4PT 1.65
MULLER CORNER YOG 4PK 3.00
WALKERS CRISPS 6PK 1.85
PG TIPS 80 BAGS 2.75
TESCO BANANAS LOOSE 0.92
LURPAK SPREADABLE 3.75
TOTAL 23.22
VISA CONTACTLESS 23.22
`;

const OFF_DISCLOSURE = (extra: Partial<Disclosure>): Disclosure => ({
  mode: "off",
  sent: [],
  notSent: [],
  sensitiveHeld: [],
  recognisedLocally: 0,
  transfersExcluded: 0,
  rowsRead: 0,
  ...extra,
});

/** Fill the demo data (its own namespace, never mixed with real data). Idempotent: wipes it first. */
export async function seedDemo(): Promise<void> {
  await ensureOpenBrands();
  await store.wipe("demo");
  await store.load("demo");
  const parse = await parseStatement(demoStatementCsv(), { filename: "demo-monzo.csv" });
  const itemId = newItemId();
  const prep = prepareStatement(parse, itemId);
  await saveStatement(
    prep,
    itemId,
    OFF_DISCLOSURE({
      notSent: prep.plan.candidates,
      sensitiveHeld: prep.plan.sensitive,
      recognisedLocally: prep.plan.recognisedLocally,
      transfersExcluded: prep.plan.transfersExcluded,
      rowsRead: prep.plan.rowsRead,
    }),
    "demo-monzo.csv",
  );
  const receipt = parseReceiptText(DEMO_RECEIPT_TEXT);
  const d = new Date();
  d.setDate(d.getDate() - 3);
  await saveReceipt(
    { storeText: receipt.storeText, storeEntryId: receipt.storeEntryId, date: d.toISOString().slice(0, 10), total: receipt.total, lines: receipt.lines.map((l) => ({ ...l, included: true })) },
    OFF_DISCLOSURE({ recognisedLocally: receipt.lines.filter((l) => l.entryId).length + (receipt.storeEntryId ? 1 : 0), rowsRead: receipt.lines.length }),
  );
}
