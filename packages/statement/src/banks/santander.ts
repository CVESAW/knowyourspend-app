import type { BankDefinition } from "./format";

/**
 * Santander UK — the `.txt` export (ro-che.info, 2018), which is the robust machine format:
 *   From: 01/01/2018 to 03/03/2018
 *   Account: XXXX XXXX XXXX XXXX
 *   Date: 03/03/2018
 *   Description: CARD PAYMENT TO STAGECOACH BUS,4.40 GBP, RATE 1.00/GBP ON 01-03-2018
 *   Amount: -4.40
 *   Balance: 123.45
 * ISO-8859-1 with non-breaking spaces (0xA0) as separators; some `Amount:` values end in `GBP`.
 * Santander's newer CSV (`Date,Description,Money in,Money out,Balance`) is UNCONFIRMED and goes to
 * the generic mapper (whose guesser recognises those headers).
 */
export const santander: BankDefinition = {
  id: "santander",
  name: "Santander (TXT export)",
  confidence: "confirmed",
  source: "ro-che.info/articles/2018-03-04-santander-export-transactions",
  match: (_h, lines) => {
    const l = lines.map((x) => x.replace(/ /g, " "));
    return (
      l.some((x) => /^\s*From:\s*\S+.*\bto\b/i.test(x)) &&
      l.some((x) => /^\s*Description:/i.test(x)) &&
      l.some((x) => /^\s*Amount:/i.test(x))
    );
  },
  parseText(text) {
    const headers = ["Date", "Description", "Amount", "Balance"];
    const rows: string[][] = [];
    let cur: Record<string, string> | null = null;
    const flush = () => {
      if (cur) rows.push([cur.date ?? "", cur.description ?? "", cur.amount ?? "", cur.balance ?? ""]);
      cur = null;
    };
    for (const rawLine of text.split(/\r\n|\r|\n/)) {
      const line = rawLine.replace(/ /g, " ");
      const m = /^\s*(Date|Description|Amount|Balance)\s*:\s*(.*?)\s*$/i.exec(line);
      if (!m) continue;
      const key = m[1]!.toLowerCase();
      if (key === "date") {
        flush();
        cur = {};
      }
      if (cur) cur[key] = m[2]!;
    }
    flush();
    return { headers, rows };
  },
  columns: { date: "Date", description: "Description", amount: "Amount", balance: "Balance" },
  dateOrder: "DMY",
  defaultCurrency: "GBP",
};
