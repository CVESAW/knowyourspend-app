import { describe, expect, it } from "vitest";
import { guessDateOrder, parseAmount, parseDate } from "../src/index";

describe("parseDate", () => {
  it.each([
    ["29/12/2024", "DMY", "2024-12-29"],
    ["29-Dec-14", "DMY", "2014-12-29"],
    ["29 Dec 2024", "DMY", "2024-12-29"],
    ["01 May 2023", "DMY", "2023-05-01"],
    ["01-08-2026", "DMY", "2026-08-01"],
    ["01.03.2025", "DMY", "2025-03-01"],
    ["2024-03-01 10:15:22", "YMD", "2024-03-01"],
    ["2024-03-01T10:15:22Z", "DMY", "2024-03-01"],
    ["12/31/2024", "MDY", "2024-12-31"],
    ["03/04/2025", "DMY", "2025-04-03"],
    ["03/04/2025", "MDY", "2025-03-04"],
  ] as const)("%s (%s) → %s", (s, order, iso) => expect(parseDate(s, order)).toBe(iso));

  it.each(["", "31/02/2025", "Opening Balance", "13/13/2025", "Date and Time:"])("rejects %j", (s) => expect(parseDate(s, "DMY")).toBeNull());

  it("guessDateOrder only decides from unambiguous samples", () => {
    expect(guessDateOrder(["13/01/2025", "01/02/2025"])).toEqual({ order: "DMY", ambiguous: false });
    expect(guessDateOrder(["01/13/2025"])).toEqual({ order: "MDY", ambiguous: false });
    expect(guessDateOrder(["2025-01-02"])).toEqual({ order: "YMD", ambiguous: false });
    expect(guessDateOrder(["01/02/2025", "03/04/2025"])).toEqual({ order: "DMY", ambiguous: true });
  });
});

describe("parseAmount", () => {
  it.each([
    ["-12.50", -12.5, undefined],
    ["£1,234.56", 1234.56, "GBP"],
    ["£-2.50", -2.5, "GBP"],
    ["(12.50)", -12.5, undefined],
    ["12.50 DR", -12.5, undefined],
    ["12.50CR", 12.5, undefined],
    ["-4.40 GBP", -4.4, "GBP"],
    ["GBP 4.40", 4.4, "GBP"],
    ["€1.234,56", 1234.56, "EUR"],
    ["-12,50", -12.5, undefined],
    ["1,234", 1234, undefined],
    ["-110000", -110000, undefined],
    ["12.50-", -12.5, undefined],
    ["Â£5.00", 5, "GBP"],
    ["�5.00", 5, undefined],
    ["+3", 3, undefined],
  ] as const)("%j → %d", (s, value, currency) => {
    const r = parseAmount(s);
    expect(r?.value).toBe(value);
    expect(r?.currency).toBe(currency);
  });
  it.each(["", "abc", "--", "1-2"])("rejects %j", (s) => expect(parseAmount(s)).toBeNull());
});
