import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { decryptBackup, encryptBackup, fromB64, toB64, type BackupData } from "../src/backup";

const random = (n: number) => webcrypto.getRandomValues(new Uint8Array(n));
const data: BackupData = { version: 1, exportedAt: "2026-10-01T00:00:00Z", items: [], transactions: [], receiptLines: [{ id: "l1", itemId: "i1", text: "CAFÉ £3 ☕", included: true }] };

describe("backups", () => {
  it("base64 round-trips every length", () => {
    for (let n = 0; n < 40; n++) {
      const b = random(n);
      expect(fromB64(toB64(b))).toEqual(b);
      expect(toB64(b)).toBe(Buffer.from(b).toString("base64"));
    }
  });

  it("round-trips with WebCrypto, and the pure-JS path opens the same file", async () => {
    const file = await encryptBackup(data, "correct horse", random);
    expect(JSON.parse(file)).toMatchObject({ app: "knowyourspend", format: "kys-backup-v1" });
    expect(await decryptBackup(file, "correct horse")).toEqual(data);
    // simulate a phone (no WebCrypto)
    const saved = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(await decryptBackup(file, "correct horse")).toEqual(data);
      const phoneFile = await encryptBackup(data, "correct horse", random);
      if (saved) Object.defineProperty(globalThis, "crypto", saved);
      expect(await decryptBackup(phoneFile, "correct horse")).toEqual(data);
    } finally {
      if (saved) Object.defineProperty(globalThis, "crypto", saved);
    }
  }, 60_000);

  it("refuses a wrong passphrase, a short passphrase and a non-backup file", async () => {
    const file = await encryptBackup(data, "correct horse", random);
    await expect(decryptBackup(file, "wrong horse")).rejects.toThrow(/Wrong passphrase/);
    await expect(encryptBackup(data, "short", random)).rejects.toThrow(/8 characters/);
    await expect(decryptBackup("{}", "x")).rejects.toThrow(/isn't a KnowYourSpend backup/);
  });
});
