/**
 * Dialogue draft autosave — IndexedDB persistence for the Dialogue Studio.
 *
 * Title, script lines, per-speaker cast settings and the inter-line pause are
 * saved (debounced) so a long production survives an accidental reload.
 * Everything stays on-device; nothing is uploaded.
 *
 * Single-record store: key 'current'. Mirrors the Audiobook draft engine.
 */

export interface StoredDialogueLine {
  id: string;
  speaker: string;
  text: string;
  muted: boolean;
}

/**
 * Stored per-speaker cast record. `group` ('narrator' | 'actor') was added in
 * the v2 stored shape — older drafts omit it, so it is optional and readers
 * must tolerate a missing field (missing = actor by default).
 */
export interface StoredCastMember {
  voiceProfile: string;
  rate: number;
  pitch: number;
  group?: 'narrator' | 'actor';
}

export interface DialogueDraft {
  key: 'current';
  savedAt: number;
  title: string;
  lines: StoredDialogueLine[];
  cast: Record<string, StoredCastMember>;
  gapMs: number;
  useLexicon: boolean;
}

const DB_NAME = 'auravoice-dialogue-drafts';
const DB_VERSION = 1;
const STORE = 'drafts';
const KEY = 'current';

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
          db.createObjectStore(STORE, { keyPath: 'key' });
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

export async function saveDialogueDraft(draft: Omit<DialogueDraft, 'key'>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      store.put({ ...draft, key: KEY } satisfies DialogueDraft);
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => resolve();
      store.transaction.onabort = () => resolve();
    });
  } catch { /* best-effort */ }
}

export async function loadDialogueDraft(): Promise<DialogueDraft | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<DialogueDraft | null>((resolve) => {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const req = store.get(KEY);
      req.onsuccess = () => resolve((req.result as DialogueDraft | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function clearDialogueDraft(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      store.delete(KEY);
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => resolve();
    });
  } catch { /* best-effort */ }
}

/** True when the draft is worth restoring (has at least one line). */
export function dialogueDraftHasContent(d: DialogueDraft | null): boolean {
  if (!d) return false;
  return d.lines.length > 0;
}
