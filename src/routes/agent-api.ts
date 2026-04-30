/**
 * Print Agent API routes.
 *
 * These endpoints are called by the print agent running on the
 * Windows print server PC. Authentication uses a shared API key.
 *
 * Routes:
 *   GET  /api/agent/jobs/next              — get next queued job
 *   POST /api/agent/jobs/:id/start         — mark job as printing
 *   POST /api/agent/jobs/:id/done          — mark job as done
 *   POST /api/agent/jobs/:id/fail          — report failure
 *   POST /api/agent/printers/:id/heartbeat — report printer status
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, orderItems, printJobs, printers, images, customers, conversationState } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';

// ===== Auth =====

function checkAgentAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const key = request.headers['x-print-agent-key'];
  if (!env.PRINT_AGENT_API_KEY || key !== env.PRINT_AGENT_API_KEY) {
    logger.warn({ ip: request.ip }, 'Unauthorized agent request');
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ===== Route registration =====

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {

  /**
   * GET /api/agent/jobs/next
   *
   * Returns the next queued print job with all info the agent needs.
   * Returns 404 if no jobs are waiting.
   */
  app.get('/api/agent/jobs/next', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;

    try {
      // Find the oldest queued job
      const [job] = await db
        .select({
          id: printJobs.id,
          orderItemId: printJobs.orderItemId,
          printerId: printJobs.printerId,
          status: printJobs.status,
        })
        .from(printJobs)
        .where(eq(printJobs.status, 'queued'))
        .orderBy(printJobs.queuedAt)
        .limit(1);

      if (!job) {
        reply.status(404).send({ message: 'No jobs queued' });
        return;
      }

      // Get the full details the agent needs
      const [item] = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.id, job.orderItemId))
        .limit(1);

      if (!item) {
        reply.status(404).send({ message: 'Order item not found' });
        return;
      }

      // Get printer info
      const [printer] = job.printerId
        ? await db.select().from(printers).where(eq(printers.id, job.printerId)).limit(1)
        : [null];

      // Get image info
      const [image] = item.imageId
        ? await db.select().from(images).where(eq(images.id, item.imageId)).limit(1)
        : [null];

      // Get order + customer info
      const [order] = await db
        .select({
          orderNumber: orders.orderNumber,
          customerName: customers.name,
        })
        .from(orders)
        .leftJoin(customers, eq(orders.customerId, customers.id))
        .where(eq(orders.id, item.orderId))
        .limit(1);

      return {
        id: job.id,
        orderItemId: job.orderItemId,
        printerId: job.printerId,
        printerOsName: printer?.osPrinterName ?? env.DNP_PRINTER_NAME ?? 'Unknown',
        printerType: printer?.printerType ?? 'dye_sub',
        sizeCode: item.sizeCode,
        productType: item.productType,
        quantity: item.quantity,
        imageStorageKey: image?.storageKey ?? '',
        imageUrl: image?.storageUrl ?? '',
        orderNumber: order?.orderNumber ?? '',
        customerName: order?.customerName ?? null,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to get next job');
      reply.status(500).send({ error: 'Internal error' });
    }
  });

  /**
   * POST /api/agent/jobs/:id/start
   * Mark a job as currently printing.
   */
  app.post('/api/agent/jobs/:id/start', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;
    const { id } = request.params as { id: string };

    try {
      await db
        .update(printJobs)
        .set({ status: 'printing', startedAt: new Date(), attempts: 1 })
        .where(eq(printJobs.id, id));

      // Update the order status too
      await db.execute(
        `UPDATE orders SET status = 'printing' WHERE id = (
          SELECT o.id FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          JOIN print_jobs pj ON pj.order_item_id = oi.id
          WHERE pj.id = '${id}'
          LIMIT 1
        )`
      );

      return { ok: true };
    } catch (err) {
      logger.error({ err, jobId: id }, 'Failed to mark job started');
      reply.status(500).send({ error: 'Internal error' });
    }
  });

  /**
   * POST /api/agent/jobs/:id/done
   * Mark a job as successfully printed.
   */
  app.post('/api/agent/jobs/:id/done', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;
    const { id } = request.params as { id: string };

    try {
      await db
        .update(printJobs)
        .set({ status: 'done', completedAt: new Date() })
        .where(eq(printJobs.id, id));

      // Check if ALL print jobs for this order are done
      // If so, mark the order as ready_for_collection
      const [jobInfo] = await db
        .select({ orderItemId: printJobs.orderItemId })
        .from(printJobs)
        .where(eq(printJobs.id, id))
        .limit(1);

      if (jobInfo) {
        const [itemInfo] = await db
          .select({ orderId: orderItems.orderId })
          .from(orderItems)
          .where(eq(orderItems.id, jobInfo.orderItemId))
          .limit(1);

        if (itemInfo) {
          // Check if all jobs for this order are done
          const remainingJobs = await db
            .select({ id: printJobs.id })
            .from(printJobs)
            .innerJoin(orderItems, eq(printJobs.orderItemId, orderItems.id))
            .where(
              and(
                eq(orderItems.orderId, itemInfo.orderId),
                eq(printJobs.status, 'queued'),
              ),
            );

          if (remainingJobs.length === 0) {
            // All jobs done — mark order ready
            await db
              .update(orders)
              .set({ status: 'ready_for_collection', readyAt: new Date() })
              .where(eq(orders.id, itemInfo.orderId));

            logger.info({ orderId: itemInfo.orderId }, 'All jobs done — order ready for collection');
          }
        }
      }

      logger.info({ jobId: id }, 'Print job marked done');
      return { ok: true };
    } catch (err) {
      logger.error({ err, jobId: id }, 'Failed to mark job done');
      reply.status(500).send({ error: 'Internal error' });
    }
  });

  /**
   * POST /api/agent/jobs/:id/fail
   * Report a job failure.
   */
  app.post('/api/agent/jobs/:id/fail', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason: string };

    try {
      await db
        .update(printJobs)
        .set({
          status: 'failed',
          errorMessage: reason,
          attempts: 1,
        })
        .where(eq(printJobs.id, id));

      logger.error({ jobId: id, reason }, 'Print job failed');
      return { ok: true };
    } catch (err) {
      logger.error({ err, jobId: id }, 'Failed to record job failure');
      reply.status(500).send({ error: 'Internal error' });
    }
  });

  /**
   * POST /api/agent/printers/:id/heartbeat
   * Receive a printer status update from the agent.
   */
  app.post('/api/agent/printers/:id/heartbeat', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;
    const { id } = request.params as { id: string };
    const body = request.body as {
      status: 'online' | 'offline' | 'media_low' | 'error';
      currentMedia?: string;
      errorMessage?: string;
    };

    try {
      await db
        .update(printers)
        .set({
          status: body.status,
          currentMedia: body.currentMedia ?? null,
          lastHeartbeatAt: new Date(),
        })
        .where(eq(printers.id, id));

      return { ok: true };
    } catch (err) {
      logger.error({ err, printerId: id }, 'Failed to update printer heartbeat');
      reply.status(500).send({ error: 'Internal error' });
    }
  });

  /**
   * POST /api/agent/test/create-job
   *
   * Creates a test print job for dry run testing.
   * Only available when NODE_ENV !== 'production'.
   */
  app.post('/api/agent/test/create-job', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;

    if (env.NODE_ENV === 'production') {
      reply.status(403).send({ error: 'Test endpoints not available in production' });
      return;
    }

    try {
      const { sizeCode = '4x6' } = request.body as { sizeCode?: string };

      // Find or create a test customer
      const existingCustomers = await db.select().from(customers).limit(1);
      let testCustomer = existingCustomers[0];

      if (!testCustomer) {
        const inserted = await db
          .insert(customers)
          .values({ phoneNumber: '+263771000000', name: 'Test Customer' })
          .returning();
        testCustomer = inserted[0];

        await db.insert(conversationState).values({
          customerId: testCustomer.id,
          currentStep: 'idle',
          context: { cart: [] },
        });
      }

      // Find the most recent image (may be null)
      const latestImages = await db
        .select()
        .from(images)
        .orderBy(desc(images.uploadedAt))
        .limit(1);
      const latestImage = latestImages[0] ?? null;

      // Determine printer type from size
      const inkjetSizes = ['8x10', '11x14', '12x18', '16x20'];
      const printerType = inkjetSizes.includes(sizeCode) ? 'inkjet' : 'dye_sub';

      // Find the matching printer
      const matchingPrinters = await db
        .select()
        .from(printers)
        .where(eq(printers.printerType, printerType))
        .limit(1);
      const printer = matchingPrinters[0] ?? null;

      // Generate order number
      const year = new Date().getFullYear();
      const lastOrders = await db
        .select({ orderNumber: orders.orderNumber })
        .from(orders)
        .orderBy(desc(orders.createdAt))
        .limit(1);
      const lastNum = lastOrders[0]
        ? parseInt(lastOrders[0].orderNumber.split('-')[2] ?? '0', 10)
        : 0;
      const orderNumber = `FP-${year}-${String(lastNum + 1).padStart(4, '0')}`;

      // Create the order
      const insertedOrders = await db
        .insert(orders)
        .values({
          customerId: testCustomer.id,
          orderNumber,
          status: 'paid',
          subtotalUsd: '0.80',
          deliveryFeeUsd: '0',
          totalUsd: '0.80',
          fulfillmentMethod: 'collection',
          paidAt: new Date(),
        })
        .returning();
      const order = insertedOrders[0];

      // Create the order item
      const insertedItems = await db
        .insert(orderItems)
        .values({
          orderId: order.id,
          imageId: latestImage?.id ?? null as unknown as string,
          productType: printerType === 'dye_sub' ? 'photo_print' : 'poster',
          sizeCode,
          quantity: 1,
          unitPriceUsd: '0.80',
          lineTotalUsd: '0.80',
          requiresManualReview: false,
        })
        .returning();
      const orderItem = insertedItems[0];

      // Create the print job
      const insertedJobs = await db
        .insert(printJobs)
        .values({
          orderItemId: orderItem.id,
          printerId: printer?.id ?? null,
          status: 'queued',
        })
        .returning();
      const printJob = insertedJobs[0];

      logger.info({ jobId: printJob.id, orderNumber, sizeCode }, 'Test print job created');

      return {
        jobId: printJob.id,
        orderNumber,
        message: 'Test job created — agent should pick it up within 30s',
      };

    } catch (err) {
      logger.error({ err }, 'Failed to create test job');
      reply.status(500).send({ error: 'Failed to create test job' });
    }
  });
}
