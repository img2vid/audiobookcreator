import type { BookProject } from './book-plan';

export interface BookChunk {
  id: string; projectId: string; chapterId: string; index: number; signature: string;
  pcm: Blob; frames: number; sampleRate: number; engineLabel: string;
}
export type BookChunkInfo = Omit<BookChunk, 'pcm'>;
const DB = 'openmukti-book-desk';
let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Local storage is unavailable. Enable IndexedDB or use a regular browser window.')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
      chunks.createIndex('projectId', 'projectId');
      chunks.createIndex('chapterId', 'chapterId');
      db.createObjectStore('leases', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); opening = undefined; };
      resolve(req.result);
    };
    req.onblocked = () => reject(new Error('Close other Audiobook Creator tabs to upgrade local storage.'));
    req.onerror = () => reject(req.error ?? new Error('Could not open local storage'));
  }).catch(err => { opening = undefined; throw err; });
  return opening;
}

async function transaction<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction, set: (value: T) => void) => void): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    tx.oncomplete = () => resolve(value);
    tx.onerror = tx.onabort = () => reject(new Error(tx.error?.name === 'QuotaExceededError'
      ? 'Local disk quota is full. Download completed parts, then delete an old project to free space.'
      : tx.error?.message ?? 'Local storage transaction failed'));
    try { work(tx, v => { value = v; }); }
    catch (err) { tx.abort(); reject(err); }
  });
}

export async function saveBook(project: BookProject): Promise<void> {
  return transaction(['projects', 'leases'], 'readwrite', tx => {
    const lock = tx.objectStore('leases').get(project.id);
    lock.onsuccess = () => {
      if (lock.result?.expires > Date.now()) { tx.abort(); return; }
      tx.objectStore('projects').put(project);
    };
  });
}

export const listBooks = () => transaction<BookProject[]>(['projects'], 'readonly', (tx, set) => {
  const req = tx.objectStore('projects').getAll();
  req.onsuccess = () => set((req.result as BookProject[]).sort((a, b) => b.updatedAt - a.updatedAt));
});
export const getBook = (id: string) => transaction<BookProject | undefined>(['projects'], 'readonly', (tx, set) => {
  const req = tx.objectStore('projects').get(id); req.onsuccess = () => set(req.result);
});
export const getBookChunk = (id: string) => transaction<BookChunk | undefined>(['chunks'], 'readonly', (tx, set) => {
  const req = tx.objectStore('chunks').get(id); req.onsuccess = () => set(req.result);
});
export const putBookChunk = (chunk: BookChunk) => transaction<void>(['chunks'], 'readwrite', tx => { tx.objectStore('chunks').put(chunk); });
export const bookChunkId = (p: string, c: string, i: number) => `${p}/${c}/${i}`;
export const chapterChunks = (chapterId: string) => transaction<BookChunk[]>(['chunks'], 'readonly', (tx, set) => {
  const req = tx.objectStore('chunks').index('chapterId').getAll(chapterId);
  req.onsuccess = () => set((req.result as BookChunk[]).sort((a, b) => a.index - b.index));
});
export const bookChunkInfo = (projectId: string) => transaction<BookChunkInfo[]>(['chunks'], 'readonly', (tx, set) => {
  const out: BookChunkInfo[] = [];
  const req = tx.objectStore('chunks').index('projectId').openCursor(projectId);
  req.onsuccess = () => {
    const cur = req.result;
    if (!cur) { set(out); return; }
    const { pcm, ...meta } = cur.value as BookChunk;
    out.push(meta); cur.continue();
  };
});
export const deleteBook = (projectId: string) => transaction<void>(['projects', 'chunks', 'leases'], 'readwrite', tx => {
  const lease = tx.objectStore('leases').get(projectId);
  lease.onsuccess = () => {
    if (lease.result?.expires > Date.now()) { tx.abort(); return; }
    tx.objectStore('projects').delete(projectId);
    const req = tx.objectStore('chunks').index('projectId').openCursor(projectId);
    req.onsuccess = () => { const cur = req.result; if (cur) { cur.delete(); cur.continue(); } };
    tx.objectStore('leases').delete(projectId);
  };
});

/** Atomic cross-tab lease also works in browsers without the Web Locks API. */
export const claimBook = (id: string, owner: string) => transaction<boolean>(['leases'], 'readwrite', (tx, set) => {
  const store = tx.objectStore('leases'), req = store.get(id);
  req.onsuccess = () => {
    if (req.result?.expires > Date.now() && req.result.owner !== owner) { set(false); return; }
    store.put({ id, owner, expires: Date.now() + 120_000 }); set(true);
  };
});
export const releaseBook = (id: string, owner: string) => transaction<void>(['leases'], 'readwrite', tx => {
  const store = tx.objectStore('leases'), req = store.get(id);
  req.onsuccess = () => { if (req.result?.owner === owner) store.delete(id); };
});
