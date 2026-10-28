/**
 * Anonymous usage counts and error reports for the site's own API (see
 * worker/api.ts): which tools get used and what breaks, never what's in a
 * file or who uses it. No cookies, no identifiers. Events are batched and
 * sent every few seconds, and when the page is hidden or closed.
 */

const FLUSH_MS = 5000;
/** The same error over and over is reported once per page view. */
const reported = new Set<string>();
let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

const NOT_COUNTED = 'lovelydoc.notrack';

/**
 * Whether this browser is left out of the counts: the site's own people mark
 * theirs with `?notrack=1` (the dashboard links to it), `?notrack=0` undoes
 * it. The address is cleaned up after, and a note says what happened.
 */
function notCounted(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const params = new URLSearchParams(location.search);
    const choice = params.get('notrack');
    if (choice !== null) {
      if (choice === '0') localStorage.removeItem(NOT_COUNTED);
      else localStorage.setItem(NOT_COUNTED, '1');
      params.delete('notrack');
      const query = params.toString();
      history.replaceState(history.state, '', location.pathname + (query ? `?${query}` : '') + location.hash);
      const text = choice === '0' ? 'Visits from this browser are counted again.' : 'Visits from this browser are no longer counted.';
      if (document.readyState === 'loading') addEventListener('DOMContentLoaded', () => note(text));
      else note(text);
    }
    return localStorage.getItem(NOT_COUNTED) === '1';
  } catch {
    return false;
  }
}

/** A short note at the bottom of the page. */
function note(text: string): void {
  const el = document.createElement('div');
  el.className = 'notice notice--plain notrack-note';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

// Only the deployed site has the API; local development and marked browsers stay quiet.
const enabled = !import.meta.env.DEV && !notCounted();

function send(path: string, body: unknown): void {
  const data = JSON.stringify(body);
  try {
    // A beacon survives the page closing; fetch with keepalive is the fallback.
    if (navigator.sendBeacon?.(path, new Blob([data], { type: 'application/json' }))) return;
    void fetch(path, { method: 'POST', body: data, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(
      () => undefined,
    );
  } catch {
    // Counting is never worth an error.
  }
}

function flush(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const names = queue.slice(0, 50);
  queue = queue.slice(50);
  send('/api/events', { names });
  if (queue.length) flush();
}

/** Counts one use of something, e.g. `track('download.pdf')`. */
export function track(name: string): void {
  if (!enabled) return;
  queue.push(name);
  timer ??= setTimeout(flush, FLUSH_MS);
}

/** Reports an error message (links are stripped on the server). */
export function reportError(error: unknown): void {
  if (!enabled) return;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // Cancelling is not an error.
  if (/AbortError/.test(message) || reported.has(message)) return;
  reported.add(message);
  send('/api/errors', { message });
}

/** Sends feedback; resolves when it's stored. */
export async function sendFeedback(feedback: { message: string; email: string; website: string }): Promise<void> {
  const response = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(feedback),
  });
  // The dialog says these in the page's language.
  if (!response.ok) throw new Error(response.status === 400 ? 'invalid' : 'failed');
}

if (enabled) {
  addEventListener('pagehide', flush);
  addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  addEventListener('error', (event) => reportError(event.error ?? event.message));
  addEventListener('unhandledrejection', (event) => reportError(event.reason));
}
