// ============================================================
// Openmukti Audiobook Creator — AutoBook analysis checkpoints
//
// Multi-hour (CPU-only, multi-day) AutoBook analyses persist their
// intermediate AI state to IndexedDB after every chunk, so closing
// the tab, a crash, or a pause never loses completed work. Re-running
// the same book with the same model/settings resumes where it stopped.
//
// Keys are content-derived (FNV-1a over text + model + settings), so a
// different book or model never collides with a saved run. Checkpoints
// are cleared automatically when a run completes successfully.
// Best-effort: every failure degrades to "no checkpoint" behaviour.
// ============================================================

const DB_NAME = 'auravoice-autobook-checkpoints';
const STORE = 'checkpoints';

export interface CheckpointRecord<T = unknown> {
  key: string;
  updatedAt: number;
  /** Human label for the book (file name / title) — for the resume UI. */
  label?: string;
  /** Pipeline stage the state represents (e.g. "verify", "voices"). */
  stage?: string;
  /** 0..1 progress within the AI pipeline at save time. */
  progress?: number;
  state: T;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

/** FNV-1a 32-bit — tiny, dependency-free, stable across sessions. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Content-derived checkpoint key: full-text FNV-1a (one pass, ~20 ms per MB)
 * combined with the model and analysis settings — the same book with the same
 * configuration always maps to the same checkpoint, and a different book or
 * model never collides with a saved run.
 */
export function autobookCheckpointKey(parts: {
  text: string;
  modelId: string;
  deep: boolean;
  genre?: string;
  maxCast?: number;
}): string {
  const textHash = fnv1a(parts.text);
  const settingsHash = fnv1a(`${parts.modelId}|${parts.deep}|${parts.genre ?? ''}|${parts.maxCast ?? ''}`);
  return `ab-${parts.text.length.toString(36)}-${textHash}-${settingsHash}`;
}

export async function saveAutobookCheckpoint<T>(
  key: string,
  state: T,
  meta?: { label?: string; stage?: string; progress?: number },
): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        key, state, updatedAt: Date.now(),
        label: meta?.label, stage: meta?.stage, progress: meta?.progress,
      } satisfies CheckpointRecord<T>);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* best-effort — persistence must never break a run */
  }
}

export async function loadAutobookCheckpoint<T>(key: string): Promise<CheckpointRecord<T> | null> {
  try {
    const d = await db();
    return await new Promise<CheckpointRecord<T> | null>((resolve, reject) => {
      const tx = d.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as CheckpointRecord<T> | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function clearAutobookCheckpoint(key: string): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* ignore */
  }
}

/** Every saved checkpoint — lets the UI offer "resume" for interrupted runs. */
export async function listAutobookCheckpoints(): Promise<Omit<CheckpointRecord, 'state'>[]> {
  try {
    const d = await db();
    const all = await new Promise<CheckpointRecord[]>((resolve, reject) => {
      const tx = d.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as CheckpointRecord[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    return all
      .map(({ key, updatedAt, label, stage, progress }) => ({ key, updatedAt, label, stage, progress }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}
