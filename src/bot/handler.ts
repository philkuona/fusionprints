/**
 * Bot handler.
 *
 * This is the central orchestrator. It:
 *   1. Receives an incoming message (phone number + text/image)
 *   2. Loads the customer and their conversation state from the database
 *   3. Runs the message through the state machine
 *   4. Saves the new state back to the database
 *   5. Handles any side effects (create order, initiate payment, etc.)
 *   6. Returns the replies to send back to the customer
 *
 * The WhatsApp integration calls this function for every incoming message.
 * The CLI simulator calls this function in simulate-bot-db.ts.
 *
 * This is deliberately the ONLY place that touches both the bot logic
 * and the database — it's the seam between them.
 */

import { logger } from '@/utils/logger.js';
import { findOrCreateCustomer, updateCustomerName, touchCustomerLastOrder } from '@/services/customer.js';
import { loadConversationState, saveConversationState } from '@/services/conversation-state.js';
import { createOrder, cancelOrder, getRecentOrders } from '@/services/order.js';
import { handleMessage } from '@/bot/state-machine.js';
import { MSG } from '@/bot/messages.js';
import type { IncomingMessage } from '@/bot/state-machine.js';

export interface HandlerInput {
  /** Customer's WhatsApp number in E.164 format e.g. +263771234567 */
  phoneNumber: string;
  /** The message content */
  message: IncomingMessage;
}

export interface HandlerResult {
  /** Messages to send back to the customer, in order */
  replies: string[];
}

/**
 * Process one incoming WhatsApp message end to end.
 */
export async function handleIncomingMessage(input: HandlerInput): Promise<HandlerResult> {
  const { phoneNumber, message } = input;

  logger.info({ phoneNumber, text: message.text }, 'Incoming message');

  try {
    // ── Step 1: Load customer ──────────────────────────────────────────────
    const customer = await findOrCreateCustomer(phoneNumber);

    // ── Step 2: Load conversation state ───────────────────────────────────
    const { currentStep, context } = await loadConversationState(customer.id);

    logger.debug(
      { phoneNumber, currentStep, cartSize: context.cart?.length ?? 0 },
      'State loaded',
    );

    // ── Step 3: Run the state machine ─────────────────────────────────────
    const response = handleMessage(
      currentStep,
      context,
      message,
      customer.name ? { name: customer.name } : null,
    );

    // ── Step 4: Handle side effects ───────────────────────────────────────
    const extraReplies: string[] = [];

    for (const effect of response.effects) {
      switch (effect.type) {
        case 'CREATE_ORDER': {
          const orderResult = await createOrder({
            customerId: customer.id,
            context: response.nextContext,
          });

          if (!orderResult.ok) {
            logger.error({ reason: orderResult.reason }, 'Order creation failed');
            extraReplies.push(MSG.somethingWentWrong());
            break;
          }

          await touchCustomerLastOrder(customer.id);

          // Store order number in context for payment retry etc.
          response.nextContext.orderNumber = orderResult.orderNumber;

          // Generate a payment link (placeholder until payment integration is built)
          const paymentUrl = `https://pay.fusionprints.co.zw/p/${generatePaymentRef()}`;
          const total = effect.quote.ok
  ? Number(effect.quote.quote.totalUsd).toFixed(2)
  : '0.00';

          extraReplies.push(
            MSG.paymentLinkSent(orderResult.orderNumber, paymentUrl, total),
          );

          // Update the step to awaiting_payment
          response.nextStep = 'awaiting_payment';
          break;
        }

        case 'CANCEL_ORDER': {
          if (effect.orderNumber) {
            await cancelOrder(effect.orderNumber);
          }
          break;
        }

        case 'LOOKUP_ORDER_STATUS': {
          const recentOrders = await getRecentOrders(customer.id);

          if (recentOrders.length === 0) {
            extraReplies.push(MSG.noRecentOrders());
          } else {
            const statusMessages = recentOrders.map((o) => {
              const statusLabel: Record<string, string> = {
                pending_payment: 'awaiting payment',
                paid: 'paid — printing soon',
                awaiting_approval: 'under quality review',
                queued_for_print: 'in the print queue',
                printing: 'printing now',
                ready_for_collection: '✅ ready to collect!',
                fulfilled: 'collected — complete',
                cancelled: 'cancelled',
                failed: 'failed — please contact us',
              };
              const label = statusLabel[o.status] ?? o.status;
              return MSG.orderStatus(o.orderNumber, label);
            });

            extraReplies.push(statusMessages.join('\n\n'));
          }
          break;
        }

        case 'INITIATE_PAYMENT': {
          // Retry payment link
          const paymentUrl = `https://pay.fusionprints.co.zw/p/${generatePaymentRef()}`;
          extraReplies.push(
            `New payment link for order *${effect.orderNumber}*:\n🔗 ${paymentUrl}\n\n_Link expires in 60 minutes._`,
          );
          break;
        }
      }
    }

    // ── Step 5: Handle name collection side effect ─────────────────────────
    // When the bot transitions from collecting_name, save the name to DB
    if (
      currentStep === 'collecting_name' &&
      response.nextStep !== 'collecting_name' &&
      !customer.name
    ) {
      // Extract name from context (the state machine stores it as _customerName)
      const name = (response.nextContext as { _customerName?: string })._customerName;
      if (name) {
        await updateCustomerName(customer.id, name);
        logger.info({ customerId: customer.id, name }, 'Customer name saved');
      }
    }

    // ── Step 6: Save new conversation state ───────────────────────────────
    await saveConversationState(customer.id, response.nextStep, response.nextContext);

    logger.info(
      { phoneNumber, nextStep: response.nextStep },
      'Message processed successfully',
    );

    // ── Step 7: Return all replies ────────────────────────────────────────
    return {
      replies: [...response.replies, ...extraReplies],
    };
  } catch (err) {
    logger.error({ err, phoneNumber }, 'Unhandled error in bot handler');
    return {
      replies: [MSG.somethingWentWrong()],
    };
  }
}

/**
 * Generate a short random payment reference for the URL.
 * In production this comes from Paynow/Stanbic when creating a payment.
 */
function generatePaymentRef(): string {
  return Math.random().toString(36).slice(2, 8);
}
