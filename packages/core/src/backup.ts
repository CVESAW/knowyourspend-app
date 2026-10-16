import { gcm } from "@noble/ciphers/aes.js";
import { bytesToUtf8, utf8ToBytes } from "@noble/ciphers/utils.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Item, ReceiptLine, StoredTransaction } from "./types";

/**
 * Encrypted backups: PBKDF2-SHA256(passphrase) → AES-256-GCM. The passphrase never leaves the
 * device; lose it and the backup can't be opened, by the user or by us. Same file format in the
 * web app and the Expo app, so a backup moves between them. Uses the browser's WebCrypto when it's
 * there (fast) and the audited pure-JS @noble libraries otherwise (phones).
 */
export const BACKUP_FORMAT = "kys-backup-v1";
const ITER = 310_000;

export interface BackupData {
  version: 1;
  exportedAt: string;
  items: Item[];
  transactions: StoredTransaction[];
  receiptLines: ReceiptLine[];
  /** Expo app: matching settings, the user's own country fixes and online lookup answers (optional; older backups lack it). */
  prefs?: unknown;
}

export interface BackupFile {
  app: "knowyourspend";
  format: typeof BACKUP_FORMAT;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function toB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=") + (i + 2 < bytes.length ? B64[n & 63]! : "=");
  }
  return out;
}
export function fromB64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]!) << 18) | (B64.indexOf(clean[i + 1]!) << 12) | ((B64.indexOf(clean[i + 2] ?? "A") & 63) << 6) | (B64.indexOf(clean[i + 3] ?? "A") & 63);
    out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out.slice(0, o);
}

type Subtle = SubtleCrypto | undefined;
const subtle = (): Subtle => (globalThis.crypto as Crypto | undefined)?.subtle;

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const s = subtle();
  if (s) {
    const base = await s.importKey("raw", utf8ToBytes(passphrase) as BufferSource, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await s.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, base, 256));
  }
  return pbkdf2Async(sha256, utf8ToBytes(passphrase), salt, { c: iterations, dkLen: 32, asyncTick: 20 });
}

async function seal(key: Uint8Array, iv: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  if (s) {
    const k = await s.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
    return new Uint8Array(await s.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, k, plain as BufferSource));
  }
  return gcm(key, iv).encrypt(plain);
}

async function open(key: Uint8Array, iv: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  const s = subtle();
  if (s) {
    const k = await s.importKey("raw", key as BufferSource, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await s.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, k, ct as BufferSource));
  }
  return gcm(key, iv).decrypt(ct);
}

/** `random` must be a cryptographically secure source (crypto.getRandomValues / expo-crypto). */
export async function encryptBackup(data: BackupData, passphrase: string, random: (n: number) => Uint8Array): Promise<string> {
  if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
  const salt = random(16);
  const iv = random(12);
  const key = await deriveKey(passphrase, salt, ITER);
  const ct = await seal(key, iv, utf8ToBytes(JSON.stringify(data)));
  const file: BackupFile = { app: "knowyourspend", format: BACKUP_FORMAT, kdf: "PBKDF2-SHA256", iterations: ITER, salt: toB64(salt), iv: toB64(iv), data: toB64(ct) };
  return JSON.stringify(file);
}

export async function decryptBackup(fileText: string, passphrase: string): Promise<BackupData> {
  let f: BackupFile;
  try {
    f = JSON.parse(fileText);
  } catch {
    throw new Error("This isn't a KnowYourSpend backup file.");
  }
  if (f?.format !== BACKUP_FORMAT) throw new Error("This isn't a KnowYourSpend backup file.");
  const key = await deriveKey(passphrase, fromB64(f.salt), f.iterations || ITER);
  let plain: Uint8Array;
  try {
    plain = await open(key, fromB64(f.iv), fromB64(f.data));
  } catch {
    throw new Error("Wrong passphrase, or the file is damaged.");
  }
  const data = JSON.parse(bytesToUtf8(plain)) as BackupData;
  if (!Array.isArray(data.items) || !Array.isArray(data.transactions) || !Array.isArray(data.receiptLines)) throw new Error("The backup is incomplete.");
  return data;
}

// ── Account copy ("vault") ─────────────────────────────────────────────────────────────────────
// The optional account keeps an encrypted copy of the same data on our server. The key is derived
// once from the user's passphrase with a salt kept beside the copy, then stored on the device, so later
// saves are quick. The server only ever holds the ciphertext; without the passphrase nobody can read it.

export const VAULT_FORMAT = "kys-vault-v1";

export interface VaultFile {
  app: "knowyourspend";
  format: typeof VAULT_FORMAT;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

/** Derive the account key. Pass the salt from an existing copy, or none to make a new one. */
export async function deriveVaultKey(passphrase: string, random: (n: number) => Uint8Array, salt?: string): Promise<{ key: Uint8Array; salt: string }> {
  if (passphrase.length < 10) throw new Error("Use a passphrase of at least 10 characters.");
  const s = salt ? fromB64(salt) : random(16);
  return { key: await deriveKey(passphrase, s, ITER), salt: toB64(s) };
}

export async function sealVault(data: BackupData, key: Uint8Array, salt: string, random: (n: number) => Uint8Array): Promise<string> {
  const iv = random(12);
  const ct = await seal(key, iv, utf8ToBytes(JSON.stringify(data)));
  const file: VaultFile = { app: "knowyourspend", format: VAULT_FORMAT, kdf: "PBKDF2-SHA256", iterations: ITER, salt, iv: toB64(iv), data: toB64(ct) };
  return JSON.stringify(file);
}

/** The salt stored with a copy (needed to derive the key on a new device). */
export function vaultSalt(text: string): string {
  const f = JSON.parse(text) as VaultFile;
  if (f?.format !== VAULT_FORMAT) throw new Error("This isn't a KnowYourSpend account copy.");
  return f.salt;
}

export async function openVault(text: string, key: Uint8Array): Promise<BackupData> {
  const f = JSON.parse(text) as VaultFile;
  if (f?.format !== VAULT_FORMAT) throw new Error("This isn't a KnowYourSpend account copy.");
  let plain: Uint8Array;
  try {
    plain = await open(key, fromB64(f.iv), fromB64(f.data));
  } catch {
    throw new Error("Wrong passphrase.");
  }
  const data = JSON.parse(bytesToUtf8(plain)) as BackupData;
  if (!Array.isArray(data.items) || !Array.isArray(data.transactions) || !Array.isArray(data.receiptLines)) throw new Error("The saved copy is incomplete.");
  return data;
}
