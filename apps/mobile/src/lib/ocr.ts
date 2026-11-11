import { parseReceiptText, type ParsedReceipt } from "@kys/core/receipt";
import { rowsFromBoxes } from "@kys/core/ocr-lines";
import type { Picked } from "./files";

/**
 * Receipt reading on iPhone/Android: Google ML Kit text recognition, on the device (the photo is
 * never uploaded). ML Kit is a native module, so it's in development/production builds but not in
 * the Expo Go app — there we fall back to the "use the web version" note.
 */
type Rect = { left: number; top: number; right: number; bottom: number };
type MlKit = { recognizeText(uri: string): Promise<{ text: string; blocks: { lines: { text: string; frame: Rect }[] }[] }> };

let mlkit: MlKit | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mlkit = require("@infinitered/react-native-mlkit-text-recognition") as MlKit;
} catch {
  mlkit = null; // Expo Go: native module not present
}

export const OCR_AVAILABLE = !!mlkit;

export async function readReceiptImage(p: Picked, onProgress?: (p: number) => void): Promise<ParsedReceipt> {
  if (!mlkit) throw new Error("Receipt reading needs the full KnowYourSpend app build. Use the web version for receipts for now.");
  onProgress?.(0.2);
  const result = await mlkit.recognizeText(p.uri);
  onProgress?.(0.8);
  // ML Kit splits receipts into column blocks; rebuild the printed lines from the line boxes
  const boxes = result.blocks.flatMap((b) => b.lines.map((l) => ({ text: l.text, ...l.frame })));
  const text = boxes.length ? rowsFromBoxes(boxes) : result.text;
  const parsed = parseReceiptText(text);
  onProgress?.(1);
  return parsed;
}
