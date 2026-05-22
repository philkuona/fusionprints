/**
 * Admin authentication helper — session-based.
 *
 * Supports two roles:
 *   - 'full'     — full admin (founder): all access
 *   - 'operator' — store attendant: Print Queue + Completed Orders + Printers
 *                  (read-only). No revenue, no metrics, no settings.
 *
 * Sessions replace Basic Auth. In-memory session store is fine for a
 * single-server setup; sessions reset on restart, but the Beelink autologin
 * token re-authenticates automatically on the next Chrome open.
 *
 * When operator count grows past ~3 staff, migrate to DB-backed users.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '@/config/env.js';

export type AdminRole = 'full' | 'operator';

/**
 * Validate username/password and return the role, or null if invalid.
 * Called by the login POST handler.
 */
export function validateCredentials(username: string, password: string): AdminRole | null {
  if (username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD) {
    return 'full';
  }
  if (username === env.OPERATOR_USERNAME && password === env.OPERATOR_PASSWORD) {
    return 'operator';
  }
  return null;
}

/**
 * Validate the Beelink autologin token (used by the Chrome shortcut).
 * Returns 'full' if valid, null if the token is wrong or not configured.
 */
export function validateAutologinToken(token: string): AdminRole | null {
  if (!env.BEELINK_AUTOLOGIN_TOKEN || env.BEELINK_AUTOLOGIN_TOKEN.length < 32) {
    return null; // not configured or too short
  }
  return token === env.BEELINK_AUTOLOGIN_TOKEN ? 'full' : null;
}

// ── Internal session accessor ──────────────────────────────────────────────

function getSessionRole(request: FastifyRequest): AdminRole | undefined {
  // Cast through any — @fastify/session augments FastifyRequest at runtime;
  // the cast avoids TS setup friction while remaining fully correct.
  return (request as any).session?.role as AdminRole | undefined;
}

// ── Public auth helpers ────────────────────────────────────────────────────

/**
 * For API routes (/admin/api/*): check session, return role or null.
 * Sends a 401 JSON response if not authenticated (caller must return).
 */
export function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): AdminRole | null {
  const role = getSessionRole(request);
  if (!role) {
    reply.status(401).send({ error: 'not_authenticated', message: 'Please sign in.' });
    return null;
  }
  return role;
}

/**
 * For HTML page routes: check session, return role or null.
 * Redirects to /admin/login if not authenticated (caller must return).
 */
export function authenticatePage(
  request: FastifyRequest,
  reply: FastifyReply,
): AdminRole | null {
  const role = getSessionRole(request);
  if (!role) {
    void reply.redirect('/admin/login');
    return null;
  }
  return role;
}

/**
 * For API routes: authenticate AND require full admin role.
 * Operator-role users get a 403 JSON response.
 */
export function requireFullAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const role = authenticate(request, reply);
  if (role === null) return false;
  if (role !== 'full') {
    reply.status(403).send({
      error: 'admin_only',
      message: 'This area requires admin access.',
    });
    return false;
  }
  return true;
}

/**
 * For HTML page routes that require full admin: redirect operator to
 * /admin (their home page) instead of returning a 403 wall.
 */
export function requireFullAdminPage(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const role = authenticatePage(request, reply);
  if (role === null) return false;
  if (role !== 'full') {
    void reply.redirect('/admin?msg=admin_only');
    return false;
  }
  return true;
}
