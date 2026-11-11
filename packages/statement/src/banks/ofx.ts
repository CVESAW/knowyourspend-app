import { guessDateOrder, parseDate } from "../values";
import type { BankDefinition } from "./format";

/**
 * OFX / QFX ("Microsoft Money" / "Quicken Web Connect") and QIF ("Quicken") exports. Many UK banks offer
 * these besides CSV (HSBC, first direct, Nationwide, Santander and others), and they are the same
 * whichever bank wrote them, so they're read here rather than per bank.
 *
 * OFX: each transaction is a <STMTTRN> block with DTPOSTED (YYYYMMDD…), TRNAMT (signed, from the account
 * holder's side, so card charges are negative), NAME, MEMO, TRNTYPE and FITID. Both the SGML (OFX 1.x,
 * no closing tags on fields) and XML (OFX 2.x) forms are read.
 * QIF: one field per line (D date, T amount, P payee, M memo), records ended by "^". QIF dates have no
 * fixed order; the order is worked out from the whole file and is day-first when it can't be told.
 */

const field = (block: string, tag: string): string => {
  const m = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "i").exec(block);
  return (m?.[1] ?? "").trim();
};

/** "20261001", "20261001120000[0:GMT]", "2026-10-01T12:00:00" → "2026-10-01" */
function ofxDate(raw: string): string {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

const decodeEntities = (s: string) => s.replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&apos;/gi, "'").replace(/&quot;/gi, '"');

export const ofx: BankDefinition = {
  id: "ofx",
  name: "OFX / QFX file",
  confidence: "confirmed",
  source: "OFX 1.6 and 2.2 specifications (ofx.org)",
  match: (_h, lines) => lines.some((l) => /^\s*OFXHEADER\s*:|<OFX>/i.test(l)),
  parseText(text) {
    const headers = ["Date", "Description", "Payee", "Amount", "Currency", "Type", "ID"];
    const currency = field(text, "CURDEF");
    const rows: string[][] = [];
    for (const m of text.matchAll(/<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi)) {
      const b = m[1]!;
      const name = decodeEntities(field(b, "NAME"));
      const memo = decodeEntities(field(b, "MEMO"));
      rows.push([
        ofxDate(field(b, "DTPOSTED") || field(b, "DTUSER")),
        [name, memo].filter(Boolean).join(" ").trim(),
        name,
        field(b, "TRNAMT"),
        field(b, "CURRENCY") ? field(field(b, "CURRENCY"), "CURSYM") || currency : currency,
        field(b, "TRNTYPE"),
        field(b, "FITID"),
      ]);
    }
    return { headers, rows };
  },
  columns: { date: "Date", description: "Description", payee: "Payee", amount: "Amount", currency: "Currency", type: "Type", sourceId: "ID" },
  dateOrder: "YMD",
  defaultCurrency: "GBP",
};

export const qif: BankDefinition = {
  id: "qif",
  name: "QIF file",
  confidence: "confirmed",
  source: "Quicken Interchange Format description (Intuit)",
  match: (_h, lines) => {
    const first = lines.find((l) => l.trim());
    return !!first && /^\s*!Type:(Bank|CCard|Cash|Oth\s?[AL]?)\b/i.test(first);
  },
  parseText(text) {
    const recs: Record<string, string>[] = [];
    let cur: Record<string, string> = {};
    for (const raw of text.split(/\r\n|\r|\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("!")) continue;
      if (line === "^") {
        if (Object.keys(cur).length) recs.push(cur);
        cur = {};
        continue;
      }
      const k = line[0]!.toUpperCase();
      if ("DTUPMN".includes(k) && cur[k] === undefined) cur[k] = line.slice(1).trim();
    }
    if (Object.keys(cur).length) recs.push(cur);
    // QIF dates: 01/10/2026, 1/10'26, 01.10.2026 … settle day/month order from the whole file.
    const norm = (d: string) => d.replace(/'\s*/, "/").replace(/\s+/g, "");
    const order = guessDateOrder(recs.map((r) => norm(r.D ?? ""))).order;
    const iso = (d: string) => parseDate(norm(d), order) ?? "";
    const headers = ["Date", "Description", "Payee", "Amount", "Reference"];
    const rows = recs.map((r) => [iso(r.D ?? ""), [r.P, r.M].filter(Boolean).join(" ").trim(), r.P ?? "", r.T ?? r.U ?? "", r.N ?? ""]);
    return { headers, rows };
  },
  columns: { date: "Date", description: "Description", payee: "Payee", amount: "Amount" },
  dateOrder: "YMD",
  defaultCurrency: "GBP",
};
