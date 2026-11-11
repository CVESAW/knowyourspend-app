/**
 * The page that reads PDF statements on phones.
 *
 * pdf.js needs a browser, so the phone app runs it in a hidden WebView. The page is sealed:
 *  - pdf.js is compiled into the app as text (pdf-engine.generated.ts) and started from blob: URLs,
 *  - its Content-Security-Policy allows no network at all (no http/https in any directive),
 *  - the host refuses every navigation away from it.
 * The app sends the PDF's bytes in, the page sends back each page's positioned text, and
 * packages/core rebuilds the transaction table exactly as on the web. Nothing is stored by the page.
 *
 * This file has no React Native imports so it can be tested in a plain browser.
 */

/** One text run from pdf.js getTextContent(), trimmed to what packages/core uses. */
export interface RawPdfItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}
export interface RawPdfPage {
  width: number;
  height: number;
  items: RawPdfItem[];
}

/** Messages from the page to the app. */
export type EngineMessage =
  | { type: "ready" }
  | { type: "boot-error"; message: string }
  | { type: "result"; id: string; pages: RawPdfPage[]; numPages: number }
  | { type: "error"; id: string; message: string; password?: boolean };

export const MAX_PDF_PAGES = 60;

/**
 * The page's origin. ".invalid" names can never resolve, and the page's CSP allows no network
 * anyway; a real origin (rather than an opaque one) lets pdf.js start its worker from a blob: URL.
 */
export const PDF_ENGINE_BASE_URL = "https://kys-pdf.invalid/";

/** JSON that is safe inside an HTML <script> element. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").split("\u2028").join("\\u2028").split("\u2029").join("\\u2029");
}

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "worker-src blob:",
  "connect-src blob: data:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
].join("; ");

/**
 * The engine page. It calls `post(msg)` with an EngineMessage (via window.ReactNativeWebView on
 * phones) and exposes `window.__kysReadPdf(id, base64)`.
 */
export function buildPdfEngineHtml(pdfjsMain: string, pdfjsWorker: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<script>window.__kysMain=${scriptJson(pdfjsMain)};window.__kysWorker=${scriptJson(pdfjsWorker)};</script>
<script>
(function () {
  var MAX_PAGES = ${MAX_PDF_PAGES};
  function post(msg) {
    var s = JSON.stringify(msg);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s);
    else if (window.__kysPost) window.__kysPost(s);
  }
  function fromB64(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var ready = (async function () {
    var mainUrl = URL.createObjectURL(new Blob([window.__kysMain], { type: "text/javascript" }));
    var workerUrl = URL.createObjectURL(new Blob([window.__kysWorker], { type: "text/javascript" }));
    window.__kysMain = window.__kysWorker = null;
    var pdfjs = await import(mainUrl);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  })();
  ready.then(function () { post({ type: "ready" }); }, function (e) { post({ type: "boot-error", message: String((e && e.message) || e) }); });

  window.__kysReadPdf = async function (id, b64) {
    var task = null;
    try {
      var pdfjs = await ready;
      task = pdfjs.getDocument({ data: fromB64(b64), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
      var doc = await task.promise;
      var pages = [];
      for (var n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
        var page = await doc.getPage(n);
        var vp = page.getViewport({ scale: 1 });
        var tc = await page.getTextContent();
        var items = [];
        for (var i = 0; i < tc.items.length; i++) {
          var it = tc.items[i];
          if (!it || typeof it.str !== "string" || !it.str.trim() || !it.transform) continue;
          items.push({ str: it.str, transform: Array.prototype.slice.call(it.transform, 0, 6), width: it.width || 0, height: it.height || 0 });
        }
        pages.push({ width: vp.width, height: vp.height, items: items });
        page.cleanup();
      }
      post({ type: "result", id: id, pages: pages, numPages: doc.numPages });
    } catch (e) {
      var name = e && e.name;
      post({ type: "error", id: id, message: String((e && e.message) || e), password: name === "PasswordException" });
    } finally {
      if (task) task.destroy().catch(function () {});
    }
  };
})();
</script></body></html>`;
}

/** A pdf.js-shaped document over pages the engine page already read, for packages/core. */
export function docFromRawPages(pages: RawPdfPage[]) {
  return {
    numPages: pages.length,
    async getPage(n: number) {
      const p = pages[n - 1];
      return {
        getViewport: () => ({ width: p.width, height: p.height }),
        getTextContent: async () => ({ items: p.items as unknown[] }),
      };
    },
  };
}
