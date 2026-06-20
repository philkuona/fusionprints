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
import { eq, and, desc, sql, lt } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { orders, orderItems, printJobs, printers, images, customers, conversationState, slipJobs, processedImages } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { getSignedImageUrl } from '@/services/image-storage.js';
import { getProduct, type PrintLayout } from '@/config/catalog.js';
import { getDnpMediaMode, mediaForPrinterType } from '@/services/store-settings.js';

// Max times a transient (printer offline / unreachable) failure requeues a job
// before we give up and mark it failed. High enough to ride out a printer being
// off for a while; bounded so a job that fails every single poll can't hot-loop.
const OFFLINE_REQUEUE_MAX = 30;

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

// ===== Atomic job claiming =====
// next-job SELECTs the job to hand out, then claims it with a compare-and-swap
// (UPDATE ... WHERE id=? AND status='queued'). Postgres row locking guarantees
// only ONE poller's claim succeeds, so two agents (e.g. the real agent + the
// virtual-printer simulator) can never both grab the same job. A failed claim
// means someone else won the race → the caller returns 404 and polls again.

async function claimPrintJob(id: string): Promise<boolean> {
  const r = await db
    .update(printJobs)
    .set({ status: 'printing', startedAt: new Date() })
    .where(and(eq(printJobs.id, id), eq(printJobs.status, 'queued')))
    .returning({ id: printJobs.id });
  return r.length > 0;
}

async function claimSlipJob(id: string): Promise<boolean> {
  const r = await db
    .update(slipJobs)
    .set({ status: 'printing', startedAt: new Date() })
    .where(and(eq(slipJobs.id, id), eq(slipJobs.status, 'queued')))
    .returning({ id: slipJobs.id });
  return r.length > 0;
}

/**
 * Re-queue jobs stuck in 'printing' past maxAgeMs — recovers work an agent
 * claimed then died mid-print (the previous SELECT-only flow self-healed because
 * it never claimed; the compare-and-swap claim needs this to restore that).
 * Cutoff is generous: photo/poster prints finish in well under a minute.
 */
export async function reclaimStaleAgentJobs(maxAgeMs = 15 * 60 * 1000): Promise<void> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  try {
    const p = await db
      .update(printJobs)
      .set({ status: 'queued', startedAt: null })
      .where(and(eq(printJobs.status, 'printing'), lt(printJobs.startedAt, cutoff)))
      .returning({ id: printJobs.id });
    const s = await db
      .update(slipJobs)
      .set({ status: 'queued', startedAt: null })
      .where(and(eq(slipJobs.status, 'printing'), lt(slipJobs.startedAt, cutoff)))
      .returning({ id: slipJobs.id });
    if (p.length || s.length) {
      logger.warn({ printJobs: p.length, slipJobs: s.length }, 'Re-queued stale printing jobs (agent likely crashed mid-print)');
    }
  } catch (err) {
    logger.error({ err }, 'reclaimStaleAgentJobs failed');
  }
}

// ===== Route registration =====

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {

  /**
   * GET /api/agent/jobs/next?printer_type=<type>
   *
   * Returns the next queued print job with all info the agent needs.
   * Returns 404 if no jobs are waiting.
   *
   * Phase D.3: accepts an optional printer_type query parameter.
   * If provided, only returns jobs matching that target printer type.
   * Valid values: 'dye_sub_4x6' | 'dye_sub_5x7' | 'inkjet' | 'thermal_label'
   *
   * If a printer_type is specified, also includes pending slip_jobs
   * (operational/branded prints) for that printer type, prioritized by
   * sequence_position so end_separator prints first within an order.
   */
  app.get('/api/agent/jobs/next', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;

    const printerType = (request.query as { printer_type?: string })?.printer_type;
    const validTypes = ['dye_sub_4x6', 'dye_sub_5x7', 'inkjet', 'thermal_label'];
    const filterType = printerType && validTypes.includes(printerType) ? printerType : null;

    try {
      // DNP media-mode gate. There is ONE physical DNP, loaded with one media
      // family at a time. Only serve dye-sub jobs whose media matches the
      // currently loaded mode, so 5×7 jobs stay held under '6x8' (and the 4×6
      // family — including its slips — stays held under '5x7'). The operator
      // flips the mode from the admin dashboard after a physical media swap.
      if (filterType === 'dye_sub_4x6' || filterType === 'dye_sub_5x7') {
        if (mediaForPrinterType(filterType) !== (await getDnpMediaMode())) {
          reply.status(404).send({ message: 'No jobs queued' });
          return;
        }
      }

      // For thermal_label requests, only check slip_jobs (no print_jobs go there)
      if (filterType === 'thermal_label') {
        const [slip] = await db
          .select()
          .from(slipJobs)
          .where(
            and(
              eq(slipJobs.status, 'queued'),
              eq(slipJobs.targetPrinterType, 'thermal_label'),
            ),
          )
          .orderBy(slipJobs.queuedAt)
          .limit(1);

        if (!slip) {
          reply.status(404).send({ message: 'No jobs queued' });
          return;
        }

        // Atomically claim it — if another poller grabbed it first, back off.
        if (!(await claimSlipJob(slip.id))) {
          reply.status(404).send({ message: 'No jobs queued' });
          return;
        }

        return {
          id: slip.id,
          jobKind: 'slip' as const,
          slipType: slip.slipType, // 'envelope_label'
          printerType: 'thermal' as const,
          quantity: 1,
          zpl: (slip.payloadJson as { zpl?: string } | null)?.zpl ?? '',
          sequencePosition: slip.sequencePosition,
        };
      }

      // For dye_sub printers, check both slip_jobs and print_jobs, one order
      // at a time so each order's stack comes out in physical sequence:
      //   sequence 0   = end_separator slip (bottom of stack, prints first)
      //   sequence 50  = customer prints (implicit, ordered by queuedAt)
      //   sequence 100 = order_info slip (top of stack, prints last —
      //                  only once the order has no queued prints left)
      // The active order is the one with the oldest queued work, so one
      // order's stack completes before the next order starts.
      let job: { id: string; orderItemId: string; printerId: string | null } | null = null;

      if (filterType === 'dye_sub_4x6' || filterType === 'dye_sub_5x7') {
        const [oldestSlip] = await db
          .select({ orderId: slipJobs.orderId, queuedAt: slipJobs.queuedAt })
          .from(slipJobs)
          .where(
            and(
              eq(slipJobs.status, 'queued'),
              eq(slipJobs.targetPrinterType, filterType),
            ),
          )
          .orderBy(slipJobs.queuedAt)
          .limit(1);

        const [oldestPrint] = await db
          .select({ orderId: orderItems.orderId, queuedAt: printJobs.queuedAt })
          .from(printJobs)
          .innerJoin(orderItems, eq(printJobs.orderItemId, orderItems.id))
          .where(
            and(
              eq(printJobs.status, 'queued'),
              eq(printJobs.targetPrinterType, filterType),
            ),
          )
          .orderBy(printJobs.queuedAt)
          .limit(1);

        if (!oldestSlip && !oldestPrint) {
          reply.status(404).send({ message: 'No jobs queued' });
          return;
        }

        const activeOrderId =
          oldestSlip && oldestPrint
            ? (oldestSlip.queuedAt <= oldestPrint.queuedAt ? oldestSlip.orderId : oldestPrint.orderId)
            : (oldestSlip ?? oldestPrint)!.orderId;

        const [slip] = await db
          .select()
          .from(slipJobs)
          .where(
            and(
              eq(slipJobs.status, 'queued'),
              eq(slipJobs.targetPrinterType, filterType),
              eq(slipJobs.orderId, activeOrderId),
            ),
          )
          .orderBy(slipJobs.sequencePosition, slipJobs.queuedAt)
          .limit(1);

        const [orderPrint] = await db
          .select({
            id: printJobs.id,
            orderItemId: printJobs.orderItemId,
            printerId: printJobs.printerId,
          })
          .from(printJobs)
          .innerJoin(orderItems, eq(printJobs.orderItemId, orderItems.id))
          .where(
            and(
              eq(printJobs.status, 'queued'),
              eq(printJobs.targetPrinterType, filterType),
              eq(orderItems.orderId, activeOrderId),
            ),
          )
          .orderBy(printJobs.queuedAt)
          .limit(1);

        // Customer prints sit at implicit sequence 50: slips below that print
        // before them, slips at or above only once the order's prints are done.
        const PRINT_SEQUENCE = 50;
        if (slip && (!orderPrint || slip.sequencePosition < PRINT_SEQUENCE)) {
          // Atomically claim before handing out — lose the race → poll again.
          if (!(await claimSlipJob(slip.id))) {
            reply.status(404).send({ message: 'No jobs queued' });
            return;
          }
          // Slips are pre-rendered print-ready 4x6 PNGs. The agent downloads by
          // B2 key (the bucket is private; the stored direct URL 401s), so we
          // derive the key from the URL and hand it over like a print job —
          // flagged isPreRendered so the agent prints it as-is (no crop/resize).
          const slipKey = slip.printReadyFileUrl
            ? new URL(slip.printReadyFileUrl).pathname.replace(/^\/+/, '')
            : '';
          return {
            id: slip.id,
            jobKind: 'slip' as const,
            slipType: slip.slipType, // end_separator | order_info | promo
            printerType: 'dye_sub' as const,
            printerOsName: env.DNP_PRINTER_NAME,
            sizeCode: '4x6',
            productType: 'photo_print' as const,
            quantity: 1,
            isPreRendered: true,
            imageStorageKey: slipKey,
            imageUrl: slip.printReadyFileUrl,
            sequencePosition: slip.sequencePosition,
          };
        }

        job = orderPrint ?? null;
      }

      // Inkjet / unfiltered: oldest queued print_job, optionally filtered by type
      if (!job) {
        const whereClauses = filterType
          ? and(eq(printJobs.status, 'queued'), eq(printJobs.targetPrinterType, filterType as 'dye_sub_4x6' | 'dye_sub_5x7' | 'inkjet'))
          : eq(printJobs.status, 'queued');

        const [oldest] = await db
          .select({
            id: printJobs.id,
            orderItemId: printJobs.orderItemId,
            printerId: printJobs.printerId,
          })
          .from(printJobs)
          .where(whereClauses)
          .orderBy(printJobs.queuedAt)
          .limit(1);
        job = oldest ?? null;
      }

      if (!job) {
        reply.status(404).send({ message: 'No jobs queued' });
        return;
      }

      // Atomically claim the print job — if another poller already took it,
      // back off and let the agent poll again.
      if (!(await claimPrintJob(job.id))) {
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

      // Web (edited) items print the processed render, not the original photo.
      const [processed] = item.processedImageId
        ? await db.select().from(processedImages).where(eq(processedImages.id, item.processedImageId)).limit(1)
        : [null];
      const printStorageKey = processed?.processedStorageKey ?? image?.storageKey ?? '';
      const printUrl = processed
        ? await getSignedImageUrl(processed.processedStorageKey)
        : image?.storageUrl ?? '';

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

      // Composite products (wallet/passport/mini): hand the agent the layout +
      // each cell's image (by B2 key, like prints) so it can render the sheet.
      let composite:
        | {
            layout: PrintLayout | null;
            cells: { cellIndex: number; imageStorageKey: string; imageUrl: string; transform: unknown; border: unknown }[];
          }
        | null = null;
      if (item.productType === 'composite') {
        const product = getProduct(item.sizeCode);
        const payload = item.layoutPayload as {
          cells?: { cellIndex: number; imageId: string | null; transform: unknown; border: unknown }[];
        } | null;
        const cells = await Promise.all(
          (payload?.cells ?? []).map(async (c) => {
            const [img] = c.imageId
              ? await db.select().from(images).where(eq(images.id, c.imageId)).limit(1)
              : [null];
            return {
              cellIndex: c.cellIndex,
              imageStorageKey: img?.storageKey ?? '',
              imageUrl: img?.storageKey ? await getSignedImageUrl(img.storageKey) : '',
              transform: c.transform ?? null,
              border: c.border ?? null,
            };
          }),
        );
        composite = { layout: product?.layout ?? null, cells };
      }

      return {
        id: job.id,
        orderItemId: job.orderItemId,
        printerId: job.printerId,
        printerOsName: printer?.osPrinterName ?? env.DNP_PRINTER_NAME ?? 'Unknown',
        printerType: printer?.printerType ?? 'dye_sub',
        sizeCode: item.sizeCode,
        productType: item.productType,
        quantity: item.quantity,
        imageStorageKey: printStorageKey,
        imageUrl: printUrl,
        // Present only for composite products; the agent composites the cells.
        composite,
        orderNumber: order?.orderNumber ?? '',
        customerName: order?.customerName ?? null,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to get next job');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  /**
   * POST /api/agent/jobs/:id/start
   * Mark a job (print or slip) as currently printing.
   */
  app.post('/api/agent/jobs/:id/start', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;
    const { id } = request.params as { id: string };

    try {
      // Try print_jobs first
      const printJobUpdate = await db
        .update(printJobs)
        .set({ status: 'printing', startedAt: new Date(), attempts: 1 })
        .where(eq(printJobs.id, id))
        .returning({ id: printJobs.id, orderItemId: printJobs.orderItemId });

      if (printJobUpdate.length > 0) {
        // Update the order status too — find via order_item
        const [item] = await db
          .select({ orderId: orderItems.orderId })
          .from(orderItems)
          .where(eq(orderItems.id, printJobUpdate[0].orderItemId))
          .limit(1);
        if (item) {
          await db
            .update(orders)
            .set({ status: 'printing' })
            .where(eq(orders.id, item.orderId));
        }
        return { ok: true };
      }

      // Try slip_jobs
      const slipJobUpdate = await db
        .update(slipJobs)
        .set({ status: 'printing', startedAt: new Date(), attempts: 1 })
        .where(eq(slipJobs.id, id))
        .returning({ id: slipJobs.id, orderId: slipJobs.orderId });

      if (slipJobUpdate.length > 0) {
        // Update the order status too
        await db
          .update(orders)
          .set({ status: 'printing' })
          .where(eq(orders.id, slipJobUpdate[0].orderId));
        return { ok: true };
      }

      return reply.status(404).send({ error: 'Job not found in print_jobs or slip_jobs' });
    } catch (err) {
      logger.error({ err, jobId: id }, 'Failed to mark job started');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  /**
   * POST /api/agent/jobs/:id/done
   * Mark a job (print or slip) as successfully printed.
   *
   * Phase D.3: jobs can be either print_jobs OR slip_jobs.
   * Tries print_jobs first; if not found, tries slip_jobs.
   *
   * When ALL jobs (print + slip) for an order are done, advances
   * order status to 'printed' (NOT directly ready_for_pickup —
   * operator must explicitly release via admin dashboard).
   */
  app.post('/api/agent/jobs/:id/done', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;
    const { id } = request.params as { id: string };

    try {
      // Try to update as print_job first
      const printJobUpdate = await db
        .update(printJobs)
        .set({ status: 'done', completedAt: new Date() })
        .where(eq(printJobs.id, id))
        .returning({ id: printJobs.id, orderItemId: printJobs.orderItemId });

      let orderId: string | null = null;

      if (printJobUpdate.length > 0) {
        // It was a print_job — find its order via order_item
        const [item] = await db
          .select({ orderId: orderItems.orderId })
          .from(orderItems)
          .where(eq(orderItems.id, printJobUpdate[0].orderItemId))
          .limit(1);
        if (item) orderId = item.orderId;
      } else {
        // Not a print_job — try slip_jobs
        const slipJobUpdate = await db
          .update(slipJobs)
          .set({ status: 'done', completedAt: new Date() })
          .where(eq(slipJobs.id, id))
          .returning({ id: slipJobs.id, orderId: slipJobs.orderId });

        if (slipJobUpdate.length > 0) {
          orderId = slipJobUpdate[0].orderId;
        } else {
          reply.status(404).send({ error: 'Job not found in print_jobs or slip_jobs' });
          return;
        }
      }

      // Check if all jobs (print + slip) for this order are done
      if (orderId) {
        const [pendingPrints] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(printJobs)
          .innerJoin(orderItems, eq(printJobs.orderItemId, orderItems.id))
          .where(
            and(
              eq(orderItems.orderId, orderId),
              eq(printJobs.status, 'queued'),
            ),
          );

        const [pendingSlips] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(slipJobs)
          .where(
            and(
              eq(slipJobs.orderId, orderId),
              eq(slipJobs.status, 'queued'),
            ),
          );

        const totalPending = (pendingPrints?.count ?? 0) + (pendingSlips?.count ?? 0);

        if (totalPending === 0) {
          // All jobs done — advance to 'printed' (operator must release for pickup)
          await db
            .update(orders)
            .set({ status: 'printed' })
            .where(eq(orders.id, orderId));

          logger.info({ orderId }, 'All jobs done — order status: printed (awaiting operator release)');
        }
      }

      logger.info({ jobId: id }, 'Job marked done');
      return { ok: true };
    } catch (err) {
      logger.error({ err, jobId: id }, 'Failed to mark job done');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  /**
   * POST /api/agent/jobs/:id/fail
   * Report a job (print or slip) failure.
   */
  app.post('/api/agent/jobs/:id/fail', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;
    const { id } = request.params as { id: string };
    const { reason, retryable } = request.body as { reason: string; retryable?: boolean };

    // A printer being offline/unreachable is TRANSIENT — keep the job queued so
    // it dispatches FIFO once a printer is back, instead of hard-failing it.
    // Honour an explicit `retryable` flag from the agent, else detect
    // connectivity-style reasons. Capped so a genuinely stuck job (the same one
    // failing every poll) eventually surfaces as failed rather than hot-looping.
    const transient =
      retryable === true ||
      /offline|not responding|unreachable|no printer|disconnect|connection|timed?\s*out|timeout/i.test(reason ?? '');

    try {
      // print_jobs first, then slip_jobs — read attempts so we can cap requeues.
      const [pj] = await db.select({ attempts: printJobs.attempts }).from(printJobs).where(eq(printJobs.id, id)).limit(1);
      if (pj) {
        const attempts = pj.attempts + 1;
        const requeue = transient && attempts < OFFLINE_REQUEUE_MAX;
        await db
          .update(printJobs)
          .set({ status: requeue ? 'queued' : 'failed', errorMessage: reason, attempts })
          .where(eq(printJobs.id, id));
        if (requeue) logger.warn({ jobId: id, reason, attempts }, 'Print job requeued (printer offline/transient) — will retry FIFO');
        else logger.error({ jobId: id, reason, attempts }, 'Print job failed');
        return { ok: true, status: requeue ? 'queued' : 'failed' };
      }

      const [sj] = await db.select({ attempts: slipJobs.attempts }).from(slipJobs).where(eq(slipJobs.id, id)).limit(1);
      if (sj) {
        const attempts = sj.attempts + 1;
        const requeue = transient && attempts < OFFLINE_REQUEUE_MAX;
        await db
          .update(slipJobs)
          .set({ status: requeue ? 'queued' : 'failed', errorMessage: reason, attempts })
          .where(eq(slipJobs.id, id));
        if (requeue) logger.warn({ slipJobId: id, reason, attempts }, 'Slip job requeued (printer offline/transient) — will retry FIFO');
        else logger.error({ slipJobId: id, reason, attempts }, 'Slip job failed');
        return { ok: true, status: requeue ? 'queued' : 'failed' };
      }

      return reply.status(404).send({ error: 'Job not found' });
    } catch (err) {
      logger.error({ err, jobId: id }, 'Failed to record job failure');
      return reply.status(500).send({ error: 'Internal error' });
    }
  });

  /**
   * GET /api/agent/printers
   * List registered printers so the agent can map its physical devices to rows
   * (by printer_type) and heartbeat them by id.
   */
  app.get('/api/agent/printers', async (request, reply) => {
    if (!checkAgentAuth(request, reply)) return;
    const rows = await db
      .select({
        id: printers.id,
        name: printers.name,
        printerType: printers.printerType,
        osPrinterName: printers.osPrinterName,
      })
      .from(printers);
    return { printers: rows };
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
      return reply.status(500).send({ error: 'Internal error' });
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
      return reply.status(500).send({ error: 'Failed to create test job' });
    }
  });
}
