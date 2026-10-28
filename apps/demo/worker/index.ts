import { handleAdmin, type AdminStore } from './admin';
import { handle, type Store, type TrialRequest } from './api';

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  /** Cloudflare Access for /admin: the team name and the application's AUD tag (wrangler.toml [vars]). */
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
}

function d1AdminStore(db: D1Database): AdminStore {
  return {
    async counts(since) {
      return (await db.prepare('SELECT day, name, count FROM counts WHERE day >= ?').bind(since).all<{ day: string; name: string; count: number }>()).results;
    },
    async errors(since) {
      return (await db.prepare('SELECT day, message, count FROM errors WHERE day >= ?').bind(since).all<{ day: string; message: string; count: number }>()).results;
    },
    async feedback(since) {
      return (
        await db
          .prepare('SELECT at, message, email, browser FROM feedback WHERE at >= ? ORDER BY id DESC LIMIT 200')
          .bind(since)
          .all<{ at: string; message: string; email: string | null; browser: string }>()
      ).results;
    },
    async trials(since) {
      return (
        await db
          .prepare('SELECT at, name, email, company, domains, message FROM trials WHERE at >= ? ORDER BY id DESC LIMIT 200')
          .bind(since)
          .all<TrialRequest>()
      ).results;
    },
  };
}

function d1Store(db: D1Database): Store {
  return {
    async count(day, names) {
      const upsert = db.prepare(
        'INSERT INTO counts (day, name, count) VALUES (?, ?, ?) ON CONFLICT (day, name) DO UPDATE SET count = count + excluded.count',
      );
      await db.batch([...names].map(([name, n]) => upsert.bind(day, name, n)));
    },
    async error(day, message) {
      await db
        .prepare(
          'INSERT INTO errors (day, message, count) VALUES (?, ?, 1) ON CONFLICT (day, message) DO UPDATE SET count = count + 1',
        )
        .bind(day, message)
        .run();
    },
    async feedback({ at, message, email, browser }) {
      await db
        .prepare('INSERT INTO feedback (at, message, email, browser) VALUES (?, ?, ?, ?)')
        .bind(at, message, email, browser)
        .run();
    },
    async trial({ at, name, email, company, domains, message }) {
      await db
        .prepare('INSERT INTO trials (at, name, email, company, domains, message) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(at, name, email, company, domains, message)
        .run();
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await handle(request, d1Store(env.DB))) ??
      (await handleAdmin(request, d1AdminStore(env.DB), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD })) ??
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
