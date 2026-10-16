/**
 * On-device OCR engines on phones (ML Kit on Android, ML Kit/Vision on iOS) return text in blocks,
 * and on receipts they often put the item names and the prices in separate column blocks. The
 * receipt parser needs whole printed lines ("HEINZ BEANZ 4X415G   3.20"), so we rebuild them from the
 * boxes: group boxes whose vertical centres line up, then read each row left to right.
 */
export interface OcrBox {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function rowsFromBoxes(boxes: OcrBox[]): string {
  const items = boxes
    .filter((b) => b.text.trim() && b.bottom > b.top)
    .map((b) => ({ ...b, cy: (b.top + b.bottom) / 2, h: b.bottom - b.top }))
    .sort((a, b) => a.cy - b.cy);
  if (!items.length) return "";
  const medianH = [...items].sort((a, b) => a.h - b.h)[Math.floor(items.length / 2)]!.h;
  const rows: (typeof items)[] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row) {
      const rowCy = row.reduce((s, r) => s + r.cy, 0) / row.length;
      // same row when the centres are within ~half a text height (receipts photographed at a slight angle drift a little)
      if (Math.abs(it.cy - rowCy) <= Math.max(medianH * 0.55, Math.min(it.h, medianH) * 0.5)) {
        row.push(it);
        continue;
      }
    }
    rows.push([it]);
  }
  return rows
    .map((r) =>
      r
        .sort((a, b) => a.left - b.left)
        .map((b) => b.text.trim())
        .join("  "),
    )
    .join("\n");
}
