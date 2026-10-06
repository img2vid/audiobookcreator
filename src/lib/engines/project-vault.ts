/**
 * Local project vault — IndexedDB persistence for saved TTS / audiobook projects.
 *
 * Replaces the former server-side SQLite/Prisma vault so the app is a pure static
 * site (GitHub Pages compatible). Everything stays on this device, inside the
 * browser profile; nothing is uploaded.
 *
 * Mirrors the other *-db.ts engines: SSR-safe open, singleton connection,
 * best-effort errors.
 */

export type VaultProjectType = 'tts' | 'audiobook' | 'video' | 'file-batch' | 'ocr' | 'settings-preset' | (string & {});

export interface VaultProject {
  id: string;
  name: string;
  type: VaultProjectType;
  /** Plain JSON-serializable payload. */
  data: unknown;
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = 'auravoice-project-vault';
const DB_VERSION = 1;
const STORE = 'projects';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser does not support IndexedDB (private mode?).'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('type', 'type', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Could not open the local project vault.'));
    req.onblocked = () => reject(new Error('The local project vault is blocked by another tab.'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? req.error ?? new Error('Vault transaction failed.'));
        tx.onabort = () => reject(tx.error ?? new Error('Vault transaction aborted.'));
      }),
  );
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Save a new project and return the stored record. */
export async function saveProject(input: { name: string; type: VaultProjectType; data: unknown }): Promise<VaultProject> {
  if (!input.name || !input.type) throw new Error('name and type are required');
  const now = Date.now();
  const record: VaultProject = {
    id: newId(),
    name: input.name,
    type: input.type,
    // Round-trip through JSON so only serializable data is stored (matches the old API behaviour).
    data: JSON.parse(JSON.stringify(input.data ?? {})),
    createdAt: now,
    updatedAt: now,
  };
  await run('readwrite', (s) => s.put(record));
  return record;
}

/** List saved projects, newest first. Optionally filter by type. */
export async function listProjects(type?: VaultProjectType): Promise<VaultProject[]> {
  const all = await run<VaultProject[]>('readonly', (s) => s.getAll());
  return all
    .filter((p) => !type || p.type === type)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200);
}

export async function getProject(id: string): Promise<VaultProject | null> {
  const rec = await run<VaultProject | undefined>('readonly', (s) => s.get(id));
  return rec ?? null;
}

export async function updateProject(id: string, patch: { name?: string; data?: unknown }): Promise<VaultProject> {
  const existing = await getProject(id);
  if (!existing) throw new Error('Project not found');
  const next: VaultProject = {
    ...existing,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.data !== undefined ? { data: JSON.parse(JSON.stringify(patch.data)) } : {}),
    updatedAt: Date.now(),
  };
  await run('readwrite', (s) => s.put(next));
  return next;
}

export async function deleteProject(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id));
}
