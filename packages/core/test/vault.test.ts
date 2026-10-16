import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { deriveVaultKey, openVault, sealVault, vaultSalt, type BackupData } from "../src/backup";

const random = (n: number) => webcrypto.getRandomValues(new Uint8Array(n));
const data: BackupData = {
  version: 1,
  exportedAt: "2026-10-11T00:00:00Z",
  items: [],
  transactions: [],
  receiptLines: [{ id: "l1", itemId: "i1", text: "TESCO MEAL DEAL 3.85", included: true }],
  prefs: { overrides: { "CORNER CAFE": "GB" } },
};

describe("account copy (vault)", () => {
  it("a second device derives the same key from the passphrase and the stored salt", async () => {
    const a = await deriveVaultKey("correct horse battery", random);
    const text = await sealVault(data, a.key, a.salt, random);
    const b = await deriveVaultKey("correct horse battery", random, vaultSalt(text));
    expect(b.salt).toBe(a.salt);
    expect(await openVault(text, b.key)).toEqual(data);
  });

  it("the stored copy carries no readable data, and a wrong passphrase can't open it", async () => {
    const a = await deriveVaultKey("correct horse battery", random);
    const text = await sealVault(data, a.key, a.salt, random);
    expect(text).not.toMatch(/TESCO|CORNER|3\.85/);
    const wrong = await deriveVaultKey("wrong horse battery", random, a.salt);
    await expect(openVault(text, wrong.key)).rejects.toThrow("Wrong passphrase");
  });

  it("each save uses a fresh IV, and short passphrases are refused", async () => {
    const a = await deriveVaultKey("correct horse battery", random);
    const one = JSON.parse(await sealVault(data, a.key, a.salt, random));
    const two = JSON.parse(await sealVault(data, a.key, a.salt, random));
    expect(one.iv).not.toBe(two.iv);
    await expect(deriveVaultKey("short", random)).rejects.toThrow("at least 10");
  });
});
