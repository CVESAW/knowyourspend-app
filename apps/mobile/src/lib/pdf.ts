import { parseWithMapping, type ParseResult } from "@kys/statement";
import { readPdfStatement, type PdfJsLike } from "@kys/core/pdf-statement";
import { toB64 } from "@kys/core/backup";
import { docFromRawPages, type EngineMessage, type RawPdfPage } from "./pdf-engine";

/**
 * PDF statements on phones. pdf.js runs in a hidden, sealed WebView (components/PdfEngineHost,
 * page built in lib/pdf-engine.ts) that has no network access; it hands back each page's
 * positioned text and packages/core rebuilds the table — the same code the web version uses.
 */
export const PDF_AVAILABLE = true;

const TIMEOUT_MS = 90_000;
const MAX_BYTES = 25 * 1024 * 1024;

type Job = { id: string; b64: string; resolve: (p: RawPdfPage[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** The host component registers here; jobs wait until it reports the page is ready. */
type Host = { run: (id: string, b64: string) => void; setWanted: (wanted: boolean) => void };
let host: Host | null = null;
let ready = false;
const queue: Job[] = [];
const running = new Map<string, Job>();
let seq = 0;

export const pdfBridge = {
  attach(h: Host) {
    host = h;
    if (queue.length || running.size) h.setWanted(true);
  },
  detach(h: Host) {
    if (host === h) {
      host = null;
      ready = false;
    }
  },
  /** The page was (re)loaded or torn down. */
  setReady(r: boolean) {
    ready = r;
    if (!r) {
      // Anything in flight is lost with the page.
      for (const j of running.values()) finish(j, new Error("The PDF reader stopped. Please try again."));
    }
    pump();
  },
  onMessage(raw: string) {
    let m: EngineMessage;
    try {
      m = JSON.parse(raw) as EngineMessage;
    } catch {
      return;
    }
    if (m.type === "ready") return pdfBridge.setReady(true);
    if (m.type === "boot-error") {
      ready = false;
      for (const j of [...queue.splice(0), ...running.values()]) finish(j, new Error("Couldn't start the PDF reader on this phone."));
      return;
    }
    const job = running.get(m.id);
    if (!job) return;
    if (m.type === "result") finish(job, undefined, m.pages);
    else finish(job, new Error(m.password ? "pdf-password" : "pdf-unreadable"));
  },
};

function finish(job: Job, err?: Error, pages?: RawPdfPage[]) {
  clearTimeout(job.timer);
  running.delete(job.id);
  const qi = queue.indexOf(job);
  if (qi >= 0) queue.splice(qi, 1);
  if (err) job.reject(err);
  else job.resolve(pages ?? []);
  if (!queue.length && !running.size) host?.setWanted(false);
  else pump();
}

function pump() {
  if (!host || !ready) return;
  while (queue.length) {
    const job = queue.shift()!;
    running.set(job.id, job);
    host.run(job.id, job.b64);
  }
}

function extractPages(bytes: ArrayBuffer): Promise<RawPdfPage[]> {
  return new Promise((resolve, reject) => {
    const id = `pdf-${Date.now()}-${++seq}`;
    const job: Job = {
      id,
      b64: toB64(new Uint8Array(bytes)),
      resolve,
      reject,
      timer: setTimeout(() => finish(job, new Error("Reading this PDF took too long. Try the bank's CSV export instead.")), TIMEOUT_MS),
    };
    queue.push(job);
    if (host) {
      host.setWanted(true);
      pump();
    }
  });
}

export async function readStatementPdf(bytes: ArrayBuffer): Promise<ParseResult> {
  if (bytes.byteLength > MAX_BYTES) throw new Error("This PDF is too large to read on the phone (over 25 MB).");
  const pages = await extractPages(bytes);
  const fromPages: PdfJsLike = { getDocument: () => ({ promise: Promise.resolve(docFromRawPages(pages)) }) };
  const { result } = await readPdfStatement(fromPages, new ArrayBuffer(0), parseWithMapping);
  return result;
}
