/**
 * Named video project manager — IndexedDB persistence for the Video Editor.
 *
 * Two kinds of records share one store:
 *  - named snapshots: id = project.id, saved explicitly from the Projects panel
 *  - the working autosave: id = 'current', upserted (debounced) after every
 *    project mutation so a reload recovers the timeline in progress
 *
 * The stored `project` payload is a plain serializable VideoProject snapshot —
 * no runtime buffers (AudioBuffers live in the Asset Bin, the project only
 * holds asset ids). Everything stays on-device; nothing is uploaded.
 *
 * Mirrors dialogue-db.ts / asset-db.ts: SSR-safe open, best-effort errors,
 * singleton connection with a clean close on versionchange/unload.
 */

export interface StoredVideoProject {
  /** Named records use the project id; the working autosave uses 'current'. */
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  /** Serializable VideoProject (clips, subtitles w/ speakers, style, music bed ids). */
  project: unknown;
}

/** Reserved key of the autosave record — never shown in the saved list. */
export const VIDEO_PROJECTS_CURRENT_KEY = 'current';

const DB_NAME = 'auravoice-video-projects-db';
const DB_VERSION = 1;
const STORE = 'projects';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function closeDb(db: IDBDatabase | null): void {
  try { db?.close(); } catch { /* already closed */ }
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; } // SSR / non-browser
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Clean singleton close: if another tab upgrades the schema, yield ours.
        db.onversionchange = () => { closeDb(db); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Best-effort graceful shutdown (used by page-unload style cleanups). */
export async function closeVideoProjectsDb(): Promise<void> {
  if (!dbPromise) return;
  const p = dbPromise;
  dbPromise = null;
  const db = await p.catch(() => null);
  closeDb(db);
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** Upsert one record (named snapshot or the 'current' autosave). Best-effort. */
export async function putProject(rec: StoredVideoProject): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const store = tx(db, 'readwrite');
      store.put({ ...rec, id: String(rec.id) });
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => resolve();
      store.transaction.onabort = () => resolve();
    });
  } catch { /* best-effort */ }
}

export async function getProject(id: string): Promise<StoredVideoProject | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<StoredVideoProject | null>((resolve) => {
      const store = tx(db, 'readonly');
      const req = store.get(id);
      req.onsuccess = () => resolve((req.result as StoredVideoProject | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** All records sorted newest-first, including the 'current' autosave. */
export async function listProjects(): Promise<StoredVideoProject[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    return await new Promise<StoredVideoProject[]>((resolve) => {
      const store = tx(db, 'readonly');
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result ?? []) as StoredVideoProject[];
        rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        resolve(rows);
      };
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const store = tx(db, 'readwrite');
      store.delete(id);
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => resolve();
      store.transaction.onabort = () => resolve();
    });
  } catch { /* best-effort */ }
}

export async function clearProjects(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const store = tx(db, 'readwrite');
      store.clear();
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => resolve();
      store.transaction.onabort = () => resolve();
    });
  } catch { /* best-effort */ }
}

/** True when a stored snapshot carries work worth restoring. */
export function storedProjectHasContent(rec: StoredVideoProject | null): boolean {
  if (!rec) return false;
  const p = (rec.project ?? {}) as { clips?: unknown; subtitles?: unknown };
  return (Array.isArray(p.clips) && p.clips.length > 0) || (Array.isArray(p.subtitles) && p.subtitles.length > 0);
}
