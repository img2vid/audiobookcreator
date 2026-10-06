/**
 * Asset persistence — IndexedDB mirror of the session Asset Bin.
 *
 * Blobs (audio renders, images, extracted files) are stored so the bin
 * survives page reloads during long studio sessions. AudioBuffers are
 * runtime-only and are never persisted. Everything stays on-device.
 */

export interface StoredAssetRecord {
  id: string;
  name: string;
  kind: 'audio' | 'image' | 'text' | 'video' | 'data';
  createdAt: number;
  mimeType: string;
  sizeBytes?: number;
  durationSec?: number;
  text?: string;
  width?: number;
  height?: number;
  meta?: Record<string, unknown>;
  blob?: Blob;
}

const DB_NAME = 'auravoice-assets';
const DB_VERSION = 1;
const STORE = 'assets';
/** Keep the newest N assets on disk; older ones are evicted on write. */
const MAX_PERSISTED = 120;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function putStoredAsset(rec: StoredAssetRecord): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const store = tx(db, 'readwrite');
      store.put(rec);
      // evict oldest beyond cap
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result > MAX_PERSISTED) {
          const idx = store.index('createdAt');
          const cursorReq = idx.openCursor();
          let toDelete = countReq.result - MAX_PERSISTED;
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor && toDelete > 0) {
              void cursor.delete();
              toDelete--;
              cursor.continue();
            }
          };
        }
      };
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => resolve();
      store.transaction.onabort = () => resolve();
    });
  } catch {
    // persistence is best-effort; the session bin still works
  }
}

export async function deleteStoredAsset(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const store = tx(db, 'readwrite');
      store.delete(id);
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => resolve();
    });
  } catch { /* best-effort */ }
}

export async function clearStoredAssets(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const store = tx(db, 'readwrite');
      store.clear();
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => resolve();
    });
  } catch { /* best-effort */ }
}

export async function listStoredAssets(): Promise<StoredAssetRecord[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    return await new Promise<StoredAssetRecord[]>((resolve) => {
      const store = tx(db, 'readonly');
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result ?? []) as StoredAssetRecord[];
        rows.sort((a, b) => b.createdAt - a.createdAt);
        resolve(rows);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function countStoredAssets(): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  try {
    return await new Promise<number>((resolve) => {
      const store = tx(db, 'readonly');
      const req = store.count();
      req.onsuccess = () => resolve(req.result ?? 0);
      req.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

/** Fetch a blob URL back into a Blob (used before persisting). */
export async function blobFromUrl(url: string): Promise<Blob | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    return await res.blob();
  } catch {
    return undefined;
  }
}
