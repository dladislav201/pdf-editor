import type { OpenRequest } from './Home';

/**
 * The file open in this tab, kept in this browser (IndexedDB, on the device)
 * so a reload opens it again instead of going back to the start page. It is
 * removed when the tab goes back to the start page. A tab with a file open
 * marks its copy as alive every few minutes; any page of the site clears
 * copies nobody marked for half an hour: those of closed tabs.
 */

const DB = 'lovelydoc';
const STORE = 'open-files';
const TAB_KEY = 'tab';
/** How long a copy nobody marks as alive lasts; tabs mark theirs every `ALIVE_EVERY`. */
const MAX_AGE = 30 * 60 * 1000;
export const ALIVE_EVERY = 5 * 60 * 1000;

interface Kept {
  tab: string;
  at: number;
  name: string;
  type: string;
  lastModified: number;
  bytes: ArrayBuffer;
  options: Omit<OpenRequest, 'file'>;
}

/**
 * This tab's id: it lasts as long as the tab (sessionStorage), reloads
 * included. Null where storage is blocked. `fresh` gives the tab a new one:
 * a duplicated tab starts with a copy of the other's sessionStorage.
 */
function tabId(fresh = false): string | null {
  try {
    let id = sessionStorage.getItem(TAB_KEY);
    if (!id || fresh) {
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

/**
 * Keeps the file this tab opens, with the tool it opened in (not what it
 * did once on opening: reading a scan, a dialog). Best effort: without
 * storage, a reload just goes to the start page.
 */
export async function keepOpen({ file, tool }: OpenRequest): Promise<void> {
  const tab = tabId();
  if (!tab) return;
  try {
    const kept: Kept = {
      tab,
      at: Date.now(),
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      bytes: await file.arrayBuffer(),
      options: tool ? { tool } : {},
    };
    await run('readwrite', (store) => store.put(kept));
  } catch {
    // Not kept (storage full or blocked).
  }
}

/** Marks this tab's copy as alive, so it isn't taken for a closed tab's. */
export async function keepAlive(): Promise<void> {
  const tab = tabId();
  if (!tab) return;
  try {
    const kept = (await run<Kept | undefined>('readonly', (store) => store.get(tab) as IDBRequest<Kept | undefined>)) as Kept | undefined;
    if (kept) await run('readwrite', (store) => store.put({ ...kept, at: Date.now() }));
  } catch {
    // Not marked; it may be cleared later.
  }
}

/** Clears copies nobody marked as alive for `MAX_AGE`: those of tabs closed with a file open. */
export async function clearStale(): Promise<void> {
  const tab = tabId();
  try {
    const all = ((await run<Kept[]>('readonly', (store) => store.getAll() as IDBRequest<Kept[]>)) ?? []) as Kept[];
    const stale = all.filter((k) => Date.now() - k.at > MAX_AGE && k.tab !== tab);
    if (stale.length) await run('readwrite', (store) => void stale.forEach((k) => store.delete(k.tab)));
  } catch {
    // Nothing to clear, or no storage.
  }
}

/**
 * The file this tab had open before a reload, if it was kept. It is kept on
 * under a new id for this tab: a duplicated tab came with the same id, and
 * each now has its own copy (the old one goes once nobody marks it).
 */
export async function reopen(): Promise<OpenRequest | null> {
  const tab = tabId();
  if (!tab) return null;
  try {
    const kept = (await run<Kept | undefined>('readonly', (store) => store.get(tab) as IDBRequest<Kept | undefined>)) as Kept | undefined;
    if (!kept) return null;
    const own = tabId(true);
    if (own) await run('readwrite', (store) => store.put({ ...kept, tab: own, at: Date.now() }));
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
