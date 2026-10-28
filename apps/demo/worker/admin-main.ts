// The dashboard's own Worker, on admin.lovelydoc.com behind Cloudflare Access
// (wrangler.admin.toml): it reads the site's database and serves nothing else.
import type { TrialRequest } from './api';
import { handleAdmin, type AdminStore } from './admin';

interface Env {
  DB: D1Database;
  /** Cloudflare Access: the team name and the application's AUD tag (wrangler.admin.toml [vars]). */
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

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleAdmin(request, d1AdminStore(env.DB), { team: env.ACCESS_TEAM, aud: env.ACCESS_AUD });
  },
} satisfies ExportedHandler<Env>;
