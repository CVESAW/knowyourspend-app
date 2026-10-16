/**
 * Key-value storage on the device (web): IndexedDB, which — unlike localStorage — has room for
 * years of statements. Nothing here is ever sent anywhere.
 */
const DB = "kys-expo";
const STORE = "kv";
let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export const kv = {
  get: async (key: string): Promise<string | null> => (await run<string | undefined>("readonly", (s) => s.get(key))) ?? null,
  set: (key: string, value: string) => run<void>("readwrite", (s) => s.put(value, key)).then(() => undefined),
  remove: (key: string) => run<void>("readwrite", (s) => s.delete(key)).then(() => undefined),
};
