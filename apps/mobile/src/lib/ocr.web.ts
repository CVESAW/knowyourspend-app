import { grayToRgba, prepareForOcr, rgbaToGray, workingSize, type Variant } from "./image-ops";
import { parseReceiptText, parseScore, type ParsedReceipt } from "./receipt";
import type { Picked } from "./files";

/**
 * Receipt reading on the device (web):
 *  1. the photo is downscaled, the paper found and cropped, and turned into high-contrast greyscale in a <canvas>
 *  2. Tesseract.js (WASM) reads the text in a Web Worker, using files served from this app's own
 *     origin (/ocr/*) — no CDN, no upload
 *  3. we parse shop, date, total and line items from the text
 * The photo itself is never stored or sent.
 */
export const OCR_AVAILABLE = true;

type TesseractWorker = {
  recognize: (img: HTMLCanvasElement) => Promise<{ data: { text: string; confidence: number } }>;
};
type TesseractGlobal = { createWorker: (lang: string, oem: number, opts: Record<string, unknown>) => Promise<TesseractWorker> };

let workerPromise: Promise<TesseractWorker> | null = null;
let progressCb: ((p: number) => void) | undefined;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as unknown as { Tesseract?: unknown }).Tesseract) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load the receipt reader"));
    document.head.appendChild(s);
  });
}

function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript("/ocr/tesseract.min.js");
      const T = (window as unknown as { Tesseract: TesseractGlobal }).Tesseract;
      return T.createWorker("eng", 1, {
        workerPath: "/ocr/worker.min.js",
        corePath: "/ocr",
        langPath: "/ocr",
        gzip: true,
        workerBlobURL: false,
        logger: (m: { status: string; progress: number }) => {
          if (m.status === "recognizing text") progressCb?.(0.3 + m.progress * 0.7);
          else if (m.status.startsWith("load")) progressCb?.(Math.min(0.3, m.progress * 0.3));
        },
      });
    })();
    workerPromise.catch(() => (workerPromise = null));
  }
  return workerPromise;
}

async function loadBitmap(p: Picked): Promise<ImageBitmap> {
  const blob = p.file ?? (await (await fetch(p.uri)).blob());
  return createImageBitmap(blob);
}

async function preprocess(bmp: ImageBitmap, variant: Variant): Promise<HTMLCanvasElement> {
  const ws = workingSize(bmp.width, bmp.height);
  const work = document.createElement("canvas");
  work.width = ws.w;
  work.height = ws.h;
  const wctx = work.getContext("2d", { willReadFrequently: true })!;
  wctx.imageSmoothingQuality = "high";
  wctx.drawImage(bmp, 0, 0, ws.w, ws.h);
  const g = prepareForOcr(rgbaToGray(wctx.getImageData(0, 0, ws.w, ws.h).data, ws.w, ws.h), variant);
  const out = document.createElement("canvas");
  out.width = g.w;
  out.height = g.h;
  const octx = out.getContext("2d")!;
  const img = octx.createImageData(g.w, g.h);
  img.data.set(grayToRgba(g));
  octx.putImageData(img, 0, 0);
  return out;
}

/** Two passes when needed: thresholded first; if that reads poorly, a softer image; keep the better read. */
export async function readReceiptImage(p: Picked, onProgress?: (p: number) => void): Promise<ParsedReceipt> {
  progressCb = (x) => onProgress?.(x * 0.6);
  const worker = await getWorker();
  const bmp = await loadBitmap(p);
  try {
    const a = await worker.recognize(await preprocess(bmp, "binary"));
    let best = parseReceiptText(a.data.text);
    best.confidence = a.data.confidence;
    if (best.total == null || best.lines.length < 2 || !best.storeEntryId) {
      onProgress?.(0.7);
      progressCb = undefined;
      const b = await worker.recognize(await preprocess(bmp, "soft"));
      const alt = parseReceiptText(b.data.text);
      alt.confidence = b.data.confidence;
      if (parseScore(alt) > parseScore(best)) best = alt;
    }
    onProgress?.(1);
    return best;
  } finally {
    bmp.close();
  }
}
