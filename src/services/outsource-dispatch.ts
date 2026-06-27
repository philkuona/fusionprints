/**
 * Outsource auto-dispatch (Outsource Routing — Phase 4).
 *
 * When a paid order has outsourced items, this packages them (Phase 3) and emails
 * the bundle to the active default partner — no human in the loop. Records every
 * dispatch (timestamp, partner, channel, line items, wholesale-cost snapshot,
 * status), retries transient failures with backoff, and alerts ops on hard
 * failure. The in-house portion is never blocked by a dispatch problem.
 *
 * v1 sends over EMAIL only. The manual-override functions (re-send, send to a
 * different partner, mark manually fulfilled) are exposed here; the admin UI that
 * calls them lands with the dual-stream order view in Phase 5.
 */
import { Resend } from 'resend';
import { eq, desc } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  orders,
  outsourceDispatches,
  type OutsourcePartner,
  type OutsourceDispatch,
} from '@/db/schema.js';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { buildOutsourcePackage, type OutsourcePackage } from '@/services/outsource-package.js';
import { getPartnerById, type PartnerChannel } from '@/services/outsource-partners.js';
import { sendOutsourceDispatchFailedAlert } from '@/services/operator-email.js';

const MAX_SEND_ATTEMPTS = 2; // initial + 1 retry (then escalate to manual)

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/** Wholesale cost for a dispatch — what we pay the partner, snapshotted at send. */
export function computeWholesaleCost(
  items: { sizeCode: string; quantity: number }[],
  prices: Record<string, number>,
): number {
  const total = items.reduce((sum, i) => sum + (prices[i.sizeCode] ?? 0) * i.quantity, 0);
  return Math.round(total * 100) / 100;
}

export interface DispatchTarget {
  ok: boolean;
  channel: PartnerChannel;
  email?: string;
  reason?: string;
}

/** Decide whether/where a partner can receive a dispatch (v1: email only). */
export function resolveDispatchTarget(partner: OutsourcePartner | null): DispatchTarget {
  if (!partner) return { ok: false, channel: 'email', reason: 'No active default partner configured' };
  if (!partner.active) return { ok: false, channel: partner.preferredChannel, reason: 'Partner is inactive' };
  const channel = partner.preferredChannel;
  if (channel !== 'email') {
    return { ok: false, channel, reason: `Preferred channel "${channel}" is not supported yet (email only in v1)` };
  }
  if (!partner.contactEmail) return { ok: false, channel, reason: 'Partner has no contact email set' };
  return { ok: true, channel, email: partner.contactEmail };
}

/** A dispatch in any of these states means the order's outsource work is in hand. */
export function isLiveDispatch(status: OutsourceDispatch['status']): boolean {
  return ['sent', 'partner_confirmed', 'partner_ready', 'received_back', 'manually_fulfilled'].includes(status);
}

/** Skip auto-dispatch if any existing dispatch already covers this order. */
export function alreadyDispatched(existing: Pick<OutsourceDispatch, 'status'>[]): boolean {
  return existing.some((d) => isLiveDispatch(d.status));
}

// ── Internals ──────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Roll the order-level outsource stream status (drives the printed-gate). */
async function setOrderOutsourceStatus(
  orderId: string,
  status: 'pending' | 'dispatched' | 'received' | 'failed',
): Promise<void> {
  await db.update(orders).set({ outsourceStatus: status }).where(eq(orders.id, orderId));
}

/** Send the package zip to the partner over email. Best-effort; returns result. */
async function emailPackage(
  partner: OutsourcePartner,
  email: string,
  pkg: OutsourcePackage,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY unset' };
  const fileList = pkg.spec.items.map((i) => `• ${i.sizeLabel} ×${i.quantity}`).join('<br>');
  const html = `
  <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f1b16;">
    <p>Hi ${partner.name},</p>
    <p>Please print the attached order. The ZIP contains print-ready files (sRGB, full size, crop baked in), a spec sheet (PDF), and a machine-readable spec (JSON).</p>
    <p style="font-family:monospace;">Reference: ${pkg.orderNumber}</p>
    <p>${fileList}</p>
    <p>Print as supplied — please don't crop or resize. Quote the reference on any query. Thank you!</p>
    <p style="color:#8a7b66;font-size:12px;">FusionPrints</p>
  </div>`;
  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from: 'FusionPrints <noreply@fusionprints.co.zw>',
      to: email,
      subject: `Print order ${pkg.orderNumber} — ${pkg.spec.itemCount} print(s)`,
      html,
      attachments: [{ filename: `${pkg.orderNumber}-print-package.zip`, content: pkg.zip }],
    });
    if (error) return { ok: false, error: typeof error === 'string' ? error : JSON.stringify(error) };
    return { ok: true, id: data?.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface DispatchOptions {
  /** Dispatch to this partner instead of the active default (manual override). */
  partnerId?: string;
  /** Bypass the already-dispatched guard (re-send / send-to-other). */
  force?: boolean;
}

/**
 * Core dispatch: build the package, resolve the partner + channel, send (with
 * retries), and record the outcome. Records a 'failed' row + alerts ops on any
 * hard failure. Never throws — the in-house portion of the order is unaffected.
 */
export async function dispatchOrder(orderId: string, opts: DispatchOptions = {}): Promise<OutsourceDispatch | null> {
  let orderNumber = orderId;
  try {
    const pkg = await buildOutsourcePackage(orderId);
    if (!pkg) return null; // no outsourced items
    orderNumber = pkg.orderNumber;

    // Idempotency: don't double-send unless explicitly forced.
    const existing = await db.select().from(outsourceDispatches).where(eq(outsourceDispatches.orderId, orderId));
    if (!opts.force && alreadyDispatched(existing)) {
      logger.info({ orderId, orderNumber }, 'Outsource dispatch skipped — already dispatched');
      return existing.find((d) => isLiveDispatch(d.status)) ?? null;
    }

    const partner = opts.partnerId ? await getPartnerById(opts.partnerId) : pkg.partner;
    const target = resolveDispatchTarget(partner);
    const lineItemIds = pkg.spec.items.map((i) => i.lineItemId);
    const wholesaleCost = partner ? computeWholesaleCost(pkg.spec.items, partner.wholesalePrices) : 0;

    if (!target.ok || !partner || !target.email) {
      const reason = target.reason ?? 'Unable to resolve a dispatch target';
      const [row] = await db
        .insert(outsourceDispatches)
        .values({
          orderId,
          partnerId: partner?.id ?? null,
          channel: target.channel,
          status: 'failed',
          lineItemIds,
          errorMessage: reason,
          attempts: 0,
        })
        .returning();
      await setOrderOutsourceStatus(orderId, 'failed');
      logger.warn({ orderId, orderNumber, reason }, 'Outsource dispatch could not be sent');
      void sendOutsourceDispatchFailedAlert(orderNumber, reason).catch(() => {});
      return row ?? null;
    }

    // Send with a small backoff; escalate to a 'failed' record + alert if it never lands.
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      const res = await emailPackage(partner, target.email, pkg);
      if (res.ok) {
        const [row] = await db
          .insert(outsourceDispatches)
          .values({
            orderId,
            partnerId: partner.id,
            channel: 'email',
            status: 'sent',
            lineItemIds,
            externalRef: res.id ?? null,
            wholesaleCostUsd: wholesaleCost.toFixed(2),
            attempts: attempt,
            sentAt: new Date(),
          })
          .returning();
        await setOrderOutsourceStatus(orderId, 'dispatched');
        logger.info({ orderId, orderNumber, partner: partner.shortCode, attempt }, 'Outsource package dispatched');
        return row ?? null;
      }
      lastError = res.error ?? 'send failed';
      if (attempt < MAX_SEND_ATTEMPTS) await delay(attempt * 2000);
    }

    const [row] = await db
      .insert(outsourceDispatches)
      .values({
        orderId,
        partnerId: partner.id,
        channel: 'email',
        status: 'failed',
        lineItemIds,
        wholesaleCostUsd: wholesaleCost.toFixed(2),
        errorMessage: lastError,
        attempts: MAX_SEND_ATTEMPTS,
      })
      .returning();
    await setOrderOutsourceStatus(orderId, 'failed');
    logger.error({ orderId, orderNumber, lastError }, 'Outsource dispatch failed after retries');
    void sendOutsourceDispatchFailedAlert(orderNumber, `Email to partner failed: ${lastError}`).catch(() => {});
    return row ?? null;
  } catch (err) {
    logger.error({ orderId, orderNumber, err }, 'dispatchOrder crashed (order unaffected)');
    return null;
  }
}

/**
 * Auto-dispatch entry point, called from markOrderPaid. Fire-and-forget safe
 * (never throws). Guards against re-dispatch are inside dispatchOrder.
 */
export async function autoDispatchOnPaid(orderId: string): Promise<void> {
  try {
    await dispatchOrder(orderId);
  } catch (err) {
    logger.error({ orderId, err }, 'autoDispatchOnPaid failed (order unaffected)');
  }
}

// ── Manual overrides (UI wired in Phase 5) ──────────────────────────────────────

/** Re-send to the same default partner (or wherever the default now points). */
export async function resendDispatch(orderId: string): Promise<OutsourceDispatch | null> {
  return dispatchOrder(orderId, { force: true });
}

/** Send to a specific partner (default unavailable / busy). */
export async function dispatchToPartner(orderId: string, partnerId: string): Promise<OutsourceDispatch | null> {
  return dispatchOrder(orderId, { force: true, partnerId });
}

/**
 * Record that ops handled the outsourced items outside the system. Settles the
 * order's outsource stream to 'received'. The caller runs the printed-gate
 * (checkAndAdvanceToPrinted) afterwards — kept out of here to avoid an import
 * cycle with order.ts.
 */
export async function markDispatchManuallyFulfilled(orderId: string): Promise<void> {
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return;
  await db.insert(outsourceDispatches).values({
    orderId,
    partnerId: null,
    channel: 'email',
    status: 'manually_fulfilled',
    lineItemIds: [],
    sentAt: new Date(),
  });
  await setOrderOutsourceStatus(orderId, 'received');
}

/**
 * Ops confirms the partner's prints are back/ready to consolidate — settles the
 * outsource stream to 'received'. Caller runs the printed-gate afterwards. Also
 * advances the latest 'sent' dispatch row to 'received_back' for the audit log.
 */
export async function markOutsourceReceived(orderId: string): Promise<void> {
  const [latest] = await db
    .select({ id: outsourceDispatches.id })
    .from(outsourceDispatches)
    .where(eq(outsourceDispatches.orderId, orderId))
    .orderBy(desc(outsourceDispatches.createdAt))
    .limit(1);
  if (latest) {
    await db
      .update(outsourceDispatches)
      .set({ status: 'received_back', updatedAt: new Date() })
      .where(eq(outsourceDispatches.id, latest.id));
  }
  await setOrderOutsourceStatus(orderId, 'received');
}

/** All dispatch rows for an order, newest first (for the admin order view). */
export async function getDispatchesForOrder(orderId: string): Promise<OutsourceDispatch[]> {
  return db
    .select()
    .from(outsourceDispatches)
    .where(eq(outsourceDispatches.orderId, orderId))
    .orderBy(desc(outsourceDispatches.createdAt));
}
