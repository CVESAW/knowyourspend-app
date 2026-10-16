import { parseWithMapping, type ParseResult } from "@kys/statement";
import { ensureOpenBrands } from "@kys/core/ownership";
import { readPdfStatement, type PdfJsLike } from "@kys/core/pdf-statement";

/**
 * PDF statements on the device (web): pdf.js is loaded from this app's own origin (/pdf/*,
 * copied in by scripts/copy-ocr-assets.mjs) — no CDN, no upload — and packages/core rebuilds the
 * transaction table from the positioned text.
 */
export const PDF_AVAILABLE = true;

type PdfJsModule = PdfJsLike & { GlobalWorkerOptions: { workerSrc: string } };
let loading: Promise<PdfJsModule> | null = null;

function loadPdfJs(): Promise<PdfJsModule> {
  if (!loading) {
    loading = new Promise<PdfJsModule>((resolve, reject) => {
      const w = window as unknown as { __kysPdfjs?: PdfJsModule };
      if (w.__kysPdfjs) return resolve(w.__kysPdfjs);
      const done = () => (w.__kysPdfjs ? resolve(w.__kysPdfjs) : reject(new Error("Couldn't load the PDF reader")));
      window.addEventListener("kys-pdfjs-ready", done, { once: true });
      // A module script keeps pdf.js out of the app bundle and loads it only when a PDF is chosen.
      const s = document.createElement("script");
      s.type = "module";
      s.textContent = 'import * as p from "/pdf/pdf.min.mjs"; p.GlobalWorkerOptions.workerSrc = "/pdf/pdf.worker.min.mjs"; window.__kysPdfjs = p; window.dispatchEvent(new Event("kys-pdfjs-ready"));';
      s.onerror = () => reject(new Error("Couldn't load the PDF reader"));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error("The PDF reader took too long to load")), 20000);
    });
    loading.catch(() => (loading = null));
  }
  return loading;
}

export async function readStatementPdf(bytes: ArrayBuffer): Promise<ParseResult> {
  const [pdfjs] = await Promise.all([loadPdfJs(), ensureOpenBrands()]);
  try {
    const { result } = await readPdfStatement(pdfjs, bytes, parseWithMapping);
    return result;
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === "PasswordException") throw new Error("pdf-password");
    if (name === "InvalidPDFException" || name === "FormatError") throw new Error("pdf-unreadable");
    throw e;
  }
}
