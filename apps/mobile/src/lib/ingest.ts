import { parseStatement, parseWithMapping, type ColumnMapping, type ParseResult } from "@kys/statement";
import { ensureOpenBrands } from "@kys/core/ownership";
import { recordDeletion } from "./account";
import { track } from "./usage";
import { decodeStatementBytes } from "./decode";
import { newId } from "./id";
import type { LookupPlan } from "./lookup";
import { findReceiptMatch } from "./aggregate";
import { store } from "./store";
import type { Disclosure, Item, ReceiptLine, StoredTransaction } from "./types";
import type { ParsedReceiptLine } from "./receipt";

/** Read statement bytes on the device. Nothing is uploaded. */
export async function readStatementBytes(bytes: ArrayBuffer, fileName: string, mapping?: ColumnMapping): Promise<ParseResult> {
  await ensureOpenBrands(); // web: make sure the full brand list is in before anything is matched
  const text = decodeStatementBytes(bytes);
  return mapping ? parseWithMapping(text, mapping) : parseStatement(text, { filename: fileName });
}

// Matching payees to owners is shared with the web app (packages/core).
export { prepareStatement, type PreparedStatement } from "@kys/core/prepare";
import type { PreparedStatement } from "@kys/core/prepare";

/** Disclosure for a submission where nothing was sent (receipts; statements before any lookup). */
export function offDisclosure(plan: LookupPlan): Disclosure {
  return {
    mode: "off",
    sent: [],
    notSent: plan.candidates,
    sensitiveHeld: plan.sensitive,
    recognisedLocally: plan.recognisedLocally,
    transfersExcluded: plan.transfersExcluded,
    rowsRead: plan.rowsRead,
  };
}

/** Receipts added earlier may match a transaction in a newly added statement (same shop, amount, ±3 days). */
function relinkReceipts(items: Item[], txns: StoredTransaction[]): Item[] {
  return items.map((r) => {
    if (r.kind !== "receipt" || !r.receipt || r.receipt.matchedTransactionId) return r;
    const m = findReceiptMatch(r, txns);
    return m ? { ...r, receipt: { ...r.receipt, matchedTransactionId: m.id } } : r;
  });
}

/** Save a statement item. Overlapping re-imports are de-duplicated against everything already on the device. */
export async function saveStatement(prep: PreparedStatement, itemId: string, disclosure: Disclosure, fileName?: string): Promise<{ item: Item; added: number; duplicates: number }> {
  const snap = await store.ready();
  const existing = new Set(snap.txns.map((t) => t.id));
  const newOnes: StoredTransaction[] = [];
  for (const t of prep.txns) {
    if (existing.has(t.id)) continue;
    existing.add(t.id);
    newOnes.push({ ...t, itemId });
  }
  const range = prep.parse.dateRange;
  const bank = prep.parse.bank;
  const item: Item = {
    id: itemId,
    kind: "statement",
    title: bank ? `${bank.name} statement` : "Bank statement",
    createdAt: new Date().toISOString(),
    dateFrom: range?.from,
    dateTo: range?.to,
    bankId: bank?.id,
    bankName: bank?.name,
    fileName,
    disclosure,
  };
  await store.update((d) => {
    const txns = [...d.txns, ...newOnes];
    return { ...d, items: relinkReceipts([item, ...d.items], txns), txns };
  });
  track("statement_added");
  return { item, added: newOnes.length, duplicates: prep.txns.length - newOnes.length };
}

export interface ReceiptDraft {
  storeText?: string;
  storeEntryId?: string;
  date?: string;
  total?: number;
  lines: (ParsedReceiptLine & { included: boolean })[];
}

/** Save a confirmed receipt. Only the text the user confirmed is kept — never the photo. */
export async function saveReceipt(draft: ReceiptDraft, disclosure: Disclosure): Promise<Item> {
  const id = newId("i_");
  const date = draft.date ?? new Date().toISOString().slice(0, 10);
  const base: Item = {
    id,
    kind: "receipt",
    title: `${draft.storeText ?? "Shop"} receipt`,
    createdAt: new Date().toISOString(),
    dateFrom: date,
    dateTo: date,
    disclosure,
    receipt: { storeText: draft.storeText, storeEntryId: draft.storeEntryId, date, total: draft.total },
  };
  const lines: ReceiptLine[] = draft.lines.map((l) => ({
    id: newId("l_"),
    itemId: id,
    text: l.text,
    price: l.price,
    entryId: l.entryId,
    ownBrandRetailerId: l.ownBrandRetailerId,
    included: l.included,
  }));
  let saved = base;
  await store.update((d) => {
    [saved] = relinkReceipts([base], d.txns);
    return { ...d, items: [saved, ...d.items], lines: [...d.lines, ...lines] };
  });
  track("receipt_added");
  return saved;
}

export async function deleteItem(id: string): Promise<void> {
  await recordDeletion(id); // so another device's account copy doesn't bring it back
  await store.update((d) => ({
    items: d.items.filter((i) => i.id !== id).map((i) => (i.receipt?.matchedTransactionId && d.txns.find((t) => t.id === i.receipt!.matchedTransactionId)?.itemId === id ? { ...i, receipt: { ...i.receipt, matchedTransactionId: undefined } } : i)),
    txns: d.txns.filter((t) => t.itemId !== id),
    lines: d.lines.filter((l) => l.itemId !== id),
  }));
}

export function newItemId(): string {
  return newId("i_");
}
