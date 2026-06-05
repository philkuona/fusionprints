/**
 * Web payment provider seam.
 *
 * Until a real Zimbabwean gateway is wired up (EcoCash via Magetsi/Paynow, card
 * via Paynow/Flutterwave — see env PAYMENT_PROVIDER), the web checkout runs
 * against a SERVICE-VIRTUALISED provider: initiate returns a synthetic
 * reference + 'pending', and the customer confirms via a mock step that mimics
 * the async gateway callback (EcoCash PIN / card 3DS). A real provider only has
 * to replace initiateWebPayment() + swap the confirm step for a real webhook —
 * order creation, payment records, and fulfilment stay unchanged.
 */
import { env } from '@/config/env.js';

export interface WebPaymentInitiation {
  /** Provider transaction reference, stored on the payment row. */
  reference: string;
  status: 'pending';
  /** The provider enum value to record this payment under. */
  provider: 'virtual';
}

export async function initiateWebPayment(params: {
  orderNumber: string;
  amountUsd: number;
}): Promise<WebPaymentInitiation> {
  // PAYMENT_PROVIDER is 'stub' until real credentials exist; either way the web
  // flow is virtualised for now. Synthetic, deterministic reference per order.
  void env.PAYMENT_PROVIDER;
  return {
    reference: `VIRT-${params.orderNumber}`,
    status: 'pending',
    provider: 'virtual',
  };
}
