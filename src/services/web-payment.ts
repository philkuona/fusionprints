/**
 * Web payment provider seam.
 *
 * The live gateway is Payonify (EcoCash / OneMoney / ZimSwitch / card), selected
 * by PAYMENT_PROVIDER=payonify. In dev (PAYMENT_PROVIDER=stub) the web checkout
 * runs against a SERVICE-VIRTUALISED provider: initiate returns a synthetic
 * reference + 'pending', and the customer confirms via a mock step that mimics
 * the async gateway callback (EcoCash PIN / card 3DS). Either way, order
 * creation, payment records, and fulfilment stay unchanged.
 */
import { env } from '@/config/env.js';
import { createCheckoutSession } from '@/services/payonify.js';

export interface WebPaymentInitiation {
  /** Provider transaction reference, stored on the payment row. */
  reference: string;
  status: 'pending';
  /** The provider enum value to record this payment under. */
  provider: 'virtual' | 'payonify';
  /** Embedded-checkout client secret the browser mounts the Drop-In with. */
  clientSecret?: string;
}

export async function initiateWebPayment(params: {
  orderNumber: string;
  amountUsd: number;
  customerEmail?: string | null;
}): Promise<WebPaymentInitiation> {
  // Real gateway: Payonify embedded checkout. Returns a client_secret the
  // browser uses to mount the Drop-In; the signed webhook confirms the order.
  if (env.PAYMENT_PROVIDER === 'payonify') {
    const session = await createCheckoutSession({
      orderNumber: params.orderNumber,
      amountUsd: params.amountUsd,
      customerEmail: params.customerEmail,
    });
    return {
      reference: session.id,
      status: 'pending',
      provider: 'payonify',
      clientSecret: session.clientSecret,
    };
  }

  // Fallback: service-virtualised provider (mock confirm step). Synthetic,
  // deterministic reference per order.
  return {
    reference: `VIRT-${params.orderNumber}`,
    status: 'pending',
    provider: 'virtual',
  };
}
