/**
 * Admin authentication helper.
 *
 * Supports two roles:
 *   - 'full'     — full admin (founder, etc): all access
 *   - 'operator' — store attendant: Print Queue + Completed Orders + Printers
 *                  (read-only). No revenue, no metrics, no settings.
 *
 * Credentials live in env vars (ADMIN_USERNAME/ADMIN_PASSWORD,
 * OPERATOR_USERNAME/OPERATOR_PASSWORD). When operator capacity grows
 * past ~3 staff, migrate to DB-backed users — see roadmap.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '@/config/env.js';

export type AdminRole = 'full' | 'operator';

const REALM = 'Basic realm="FusionPrints Admin"';

/**
 * Validate Basic auth and return the role of the authenticated user.
 * Returns null if auth is missing or invalid; in that case, also sets
 * the 401 response on the reply (caller should `return` immediately).
 */
export function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
): AdminRole | null {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    reply.header('WWW-Authenticate', REALM).status(401).send('Auth required');
    return null;
  }

  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
  const [username, password] = decoded.split(':');

  if (username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD) {
    return 'full';
  }

  if (username === env.OPERATOR_USERNAME && password === env.OPERATOR_PASSWORD) {
    return 'operator';
  }

  reply.header('WWW-Authenticate', REALM).status(401).send('Wrong username or password');
  return null;
}

/**
 * Authenticate AND require full admin role. Operator-role users are
 * rejected with a 403 response. Returns true if authorized, false if
 * the response has been set (caller should `return`).
 *
 * For HTML page routes, the redirect to /admin happens at the route
 * level — see requireFullAdminPage().
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
  const role = authenticate(request, reply);
  if (role === null) return false;
  if (role !== 'full') {
    reply.redirect('/admin?msg=admin_only');
    return false;
  }
  return true;
}
