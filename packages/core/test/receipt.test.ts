import { describe, expect, it } from "vitest";
import { fuzzyStore, parseReceiptText } from "../src/receipt";
import { adaptiveThreshold, findPaper, stretchContrast, targetSize, type Gray } from "../src/image-ops";

describe("receipt parser", () => {
  it("reads shop, total and brands from a clean UK receipt", () => {
    const r = parseReceiptText(
      ["TESCO", "Greenwich Superstore", "COCA COLA ZERO 2L £2.15", "HEINZ BEANZ 4X415G £3.20", "TESCO BANANAS £0.92", "2 BALANCE DUE £6.27", "VISA CONTACTLESS £6.27"].join("\n"),
    );
    expect(r.storeEntryId).toBe("tesco");
    expect(r.total).toBe(6.27);
    expect(r.lines.map((l) => l.entryId).filter(Boolean)).toEqual(["coca-cola", "heinz"]);
  });

  it("takes the total the TOTAL and card lines agree on when OCR garbles one", () => {
    const r = parseReceiptText(["ASDA", "PEPSI MAX 2L 2.00", "HOVIS SOFT WHITE 1.40", "TOTAL 3.4O", "VISA CONTACTLESS 3.40"].join("\n"));
    expect(r.total).toBe(3.4);
  });

  it("keeps a branded line even when its price is unreadable", () => {
    const r = parseReceiptText(["ALDI", "NUTELLA 400G", "PRINGLES ORIGINAL 2.25", "TOTAL 5.74"].join("\n"));
    expect(r.lines.find((l) => l.entryId === "ferrero")?.price).toBeUndefined();
  });

  it("tolerates a one-letter slip in a long shop name", () => {
    expect(fuzzyStore(["SAINSBURYS"])?.id).toBe("sainsburys");
    expect(fuzzyStore(["SAINSBURV'S"])?.id).toBe("sainsburys");
  });

  it("does not turn short near-misses in receipt noise into shops", () => {
    expect(fuzzyStore(["OPEN 8:00AM TO 9:00PM DAILY"])).toBeUndefined();
    expect(fuzzyStore(["LL SE VE SELL FOR LESS KO"])).toBeUndefined();
    expect(fuzzyStore(["LO RAL"])).toBeUndefined();
    expect(fuzzyStore(["GIVE US FEEDBACK @ SURVEY.WALMART.COM TA"])).toBeUndefined();
    expect(parseReceiptText("-Z RE Ee\nFOO 1.00\nTOTAL 1.00").storeEntryId).toBeUndefined();
    expect(parseReceiptText("WALMART\nSAVE MONEY LIVE BETTER\nST# 1234\nOP# 99\nEE\nMILK 1.00\nTOTAL 1.00").storeEntryId).toBeUndefined();
    expect(parseReceiptText("EE\nEE Store Oxford St\nSIM PACK 10.00\nTOTAL 10.00").storeEntryId).toBe("ee");
    expect(parseReceiptText("» . Lo Lo. oT To\nd al —- - [] © ve . .\nEE ~~\n~ © WALMART 1 ~~\nMILK 1.00\nTOTAL 1.00").storeEntryId).toBeUndefined();
    expect(parseReceiptText("Rp LU ff\nHa Give us feedback @ survey.walmart.com  - ln er\nMILK 1.00\nTOTAL 1.00").storeEntryId).toBeUndefined();
    expect(parseReceiptText("ASDA Greenwich Peninsula\nPEPSI MAX 2L 2.00\nTOTAL 2.00").storeEntryId).toBe("asda");
    expect(parseReceiptText("M&S\nSIMPLY FOOD\nSANDWICH 3.00\nTOTAL 3.00").storeEntryId).toBeDefined();
  });
});

describe("image ops", () => {
  function synth(w: number, h: number, f: (x: number, y: number) => number): Gray {
    const px = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = f(x, y);
    return { w, h, px };
  }

  it("finds a bright receipt on a dark table", () => {
    const g = synth(400, 600, (x, y) => (x >= 100 && x < 300 && y >= 50 && y < 550 ? 230 : 60));
    const box = findPaper(g)!;
    expect(box.x).toBeGreaterThan(80);
    expect(box.x + box.w).toBeLessThan(320);
    expect(box.y).toBeGreaterThan(30);
  });

  it("returns nothing when the photo is all paper", () => {
    expect(findPaper(synth(300, 300, () => 230))).toBeNull();
  });

  it("thresholds dark text to black and paper to white under a lighting gradient", () => {
    const g = stretchContrast(synth(400, 400, (x, y) => (y % 40 < 4 && x % 20 < 10 ? 40 : 240) - x * 0.3));
    const b = adaptiveThreshold(g);
    expect(b.px[2 * 400 + 5]).toBe(0);
    expect(b.px[20 * 400 + 390]).toBe(255);
  });

  it("scales small photos up and huge ones down", () => {
    expect(targetSize(700, 1400).w).toBe(1400);
    expect(targetSize(6000, 8000).w).toBeLessThanOrEqual(2400);
  });
});
