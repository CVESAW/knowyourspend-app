import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import { getRandomValues } from "expo-crypto";
import { decryptBackup, encryptBackup, type BackupData } from "@kys/core/backup";
import { store } from "./store";

const random = (n: number) => getRandomValues(new Uint8Array(n));
const fileName = () => `knowyourspend-backup-${new Date().toISOString().slice(0, 10)}.kys.json`;

/** Save an encrypted backup of everything on this device. Web: downloads a file. Phones: system share sheet (Files, Drive, email to yourself…). */
export async function saveBackup(passphrase: string): Promise<void> {
  const s = await store.ready();
  const data: BackupData = { version: 1, exportedAt: new Date().toISOString(), items: s.items, transactions: s.txns, receiptLines: s.lines, prefs: s.prefs };
  const text = await encryptBackup(data, passphrase, random);
  if (Platform.OS === "web") {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = fileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return;
  }
  const { File, Paths } = await import("expo-file-system");
  const f = new File(Paths.cache, fileName());
  if (f.exists) f.delete();
  f.create();
  f.write(text);
  await Sharing.shareAsync(f.uri, { mimeType: "application/json", dialogTitle: "Save your KnowYourSpend backup", UTI: "public.json" });
}

/** Restore a backup. Merges with what's already here (nothing is overwritten twice; duplicates are skipped). */
export async function restoreBackup(passphrase: string): Promise<{ items: number } | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: Platform.OS === "web" ? ["application/json", ".json"] : "*/*", copyToCacheDirectory: true, base64: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  let text: string;
  if (a.file) text = await a.file.text();
  else if (Platform.OS === "web") text = await (await fetch(a.uri)).text();
  else {
    const { File } = await import("expo-file-system");
    text = await new File(a.uri).text();
  }
  const data = await decryptBackup(text, passphrase);
  let added = 0;
  await store.update((d) => {
    const ids = new Set(d.items.map((i) => i.id));
    const newItems = data.items.filter((i) => !ids.has(i.id));
    added = newItems.length;
    const tx = new Set(d.txns.map((t) => t.id));
    const ln = new Set(d.lines.map((l) => l.id));
    const p = data.prefs as Partial<typeof d.prefs> | undefined;
    return {
      ...(p ? { prefs: { ...d.prefs, overrides: { ...(p.overrides ?? {}), ...d.prefs.overrides }, lookups: { ...(p.lookups ?? {}), ...d.prefs.lookups }, lookupLocal: { ...(p.lookupLocal ?? {}), ...d.prefs.lookupLocal }, lookupChecks: { ...(p.lookupChecks ?? {}), ...d.prefs.lookupChecks } } } : {}),
      items: [...newItems, ...d.items],
      txns: [...d.txns, ...data.transactions.filter((t) => !tx.has(t.id))],
      lines: [...d.lines, ...data.receiptLines.filter((l) => !ln.has(l.id))],
    };
  });
  return { items: added };
}
