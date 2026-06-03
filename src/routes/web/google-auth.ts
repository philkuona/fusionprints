/**
 * Google OAuth routes — web platform "Sign in with Google".
 *
 *   GET /web/api/auth/google           — start flow: redirect to Google consent
 *   GET /web/api/auth/google/callback  — handle Google's redirect, sign user in
 *
 * Account model: one web_users row per email.
 *   - Found by googleId        → existing Google account, sign in.
 *   - Found by email (no link) → AUTO-LINK: attach googleId, mark verified,
 *                                sign in. Safe because Google's email is verified.
 *   - Not found                → create a Google-only account (passwordHash null).
 *
 * CSRF: a random `state` is stored on the session before redirecting and
 * verified on callback. Setting it initializes the session so it persists
 * (saveUninitialized:false). sameSite:'lax' lets the cookie ride the
 * top-level GET redirect back from Google.
 */

import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { webUsers } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { setWebUserSession } from '@/utils/web-auth.js';
import {
  isEnabled,
  getAuthorizationUrl,
  exchangeCodeForProfile,
} from '@/services/google-oauth.js';

export async function registerWebGoogleAuthRoutes(app: FastifyInstance): Promise<void> {
  // GET /web/api/auth/google — kick off the OAuth flow
  app.get('/web/api/auth/google', async (request, reply) => {
    if (!isEnabled()) {
      return reply.redirect(`${env.WEB_URL}/login?error=google_disabled`);
    }

    const state = crypto.randomBytes(16).toString('hex');
    (request as any).session.googleOAuthState = state;

    return reply.redirect(getAuthorizationUrl(state));
  });

  // GET /web/api/auth/google/callback — Google redirects back here
  app.get('/web/api/auth/google/callback', async (request, reply) => {
    const { code, state, error } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    const expectedState = (request as any).session?.googleOAuthState as string | undefined;
    // One-time use — clear regardless of outcome.
    (request as any).session.googleOAuthState = undefined;

    if (error || !code || !state || !expectedState || state !== expectedState) {
      logger.warn(
        { error, hasCode: !!code, stateMatch: state === expectedState },
        'Google OAuth callback rejected',
      );
      return reply.redirect(`${env.WEB_URL}/login?error=google`);
    }

    try {
      const profile = await exchangeCodeForProfile(code);
      const normalizedEmail = profile.email.toLowerCase().trim();

      // 1. Existing Google account?
      const [byGoogle] = await db
        .select()
        .from(webUsers)
        .where(eq(webUsers.googleId, profile.sub))
        .limit(1);

      let userId: string;

      if (byGoogle) {
        userId = byGoogle.id;
        await db
          .update(webUsers)
          .set({
            lastLoginAt: new Date(),
            displayName: byGoogle.displayName ?? profile.name ?? null,
            avatarUrl: byGoogle.avatarUrl ?? profile.picture ?? null,
          })
          .where(eq(webUsers.id, byGoogle.id));
      } else {
        // 2. Existing password account on this email? Auto-link.
        const [byEmail] = await db
          .select()
          .from(webUsers)
          .where(eq(webUsers.email, normalizedEmail))
          .limit(1);

        if (byEmail) {
          userId = byEmail.id;
          await db
            .update(webUsers)
            .set({
              googleId: profile.sub,
              emailVerified: true,
              displayName: byEmail.displayName ?? profile.name ?? null,
              avatarUrl: byEmail.avatarUrl ?? profile.picture ?? null,
              lastLoginAt: new Date(),
            })
            .where(eq(webUsers.id, byEmail.id));
          logger.info({ userId }, 'Google auto-linked to existing email account');
        } else {
          // 3. Brand-new Google account.
          const [created] = await db
            .insert(webUsers)
            .values({
              email: normalizedEmail,
              passwordHash: null,
              googleId: profile.sub,
              emailVerified: true,
              displayName: profile.name ?? null,
              avatarUrl: profile.picture ?? null,
              lastLoginAt: new Date(),
            })
            .returning({ id: webUsers.id });
          userId = created.id;
          logger.info({ userId }, 'New web user created via Google');
        }
      }

      setWebUserSession(request, userId);
      return reply.redirect(`${env.WEB_URL}/account`);
    } catch (err) {
      logger.error({ err }, 'Google OAuth callback failed');
      return reply.redirect(`${env.WEB_URL}/login?error=google`);
    }
  });
}
