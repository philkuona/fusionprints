/**
 * Web platform address routes — /web/api/addresses/*
 *
 * GET    /web/api/addresses         — list user's addresses
 * POST   /web/api/addresses         — create address
 * PUT    /web/api/addresses/:id     — update address
 * DELETE /web/api/addresses/:id     — delete address
 * PATCH  /web/api/addresses/:id/default — set as default
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { customerAddresses } from '@/db/schema.js';
import { authenticateWebUser } from '@/utils/web-auth.js';

const addressSchema = z.object({
  label: z.string().min(1).max(50).default('Home'),
  recipientName: z.string().min(1, 'Recipient name is required.').max(100),
  addressLine1: z.string().min(1, 'Address is required.').max(200),
  suburb: z.string().max(100).optional().nullable(),
  city: z.string().min(1, 'City is required.').max(100),
  deliveryInstructions: z.string().max(500).optional().nullable(),
  isDefault: z.boolean().optional().default(false),
});

export async function registerWebAddressRoutes(app: FastifyInstance): Promise<void> {
  // GET /web/api/addresses
  app.get('/web/api/addresses', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const addresses = await db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.webUserId, userId))
      .orderBy(customerAddresses.createdAt);

    return reply.send(addresses);
  });

  // POST /web/api/addresses
  app.post('/web/api/addresses', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const result = addressSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        error: 'validation_error',
        issues: result.error.flatten().fieldErrors,
      });
    }

    // If this is set as default, clear existing default first
    if (result.data.isDefault) {
      await db
        .update(customerAddresses)
        .set({ isDefault: false })
        .where(eq(customerAddresses.webUserId, userId));
    }

    // If this is the first address, auto-set as default
    const existing = await db
      .select({ id: customerAddresses.id })
      .from(customerAddresses)
      .where(eq(customerAddresses.webUserId, userId))
      .limit(1);

    const shouldBeDefault = result.data.isDefault || existing.length === 0;

    const [address] = await db
      .insert(customerAddresses)
      .values({
        webUserId: userId,
        ...result.data,
        isDefault: shouldBeDefault,
      })
      .returning();

    return reply.status(201).send(address);
  });

  // PUT /web/api/addresses/:id
  app.put('/web/api/addresses/:id', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const { id } = request.params as { id: string };
    const result = addressSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        error: 'validation_error',
        issues: result.error.flatten().fieldErrors,
      });
    }

    // Verify ownership
    const [existing] = await db
      .select({ id: customerAddresses.id })
      .from(customerAddresses)
      .where(and(eq(customerAddresses.id, id), eq(customerAddresses.webUserId, userId)))
      .limit(1);

    if (!existing) return reply.status(404).send({ error: 'not_found' });

    if (result.data.isDefault) {
      await db
        .update(customerAddresses)
        .set({ isDefault: false })
        .where(eq(customerAddresses.webUserId, userId));
    }

    const [updated] = await db
      .update(customerAddresses)
      .set(result.data)
      .where(eq(customerAddresses.id, id))
      .returning();

    return reply.send(updated);
  });

  // DELETE /web/api/addresses/:id
  app.delete('/web/api/addresses/:id', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const { id } = request.params as { id: string };

    const [deleted] = await db
      .delete(customerAddresses)
      .where(and(eq(customerAddresses.id, id), eq(customerAddresses.webUserId, userId)))
      .returning({ id: customerAddresses.id, wasDefault: customerAddresses.isDefault });

    if (!deleted) return reply.status(404).send({ error: 'not_found' });

    // If we deleted the default, promote the oldest remaining address
    if (deleted.wasDefault) {
      const [next] = await db
        .select({ id: customerAddresses.id })
        .from(customerAddresses)
        .where(eq(customerAddresses.webUserId, userId))
        .orderBy(customerAddresses.createdAt)
        .limit(1);

      if (next) {
        await db
          .update(customerAddresses)
          .set({ isDefault: true })
          .where(eq(customerAddresses.id, next.id));
      }
    }

    return reply.send({ success: true });
  });

  // PATCH /web/api/addresses/:id/default
  app.patch('/web/api/addresses/:id/default', async (request, reply) => {
    const userId = authenticateWebUser(request, reply);
    if (!userId) return;

    const { id } = request.params as { id: string };

    const [existing] = await db
      .select({ id: customerAddresses.id })
      .from(customerAddresses)
      .where(and(eq(customerAddresses.id, id), eq(customerAddresses.webUserId, userId)))
      .limit(1);

    if (!existing) return reply.status(404).send({ error: 'not_found' });

    // Clear all defaults then set this one
    await db
      .update(customerAddresses)
      .set({ isDefault: false })
      .where(eq(customerAddresses.webUserId, userId));

    await db
      .update(customerAddresses)
      .set({ isDefault: true })
      .where(eq(customerAddresses.id, id));

    return reply.send({ success: true });
  });
}
