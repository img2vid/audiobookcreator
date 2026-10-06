/**
 * Transcribe draft autosave — IndexedDB persistence for the Transcribe Studio.
 *
 * Transcript segments and the recognition language are saved (debounced) so a
 * long dictation survives an accidental reload. Audio blobs are deliberately
 * NOT stored here (too large for this store) — the draft only records a note
 * that a recording existed, and the view surfaces a "re-record" notice on
 * restore. Everything stays on-device; nothing is uploaded.
 *
 * Single-record store: key 'auravoice-transcribe/1'. Mirrors the dialogue-db
 * draft engine (same open/put/get/delete shape).
 */

export interface StoredTranscriptSegment {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
  confidence: number;
  /**
   * Optional speaker attribution (R10). Missing/undefined on older drafts =
   * unassigned — restore is tolerant, the draft key and version stay unchanged.
   */
  speaker?: string;
}

export interface TranscribeDraft {
  key: 'auravoice-transcribe/1';
  savedAt: number;
  segments: StoredTranscriptSegment[];
  language: string; // '' = browser default
  /** True when the session had an attached recording — audio itself is never persisted. */
  hadRecording: boolean;
}

const DB_NAME = 'auravoice-transcribe-db';
const DB_VERSION = 1;
const STORE = 'drafts';
const KEY = 'auravoice-transcribe/1';

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

export async function saveTranscribeDraft(draft: Omit<TranscribeDraft, 'key'>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      store.put({ ...draft, key: KEY } satisfies TranscribeDraft);
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => resolve();
      store.transaction.onabort = () => resolve();
    });
  } catch { /* best-effort */ }
}

export async function loadTranscribeDraft(): Promise<TranscribeDraft | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<TranscribeDraft | null>((resolve) => {
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const req = store.get(KEY);
      req.onsuccess = () => resolve((req.result as TranscribeDraft | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function clearTranscribeDraft(): Promise<void> {
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

/** True when the draft is worth restoring (has at least one non-empty segment). */
export function transcribeDraftHasContent(d: TranscribeDraft | null): boolean {
  if (!d) return false;
  return d.segments.some((s) => typeof s.text === 'string' && s.text.trim().length > 0);
}
