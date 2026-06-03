/**
 * Google OAuth routes — web platform "Sign in with Google".
 *
 *   GET /web/api/auth/google           — start flow: redirect to Google consent
 *   GET /web/api/auth/google/callback  — handle Google's redirect, sign user in
 *
 * Two presentation modes, chosen by the `?popup=1` query on the start route
 * (remembered on the session for the callback):
 *   - Redirect mode (default): the callback 302s the whole tab to the app.
 *   - Popup mode: the button opened a small window; the callback returns a
 *     tiny self-closing page that postMessages the result to window.opener,
 *     which then routes the main page and closes the popup.
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

import type { FastifyReply } from 'fastify';
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

/**
 * Self-closing page for popup mode. Posts the outcome to the opener (the
 * page that launched the popup) and closes itself. If there is no opener
 * (e.g. the popup was blocked and this became a full navigation), it falls
 * back to the same destinations the redirect flow would use.
 */
function popupResultHtml(ok: boolean, error?: string): string {
  const payload = JSON.stringify({ source: 'fp-google-auth', ok, error: error ?? null });
  const target = JSON.stringify(env.WEB_URL);
  const fallback = JSON.stringify(
    ok ? `${env.WEB_URL}/account` : `${env.WEB_URL}/login?error=${error ?? 'google'}`,
  );
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Signing in…</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,sans-serif;background:#FBF7F0;color:#1F1B16;display:flex;align-items:center;justify-content:center;height:100vh">
<p>${ok ? 'Signing you in…' : 'Sign-in failed — you can close this window.'}</p>
<script>
(function () {
  var hasOpener = window.opener && !window.opener.closed;
  try { if (hasOpener) window.opener.postMessage(${payload}, ${target}); } catch (e) {}
  if (hasOpener) { window.close(); }
  else { window.location.replace(${fallback}); }
})();
</script>
</body>
</html>`;
}

export async function registerWebGoogleAuthRoutes(app: FastifyInstance): Promise<void> {
  // GET /web/api/auth/google — kick off the OAuth flow
  app.get('/web/api/auth/google', async (request, reply) => {
    const { popup } = request.query as { popup?: string };
    const isPopup = popup === '1';

    if (!isEnabled()) {
      return isPopup
        ? reply.type('text/html').send(popupResultHtml(false, 'google_disabled'))
        : reply.redirect(`${env.WEB_URL}/login?error=google_disabled`);
    }

    const state = crypto.randomBytes(16).toString('hex');
    (request as any).session.googleOAuthState = state;
    (request as any).session.googleOAuthPopup = isPopup;

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
    const isPopup = (request as any).session?.googleOAuthPopup === true;
    // One-time use — clear regardless of outcome.
    (request as any).session.googleOAuthState = undefined;
    (request as any).session.googleOAuthPopup = undefined;

    // Emit the right kind of failure for the mode we're in.
    const fail = (reply: FastifyReply) =>
      isPopup
        ? reply.type('text/html').send(popupResultHtml(false, 'google'))
        : reply.redirect(`${env.WEB_URL}/login?error=google`);

    if (error || !code || !state || !expectedState || state !== expectedState) {
      logger.warn(
        { error, hasCode: !!code, stateMatch: state === expectedState, isPopup },
        'Google OAuth callback rejected',
      );
      return fail(reply);
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
      return isPopup
        ? reply.type('text/html').send(popupResultHtml(true))
        : reply.redirect(`${env.WEB_URL}/account`);
    } catch (err) {
      logger.error({ err }, 'Google OAuth callback failed');
      return fail(reply);
    }
  });
}
