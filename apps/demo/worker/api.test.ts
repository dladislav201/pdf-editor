import { describe, expect, it } from 'vitest';
import { browserFamily, cleanError, handle, parseDomains, type Store, type TrialRequest } from './api';

const SITE = 'https://pdf.example';
const NOW = new Date('2026-10-25T12:00:00Z');

function memory() {
  const counts = new Map<string, number>();
  const errors: string[] = [];
  const feedback: Parameters<Store['feedback']>[0][] = [];
  const trials: TrialRequest[] = [];
  const store: Store = {
    async count(day, names) {
      for (const [name, n] of names) counts.set(`${day} ${name}`, (counts.get(`${day} ${name}`) ?? 0) + n);
    },
    async error(day, message) {
      errors.push(`${day} ${message}`);
    },
    async feedback(entry) {
      feedback.push(entry);
    },
    async trial(entry) {
      trials.push(entry);
    },
  };
  return { store, counts, errors, feedback, trials };
}

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${SITE}${path}`, {
    method: 'POST',
    headers: { origin: SITE, 'content-type': 'application/json', 'user-agent': BROWSER, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('site API', () => {
  it('leaves other paths to the static site', async () => {
    expect(await handle(new Request(`${SITE}/`), memory().store, NOW)).toBeNull();
  });

  it('counts events per day and name', async () => {
    const { store, counts } = memory();
    const response = await handle(post('/api/events', { names: ['open.file', 'tool.editText', 'open.file'] }), store, NOW);
    expect(response!.status).toBe(204);
    expect(Object.fromEntries(counts)).toEqual({ '2026-10-25 open.file': 2, '2026-10-25 tool.editText': 1 });
  });

  it('turns away bad names, other sites and other methods', async () => {
    const { store, counts } = memory();
    expect((await handle(post('/api/events', { names: ['Contract.pdf opened'] }), store, NOW))!.status).toBe(400);
    expect((await handle(post('/api/events', { names: ['open.file'] }, { origin: 'https://evil.example' }), store, NOW))!.status).toBe(
      403,
    );
    expect((await handle(new Request(`${SITE}/api/events`), store, NOW))!.status).toBe(405);
    expect((await handle(post('/api/events', 'not json'), store, NOW))!.status).toBe(400);
    expect(counts.size).toBe(0);
  });

  it('keeps errors without links', async () => {
    const { store, errors } = memory();
    await handle(post('/api/errors', { message: 'Could not load  blob:https://pdf.example/1234 \n at line 3' }), store, NOW);
    expect(errors).toEqual(['2026-10-25 Could not load <url> at line 3']);
    expect(cleanError('x'.repeat(500))).toHaveLength(300);
  });

  it('stores feedback with a browser family only', async () => {
    const { store, feedback } = memory();
    const agent =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const response = await handle(
      post('/api/feedback', { message: '  Love it  ', email: 'jane@example.com' }, { 'user-agent': agent }),
      store,
      NOW,
    );
    expect(response!.status).toBe(204);
    expect(feedback).toEqual([{ at: NOW.toISOString(), message: 'Love it', email: 'jane@example.com', browser: 'Safari on iOS' }]);
  });

  it('drops bots and refuses empty or bad feedback', async () => {
    const { store, feedback } = memory();
    expect((await handle(post('/api/feedback', { message: 'Buy now', website: 'spam.example' }), store, NOW))!.status).toBe(204);
    expect((await handle(post('/api/feedback', { message: '   ' }), store, NOW))!.status).toBe(400);
    expect((await handle(post('/api/feedback', { message: 'Hi', email: 'not an email' }), store, NOW))!.status).toBe(400);
    expect(feedback).toEqual([]);
  });

  it('names browser families', () => {
    expect(browserFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0')).toBe(
      'Edge on Windows',
    );
    expect(browserFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0')).toBe('Firefox on macOS');
    expect(browserFamily('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36')).toBe(
      'Chrome on Android',
    );
  });

  it('takes a trial key request with the host names it should cover', async () => {
    const { store, trials } = memory();
    const request = { name: ' Jane Doe ', email: 'jane@acme.com', company: 'Acme', domains: 'https://App.Acme.com/editor, *.acme.dev; app.acme.com', message: 'Contracts in our CRM' };
    expect((await handle(post('/api/trial', request), store, NOW))!.status).toBe(204);
    expect(trials).toEqual([
      { at: NOW.toISOString(), name: 'Jane Doe', email: 'jane@acme.com', company: 'Acme', domains: 'app.acme.com, *.acme.dev', message: 'Contracts in our CRM' },
    ]);
  });

  it('turns away a trial request without its fields, with something that is not a host name, or from a bot', async () => {
    const { store, trials } = memory();
    const ok = { name: 'Jane', email: 'jane@acme.com', company: 'Acme', domains: 'app.acme.com' };
    expect((await handle(post('/api/trial', { ...ok, email: 'jane' }), store, NOW))!.status).toBe(400);
    expect((await handle(post('/api/trial', { ...ok, company: ' ' }), store, NOW))!.status).toBe(400);
    expect((await handle(post('/api/trial', { ...ok, domains: 'app.acme.com"; rm -rf ~' }), store, NOW))!.status).toBe(400);
    expect((await handle(post('/api/trial', { ...ok, domains: '' }), store, NOW))!.status).toBe(400);
    expect((await handle(post('/api/trial', { ...ok, name: 'x'.repeat(101) }), store, NOW))!.status).toBe(400);
    expect((await handle(post('/api/trial', { ...ok, website: 'spam.example' }), store, NOW))!.status).toBe(204);
    expect((await handle(post('/api/trial', ok, { origin: 'https://evil.example' }), store, NOW))!.status).toBe(403);
    expect(trials).toEqual([]);
  });

  it('reads host names as a key covers them', () => {
    expect(parseDomains('localhost')).toBeNull();
    expect(parseDomains('acme.com:8080/x  *.acme.com')).toEqual(['acme.com', '*.acme.com']);
    expect(parseDomains('a..com')).toBeNull();
  });

  it('leaves robots out of the counts and errors: crawlers, link previews, headless browsers, scripts', async () => {
    const { store, counts, errors } = memory();
    for (const agent of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36',
      'facebookexternalhit/1.1',
      'curl/8.7.1',
      '',
    ]) {
      expect((await handle(post('/api/events', { names: ['view.home.en'] }, { 'user-agent': agent }), store, NOW))!.status).toBe(204);
      await handle(post('/api/errors', { message: 'Boom' }, { 'user-agent': agent }), store, NOW);
    }
    expect(counts.size).toBe(0);
    expect(errors).toEqual([]);
  });
});
