/**
 * Postgres-backed session store for @fastify/session.
 *
 * Replaces the default in-memory store, which lost every session on each
 * backend restart (deploy/crash/reboot) and silently logged all users out.
 * Sessions now live in the `web_sessions` table and survive restarts for their
 * full cookie lifetime.
 *
 * Implements the @fastify/session SessionStore interface (callback style):
 *   set(sid, session, cb) · get(sid, cb) · destroy(sid, cb)
 */

import type { SessionStore } from '@fastify/session';
import { eq, lt } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { webSessions } from '@/db/schema.js';
import { logger } from './logger.js';

// Fallback lifetime if a session somehow has no cookie.expires (30 days).
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function expiryFromSession(session: any): Date {
  const expires = session?.cookie?.expires;
  if (expires) return new Date(expires);
  const maxAge = session?.cookie?.maxAge;
  if (typeof maxAge === 'number') return new Date(Date.now() + maxAge);
  return new Date(Date.now() + DEFAULT_TTL_MS);
}

export class PgSessionStore implements SessionStore {
  set(sessionId: string, session: any, callback: (err?: any) => void): void {
    const expire = expiryFromSession(session);
    db.insert(webSessions)
      .values({ sid: sessionId, sess: session, expire })
      .onConflictDoUpdate({ target: webSessions.sid, set: { sess: session, expire } })
      .then(() => callback())
      .catch((err) => {
        logger.error({ err, sessionId }, 'session store: set failed');
        callback(err);
      });
  }

  get(sessionId: string, callback: (err: any, result?: any) => void): void {
    db.select()
      .from(webSessions)
      .where(eq(webSessions.sid, sessionId))
      .limit(1)
      .then(([row]) => {
        if (!row) return callback(null, null);
        // Expired rows are treated as absent (and swept lazily).
        if (row.expire.getTime() <= Date.now()) {
          this.destroy(sessionId, () => callback(null, null));
          return;
        }
        callback(null, row.sess);
      })
      .catch((err) => {
        logger.error({ err, sessionId }, 'session store: get failed');
        callback(err);
      });
  }

  destroy(sessionId: string, callback: (err?: any) => void): void {
    db.delete(webSessions)
      .where(eq(webSessions.sid, sessionId))
      .then(() => callback())
      .catch((err) => {
        logger.error({ err, sessionId }, 'session store: destroy failed');
        callback(err);
      });
  }
}

/**
 * Delete expired session rows. Safe to call periodically; cheap thanks to the
 * index on `expire`.
 */
export async function sweepExpiredSessions(): Promise<void> {
  try {
    await db.delete(webSessions).where(lt(webSessions.expire, new Date()));
  } catch (err) {
    logger.error({ err }, 'session store: sweep failed');
  }
}
