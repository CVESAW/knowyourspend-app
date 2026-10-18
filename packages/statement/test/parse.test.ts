import { describe, expect, it } from "vitest";
import { decodeFile, guessMapping, parseStatement, parseWithMapping, sniffDelimiter } from "../src/index";
import { brief, fixtureBytes, fixtureText, parseFixture } from "./helpers";

describe("decodeFile", () => {
  it("decodes UTF-8 and strips the BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Date,£")]);
    expect(decodeFile(bytes.buffer)).toBe("Date,£");
  });
  it("falls back to Windows-1252 for Latin-1 files (Nationwide £, Santander NBSP)", () => {
    const text = decodeFile(fixtureBytes("nationwide.csv"));
    expect(text).toContain("£1,229.56");
    expect(decodeFile(fixtureBytes("santander.txt"))).toContain("Amount: -4.40");
  });
});

describe("delimiter sniffing", () => {
  it("picks comma, semicolon and tab", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(sniffDelimiter("a;b;c\n01.03.2025;x;-12,50\n")).toBe(";");
    expect(sniffDelimiter("a\tb\tc\n1\t2,5\t3\n")).toBe("\t");
  });
  it("is not fooled by tabs inside Barclays memos", () => {
    expect(sniffDelimiter(fixtureText("barclays.csv"))).toBe(",");
  });
});

describe("Monzo", () => {
  it("uses the cleaned Name as rawPayee and keeps the raw Description", async () => {
    const r = await parseFixture("monzo.csv");
    const costa = r.transactions[0]!;
    expect(costa).toMatchObject({ date: "2025-03-01", amount: -3.4, currency: "GBP", rawPayee: "Costa Coffee", normPayee: "COSTA COFFEE", kind: "spend", sourceId: "tx_0001" });
    expect(costa.rawDescription).toBe("COSTA COFFEE 43012 LONDON GBR");
  });
  it("keeps account currency for foreign card spend", async () => {
    const r = await parseFixture("monzo.csv");
    expect(r.transactions.find((t) => t.rawPayee === "Monoprix")).toMatchObject({ amount: -15.2, currency: "GBP" });
  });
  it("classifies pots, transfers, salary, refunds and ATM", async () => {
    const kinds = Object.fromEntries((await parseFixture("monzo.csv")).transactions.map((t) => [`${t.date} ${t.rawPayee}`, t.kind]));
    expect(kinds["2025-03-02 Jane Smith"]).toBe("transfer");
    expect(kinds["2025-03-03 Holiday"]).toBe("internal");
    expect(kinds["2025-03-05 Acme Widgets Ltd"]).toBe("income");
    expect(kinds["2025-03-09 Amazon"]).toBe("refund");
    expect(kinds["2025-03-12 Cash withdrawal"]).toBe("cash");
    expect(kinds["2025-03-14 Octopus Energy"]).toBe("spend");
  });
});

describe("Starling", () => {
  it("skips the Opening Balance row and reads balances", async () => {
    const r = await parseFixture("starling.csv");
    expect(r.skipped).toEqual([{ row: 2, reason: "opening/closing balance row" }]);
    expect(r.transactions[0]).toMatchObject({ date: "2025-03-01", amount: -12.3, balance: 987.7, rawPayee: "Tesco", rawDescription: "TESCO STORES 3456" });
    expect(r.dateRange).toEqual({ from: "2025-03-01", to: "2025-03-08" });
  });
  it("classifies Faster Payments to people as transfers and income as income", async () => {
    const t = (await parseFixture("starling.csv")).transactions;
    expect(t.find((x) => x.rawPayee === "J Smith")!.kind).toBe("transfer");
    expect(t.find((x) => x.rawPayee === "Acme Widgets Ltd")!.kind).toBe("income");
    expect(t.find((x) => x.rawPayee === "Holiday")!.kind).toBe("internal");
    expect(t.find((x) => x.rawPayee === "Bet365")!).toMatchObject({ kind: "spend", sensitive: true });
  });
});

describe("Revolut", () => {
  it("parses ISO datetimes, uses Completed Date, skips non-COMPLETED rows", async () => {
    const r = await parseFixture("revolut.csv");
    expect(r.skipped).toEqual([{ row: 5, reason: "status PENDING" }]);
    expect(brief(r.transactions[1]!)).toEqual({ date: "2025-03-02", amount: -6.85, kind: "spend", normPayee: "PRET A MANGER" });
  });
  it("emits the Fee column as its own fee row and reads per-row currency", async () => {
    const r = await parseFixture("revolut.csv");
    const fee = r.transactions.find((t) => t.kind === "fee")!;
    expect(fee).toMatchObject({ date: "2025-03-06", amount: -1, normPayee: "" });
    expect(r.currencies).toEqual(["EUR", "GBP"]);
    expect(r.transactions.find((t) => t.rawPayee === "Carrefour")!.currency).toBe("EUR");
  });
  it("top-ups and exchanges are internal, card refunds are refunds", async () => {
    const t = (await parseFixture("revolut.csv")).transactions;
    expect(t.map((x) => x.kind)).toEqual(["internal", "spend", "spend", "transfer", "cash", "fee", "refund", "internal", "spend"]);
  });
});

describe("Lloyds", () => {
  it("combines unsigned Debit/Credit columns into a signed amount", async () => {
    const t = (await parseFixture("lloyds.csv")).transactions;
    expect(t[0]).toMatchObject({ amount: -12.3, typeLabel: "DEB", balance: 1987.7 });
    expect(t.find((x) => x.typeLabel === "BGC")).toMatchObject({ amount: 2500, kind: "income" });
  });
  it("skips a repeated header from concatenated exports", async () => {
    expect((await parseFixture("lloyds.csv")).skipped).toEqual([{ row: 10, reason: "repeated header row" }]);
  });
  it("classifies by LBG type code; person transfers never carry a normPayee", async () => {
    const t = (await parseFixture("lloyds.csv")).transactions;
    const byPayee = (p: string) => t.find((x) => x.rawPayee === p)!;
    expect(byPayee("D STEPHENS 04MAR25")).toMatchObject({ kind: "transfer", normPayee: "" });
    expect(byPayee("J SMITH")).toMatchObject({ kind: "transfer", normPayee: "" });
    expect(byPayee("M JONES RENT")).toMatchObject({ kind: "transfer", normPayee: "" });
    expect(byPayee("OCTOPUS ENERGY LTD")).toMatchObject({ kind: "spend", normPayee: "OCTOPUS ENERGY LTD" });
    expect(byPayee("THAMES WATER").kind).toBe("spend");
    expect(byPayee("LINK ATM CD 1234").kind).toBe("cash");
    expect(byPayee("ACCOUNT FEE").kind).toBe("fee");
  });
  it("never reads sort code or account number into a transaction", async () => {
    const json = JSON.stringify((await parseFixture("lloyds.csv")).transactions);
    expect(json).not.toContain("12345678");
    expect(json).not.toContain("30-00-00");
  });
});

describe("Barclays", () => {
  it("re-joins unquoted commas in Memo and warns", async () => {
    const r = await parseFixture("barclays.csv");
    const t = r.transactions.find((x) => x.date === "2025-03-02")!;
    expect(t.rawPayee).toBe("SMITH, JONES & CO LTD ON 02 MAR BCC");
    expect(t.normPayee).toBe("SMITH JONES & CO LTD");
    expect(t.amount).toBe(-24.5);
    expect(r.warnings).toEqual(["1 row(s) had unquoted commas in the description and were re-joined."]);
  });
  it("reads whole-pound amounts and tab-padded memos", async () => {
    const t = (await parseFixture("barclays.csv")).transactions;
    expect(t.find((x) => x.date === "2025-03-03")).toMatchObject({ amount: -1100, kind: "transfer", normPayee: "" });
    expect(t.find((x) => x.date === "2025-03-04")).toMatchObject({ amount: 2500, kind: "income" });
    expect(t.find((x) => x.date === "2025-03-07")).toMatchObject({ normPayee: "TFL", kind: "spend" });
    expect(t.find((x) => x.date === "2025-03-06")).toMatchObject({ normPayee: "DREAMHOST", kind: "spend" });
    expect(t.find((x) => x.date === "2025-03-05")!.kind).toBe("cash");
  });
});

describe("Nationwide", () => {
  it("skips the preamble, parses £ amounts and '01 May 2025' dates (Windows-1252 file)", async () => {
    const r = await parseFixture("nationwide.csv");
    expect(r.transactions.map(brief).slice(0, 2)).toEqual([
      { date: "2025-05-01", amount: -5, kind: "spend", normPayee: "UBER" },
      { date: "2025-05-02", amount: -23.1, kind: "spend", normPayee: "TESCO STORES" },
    ]);
    expect(r.transactions.find((t) => t.date === "2025-05-05")).toMatchObject({ amount: 2000, balance: 3126.46, kind: "income" });
    expect(r.transactions.find((t) => t.date === "2025-05-08")).toMatchObject({ amount: 15.99, kind: "refund", normPayee: "AMAZON" });
  });
  it("parses the 2014 layout with DD-Mon-YY dates and negative £ balances", async () => {
    const t = (await parseFixture("nationwide-2014.csv")).transactions;
    expect(t[0]).toMatchObject({ date: "2014-12-29", amount: -1.23, balance: 0, kind: "transfer" });
    expect(t[1]).toMatchObject({ date: "2014-12-30", amount: -2.5, balance: -2.5, normPayee: "COSTA COFFEE" });
  });
});

describe("NatWest", () => {
  it("trims padded headers, strips Excel apostrophes and trailing empty fields", async () => {
    const t = (await parseFixture("natwest.csv")).transactions;
    expect(t[0]).toMatchObject({ date: "2025-03-01", amount: -15.2, typeLabel: "POS", normPayee: "TESCO STORES", kind: "spend" });
    expect(t.map((x) => x.kind)).toEqual(["spend", "spend", "income", "cash", "transfer", "spend"]);
    expect(JSON.stringify(t)).not.toContain("BLOGGS");
  });
});

describe("Santander .txt", () => {
  it("parses key:value blocks with NBSP separators and GBP-suffixed amounts", async () => {
    const t = (await parseFixture("santander.txt")).transactions;
    expect(t.map(brief)).toEqual([
      { date: "2018-03-01", amount: -4.4, kind: "spend", normPayee: "STAGECOACH BUS" },
      { date: "2018-03-02", amount: -30, kind: "spend", normPayee: "VODAFONE LTD" },
      { date: "2018-03-02", amount: 2000, kind: "income", normPayee: "" },
      { date: "2018-03-03", amount: -500, kind: "transfer", normPayee: "" },
      { date: "2018-03-03", amount: -20, kind: "cash", normPayee: "" },
    ]);
    expect(t[0]!.balance).toBe(995.6);
  });
});

describe("HSBC (headerless, unconfirmed)", () => {
  it("parses date/details/amount rows, quoted thousands and contactless markers", async () => {
    const t = (await parseFixture("hsbc.csv")).transactions;
    expect(t[0]).toMatchObject({ amount: -12.3, normPayee: "TESCO STORES", kind: "spend" });
    expect(t.find((x) => x.rawPayee === "J SMITH")!.kind).toBe("transfer");
    expect(t.find((x) => x.date === "2025-03-09")).toMatchObject({ amount: -1234, normPayee: "AMAZON" });
    expect(t.find((x) => x.date === "2025-03-08")!.kind).toBe("cash");
  });
});

describe("Wise", () => {
  it("prefers Merchant, falls back to the counterparty, types from the ID prefix", async () => {
    const t = (await parseFixture("wise.csv")).transactions;
    expect(t[0]).toMatchObject({ date: "2025-03-01", rawPayee: "PRET A MANGER", typeLabel: "CARD", kind: "spend", sourceId: "CARD-123456789" });
    expect(t[1]).toMatchObject({ rawPayee: "John Smith", kind: "transfer", normPayee: "" });
    expect(t[2]).toMatchObject({ rawPayee: "ACME WIDGETS LTD", kind: "income" });
    expect(t[3]!.kind).toBe("internal");
  });
});

describe("N26", () => {
  it("new header: Partner Name, ISO dates, EUR", async () => {
    const t = (await parseFixture("n26-new.csv")).transactions;
    expect(t[0]).toMatchObject({ date: "2025-03-01", amount: -23.45, currency: "EUR", kind: "spend", normPayee: "LIDL DIENSTLEISTUNG" });
    expect(t[1]).toMatchObject({ rawPayee: "Max Mustermann", kind: "transfer", normPayee: "" });
    expect(t[4]).toMatchObject({ kind: "spend", normPayee: "VODAFONE GMBH" });
  });
  it("old header: Payee column", async () => {
    const t = (await parseFixture("n26-old.csv")).transactions;
    expect(t.map((x) => x.kind)).toEqual(["spend", "transfer", "income"]);
  });
});

describe("Amex (unconfirmed)", () => {
  it("inverts the sign: charges become negative spend, card repayments internal", async () => {
    const t = (await parseFixture("amex.csv")).transactions;
    expect(t.map(brief)).toEqual([
      { date: "2025-03-01", amount: -12.3, kind: "spend", normPayee: "TESCO STORES" },
      { date: "2025-03-02", amount: -10.99, kind: "spend", normPayee: "NETFLIX" },
      { date: "2025-03-03", amount: 250, kind: "internal", normPayee: "" },
      { date: "2025-03-04", amount: 15.99, kind: "refund", normPayee: "AMAZON" },
      { date: "2025-03-05", amount: -55.2, kind: "spend", normPayee: "SHELL" },
    ]);
  });
});

describe("amount and text quirks through the full parser", () => {
  const csv = (rows: string) => `Number,Date,Account,Amount,Subcategory,Memo\n${rows}`;
  it("handles £, commas, parentheses, CR/DR suffixes and GBP codes", async () => {
    const text = csv(
      [
        '0,01/03/2025,x,"£1,234.56",Counter Credit,A',
        "0,02/03/2025,x,(12.50),Card Purchase,B",
        "0,03/03/2025,x,12.50 DR,Card Purchase,C",
        "0,04/03/2025,x,12.50CR,Counter Credit,D",
        "0,05/03/2025,x,-4.40 GBP,Card Purchase,E",
        "0,06/03/2025,x,€3.00,Card Purchase,F",
      ].join("\n"),
    );
    const t = (await parseStatement(text)).transactions;
    expect(t.map((x) => x.amount)).toEqual([1234.56, -12.5, -12.5, 12.5, -4.4, 3]);
    expect(t[5]!.currency).toBe("EUR");
  });
  it("repairs UTF-8-read-as-1252 mojibake (Â£)", async () => {
    const text = 'Date,Transaction type,Description,Paid out,Paid in,Balance\n01 May 2025,Visa purchase,TESCO,Â£5.00,,Â£10.00\n';
    expect((await parseStatement(text)).transactions[0]).toMatchObject({ amount: -5, balance: 10 });
  });
  it("records unparseable dates as skipped, without echoing row content", async () => {
    const r = await parseStatement(csv("0,not a date,x,-1.00,Card Purchase,SECRET MERCHANT\n0,01/03/2025,x,-1.00,Card Purchase,OK\n"));
    expect(r.skipped).toEqual([{ row: 2, reason: "unparseable date" }]);
    expect(JSON.stringify(r.skipped)).not.toContain("SECRET");
    expect(r.transactions).toHaveLength(1);
  });
});

describe("generic mapping fallback", () => {
  it("returns headers and up to 8 preview rows when no bank matches", async () => {
    const r = await parseFixture("unknown-semicolon.csv");
    expect(r.needsMapping).toBe(true);
    expect(r.headers).toEqual(["Buchungstag", "Empfänger", "Verwendungszweck", "Betrag"]);
    expect(r.previewRows).toHaveLength(3);
    expect(r.previewRows[0]).toEqual(["01.03.2025", "REWE MARKT", "Einkauf Filiale 1234", "-12,50"]);
  });

  it("guessMapping pre-fills date/description/amount from headers and content", async () => {
    const r = await parseFixture("unknown-semicolon.csv");
    const m = guessMapping(r.headers, r.previewRows);
    expect(m).toMatchObject({ date: 0, amount: 3, dateOrder: "DMY" });
    expect([1, 2]).toContain(m.description);
  });

  it("parses with a user mapping, including European decimal commas", async () => {
    const text = fixtureText("unknown-semicolon.csv");
    const r = await parseStatement(text, { mapping: { date: 0, description: 1, amount: 3, dateOrder: "DMY" } });
    expect(r.needsMapping).toBe(false);
    expect(r.bank).toBeNull();
    expect(r.transactions.map(brief)).toEqual([
      // No type column: an unknown two-word payee could be a person, so it stays a transfer…
      { date: "2025-03-01", amount: -12.5, kind: "transfer", normPayee: "" },
      // …while a known brand is spend.
      { date: "2025-03-02", amount: -9.99, kind: "spend", normPayee: "SPOTIFY AB" },
      { date: "2025-03-15", amount: 2500, kind: "income", normPayee: "" },
    ]);
  });

  it("guesses date order when the mapping omits it, warning when ambiguous", async () => {
    const text = fixtureText("unknown-ambiguous.csv");
    const r = await parseFixture("unknown-ambiguous.csv");
    const m = guessMapping(r.headers, r.previewRows);
    expect(m).toMatchObject({ date: 0, description: 1, paidOut: 2, paidIn: 3 });
    expect(m.amount).toBeUndefined();
    const { dateOrder: _omit, ...noOrder } = m;
    const parsed = await parseWithMapping(text, noOrder as typeof m & { date: number; description: number });
    expect(parsed.transactions[0]).toMatchObject({ date: "2025-02-01", amount: -3.4 });
    expect(parsed.warnings?.[0]).toMatch(/ambiguous/);
  });

  it("uses data to settle the date order when it can", async () => {
    const text = "When,What,How much\n12/31/2024,NETFLIX.COM,-10.99\n01/05/2025,TESCO STORES 3456,-3.00\n";
    const r = await parseWithMapping(text, { date: 0, description: 1, amount: 2 });
    expect(r.transactions.map((t) => t.date)).toEqual(["2024-12-31", "2025-01-05"]);
    expect(r.warnings).toBeUndefined();
  });

  it("handles headerless files with synthetic column names", async () => {
    const r = await parseFixture("unknown-headerless-tab.tsv");
    expect(r.headers).toEqual(["Column 1", "Column 2", "Column 3", "Column 4"]);
    const m = guessMapping(r.headers, r.previewRows);
    expect(m).toMatchObject({ date: 0, description: 1, amount: 2 });
    const parsed = await parseWithMapping(fixtureText("unknown-headerless-tab.tsv"), { ...m, balance: 3 } as Parameters<typeof parseWithMapping>[1]);
    expect(parsed.transactions).toHaveLength(3);
    expect(parsed.transactions[0]).toMatchObject({ date: "2025-03-01", amount: -10.99, balance: 989.01, normPayee: "NETFLIX" });
  });

  it("refuses an incomplete mapping", async () => {
    const r = await parseWithMapping(fixtureText("unknown-semicolon.csv"), { date: 0, description: 1 });
    expect(r.needsMapping).toBe(true);
    expect(r.warnings?.[0]).toMatch(/amount/);
  });
});

describe("names that might be a person (18 Oct 2026)", () => {
  it("counts a bill payment to one plain word as spending but holds it back from the look-up", async () => {
    const text = "Date,Type,Description,Amount\n2026-07-01,BP,PIPPA,-40.00\n2026-07-02,BP,EXAMPLE COUNCIL,-120.00\n2026-07-03,DEB,TESCO STORES 3456,-9.50\n";
    const r = await parseWithMapping(text, { date: 0, type: 1, description: 2, amount: 3 });
    const by = (p: string) => r.transactions.find((t) => t.rawPayee === p)!;
    expect(by("PIPPA")).toMatchObject({ kind: "spend", sensitive: true });
    expect(by("EXAMPLE COUNCIL")).toMatchObject({ kind: "spend", sensitive: false });
    expect(by("TESCO STORES 3456")).toMatchObject({ kind: "spend", sensitive: false });
  });
});
