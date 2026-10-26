/**
 * The site's small API: anonymous usage counts, error reports and feedback.
 * Nothing here can identify a person or a file: counts are per day and
 * name, errors per day and message, and the browser is kept only as a
 * family ("Safari on iOS").
 */

export interface Store {
  /** Adds `n` to each name's count for the day. */
  count(day: string, names: Map<string, number>): Promise<void>;
  error(day: string, message: string): Promise<void>;
  feedback(entry: { at: string; message: string; email: string | null; browser: string }): Promise<void>;
}

/** Event names: up to four words joined by dots, starting lower case, e.g. "tool.editText", "download.pdf". */
const NAME = /^[a-z][a-zA-Z0-9_-]{0,31}(\.[a-zA-Z0-9_-]{1,32}){0,3}$/;
const MAX_EVENTS = 50;
const MAX_BODY = 16 * 1024;
const MAX_ERROR = 300;
const MAX_FEEDBACK = 4000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const empty = (status = 204) => new Response(null, { status });

/** A browser and system family from a user agent, nothing finer. */
export function browserFamily(agent: string): string {
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Other';
  const system = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Mac OS X/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : 'other';
  return `${browser} on ${system}`;
}

/** An error message without anything that could point at a file or a page: links, then trimmed. */
export function cleanError(message: string): string {
  return message
    .replace(/\b(?:https?|blob|file|data):\S+/g, '<url>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR);
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY) return undefined;
  const text = await request.text();
  if (text.length > MAX_BODY) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Answers `/api/*` requests; null for anything else. */
export async function handle(request: Request, store: Store, now = new Date()): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (request.method !== 'POST') return empty(405);
  // Only the site itself posts here.
  const origin = request.headers.get('origin');
  if (origin !== url.origin) return empty(403);
  const body = (await readJson(request)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return empty(400);
  const day = now.toISOString().slice(0, 10);

  switch (url.pathname) {
    case '/api/events': {
      const names = body.names;
      if (!Array.isArray(names) || names.length > MAX_EVENTS) return empty(400);
      const counts = new Map<string, number>();
      for (const name of names) {
        if (typeof name !== 'string' || !NAME.test(name)) return empty(400);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      if (counts.size) await store.count(day, counts);
      return empty();
    }
    case '/api/errors': {
      if (typeof body.message !== 'string') return empty(400);
      const message = cleanError(body.message);
      if (message) await store.error(day, message);
      return empty();
    }
    case '/api/feedback': {
      // A field people never see: filled in, it's a bot. Say thanks and drop it.
      if (body.website) return empty();
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (!message || message.length > MAX_FEEDBACK) return empty(400);
      if (email && (email.length > 200 || !EMAIL.test(email))) return empty(400);
      await store.feedback({
        at: now.toISOString(),
        message,
        email: email || null,
        browser: browserFamily(request.headers.get('user-agent') ?? ''),
      });
      return empty();
    }
    default:
      return empty(404);
  }
}
