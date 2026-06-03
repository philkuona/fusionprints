/**
 * Google OAuth 2.0 service — web platform "Sign in with Google".
 *
 * Hand-rolled Authorization Code flow, mirroring the QBO integration
 * (src/services/qbo.ts) rather than pulling in @fastify/oauth2.
 *
 * Unlike QBO, we don't persist Google tokens: we only need the user's
 * profile once at sign-in to find-or-create their web_users row. The
 * access token is used immediately to fetch userinfo, then discarded.
 *
 * The redirect URI is derived from PUBLIC_URL (the BACKEND origin, since
 * Google redirects back to this Fastify server's callback route):
 *   {PUBLIC_URL}/web/api/auth/google/callback
 * Register that exact URI in the Google Cloud Console.
 */

import { env } from '@/config/env.js';

// ── Google endpoints ─────────────────────────────────────────────────────────

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_SCOPES = 'openid email profile';

function redirectUri(): string {
  return `${env.PUBLIC_URL}/web/api/auth/google/callback`;
}

// ── Public profile shape ─────────────────────────────────────────────────────

export interface GoogleProfile {
  sub: string; // Google's stable unique user id
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

// ── Status helper ────────────────────────────────────────────────────────────

/** True when both Google client credentials are configured. */
export function isEnabled(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

// ── OAuth helpers ────────────────────────────────────────────────────────────

export function getAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'online',
    state,
  });
  return `${GOOGLE_AUTH_BASE}?${params.toString()}`;
}

/**
 * Exchange an authorization code for the user's Google profile.
 * Throws on any HTTP failure — the caller redirects to /login?error=google.
 */
export async function exchangeCodeForProfile(code: string): Promise<GoogleProfile> {
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${await tokenRes.text()}`);
  }

  const token = (await tokenRes.json()) as { access_token: string };
  if (!token.access_token) throw new Error('Google token exchange: no access_token');

  const infoRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
  });

  if (!infoRes.ok) {
    throw new Error(`Google userinfo failed: ${await infoRes.text()}`);
  }

  const info = (await infoRes.json()) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  if (!info.sub || !info.email) {
    throw new Error('Google userinfo missing sub or email');
  }

  return {
    sub: info.sub,
    email: info.email,
    emailVerified: info.email_verified === true,
    name: info.name,
    picture: info.picture,
  };
}
