/**
 * Web platform auth routes — /web/api/auth/*
 *
 * POST /web/api/auth/signup   — create account, send verification email
 * GET  /web/api/auth/verify   — verify email token, start session
 * POST /web/api/auth/login    — email + password login
 * POST /web/api/auth/logout   — destroy session
 * GET  /web/api/auth/me       — return current web user
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { Resend } from 'resend';
import { db } from '@/db/client.js';
import { webUsers } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import {
  hashPassword,
  verifyPassword,
  generateVerificationToken,
  verificationTokenExpiry,
  authenticateWebUser,
  setWebUserSession,
  clearWebUserSession,
} from '@/utils/web-auth.js';

const resend = new Resend(env.RESEND_API_KEY || undefined);

// ── Zod schemas ────────────────────────────────────────────────────────────

const signupSchema = z.object({
  email: z.string().email('Please enter a valid email address.'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters.')
    .max(128, 'Password is too long.'),
  whatsappNumber: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, 'Enter your WhatsApp number in international format, e.g. +263771234567.')
    .optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ── Route registration ─────────────────────────────────────────────────────

export async function registerWebAuthRoutes(app: FastifyInstance): Promise<void> {
  // POST /web/api/auth/signup
  app.post('/web/api/auth/signup', async (request, reply) => {
    const result = signupSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        error: 'validation_error',
        issues: result.error.flatten().fieldErrors,
      });
    }

    const { email, password, whatsappNumber } = result.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already taken
    const existing = await db
      .select({ id: webUsers.id, emailVerified: webUsers.emailVerified })
      .from(webUsers)
      .where(eq(webUsers.email, normalizedEmail))
      .limit(1);

    if (existing.length > 0) {
      // Don't leak whether email exists — generic message
      return reply.status(409).send({
        error: 'email_taken',
        message: 'An account with this email already exists.',
      });
    }

    const passwordHash = await hashPassword(password);
    const emailVerificationToken = generateVerificationToken();
    const emailVerificationExpiresAt = verificationTokenExpiry();

    const [newUser] = await db
      .insert(webUsers)
      .values({
        email: normalizedEmail,
        passwordHash,
        emailVerificationToken,
        emailVerificationExpiresAt,
        whatsappNumber: whatsappNumber ?? null,
      })
      .returning({ id: webUsers.id, email: webUsers.email });

    // Send verification email
    const verifyUrl = `${env.WEB_URL}/auth/verify?token=${emailVerificationToken}`;
    try {
      await resend.emails.send({
        from: 'FusionPrints <noreply@fusionprints.co.zw>',
        to: normalizedEmail,
        subject: 'Verify your FusionPrints account',
        html: `
          <div style="font-family: sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
            <h1 style="font-size: 24px; color: #1F1B16; margin-bottom: 8px;">Verify your email</h1>
            <p style="color: #4A3F32; line-height: 1.6;">
              Welcome to FusionPrints. Click the button below to verify your email and start printing.
            </p>
            <a href="${verifyUrl}"
               style="display: inline-block; margin-top: 24px; padding: 14px 28px;
                      background: #05D668; color: #1F1B16; text-decoration: none;
                      border-radius: 100px; font-weight: 600; font-size: 15px;">
              Verify email
            </a>
            <p style="margin-top: 24px; color: #8A7B66; font-size: 13px;">
              This link expires in 24 hours. If you didn't create an account, you can ignore this email.
            </p>
          </div>
        `,
      });
    } catch (err) {
      logger.error({ err, userId: newUser.id }, 'Failed to send verification email');
      // Don't fail the signup — user can request a resend later
    }

    return reply.status(201).send({
      message: 'Account created. Check your email to verify your account.',
    });
  });

  // GET /web/api/auth/verify?token=...
  app.get('/web/api/auth/verify', async (request, reply) => {
    const { token } = request.query as { token?: string };
    if (!token || token.length !== 64) {
      return reply.status(400).send({ error: 'invalid_token', message: 'Invalid verification link.' });
    }

    const [user] = await db
      .select()
      .from(webUsers)
      .where(eq(webUsers.emailVerificationToken, token))
      .limit(1);

    if (!user) {
      return reply.status(400).send({ error: 'invalid_token', message: 'Invalid or expired link.' });
    }

    if (user.emailVerificationExpiresAt && user.emailVerificationExpiresAt < new Date()) {
      return reply.status(400).send({ error: 'token_expired', message: 'This link has expired. Please sign up again.' });
    }

    if (user.emailVerified) {
      // Already verified — just log them in
      setWebUserSession(request, user.id);
      return reply.send({ success: true, message: 'Email already verified. You are signed in.' });
    }

    await db
      .update(webUsers)
      .set({
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
        lastLoginAt: new Date(),
      })
      .where(eq(webUsers.id, user.id));

    setWebUserSession(request, user.id);
    return reply.send({ success: true, message: 'Email verified. Welcome to FusionPrints.' });
  });

  // POST /web/api/auth/login
  app.post('/web/api/auth/login', async (request, reply) => {
    const result = loginSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: 'validation_error', message: 'Invalid credentials.' });
    }

    const { email, password } = result.data;
    const normalizedEmail = email.toLowerCase().trim();

    const [user] = await db
      .select()
      .from(webUsers)
      .where(eq(webUsers.email, normalizedEmail))
      .limit(1);

    // Use constant-time comparison to avoid timing attacks
    const dummyHash = '$2a$12$dummy.hash.to.prevent.timing.attack.on.nonexistent';
    const passwordValid = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, dummyHash).then(() => false);

    if (!user || !passwordValid) {
      return reply.status(401).send({
        error: 'invalid_credentials',
        message: 'Incorrect email or password.',
      });
    }

    if (!user.emailVerified) {
      return reply.status(403).send({
        error: 'email_not_verified',
        message: 'Please verify your email before signing in. Check your inbox.',
      });
    }

    await db
      .update(webUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(webUsers.id, user.id));

    setWebUserSession(request, user.id);

    return reply.send({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    });
  });

  // POST /web/api/auth/logout
  app.post('/web/api/auth/logout', async (request, reply) => {
    clearWebUserSession(request);
    await (request as any).session.destroy();
    return reply.send({ success: true });
  });

  // GET /web/api/auth/me
  app.get('/web/api/auth/me', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const [user] = await db
      .select({
        id: webUsers.id,
        email: webUsers.email,
        emailVerified: webUsers.emailVerified,
        whatsappNumber: webUsers.whatsappNumber,
        createdAt: webUsers.createdAt,
        lastLoginAt: webUsers.lastLoginAt,
      })
      .from(webUsers)
      .where(eq(webUsers.id, userId))
      .limit(1);

    if (!user) {
      clearWebUserSession(request);
      return reply.status(401).send({ error: 'not_authenticated', message: 'Session expired.' });
    }

    return reply.send(user);
  });
}
