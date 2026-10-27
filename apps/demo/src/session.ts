import type { OpenRequest } from './Home';

/**
 * The file open in this tab, kept in this browser (IndexedDB, on the device)
 * so a reload opens it again instead of going back to the start page. It is
 * removed when the tab goes back to the start page; copies left by tabs that
 * were closed go after a day.
 */

const DB = 'lovelydoc';
const STORE = 'open-files';
const TAB_KEY = 'tab';
const MAX_AGE = 24 * 60 * 60 * 1000;

interface Kept {
  tab: string;
  at: number;
  name: string;
  type: string;
  lastModified: number;
  bytes: ArrayBuffer;
  options: Omit<OpenRequest, 'file'>;
}

/** This tab's id: it lasts as long as the tab (sessionStorage), reloads included. Null where storage is blocked. */
function tabId(): string | null {
  try {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(TAB_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'tab' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await database();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Keeps the file this tab opens. Best effort: without storage, a reload just goes to the start page. */
export async function keepOpen({ file, ...options }: OpenRequest): Promise<void> {
  const tab = tabId();
  if (!tab) return;
  try {
    const kept: Kept = { tab, at: Date.now(), name: file.name, type: file.type, lastModified: file.lastModified, bytes: await file.arrayBuffer(), options };
    await run('readwrite', (store) => store.put(kept));
  } catch {
    // Not kept (storage full or blocked).
  }
}

/** The file this tab had open before a reload, if it was kept. Also clears copies older than a day. */
export async function reopen(): Promise<OpenRequest | null> {
  const tab = tabId();
  if (!tab) return null;
  try {
    const all = ((await run<Kept[]>('readonly', (store) => store.getAll() as IDBRequest<Kept[]>)) ?? []) as Kept[];
    const stale = all.filter((k) => Date.now() - k.at > MAX_AGE && k.tab !== tab);
    if (stale.length) await run('readwrite', (store) => void stale.forEach((k) => store.delete(k.tab)));
    const kept = all.find((k) => k.tab === tab);
    if (!kept) return null;
    return { ...kept.options, file: new File([kept.bytes], kept.name, { type: kept.type, lastModified: kept.lastModified }) };
  } catch {
    return null;
  }
}

/** Removes the file this tab kept: it went back to the start page. */
export async function forget(): Promise<void> {
  const tab = tabId();
  if (!tab) return;
  try {
    await run('readwrite', (store) => void store.delete(tab));
  } catch {
    // Nothing kept.
  }
}
