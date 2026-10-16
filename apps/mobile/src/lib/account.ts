import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { getRandomValues } from "expo-crypto";
import { deriveVaultKey, fromB64, openVault, sealVault, toB64, vaultSalt, type BackupData } from "@kys/core/backup";
import { kv } from "./kv";
import { LOOKUP_KEY } from "./lookup";
import { store } from "./store";

/**
 * Optional account. Nobody needs one: the app works fully without signing in. Signing in (with a
 * 6-digit code sent by email — no password) lets someone keep an encrypted copy of their data on our
 * server and open it on another device.
 *
 * The copy is encrypted on this device with a key made from a passphrase only the user knows
 * (PBKDF2-SHA256 → AES-256-GCM, @kys/core/backup). The server stores ciphertext, its size and when it was
 * saved — never amounts, shop names or anything else readable. Lose the passphrase and the copy can't be
 * opened, by the user or by us. The key is kept on this device after the first unlock, beside the data
 * it protects (which is already stored here in the clear), so later saves happen automatically.
 *
 * Talks to Supabase Auth and the kys_vault table (row-level security: each account can only reach its
 * own row) over plain fetch, so no SDK is added to the app.
 */
export const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? "https://cxvwngmnkxtweuwaxfmz.supabase.co").replace(/\/$/, "");
const ANON = LOOKUP_KEY;
const random = (n: number) => getRandomValues(new Uint8Array(n));

interface Session {
  access_token: string;
  refresh_token: string;
  /** ms since epoch */
  expires_at: number;
  user_id: string;
  email: string;
}
interface VaultKey {
  key: string; // base64
  salt: string;
}

export interface AccountState {
  ready: boolean;
  email: string | null;
  /** signed in and the account copy is unlocked on this device */
  syncing: boolean;
  status: "idle" | "saving" | "saved" | "offline" | "error";
  savedAt: string | null;
  error: string | null;
}

const K = { session: "kys.account.session", key: "kys.account.key", synced: "kys.account.synced", deleted: "kys.account.deleted" };

let session: Session | null = null;
let vaultKey: VaultKey | null = null;
let state: AccountState = { ready: false, email: null, syncing: false, status: "idle", savedAt: null, error: null };
const listeners = new Set<() => void>();
function set(p: Partial<AccountState>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function useAccount(): AccountState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
    () => state,
  );
}
export const account = { get: () => state };

// ── Supabase Auth (email code) ─────────────────────────────────────────────────────────────────
async function authPost(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${token ?? ANON}` },
    body: JSON.stringify(body),
  });
}
async function readError(res: Response): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { msg?: string; message?: string; error_description?: string; error?: string };
  const m = j.msg ?? j.message ?? j.error_description ?? j.error ?? `HTTP ${res.status}`;
  if (res.status === 429 || /rate limit/i.test(m)) return "Too many tries. Please wait a few minutes and try again.";
  if (/expired|invalid/i.test(m)) return "That code didn't work. Check it, or ask for a new one.";
  return m;
}
function toSession(j: { access_token: string; refresh_token: string; expires_in: number; user: { id: string; email?: string } }): Session {
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + j.expires_in * 1000, user_id: j.user.id, email: j.user.email ?? "" };
}
async function saveSession(s: Session | null) {
  session = s;
  if (s) await kv.set(K.session, JSON.stringify(s));
  else await kv.remove(K.session);
  set({ email: s?.email ?? null });
}

/** Step 1: email a 6-digit code (also creates the account the first time). */
export async function requestCode(email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("Please enter a valid email address.");
  const res = await authPost("otp", { email: e, create_user: true });
  if (!res.ok) throw new Error(await readError(res));
}

/** Step 2: check the code. Returns whether this account already has a saved copy. */
export async function verifyCode(email: string, code: string): Promise<{ hasCopy: boolean }> {
  const res = await authPost("verify", { type: "email", email: email.trim().toLowerCase(), token: code.replace(/\s/g, "") });
  if (!res.ok) throw new Error(await readError(res));
  await saveSession(toSession(await res.json()));
  return { hasCopy: !!(await fetchCopy()) };
}

async function token(): Promise<string> {
  if (!session) throw new Error("Not signed in.");
  if (session.expires_at - Date.now() < 60_000) {
    const res = await authPost("token?grant_type=refresh_token", { refresh_token: session.refresh_token });
    if (!res.ok) {
      await saveSession(null);
      set({ syncing: false, error: "You've been signed out. Sign in again to keep saving to your account." });
      throw new Error("signed out");
    }
    await saveSession(toSession(await res.json()));
  }
  return session!.access_token;
}

// ── The encrypted copy ─────────────────────────────────────────────────────────────────────────
async function fetchCopy(): Promise<{ blob: string; updated_at: string } | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kys_vault?select=blob,updated_at`, { headers: { apikey: ANON, Authorization: `Bearer ${await token()}` } });
  if (!res.ok) throw new Error(`Couldn't reach your account (HTTP ${res.status}).`);
  const rows = (await res.json()) as { blob: string; updated_at: string }[];
  return rows[0] ?? null;
}

type Payload = BackupData & { deleted?: string[] };

async function deletedIds(): Promise<string[]> {
  try {
    return JSON.parse((await kv.get(K.deleted)) ?? "[]");
  } catch {
    return [];
  }
}

/** Remember a deleted item so it isn't brought back from the account copy by another device. */
export async function recordDeletion(id: string): Promise<void> {
  if (!session) return;
  const d = await deletedIds();
  if (!d.includes(id)) await kv.set(K.deleted, JSON.stringify([...d, id].slice(-5000)));
}

async function snapshot(): Promise<Payload> {
  const s = await store.ready();
  return { version: 1, exportedAt: new Date().toISOString(), items: s.items, transactions: s.txns, receiptLines: s.lines, prefs: s.prefs, deleted: await deletedIds() };
}

/** Merge a copy into this device: nothing local is lost, deletions from either side are respected. */
async function mergeIn(data: Payload): Promise<void> {
  const gone = new Set([...(data.deleted ?? []), ...(await deletedIds())]);
  await kv.set(K.deleted, JSON.stringify([...gone].slice(-5000)));
  await store.update((d) => {
    const ids = new Set(d.items.map((i) => i.id));
    const tx = new Set(d.txns.map((t) => t.id));
    const ln = new Set(d.lines.map((l) => l.id));
    const p = data.prefs as Partial<typeof d.prefs> | undefined;
    return {
      ...(p ? { prefs: { ...d.prefs, overrides: { ...(p.overrides ?? {}), ...d.prefs.overrides }, lookups: { ...(p.lookups ?? {}), ...d.prefs.lookups } } } : {}),
      items: [...data.items.filter((i) => !ids.has(i.id)), ...d.items].filter((i) => !gone.has(i.id)),
      txns: [...d.txns, ...data.transactions.filter((t) => !tx.has(t.id))].filter((t) => !gone.has(t.itemId)),
      lines: [...d.lines, ...data.receiptLines.filter((l) => !ln.has(l.id))].filter((l) => !gone.has(l.itemId)),
    };
  });
}

let lastPushed = "";
async function push(): Promise<void> {
  if (!session || !vaultKey || store.get().mode !== "real") return;
  const data = await snapshot();
  const fingerprint = JSON.stringify([data.items.map((i) => i.id), data.transactions.length, data.receiptLines.length, data.prefs, data.deleted]);
  if (fingerprint === lastPushed) return;
  set({ status: "saving", error: null });
  try {
    const blob = await sealVault(data, fromB64(vaultKey.key), vaultKey.salt, random);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/kys_vault?on_conflict=user_id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${await token()}`, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ user_id: session.user_id, blob }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const [row] = (await res.json()) as { updated_at: string }[];
    lastPushed = fingerprint;
    await kv.set(K.synced, row?.updated_at ?? new Date().toISOString());
    set({ status: "saved", savedAt: row?.updated_at ?? new Date().toISOString() });
  } catch (e) {
    const offline = typeof navigator !== "undefined" && "onLine" in navigator && !navigator.onLine;
    set({ status: offline ? "offline" : "error", error: offline ? null : "Couldn't save to your account. We'll try again." });
  }
}

/** Pull the account copy if another device saved since we last did. */
async function pull(): Promise<void> {
  if (!session || !vaultKey || store.get().mode !== "real") return;
  const copy = await fetchCopy();
  if (!copy) return;
  const synced = await kv.get(K.synced);
  if (synced && copy.updated_at <= synced) return;
  await mergeIn((await openVault(copy.blob, fromB64(vaultKey.key))) as Payload);
  await kv.set(K.synced, copy.updated_at);
}

/** Whether the signed-in account already has a saved copy (to ask for its passphrase, or a new one). */
export async function hasSavedCopy(): Promise<boolean> {
  return !!(await fetchCopy());
}

/** Step 3a (new account): choose the passphrase and save the first copy. */
export async function createPassphrase(passphrase: string): Promise<void> {
  const { key, salt } = await deriveVaultKey(passphrase, random);
  vaultKey = { key: toB64(key), salt };
  await kv.set(K.key, JSON.stringify(vaultKey));
  set({ syncing: true });
  lastPushed = "";
  await push();
  startAutoSave();
}

/** Step 3b (existing account): unlock the saved copy with the passphrase and merge it into this device. */
export async function unlockCopy(passphrase: string): Promise<void> {
  const copy = await fetchCopy();
  if (!copy) return createPassphrase(passphrase);
  const { key, salt } = await deriveVaultKey(passphrase, random, vaultSalt(copy.blob));
  const data = (await openVault(copy.blob, key)) as Payload; // throws "Wrong passphrase."
  vaultKey = { key: toB64(key), salt };
  await kv.set(K.key, JSON.stringify(vaultKey));
  if (store.get().mode !== "real") await store.load("real");
  await mergeIn(data);
  await kv.set(K.synced, copy.updated_at);
  set({ syncing: true });
  lastPushed = "";
  await push();
  startAutoSave();
}

/** Forgot the passphrase: delete the saved copy (this device's data stays) and choose a new one. */
export async function resetCopy(newPassphrase: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kys_vault?user_id=eq.${session?.user_id}`, { method: "DELETE", headers: { apikey: ANON, Authorization: `Bearer ${await token()}` } });
  if (!res.ok) throw new Error(`Couldn't delete the old copy (HTTP ${res.status}).`);
  await kv.remove(K.synced);
  await createPassphrase(newPassphrase);
}

/** Sign out on this device. The data on this device and the account copy both stay. */
export async function signOut(): Promise<void> {
  stopAutoSave();
  if (session) await authPost("logout", {}, session.access_token).catch(() => {});
  vaultKey = null;
  await Promise.all([kv.remove(K.key), kv.remove(K.synced), kv.remove(K.deleted)]);
  await saveSession(null);
  set({ syncing: false, status: "idle", savedAt: null, error: null });
}

/** Delete the account and its saved copy for good. This device's data stays. */
export async function deleteAccount(): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/kys-account`, { method: "DELETE", headers: { apikey: ANON, Authorization: `Bearer ${await token()}` } });
  if (!res.ok) throw new Error(`Couldn't delete your account (HTTP ${res.status}). Email hello@knowyourspend.org and we'll do it.`);
  session = null;
  await signOut();
}

/** The signed-in user's access token, for features that act for them (e.g. emailing their results). */
export async function accessToken(): Promise<string | null> {
  return session ? token().catch(() => null) : null;
}

// ── Saving automatically ───────────────────────────────────────────────────────────────────────
let unsub: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
function startAutoSave() {
  if (unsub) return;
  unsub = store.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void push(), 2500);
  });
}
function stopAutoSave() {
  unsub?.();
  unsub = null;
  if (timer) clearTimeout(timer);
}

/** Web: a sign-in link (instead of the code) lands here with the session in the address. */
async function sessionFromLink(): Promise<void> {
  if (Platform.OS !== "web" || typeof location === "undefined" || !location.hash.includes("access_token=")) return;
  const h = new URLSearchParams(location.hash.slice(1));
  const access = h.get("access_token"), refresh = h.get("refresh_token"), expires = Number(h.get("expires_in") ?? 3600);
  history.replaceState(null, "", location.pathname + location.search);
  if (!access || !refresh) return;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${access}` } });
  if (!res.ok) return;
  const u = (await res.json()) as { id: string; email?: string };
  await saveSession({ access_token: access, refresh_token: refresh, expires_at: Date.now() + expires * 1000, user_id: u.id, email: u.email ?? "" });
}

/** Called once at start-up. */
export async function initAccount(): Promise<void> {
  try {
    await sessionFromLink();
    if (!session) {
      const raw = await kv.get(K.session);
      if (raw) session = JSON.parse(raw);
    }
    const rawKey = await kv.get(K.key);
    vaultKey = rawKey ? JSON.parse(rawKey) : null;
    set({ ready: true, email: session?.email ?? null, syncing: !!(session && vaultKey) });
    if (session && vaultKey) {
      await store.ready();
      await pull().catch(() => {});
      startAutoSave();
      void push();
    }
  } catch {
    set({ ready: true });
  }
}

