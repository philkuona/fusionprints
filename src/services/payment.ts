/**
 * Payment service.
 *
 * Two payment methods are supported:
 *
 *   1. EcoCash (via Magetsi) — for Zim mobile money customers.
 *      - We POST to Magetsi's API with the order amount and customer's number
 *      - Customer gets a USSD prompt on their phone for PIN entry
 *      - Magetsi calls back to /webhook/payment/ecocash when PIN is confirmed
 *      - On callback we mark the order paid and release print jobs to queue
 *
 *   2. Card (via Stripe) — for international customers, diaspora orders, etc.
 *      - We create a Stripe Checkout session with the order amount
 *      - Customer is sent a hosted payment URL
 *      - Stripe webhook calls /webhook/payment/stripe on completion
 *
 * Both providers are placeholder-stubbed for now. When Magetsi API spec arrives
 * we wire that up. Stripe stays a future task.
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
 * In production this will POST to Magetsi's API. For now it just logs and
 * returns true. The actual payment confirmation comes via webhook callback,
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

interface CreateCardCheckoutParams {
  orderNumber: string;
  totalUsd: number;
  customerEmail?: string;
}

/**
 * Create a card payment session (Stripe Checkout).
 * Returns a payment URL the customer can tap to complete payment.
 *
 * For now returns a placeholder URL.
 */
export async function createCardCheckoutUrl(
  params: CreateCardCheckoutParams,
): Promise<string> {
  if (env.PAYMENT_PROVIDER === 'stub') {
    logger.info({ orderNumber: params.orderNumber }, '[STUB] Card checkout requested');
    return `https://pay.fusionprints.co.zw/stub/${params.orderNumber}`;
  }

  // TODO: Stripe Checkout integration
  // const session = await stripe.checkout.sessions.create({
  //   mode: 'payment',
  //   line_items: [{
  //     price_data: {
  //       currency: 'usd',
  //       product_data: { name: `FusionPrints Order ${params.orderNumber}` },
  //       unit_amount: Math.round(params.totalUsd * 100),
  //     },
  //     quantity: 1,
  //   }],
  //   success_url: `${env.PUBLIC_URL}/payment/success?order=${params.orderNumber}`,
  //   cancel_url: `${env.PUBLIC_URL}/payment/cancel?order=${params.orderNumber}`,
  //   client_reference_id: params.orderNumber,
  // });
  // return session.url ?? '';

  return `https://pay.fusionprints.co.zw/p/${params.orderNumber}`;
}
