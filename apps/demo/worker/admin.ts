/**
 * The site's private dashboard: what the anonymous counts, error reports,
 * feedback and trial requests say, on its own host (admin.lovelydoc.com, a
 * Worker of its own: admin-main.ts). Only Cloudflare Access lets anyone in:
 * the Worker checks the token Access signs for every request (its team's
 * keys, the application's audience, the expiry) and answers 404 to anything
 * else, or when Access isn't set up (ACCESS_TEAM and ACCESS_AUD unset).
 */

import type { TrialRequest } from './api';

export interface AdminStore {
  /** Counts per day and name since a day (YYYY-MM-DD). */
  counts(since: string): Promise<{ day: string; name: string; count: number }[]>;
  errors(since: string): Promise<{ day: string; message: string; count: number }[]>;
  feedback(since: string): Promise<{ at: string; message: string; email: string | null; browser: string }[]>;
  /** Requests for a trial key of the SDK, newest first. */
  trials(since: string): Promise<TrialRequest[]>;
}

export interface AccessConfig {
  /** The Access team, the `<team>` of `<team>.cloudflareaccess.com`. */
  team: string;
  /** The Access application's audience (AUD) tag. */
  aud: string;
}

/** A JSON Web Key as Access publishes it. */
type Key = JsonWebKey & { kid?: string };
export type FetchKeys = (url: string) => Promise<Key[]>;

const base64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const decode = (part: string) => JSON.parse(new TextDecoder().decode(base64url(part))) as Record<string, unknown>;

let cachedKeys: { url: string; keys: Key[]; until: number } | null = null;

async function accessKeys(url: string): Promise<Key[]> {
  if (cachedKeys && cachedKeys.url === url && cachedKeys.until > Date.now()) return cachedKeys.keys;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Access keys: HTTP ${response.status}`);
  const keys = ((await response.json()) as { keys: Key[] }).keys;
  cachedKeys = { url, keys, until: Date.now() + 60 * 60 * 1000 };
  return keys;
}

/**
 * The email of the person Access let in, from the token it adds to the
 * request (`Cf-Access-Jwt-Assertion`); null when there is none or it doesn't
 * check out: signature by one of the team's keys (RS256), issuer, audience,
 * expiry.
 */
export async function accessEmail(
  request: Request,
  config: AccessConfig,
  now = Date.now(),
  fetchKeys: FetchKeys = accessKeys,
): Promise<string | null> {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = decode(parts[0]!);
    const payload = decode(parts[1]!);
    if (header.alg !== 'RS256') return null;
    const issuer = `https://${config.team}.cloudflareaccess.com`;
    const keys = await fetchKeys(`${issuer}/cdn-cgi/access/certs`);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64url(parts[2]!), signed))) return null;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== issuer || !audiences.includes(config.aud)) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now + 60_000) return null;
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

/** What the dashboard shows for a period. */
export interface Summary {
  days: string[];
  /** Per day, in `days` order. */
  views: number[];
  opened: number[];
  downloads: number[];
  totals: { views: number; opened: number; downloads: number; feedback: number; errors: number; trials: number };
  /** Views per language and per page, opened files per way, uses per tool: largest first. */
  languages: [string, number][];
  pages: [string, number][];
  opening: [string, number][];
  tools: [string, number][];
  saving: [string, number][];
  errors: { message: string; times: number; last: string }[];
  feedback: { at: string; message: string; email: string | null; browser: string }[];
  trials: TrialRequest[];
}

const LOCALES = new Set(['en', 'de', 'nb', 'sv', 'uk']);
const ranked = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const add = (map: Map<string, number>, key: string, n: number) => map.set(key, (map.get(key) ?? 0) + n);

/** Files opened (from a file, a sample or pictures), not files unlocked. */
const isOpening = (name: string) => name === 'open.file' || name.startsWith('open.file.') || name.startsWith('open.sample.') || name === 'open.pictures';

/** Sums the raw rows into what the dashboard shows, for the `days` days up to `today`. */
export function summarize(
  rows: { day: string; name: string; count: number }[],
  errors: { day: string; message: string; count: number }[],
  feedback: Summary['feedback'],
  today: string,
  span: number,
  trials: TrialRequest[] = [],
): Summary {
  const days = Array.from({ length: span }, (_, i) => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (span - 1 - i));
    return date.toISOString().slice(0, 10);
  });
  const index = new Map(days.map((d, i) => [d, i]));
  const views = days.map(() => 0);
  const opened = days.map(() => 0);
  const downloads = days.map(() => 0);
  const languages = new Map<string, number>();
  const pages = new Map<string, number>();
  const opening = new Map<string, number>();
  const tools = new Map<string, number>();
  const saving = new Map<string, number>();
  for (const { day, name, count } of rows) {
    const i = index.get(day);
    if (i === undefined) continue;
    const [kind, ...rest] = name.split('.');
    if (kind === 'view') {
      views[i]! += count;
      // view.<page>.<language>, view.blog.<guide>; early counts have no language.
      if (rest[0] === 'blog') add(pages, rest[1] ? `guide: ${rest[1]}` : 'guides', count);
      else {
        add(pages, rest[0] ?? '?', count);
        add(languages, rest[1] && LOCALES.has(rest[1]) ? rest[1] : 'en (before languages were counted)', count);
      }
    } else if (isOpening(name)) {
      opened[i]! += count;
      add(opening, rest.join('.') || 'file', count);
    } else if (kind === 'download') {
      downloads[i]! += count;
      add(saving, rest.join('.'), count);
    } else if (kind !== 'open') {
      add(tools, name, count);
    }
  }
  const byMessage = new Map<string, { times: number; last: string }>();
  for (const { day, message, count } of errors) {
    if (!index.has(day)) continue;
    const seen = byMessage.get(message);
    byMessage.set(message, { times: (seen?.times ?? 0) + count, last: !seen || day > seen.last ? day : seen.last });
  }
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const errorList = [...byMessage].map(([message, e]) => ({ message, ...e })).sort((a, b) => b.times - a.times);
  return {
    days,
    views,
    opened,
    downloads,
    totals: {
      views: sum(views),
      opened: sum(opened),
      downloads: sum(downloads),
      feedback: feedback.length,
      errors: sum(errorList.map((e) => e.times)),
      trials: trials.length,
    },
    languages: ranked(languages),
    pages: ranked(pages),
    opening: ranked(opening),
    tools: ranked(tools),
    saving: ranked(saving),
    errors: errorList,
    feedback,
    trials,
  };
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  'referrer-policy': 'no-referrer',
  // Feedback is text from anyone: the page shows it as text, and could run nothing else anyway.
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** The dashboard (`/`) and its numbers (`/api/summary`) for people Access let in; 404 for anything else. */
export async function handleAdmin(
  request: Request,
  store: AdminStore,
  config: Partial<AccessConfig>,
  now = new Date(),
  fetchKeys?: FetchKeys,
): Promise<Response> {
  const url = new URL(request.url);
  const notFound = () => new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  // No Access set up: no dashboard. With it, only a token Access signed gets in.
  if (!config.team || !config.aud || request.method !== 'GET') return notFound();
  const email = await accessEmail(request, config as AccessConfig, now.getTime(), fetchKeys);
  if (!email) return notFound();

  if (url.pathname === '/') return new Response(PAGE, { headers: PAGE_HEADERS });
  if (url.pathname === '/api/summary') {
    const span = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
    const today = now.toISOString().slice(0, 10);
    const since = new Date(now.getTime() - (span - 1) * 86_400_000).toISOString().slice(0, 10);
    const [rows, errors, feedback, trials] = await Promise.all([store.counts(since), store.errors(since), store.feedback(since), store.trials(since)]);
    const summary = summarize(rows, errors, feedback, today, span, trials);
    return Response.json({ ...summary, viewer: email }, { headers: { 'cache-control': 'no-store' } });
  }
  return notFound();
}

/** The dashboard: one page that reads `/api/summary` and draws it, light or dark like the system. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>LovelyDoc · Admin</title>
<style>
  :root { --bg: #f2f2f0; --card: #fff; --text: #191918; --muted: #6f6f6b; --line: rgba(20,20,18,.08); --accent: #2f6fed; --soft: #c9d8fb; --warn: #d64933; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141414; --card: #1f1f1f; --text: #f0f0ee; --muted: #a6a6a1; --line: rgba(255,255,255,.08); --accent: #6d9bff; --soft: #2c3d63; color-scheme: dark; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: -.01em; }
  h2 { margin: 0 0 12px; font-size: 15px; }
  .muted { color: var(--muted); }
  select { font: inherit; padding: 6px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--text); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .card { background: var(--card); border-radius: 16px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.04); min-width: 0; }
  .tile b { display: block; font-size: 26px; letter-spacing: -.02em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; margin-top: 12px; }
  .chart svg { width: 100%; height: 200px; display: block; }
  .legend { display: flex; gap: 14px; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
  .bars div { display: grid; grid-template-columns: minmax(0, 1.4fr) 1.6fr auto; gap: 8px; align-items: center; padding: 3px 0; }
  .bars span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bars em { display: block; height: 8px; border-radius: 4px; background: var(--accent); }
  .bars b { font-variant-numeric: tabular-nums; font-weight: 500; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 6px 4px; border-top: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; border-top: 0; }
  td.n { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .note { white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty { color: var(--muted); padding: 8px 0; }
  .error { color: var(--warn); }
</style>
</head>
<body>
<main>
  <header>
    <div><h1>LovelyDoc · Admin</h1><div class="muted" id="who"></div></div>
    <label class="muted">Period
      <select id="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option><option value="365">A year</option></select>
    </label>
  </header>
  <div class="tiles" id="tiles"></div>
  <div class="card chart">
    <h2>Every day</h2>
    <div class="legend"><span><i style="background:var(--soft)"></i>Page views</span><span><i style="background:var(--accent)"></i>Files opened</span><span><i style="background:var(--text)"></i>Downloads</span></div>
    <svg id="chart" role="img" aria-label="Page views, files opened and downloads per day"></svg>
  </div>
  <div class="grid">
    <div class="card"><h2>Tools used</h2><div class="bars" id="tools"></div></div>
    <div class="card"><h2>Pages people land on</h2><div class="bars" id="pages"></div></div>
    <div class="card"><h2>Languages</h2><div class="bars" id="languages"></div></div>
    <div class="card"><h2>How files are opened</h2><div class="bars" id="opening"></div></div>
    <div class="card"><h2>How files are saved</h2><div class="bars" id="saving"></div></div>
  </div>
  <div class="card" style="margin-top:12px"><h2>Trial key requests (SDK)</h2><div id="trials"></div></div>
  <div class="grid">
    <div class="card"><h2>Feedback</h2><div id="feedback"></div></div>
    <div class="card"><h2>Errors</h2><div id="errors"></div></div>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = String(text); if (cls) e.className = cls; return e; };
  const fmt = (n) => n.toLocaleString('en');
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  function bars(target, rows) {
    target.replaceChildren();
    if (!rows.length) return target.append(el('div', 'Nothing yet.', 'empty'));
    const top = rows[0][1] || 1;
    for (const [name, n] of rows.slice(0, 15)) {
      const row = el('div');
      const bar = el('span'); const fill = el('em'); fill.style.width = Math.max(2, (n / top) * 100) + '%'; bar.append(fill);
      row.append(el('span', name), bar, el('b', fmt(n)));
      row.title = name + ': ' + fmt(n);
      target.append(row);
    }
  }

  function chart(data) {
    const svg = $('chart'); svg.replaceChildren();
    const w = 1000, h = 200, pad = 22, n = data.days.length;
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h); svg.setAttribute('preserveAspectRatio', 'none');
    const top = Math.max(1, ...data.views, ...data.opened, ...data.downloads);
    const step = (w - pad) / n, bw = Math.max(1, step * 0.8);
    const y = (v) => h - pad - (v / top) * (h - pad * 2);
    data.days.forEach((day, i) => {
      const x = pad + i * step + (step - bw) / 2;
      const g = svgEl('g', {});
      const title = svgEl('title', {}); title.textContent = day + ' · views ' + data.views[i] + ' · opened ' + data.opened[i] + ' · downloads ' + data.downloads[i];
      g.append(title);
      g.append(svgEl('rect', { x, y: y(data.views[i]), width: bw, height: h - pad - y(data.views[i]), fill: 'var(--soft)', rx: 2 }));
      g.append(svgEl('rect', { x: x + bw * 0.2, y: y(data.opened[i]), width: bw * 0.6, height: h - pad - y(data.opened[i]), fill: 'var(--accent)', rx: 2 }));
      g.append(svgEl('rect', { x: x + bw * 0.4, y: y(data.downloads[i]), width: bw * 0.2, height: h - pad - y(data.downloads[i]), fill: 'var(--text)' }));
      svg.append(g);
    });
    const label = (text, x, anchor) => { const t = svgEl('text', { x, y: h - 6, 'font-size': 11, fill: 'var(--muted)', 'text-anchor': anchor }); t.textContent = text; svg.append(t); };
    label(data.days[0], pad, 'start'); label(data.days[n - 1], w, 'end');
    const max = svgEl('text', { x: 0, y: pad - 6, 'font-size': 11, fill: 'var(--muted)' }); max.textContent = fmt(top); svg.append(max);
  }

  async function load() {
    const days = $('days').value;
    let data;
    try {
      const response = await fetch('/api/summary?days=' + days, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      data = await response.json();
    } catch (error) {
      $('tiles').replaceChildren(el('div', 'Could not load the numbers (' + error.message + '). Signed out of Access? Reload the page.', 'card error'));
      return;
    }
    $('who').textContent = 'Signed in as ' + data.viewer + ' · anonymous counts, no personal data';
    const t = data.totals;
    const rate = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
    $('tiles').replaceChildren(...[
      ['Page views', fmt(t.views), ''],
      ['Files opened', fmt(t.opened), rate(t.opened, t.views) + ' of views'],
      ['Downloads', fmt(t.downloads), rate(t.downloads, t.opened) + ' of opened'],
      ['Trial requests', fmt(t.trials), 'SDK, from /sdk'],
      ['Feedback', fmt(t.feedback), ''],
      ['Errors', fmt(t.errors), ''],
    ].map(([label, value, sub]) => { const c = el('div', undefined, 'card tile'); c.append(el('span', label, 'muted'), el('b', value), el('span', sub, 'muted')); return c; }));
    chart(data);
    bars($('tools'), data.tools); bars($('pages'), data.pages); bars($('languages'), data.languages);
    bars($('opening'), data.opening); bars($('saving'), data.saving);

    const fb = $('feedback'); fb.replaceChildren();
    if (!data.feedback.length) fb.append(el('div', 'No feedback in this period.', 'empty'));
    else {
      const table = el('table'); const head = el('tr'); ['When', 'Note', 'From'].forEach((h) => head.append(el('th', h))); table.append(head);
      for (const f of data.feedback) {
        const tr = el('tr');
        tr.append(el('td', f.at.slice(0, 16).replace('T', ' '), 'n'), el('td', f.message, 'note'), el('td', [f.browser, f.email].filter(Boolean).join(' · ')));
        table.append(tr);
      }
      fb.append(table);
    }
    const tr = $('trials'); tr.replaceChildren();
    if (!data.trials.length) tr.append(el('div', 'No requests in this period.', 'empty'));
    else {
      const table = el('table'); const head = el('tr'); ['When', 'Who', 'Domains', 'What they build'].forEach((h) => head.append(el('th', h))); table.append(head);
      for (const r of data.trials) {
        const row = el('tr');
        const who = el('td'); who.append(el('div', r.name + ' · ' + r.company), el('div', r.email, 'muted'));
        row.append(el('td', r.at.slice(0, 16).replace('T', ' '), 'n'), who, el('td', r.domains, 'note'), el('td', r.message || '', 'note'));
        table.append(row);
      }
      tr.append(table);
    }
    const er = $('errors'); er.replaceChildren();
    if (!data.errors.length) er.append(el('div', 'No errors in this period.', 'empty'));
    else {
      const table = el('table'); const head = el('tr'); ['Message', 'Times', 'Last'].forEach((h) => head.append(el('th', h))); table.append(head);
      for (const e of data.errors.slice(0, 50)) {
        const tr = el('tr'); tr.append(el('td', e.message, 'note'), el('td', fmt(e.times), 'n'), el('td', e.last, 'n')); table.append(tr);
      }
      er.append(table);
    }
  }
  $('days').addEventListener('change', load);
  load();
</script>
</body>
</html>`;
