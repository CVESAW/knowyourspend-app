import { parseAmount, parseDate } from "../values";
import type { BankDefinition } from "./format";

/**
 * HSBC UK / First Direct — UNCONFIRMED. The only source describes the CSV as three columns
 * "date, details, amount"; that it has no header row is from memory, not a fetched sample.
 * The fingerprint therefore matches any headerless 3-column file whose first row is a
 * day-first date, some text, and an amount. Details often contain `)))` (contactless marker,
 * unconfirmed) and codes such as VIS / DD / CR / BP.
 */
export const hsbc: BankDefinition = {
  id: "hsbc",
  name: "HSBC / First Direct (headerless)",
  confidence: "unconfirmed",
  source: "MSE forum 6297815 (\"three columns: date, details, amount\"); headerless layout unconfirmed",
  match: (h) => {
    const cells = trimTrailingEmpty(h);
    return (
      cells.length === 3 &&
      parseDate(cells[0]!, "DMY") !== null &&
      /[A-Za-z]/.test(cells[1]!) &&
      parseAmount(cells[2]!) !== null
    );
  },
  headerless: true,
  displayHeaders: ["Date", "Details", "Amount"],
  columns: { date: 0, description: 1, amount: 2 },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
};

function trimTrailingEmpty(cells: string[]): string[] {
  const out = cells.map((c) => c.trim());
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}
