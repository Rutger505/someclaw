// Stale-while-revalidate for a page load (back from a link, reload): the last conversation list + snapshots, shown
// until the broker's fresh ones arrive. IndexedDB, not localStorage: one snapshot with its tool logs can be MBs.
const DB = "someclaw";
const STORE = "cache";
const KEEP = 30; // snapshots kept, least recently written dropped

let db: Promise<IDBDatabase> | null = null;
const open = () =>
  (db ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    db = null;
    throw e;
  }));

const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void) => {
  const tx = (await open()).transaction(STORE, mode);
  const req = fn(tx.objectStore(STORE));
  return new Promise<T | undefined>((resolve, reject) => {
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
};

const warn = (what: string) => (e: unknown) => (console.warn(`cache ${what}:`, e), undefined);

type Entry<T> = { at: number; value: T };

export const cacheGet = <T>(key: string): Promise<T | undefined> =>
  run<Entry<T>>("readonly", (s) => s.get(key)).then((e) => e?.value, warn(`get ${key}`));

export const cachePut = (key: string, value: unknown) =>
  run("readwrite", (s) => void s.put({ at: Date.now(), value } satisfies Entry<unknown>, key))
    .then(() => (key.startsWith("snap:") ? prune(key) : undefined))
    .catch(warn(`put ${key}`));

export const cacheClear = () => {
  localStorage.removeItem(INDEX);
  return run("readwrite", (s) => void s.clear()).catch(warn("clear"));
};

/** Write times of the cached snapshots, so pruning doesn't read MBs of them back. */
const INDEX = "cache.snaps";

async function prune(key: string) {
  const index: Record<string, number> = JSON.parse(localStorage.getItem(INDEX) ?? "{}");
  index[key] = Date.now();
  const drop = Object.keys(index).sort((a, b) => index[a]! - index[b]!).slice(0, Math.max(0, Object.keys(index).length - KEEP));
  for (const k of drop) delete index[k];
  localStorage.setItem(INDEX, JSON.stringify(index));
  if (drop.length) await run("readwrite", (s) => drop.forEach((k) => s.delete(k)));
}
