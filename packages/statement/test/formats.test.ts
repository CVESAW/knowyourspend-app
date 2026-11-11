import { describe, expect, it } from "vitest";
import { guessMapping, normalisePayee, parseStatement, parseWithMapping } from "../src/index";
import { brief } from "./helpers";

// Every file below is made up for these tests. The layouts follow published sample exports from
// open-source importers (October 2026); none of the people, shops or numbers are real.

const csv = (...lines: string[]) => lines.join("\r\n") + "\r\n";
const read = (text: string, filename = "statement.csv") => parseStatement(text, { filename });

describe("current accounts", () => {
  it("Monzo exports without the Emoji column", async () => {
    const r = await read(csv(
      "Transaction ID,Date,Time,Type,Name,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Description",
      "tx_01,01/09/2026,09:12:00,Card payment,Pret A Manger,Eating out,-3.95,GBP,-3.95,GBP,,1 High St,PRET A MANGER LONDON GBR",
      "tx_02,02/09/2026,10:00:00,Faster payment,Acme Widgets Ltd,Income,1500.00,GBP,1500.00,GBP,,,ACME WIDGETS LTD",
    ));
    expect(r.bank?.id).toBe("monzo");
    expect(r.transactions.map(brief)[0]).toEqual({ date: "2026-09-01", amount: -3.95, kind: "spend", normPayee: "PRET A MANGER" });
  });

  it("Chase UK by its header, without the file name hint", async () => {
    const r = await read(csv(
      "Date,Time,Transaction Type,Description,Amount,Currency,Balance",
      "03/09/2026,12:01:44,Purchase,Greggs,-2.10,GBP,997.90",
      "04/09/2026,08:30:00,Purchase,Boots,-7.49,GBP,990.41",
    ));
    expect(r.bank?.id).toBe("chase-uk");
    expect(r.transactions.map((t) => [t.date, t.amount])).toEqual([["2026-09-03", -2.1], ["2026-09-04", -7.49]]);
  });

  it("Nationwide's older layout (Transactions column)", async () => {
    const r = await read(csv(
      '"Account Name:","FlexAccount ****1234"',
      '"Account Balance:","£1,000.00"',
      '"Available Balance: ","£1,000.00"',
      "",
      '"Date","Transactions","Paid out","Paid in","Balance"',
      '"05 Sep 2026","Contactless Payment SAINSBURYS S/MKTS","£12.40","","£987.60"',
      '"06 Sep 2026","Bank credit ACME WIDGETS LTD","","£250.00","£1,237.60"',
    ));
    expect(r.bank?.id).toBe("nationwide-old");
    expect(r.transactions.map((t) => [t.date, t.amount])).toEqual([["2026-09-05", -12.4], ["2026-09-06", 250]]);
  });
});

describe("credit cards (charges positive in the file, negative here)", () => {
  it("Barclaycard, card-number layout, with a CR refund", async () => {
    const r = await read(csv(
      "Transaction Date,Posting Date,Card Number,Description,Category,Amount",
      "07/09/2026,08/09/2026,****1234,WAITROSE 123 READING,Groceries,23.80",
      "08/09/2026,09/09/2026,****1234,ARGOS LTD,Shopping,6.15 CR",
      "10/09/2026,10/09/2026,****1234,PAYMENT RECEIVED - THANK YOU,Payment,-200.00",
    ));
    expect(r.bank?.id).toBe("barclaycard");
    expect(r.transactions.map((t) => t.amount)).toEqual([-23.8, 6.15, 200]);
    expect(r.transactions[0]!.normPayee).toBe("WAITROSE");
  });

  it("Barclaycard, card-holder layout", async () => {
    const r = await read(csv(
      "Card Holder Name,Account Number,Transaction Date,Merchant Name,Transaction Amount,Currency",
      "A N OTHER,****1234,11/09/2026,COSTA COFFEE,3.20,GBP",
      "A N OTHER,****1234,12/09/2026,TRAINLINE,45.60,GBP",
    ));
    expect(r.bank?.id).toBe("barclaycard");
    expect(r.transactions.map((t) => [t.date, t.amount, t.normPayee])).toEqual([["2026-09-11", -3.2, "COSTA COFFEE"], ["2026-09-12", -45.6, "TRAINLINE"]]);
  });

  it("MBNA", async () => {
    const r = await read(csv(
      "Transaction Date,Transaction Cleared Date,Transaction Type,Transaction Description,Transaction Amount",
      "13/09/2026,14/09/2026,Purchase,SCREWFIX DIRECT,18.99",
      "15/09/2026,15/09/2026,Payment,DIRECT DEBIT PAYMENT,-100.00",
    ));
    expect(r.bank?.id).toBe("mbna");
    expect(r.transactions.map((t) => t.amount)).toEqual([-18.99, 100]);
  });

  it("Tesco Bank credit card (£ amounts)", async () => {
    const r = await read(csv(
      "Transaction Date,Posting Date,Billing Amount,Merchant,Merchant City,Merchant County,Merchant Postal Code,Reference,Debit/Credit Flag,SICMCC Code",
      '16/09/2026,17/09/2026,£9.99,NETFLIX.COM,LOS GATOS,,,74000001,D,4899',
    ));
    expect(r.bank?.id).toBe("tesco-bank");
    expect(r.transactions[0]).toMatchObject({ date: "2026-09-16", amount: -9.99 });
  });

  it("Aqua reads the raw descriptor from Note", async () => {
    const r = await read(csv(
      "Date,Description,Note,Amount(GBP)",
      "18/09/2026,Shell,SHELL 4321 SWINDON GBR,52.00",
    ));
    expect(r.bank?.id).toBe("aqua");
    expect(r.transactions[0]).toMatchObject({ amount: -52, rawPayee: "Shell" });
  });

  it("Amex's short download only when the file is named like Amex's", async () => {
    const text = csv("Date,Description,Amount", "19/09/2026,UBER *TRIP HELP.UBER.COM,14.30", "20/09/2026,DELIVEROO,21.75", "20/09/2026,WAITROSE,30.00", "21/09/2026,PAYMENT RECEIVED - THANK YOU,-36.05");
    const amex = await read(text, "activity.csv");
    expect(amex.bank?.id).toBe("amex-short");
    expect(amex.transactions.map((t) => t.amount)).toEqual([-14.3, -21.75, -30, 36.05]);
    // Same header from an unknown source: mostly positive amounts, so ask rather than guess the sign.
    const other = await read(text, "export.csv");
    expect(other.bank).toBeNull();
    expect(other.needsMapping).toBe(true);
    expect(guessMapping(other.headers, other.previewRows)).toMatchObject({ date: 0, description: 1, amount: 2, invertSign: true });
  });

  it("Curve skips Curve Cash rewards", async () => {
    const r = await read(csv(
      "Date (YYYY-MM-DD as UTC),Time (HH:MM:SS),Merchant,Txn Amount (Funding Card),Txn Currency (Funding Card),Txn Amount (Foreign Spend),Txn Currency (Foreign Spend),Card Name,Card Last 4 Digits,Type,Category,Notes",
      "2026-09-22,10:15:00,Tesco Stores,12.34,GBP,,,Main,1234,Debit,Groceries,",
      "2026-09-22,10:15:01,Curve Cash,0.12,CPT,,,Main,1234,Debit,,",
    ));
    expect(r.bank?.id).toBe("curve");
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({ date: "2026-09-22", amount: -12.34 });
  });

  it("the mapper's sign switch flips charges for an unknown card file", async () => {
    const text = csv("Posted,Details,Value", "23/09/2026,ODEON CINEMAS,11.50", "24/09/2026,REFUND ODEON CINEMAS,-11.50");
    const r = await parseWithMapping(text, { date: 0, description: 1, amount: 2, invertSign: true });
    expect(r.transactions.map((t) => t.amount)).toEqual([-11.5, 11.5]);
  });
});

describe("OFX, QFX and QIF", () => {
  it("OFX 1.x (SGML, no closing tags)", async () => {
    const r = await read(
      [
        "OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "",
        "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>GBP<BANKTRANLIST>",
        "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260925000000[0:GMT]<TRNAMT>-4.50<FITID>A1<NAME>CAFFE NERO<MEMO>CAFFE NERO 123 BATH",
        "</STMTTRN>",
        "<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260926<TRNAMT>1200.00<FITID>A2<NAME>ACME WIDGETS LTD &amp; CO",
        "</STMTTRN>",
        "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
      ].join("\n"),
      "statement.ofx",
    );
    expect(r.bank?.id).toBe("ofx");
    expect(r.transactions.map((t) => [t.date, t.amount, t.currency, t.sourceId])).toEqual([["2026-09-25", -4.5, "GBP", "A1"], ["2026-09-26", 1200, "GBP", "A2"]]);
    expect(r.transactions[0]!.normPayee).toBe("CAFFE NERO");
    expect(r.transactions[1]!.rawPayee).toBe("ACME WIDGETS LTD & CO");
  });

  it("OFX 2.x (XML)", async () => {
    const r = await read(
      `<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="220"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>GBP</CURDEF><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>2026-09-27T12:00:00</DTPOSTED><TRNAMT>-19.99</TRNAMT><FITID>X1</FITID><NAME>JOHN LEWIS</NAME></STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`,
      "card.qfx",
    );
    expect(r.bank?.id).toBe("ofx");
    expect(r.transactions.map(brief)).toEqual([{ date: "2026-09-27", amount: -19.99, kind: "spend", normPayee: "JOHN LEWIS" }]);
  });

  it("QIF, working out day-first dates from the whole file", async () => {
    const r = await read(
      ["!Type:Bank", "D02/09/2026", "T-8.00", "PSUBWAY", "^", "D28/09/2026", "T-30.00", "PEE LIMITED", "MMOBILE", "^"].join("\n"),
      "money.qif",
    );
    expect(r.bank?.id).toBe("qif");
    expect(r.transactions.map((t) => [t.date, t.amount])).toEqual([["2026-09-02", -8], ["2026-09-28", -30]]);
  });
});

describe("unknown banks read by their column names", () => {
  it("reads paid out / paid in columns, with a note to check", async () => {
    const r = await read(csv("Date,Details,Money Out,Money In,Balance", "01/10/2026,LIDL GB,14.20,,985.80", "02/10/2026,ACME WIDGETS LTD,,300.00,1285.80", "13/10/2026,IKEA,45.00,,1240.80"));
    expect(r.bank).toBeNull();
    expect(r.needsMapping).toBe(false);
    expect(r.transactions.map((t) => [t.date, t.amount])).toEqual([["2026-10-01", -14.2], ["2026-10-02", 300], ["2026-10-13", -45]]);
    expect((r.warnings ?? []).join(" ")).toMatch(/column names/);
  });

  it("reads a single signed amount column when most rows are spending", async () => {
    const r = await read(csv("Date,Description,Amount", "03/10/2026,ALDI,-21.00", "14/10/2026,ARGOS,-9.99", "15/10/2026,ACME WIDGETS LTD,500.00"));
    expect(r.needsMapping).toBe(false);
    expect(r.transactions.map((t) => t.amount)).toEqual([-21, -9.99, 500]);
  });

  it("asks when the dates could be either way round", async () => {
    const r = await read(csv("Date,Description,Amount", "03/10/2026,ALDI,-21.00", "04/10/2026,ARGOS,-9.99"));
    expect(r.needsMapping).toBe(true);
  });
});

describe("descriptor clean-up", () => {
  it("drops NatWest's card and date prefix in its variants", () => {
    expect(normalisePayee("'4321 01SEP26 TESCO STORES 3297 , LONDON GB")).toBe("TESCO STORES");
    expect(normalisePayee("4321 01SEP26 C , WAITROSE 123 , READING GB")).toBe("WAITROSE");
    expect(normalisePayee("4321 1SEP26 ARGOS")).toBe("ARGOS");
  });

  it("drops trailing UK and Irish towns, but not when the town is the name", () => {
    expect(normalisePayee("TESCO STORES 3142 DARTFORD")).toBe("TESCO STORES");
    expect(normalisePayee("B&Q 1123 DARTFORD")).toBe("B&Q");
    expect(normalisePayee("BOOTS 1234 ST HELENS")).toBe("BOOTS");
    expect(normalisePayee("CAFE BELMONT")).toBe("CAFE BELMONT");
  });
});
