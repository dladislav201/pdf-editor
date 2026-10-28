import { beforeAll, describe, expect, it } from 'vitest';
import { accessEmail, handleAdmin, summarize, type AdminStore, type FetchKeys } from './admin';

const SITE = 'https://lovelydoc.example';
const NOW = new Date('2026-10-28T12:00:00Z');
const CONFIG = { team: 'lovely', aud: 'aud-tag-123' };
const ISSUER = 'https://lovely.cloudflareaccess.com';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json64 = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));

let keys: CryptoKeyPair;
let other: CryptoKeyPair;
let fetchKeys: FetchKeys;

beforeAll(async () => {
  const params = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  keys = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
  other = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
  fetchKeys = async (url) => {
    expect(url).toBe(`${ISSUER}/cdn-cgi/access/certs`);
    return [{ ...jwk, kid: 'k1' }];
  };
});

/** A token as Access signs it, with `claims` over the usual ones. */
async function token(claims: Record<string, unknown> = {}, signer = keys.privateKey): Promise<string> {
  const head = json64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = json64({ iss: ISSUER, aud: [CONFIG.aud], email: 'owner@example.com', exp: NOW.getTime() / 1000 + 3600, ...claims });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(signature))}`;
}

const request = (path: string, jwt?: string) =>
  new Request(`${SITE}${path}`, { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });

const store: AdminStore = {
  async counts() {
    return [
      { day: '2026-10-27', name: 'view.home.en', count: 10 },
      { day: '2026-10-28', name: 'view.home.de', count: 4 },
      { day: '2026-10-28', name: 'view.compress.en', count: 2 },
      { day: '2026-10-28', name: 'view.blog.sign-pdf-on-phone', count: 1 },
      { day: '2026-10-28', name: 'open.file', count: 5 },
      { day: '2026-10-28', name: 'open.sample.contract', count: 2 },
      { day: '2026-10-28', name: 'open.unlocked.password', count: 1 },
      { day: '2026-10-28', name: 'tool.highlight', count: 3 },
      { day: '2026-10-28', name: 'download.pdf', count: 3 },
      { day: '2026-10-28', name: 'download.protected', count: 1 },
      { day: '2026-09-01', name: 'view.home.en', count: 99 },
    ];
  },
  async errors() {
    return [
      { day: '2026-10-27', message: 'Boom', count: 2 },
      { day: '2026-10-28', message: 'Boom', count: 1 },
    ];
  },
  async feedback() {
    return [{ at: '2026-10-28T10:00:00.000Z', message: '<img src=x onerror=alert(1)> love it', email: null, browser: 'Safari on iOS' }];
  },
  async trials() {
    return [{ at: '2026-10-28T09:00:00.000Z', name: 'Jane', email: 'jane@acme.com', company: 'Acme', domains: 'app.acme.com', message: null }];
  },
};

describe('Cloudflare Access token', () => {
  it('lets in a token Access signed for this application', async () => {
    expect(await accessEmail(request('/admin', await token()), CONFIG, NOW.getTime(), fetchKeys)).toBe('owner@example.com');
  });

  it('turns away no token, another key, another audience or issuer, and an expired token', async () => {
    const check = async (jwt?: string) => accessEmail(request('/admin', jwt), CONFIG, NOW.getTime(), fetchKeys);
    expect(await check()).toBeNull();
    expect(await check('not.a.token')).toBeNull();
    expect(await check(await token({}, other.privateKey))).toBeNull();
    expect(await check(await token({ aud: ['someone-else'] }))).toBeNull();
    expect(await check(await token({ iss: 'https://evil.cloudflareaccess.com' }))).toBeNull();
    expect(await check(await token({ exp: NOW.getTime() / 1000 - 10 }))).toBeNull();
  });
});

describe('the dashboard', () => {
  it('is not there without Access set up, or without a valid token', async () => {
    expect((await handleAdmin(request('/admin', await token()), store, {}, NOW, fetchKeys))!.status).toBe(404);
    expect((await handleAdmin(request('/admin'), store, CONFIG, NOW, fetchKeys))!.status).toBe(404);
    expect((await handleAdmin(request('/admin/api/summary', await token({}, other.privateKey)), store, CONFIG, NOW, fetchKeys))!.status).toBe(404);
    expect(await handleAdmin(request('/'), store, CONFIG, NOW, fetchKeys)).toBeNull();
  });

  it('serves the page, which can run only its own script and shows feedback as text', async () => {
    const response = (await handleAdmin(request('/admin', await token()), store, CONFIG, NOW, fetchKeys))!;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    const html = await response.text();
    expect(html).toContain('/admin/api/summary');
    expect(html).not.toContain('innerHTML');
  });

  it('sums the period: per day, per language and page, tools, opening and saving, errors and feedback', async () => {
    const response = (await handleAdmin(request('/admin/api/summary?days=2', await token()), store, CONFIG, NOW, fetchKeys))!;
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.viewer).toBe('owner@example.com');
    expect(data.days).toEqual(['2026-10-27', '2026-10-28']);
    expect(data.views).toEqual([10, 7]);
    expect(data.opened).toEqual([0, 7]);
    expect(data.downloads).toEqual([0, 4]);
    expect(data.totals).toEqual({ views: 17, opened: 7, downloads: 4, feedback: 1, errors: 3, trials: 1 });
    expect(data.trials).toEqual([{ at: '2026-10-28T09:00:00.000Z', name: 'Jane', email: 'jane@acme.com', company: 'Acme', domains: 'app.acme.com', message: null }]);
    expect(data.languages).toEqual([['en', 12], ['de', 4]]);
    expect(data.pages).toEqual([['home', 14], ['compress', 2], ['guide: sign-pdf-on-phone', 1]]);
    expect(data.opening).toEqual([['file', 5], ['sample.contract', 2]]);
    expect(data.saving).toEqual([['pdf', 3], ['protected', 1]]);
    expect(data.tools).toEqual([['tool.highlight', 3]]);
    expect(data.errors).toEqual([{ message: 'Boom', times: 3, last: '2026-10-28' }]);
  });

  it('fills days without counts with zeros', () => {
    const summary = summarize([], [], [], '2026-10-28', 3);
    expect(summary.days).toEqual(['2026-10-26', '2026-10-27', '2026-10-28']);
    expect(summary.views).toEqual([0, 0, 0]);
  });
});
