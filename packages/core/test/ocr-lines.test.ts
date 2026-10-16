import { describe, expect, it } from "vitest";
import { rowsFromBoxes, type OcrBox } from "../src/ocr-lines";
import { parseReceiptText } from "../src/receipt";

const box = (text: string, left: number, top: number, w = text.length * 12, h = 22): OcrBox => ({ text, left, top, right: left + w, bottom: top + h });

describe("rowsFromBoxes", () => {
  it("pairs item names with prices read as separate columns", () => {
    // what ML Kit typically returns for a till receipt: the names in one block, the prices in another
    const names = ["TESCO", "COCA COLA ZERO 2L", "HEINZ BEANZ 4X415G", "CADBURY DAIRY MILK", "TOTAL", "VISA CONTACTLESS"].map((t, i) => box(t, 40, 100 + i * 40));
    const prices = ["2.15", "3.20", "2.50", "7.85", "7.85"].map((t, i) => box(t, 520, 141 + i * 40 + (i % 2 ? 3 : -2)));
    const text = rowsFromBoxes([...prices, ...names]);
    expect(text.split("\n")[1]).toBe("COCA COLA ZERO 2L  2.15");
    const r = parseReceiptText(text);
    expect(r.storeEntryId).toBe("tesco");
    expect(r.total).toBe(7.85);
    expect(r.lines.map((l) => l.entryId).filter(Boolean)).toEqual(["coca-cola", "heinz", "cadbury"]);
  });

  it("copes with a slightly tilted photo", () => {
    const rows = [0, 1, 2].flatMap((i) => [box(`ITEM ${i}`, 40, 100 + i * 40), box(`${i}.99`, 500, 100 + i * 40 + 8)]);
    expect(rowsFromBoxes(rows).split("\n")).toEqual(["ITEM 0  0.99", "ITEM 1  1.99", "ITEM 2  2.99"]);
  });

  it("returns nothing for no boxes", () => {
    expect(rowsFromBoxes([])).toBe("");
  });
});
