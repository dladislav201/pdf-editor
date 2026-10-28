// A tab opened before a deploy still asks for the old build's code chunks,
// which are gone after it ("Failed to fetch dynamically imported module").
// Instead of failing, the page reloads once and gets the new build. A file
// open in the tab opens again after the reload (see session.ts).

const GONE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/;
const KEY = 'lovelydoc.reloaded';
/** A second failure this soon after reloading is not a deploy: it's reported as an error. */
const AGAIN_AFTER = 10_000;

let reloading = false;
const waiting = new Set<Promise<unknown>>();
const finishing = new Set<() => Promise<unknown>>();

/** A chunk of the old build, or the editor's worker (the SDK names its error). */
const isGoneChunk = (error: unknown) =>
  (error instanceof Error && error.name === 'EngineLoadError') || GONE.test(error instanceof Error ? error.message : String(error));
const never = <T>() => new Promise<T>(() => undefined);

/** True once the page is reloading for a new version: errors until then are its own doing. */
export const isReloading = () => reloading;

/** A reload for a new version waits for this first, e.g. keeping the file just opened. */
export function beforeReload(work: Promise<unknown>): void {
  waiting.add(work);
  void work.catch(() => undefined).finally(() => waiting.delete(work));
}

/** Runs `finish` when a reload for a new version starts and waits for it, e.g. keeping changes not kept yet. Returns the undo. */
export function whenReloading(finish: () => Promise<unknown>): () => void {
  finishing.add(finish);
  return () => finishing.delete(finish);
}

/** Reloads the page unless it just did; true if it's reloading. */
function reloadOnce(): boolean {
  if (reloading) return true;
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < AGAIN_AFTER) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  reloading = true;
  const finished = [...finishing].map((finish) => Promise.resolve().then(finish));
  void Promise.allSettled([...waiting, ...finished]).then(() => location.reload());
  return true;
}

/** `import()` that reloads the page instead of failing when the chunk is gone. */
export function load<T>(importer: () => Promise<T>): Promise<T> {
  return importer().then(
    // Vite's handler below has already started the reload: the import gives undefined.
    (module) => (reloading ? never<T>() : module),
    (error: unknown) => {
      if (isGoneChunk(error) && reloadOnce()) return never<T>();
      throw error;
    },
  );
}

/**
 * For an error the editor reports: true when it comes from code that's gone (the
 * page then reloads) or from the page already reloading. Either way, not shown.
 */
export function reloadsFor(error: unknown): boolean {
  return reloading || (isGoneChunk(error) && reloadOnce());
}

// Vite's loading of a chunk and its dependencies (scripts and styles). Not when prerendering.
if (typeof window !== 'undefined') {
  addEventListener('vite:preloadError', (event) => {
    if (reloadOnce()) event.preventDefault();
  });
}
