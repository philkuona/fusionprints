/**
 * Web platform authentication helpers.
 *
 * Separate from admin auth (src/utils/auth.ts) — never mix the two.
 *   - Admin auth: env-var credentials, session.role
 *   - Web auth:   DB-backed web_users, session.webUserId
 */

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

const BCRYPT_ROUNDS = 12;

/** Hash a plain-text password. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/** Verify a plain-text password against a stored hash. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Generate a URL-safe verification token (32 bytes = 64 hex chars). */
export function generateVerificationToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Verification tokens expire after 24 hours. */
export function verificationTokenExpiry(): Date {
  return new Date(Date.now() + 24 * 60 * 60 * 1000);
}

// ── Session helpers ────────────────────────────────────────────────────────

function getWebUserId(request: FastifyRequest): string | undefined {
  return (request as any).session?.webUserId as string | undefined;
}

/**
 * For API routes: returns webUserId or sends 401 and returns null.
 * Caller must `return` immediately after null.
 */
export function authenticateWebUser(
  request: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const id = getWebUserId(request);
  if (!id) {
    reply.status(401).send({ error: 'not_authenticated', message: 'Please sign in.' });
    return null;
  }
  return id;
}

/** Set the web user session after login or email verification. */
export function setWebUserSession(request: FastifyRequest, userId: string): void {
  (request as any).session.webUserId = userId;
}

/** Clear the web user session on logout. */
export function clearWebUserSession(request: FastifyRequest): void {
  (request as any).session.webUserId = undefined;
}
