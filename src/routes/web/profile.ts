/**
 * Web platform profile routes — /web/api/profile/*
 *
 * GET  /web/api/profile                  — return current user's profile
 * PATCH /web/api/profile                 — update name + whatsapp number
 * POST /web/api/profile/change-password  — change password (requires current)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { webUsers } from '@/db/schema.js';
import {
  authenticateWebUser,
  hashPassword,
  verifyPassword,
} from '@/utils/web-auth.js';

const updateProfileSchema = z.object({
  whatsappNumber: z
    .string()
    .regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid international number e.g. +263771234567.')
    .optional()
    .nullable(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters.').max(128),
});

export async function registerWebProfileRoutes(app: FastifyInstance): Promise<void> {
  // GET /web/api/profile
  app.get('/web/api/profile', async (request, reply) => {
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

    if (!user) return reply.status(404).send({ error: 'not_found' });
    return reply.send(user);
  });

  // PATCH /web/api/profile
  app.patch('/web/api/profile', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const result = updateProfileSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        error: 'validation_error',
        issues: result.error.flatten().fieldErrors,
      });
    }

    const [updated] = await db
      .update(webUsers)
      .set({ whatsappNumber: result.data.whatsappNumber ?? null })
      .where(eq(webUsers.id, userId))
      .returning({
        id: webUsers.id,
        email: webUsers.email,
        whatsappNumber: webUsers.whatsappNumber,
      });

    return reply.send(updated);
  });

  // POST /web/api/profile/change-password
  app.post('/web/api/profile/change-password', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const result = changePasswordSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        error: 'validation_error',
        issues: result.error.flatten().fieldErrors,
      });
    }

    const [user] = await db
      .select({ passwordHash: webUsers.passwordHash })
      .from(webUsers)
      .where(eq(webUsers.id, userId))
      .limit(1);

    if (!user) return reply.status(404).send({ error: 'not_found' });
    // OAuth-only accounts have no password to verify against.
    if (!user.passwordHash) {
      return reply.status(400).send({
        error: 'no_password',
        message: 'This account signs in with Google and has no password to change.',
      });
    }

    const valid = await verifyPassword(result.data.currentPassword, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({
        error: 'wrong_password',
        message: 'Current password is incorrect.',
      });
    }

    const newHash = await hashPassword(result.data.newPassword);
    await db.update(webUsers).set({ passwordHash: newHash }).where(eq(webUsers.id, userId));

    return reply.send({ success: true, message: 'Password updated.' });
  });
}
