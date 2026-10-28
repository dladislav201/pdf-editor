import { handle, type Store } from './api';

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
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
    return (await handle(request, d1Store(env.DB))) ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
