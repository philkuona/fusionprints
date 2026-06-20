/**
 * Payment service (bot channel).
 *
 * EcoCash mobile money via Payonify — the customer gets a USSD/PIN push on their
 * phone. We send the push here; the actual approval is confirmed asynchronously
 * via Payonify's signed `charge.succeeded` webhook (see routes/web/payonify-webhook.ts),
 * which reconciles by metadata.order_number and marks the order paid.
 *
 * In dev mode (PAYMENT_PROVIDER=stub) no external calls are made — we just log.
 */

import { logger } from '@/utils/logger.js';
import { env } from '@/config/env.js';
import { getOrderByNumber } from '@/services/order.js';
import { createEcocashCharge } from '@/services/payonify.js';

interface InitiateEcocashParams {
  orderNumber: string;
  ecocashNumber: string;
}

/**
 * Initiate an EcoCash USSD push payment.
 *
 * In stub mode this just logs and returns true. Otherwise it sends a Payonify
 * EcoCash charge. The actual payment confirmation comes via webhook callback,
 * not this function.
 *
 * Returns false if we couldn't even reach the provider (network, credentials).
 */
export async function initiateEcocashPayment(
  params: InitiateEcocashParams,
): Promise<boolean> {
  if (env.PAYMENT_PROVIDER === 'stub') {
    logger.info(
      { orderNumber: params.orderNumber, ecocashNumber: params.ecocashNumber },
      '[STUB] EcoCash payment initiated — bypassing real API call',
    );
    return true;
  }

  // Payonify EcoCash USSD push (same gateway as web checkout). The push is
  // confirmed later via the charge.succeeded webhook → markOrderPaid.
  if (env.PAYMENT_PROVIDER === 'payonify') {
    const order = await getOrderByNumber(params.orderNumber);
    if (!order) {
      logger.error({ orderNumber: params.orderNumber }, 'EcoCash charge: order not found');
      return false;
    }
    try {
      await createEcocashCharge({
        orderNumber: params.orderNumber,
        amountUsd: Number(order.totalUsd),
        ecocashNumber: params.ecocashNumber,
      });
      return true; // USSD push sent; webhook confirms approval
    } catch (err) {
      logger.error(
        { orderNumber: params.orderNumber, amountUsd: Number(order.totalUsd), err },
        'EcoCash charge failed',
      );
      return false;
    }
  }

  logger.warn({ orderNumber: params.orderNumber }, 'EcoCash provider not implemented');
  return false;
}
