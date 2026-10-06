/**
 * Audiobook draft autosave — IndexedDB persistence for the Audiobook Studio.
 *
 * Manuscript, metadata, chapters (text/title/voice/rate), pronunciation rules
 * and cover choices are saved (debounced) so a long book project survives an
 * accidental reload or browser crash. Audio buffers are runtime-only and are
 * never persisted — restored chapters return to 'draft' status ready to
 * re-render.
 *
 * Single-record store: key 'current'. Everything stays on-device.
 */

export interface StoredChapterDraft {
  id: string;
  title: string;
  text: string;
  voiceProfile: string;
  rate: number;
}

export interface AudiobookDraft {
  key: 'current';
  savedAt: number;
  meta: { title: string; author: string; narrator: string; genre: string };
  rawText: string;
  splitMarker: string;
  gapSec: number;
  defaultVoice: string;
  globalRate: number;
  coverPreset: string;
  coverAccentId: string;
  rules: { id: string; find: string; replace: string; enabled: boolean }[];
  chapters: StoredChapterDraft[];
}

const DB_NAME = 'auravoice-drafts';
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

export async function saveAudiobookDraft(draft: Omit<AudiobookDraft, 'key'>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      store.put({ ...draft, key: KEY } satisfies AudiobookDraft);
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => resolve();
      store.transaction.onabort = () => resolve();
    });
  } catch { /* best-effort */ }
}

export async function loadAudiobookDraft(): Promise<AudiobookDraft | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<AudiobookDraft | null>((resolve) => {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const req = store.get(KEY);
      req.onsuccess = () => resolve((req.result as AudiobookDraft | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function clearAudiobookDraft(): Promise<void> {
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

/** True when the draft is worth restoring (has a manuscript or chapters). */
export function draftHasContent(d: AudiobookDraft | null): boolean {
  if (!d) return false;
  return Boolean(d.rawText.trim() || d.chapters.length > 0);
}
