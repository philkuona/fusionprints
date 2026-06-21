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
import { env } from '@/config/env.js';
import { findOrCreateCustomer, updateCustomerName, updateCustomerEmail, incrementEmailDecline, touchCustomerLastOrder } from '@/services/customer.js';
import { loadConversationState, saveConversationState } from '@/services/conversation-state.js';
import { getActiveCollectionPoints } from '@/services/collection-points.js';
import { createOrder, cancelOrder, getRecentOrders, getOrderByNumber } from '@/services/order.js';
import { requestOrderCancellation } from '@/services/refund.js';
import { initiateEcocashPayment } from '@/services/payment.js';
import { createUploadSession, getSessionImages, completeSession } from '@/routes/upload.js';
import { getProduct } from '@/config/catalog.js';
import { handleMessage } from '@/bot/state-machine.js';
import { MSG } from '@/bot/messages.js';
import type { BotReply, IncomingMessage } from '@/bot/state-machine.js';

export interface HandlerInput {
  /** Customer's WhatsApp number in E.164 format e.g. +263771234567 */
  phoneNumber: string;
  /** The message content */
  message: IncomingMessage;
}

export interface HandlerResult {
  /** Messages to send back to the customer, in order */
  replies: BotReply[];
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
    const loaded = await loadConversationState(customer.id);
    let currentStep = loaded.currentStep;
    const { context } = loaded;

    // Self-heal stale state: an order is only "in progress" for this chat while
    // it's awaiting payment. Once it's settled (paid via webhook/EcoCash, then
    // printed/fulfilled/cancelled), a lingering context.orderNumber would make
    // the reset-guard tell a returning customer they "have an order in progress"
    // (and trap them on a payment-wait step for a payment that already landed).
    // Clear it so a greeting starts a fresh order. Only queried when one is set.
    if (context.orderNumber) {
      const settled = await getOrderByNumber(context.orderNumber);
      if (settled && settled.status !== 'pending_payment') {
        logger.info(
          { orderNumber: context.orderNumber, status: settled.status },
          'Clearing settled order from conversation context',
        );
        delete context.orderNumber;
        const PAYMENT_WAIT_STEPS = [
          'choosing_payment_method',
          'entering_ecocash_number',
          'awaiting_ecocash_pin',
          'awaiting_payment',
        ];
        if (PAYMENT_WAIT_STEPS.includes(currentStep)) {
          currentStep = 'idle';
          context.cart = [];
        }
      }
    }

    logger.debug(
      { phoneNumber, currentStep, cartSize: context.cart?.length ?? 0 },
      'State loaded',
    );

    // ── Step 3: Run the state machine ─────────────────────────────────────
    // The state machine is pure, so inject the live collection points it needs
    // for the pickup steps (only fetched there to avoid a query per message).
    const collectionPoints =
      currentStep === 'choosing_fulfillment' ||
      currentStep === 'choosing_collection_point' ||
      currentStep === 'collecting_recipient'
        ? await getActiveCollectionPoints()
        : [];
    const response = handleMessage(
      currentStep,
      context,
      message,
      { name: customer.name, email: customer.email, emailDeclineCount: customer.emailDeclineCount },
      collectionPoints,
    );

    // ── Step 4: Handle side effects ───────────────────────────────────────
    const extraReplies: BotReply[] = [];

    for (const effect of response.effects) {
      switch (effect.type) {
        case 'CREATE_ORDER': {
          const orderResult = await createOrder({
            customerId: customer.id,
            context: response.nextContext,
          });

          if (!orderResult.ok) {
            logger.error({ reason: orderResult.reason }, 'Order creation failed');
            // Reasons are customer-safe (e.g. the order-minimum message), so show
            // them directly instead of a generic error.
            extraReplies.push(orderResult.reason || MSG.somethingWentWrong());
            break;
          }

          await touchCustomerLastOrder(customer.id);

          // Store order number in context for payment flow
          response.nextContext.orderNumber = orderResult.orderNumber;

          const total = effect.quote.ok ? String(effect.quote.quote.totalUsd) : '0.00';

          // Orders containing a 5×7 are operator-gated (media swap) so the whole
          // order is next-day — tell the customer before they pay (positive,
          // reason hidden). See services/order.ts applyFiveBySevenHandling.
          const has5x7 =
            effect.quote.ok && effect.quote.quote.items.some((i) => i.sizeCode === '5x7');

          // Tell the customer their order is created and ask how they want to pay
          // EcoCash only for now — card payments aren't built yet, so we don't
          // offer a button that leads to a dead link.
          extraReplies.push({
            text:
              MSG.choosePaymentMethod(orderResult.orderNumber, total) +
              (has5x7 ? `\n\n${MSG.fiveBySevenNextDay()}` : ''),
            buttons: [
              { id: 'PAY_ECOCASH', title: '📱 EcoCash' },
            ],
          });

          // Step is already set to choosing_payment_method by the state machine
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
                paid: 'paid, printing soon',
                awaiting_approval: 'under quality review',
                queued_for_print: 'in the print queue',
                printing: 'printing now',
                ready_for_collection: '✅ ready to collect!',
                shipped: '🚚 on its way to you',
                fulfilled: 'collected, complete',
                cancelled: 'cancelled',
                failed: 'failed, please contact us',
              };
              const label = statusLabel[o.status] ?? o.status;
              return MSG.orderStatus(o.orderNumber, label);
            });

            extraReplies.push(statusMessages.join('\n\n'));
            extraReplies.push(MSG.cancelHint());
          }
          break;
        }

        case 'REQUEST_CANCELLATION': {
          const ord = await getOrderByNumber(effect.orderNumber);
          // Must exist and belong to this customer.
          if (!ord || ord.customerId !== customer.id) {
            extraReplies.push(MSG.cancelOrderNotFound(effect.orderNumber));
            break;
          }
          if (ord.status === 'pending_payment') {
            // Unpaid — cancel outright (also voids any QBO invoice).
            await cancelOrder(ord.orderNumber);
            extraReplies.push(MSG.cancelOrderDone(ord.orderNumber));
          } else if (ord.paidAt) {
            // Paid — file a request for admin review (approve → Payonify refund).
            const res = await requestOrderCancellation({ orderId: ord.id });
            extraReplies.push(
              res.ok ? MSG.cancelOrderRequested(ord.orderNumber) : MSG.cancelOrderTooLate(ord.orderNumber),
            );
          } else {
            extraReplies.push(MSG.cancelOrderTooLate(ord.orderNumber));
          }
          break;
        }

        case 'INITIATE_PAYMENT': {
          // Legacy: retry generic payment link (kept for backwards compat)
          const paymentUrl = `https://pay.fusionprints.co.zw/p/${generatePaymentRef()}`;
          extraReplies.push(
            `New payment link for order *${effect.orderNumber}*:\n🔗 ${paymentUrl}\n\n_Link expires in 60 minutes._`,
          );
          break;
        }

        case 'INITIATE_ECOCASH_PAYMENT': {
          // Send the EcoCash USSD push via Payonify (stubbed in dev). The
          // customer's PIN approval is confirmed asynchronously via the signed
          // Payonify webhook, which calls markOrderPaid.
          const success = await initiateEcocashPayment({
            orderNumber: effect.orderNumber,
            ecocashNumber: effect.ecocashNumber,
          });

          if (!success) {
            extraReplies.push(
              `⚠️ Couldn't reach EcoCash right now. Reply *1* to try again or *2* to cancel.`,
            );
          }
          // On success, the bot already showed "waiting" message; nothing to add
          break;
        }

        case 'create_upload_link': {
          // Create a web upload session for this customer
          const { token } = await createUploadSession(customer.id, effect.sizeCode);
          const uploadUrl = `${env.PUBLIC_URL}/u/${token}`;

          // Store token in context so we can retrieve images later
          (response.nextContext as { _uploadToken?: string })._uploadToken = token;

          // Get product price for the message
          const product = getProduct(effect.sizeCode);
          const priceLabel = product ? `$${product.unitPriceUsd.toFixed(2)}` : '';

          extraReplies.push(MSG.awaitingWebUpload(effect.displayLabel, priceLabel, uploadUrl));
          break;
        }

        case 'resolve_web_upload': {
          // Pull all uploaded images from the session into the cart
          const token = (response.nextContext as { _uploadToken?: string })._uploadToken;
          if (!token) {
            extraReplies.push(MSG.somethingWentWrong());
            break;
          }

          const sessionData = await getSessionImages(token);

          if (!sessionData || sessionData.imageIds.length === 0) {
            extraReplies.push(MSG.webUploadEmpty());
            break;
          }

          const product = getProduct(sessionData.sizeCode);
          if (!product) {
            extraReplies.push(MSG.somethingWentWrong());
            break;
          }

          // One photo → ask how many copies (route into the existing quantity
          // step). Many photos → one print each (a batch), as before.
          if (sessionData.imageIds.length === 1) {
            response.nextContext.pendingSize = product.sizeCode;
            (response.nextContext as { _pendingImageRef?: string })._pendingImageRef = sessionData.imageIds[0];
            response.nextContext.uploadMode = undefined;
            (response.nextContext as { _uploadToken?: string })._uploadToken = undefined;
            await completeSession(token);
            extraReplies.push(MSG.imageOkNoCheck());
            response.nextStep = 'choosing_quantity';
            break;
          }

          // Add each uploaded image as a separate cart item
          const newCart = [...response.nextContext.cart];
          for (const imageId of sessionData.imageIds) {
            newCart.push({
              sizeCode: product.sizeCode,
              displayLabel: product.displayLabel,
              quantity: 1,
              unitPriceUsd: product.unitPriceUsd,
              lineTotalUsd: product.unitPriceUsd,
              requiresManualReview: product.requiresManualReview,
              imageRef: imageId,
            });
          }

          response.nextContext.cart = newCart;
          response.nextContext.pendingProductType = undefined;
          response.nextContext.pendingSize = undefined;
          response.nextContext.uploadMode = undefined;
          (response.nextContext as { _uploadToken?: string })._uploadToken = undefined;

          await completeSession(token);

          const lineTotal = product.unitPriceUsd * sessionData.imageIds.length;
          const cartTotal = newCart.reduce((sum, item) => sum + item.lineTotalUsd, 0);

          extraReplies.push(
            MSG.webUploadComplete(
              sessionData.imageIds.length,
              product.displayLabel,
              `$${lineTotal.toFixed(2)}`,
              `$${cartTotal.toFixed(2)}`,
            ),
          );

          response.nextStep = 'adding_more_or_checkout';
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

    // ── Step 5b: Handle email collection side effect ───────────────────────
    // When the bot transitions out of collecting_email, save the email to DB.
    if (
      currentStep === 'collecting_email' &&
      response.nextStep !== 'collecting_email' &&
      !customer.email
    ) {
      const email = (response.nextContext as { _customerEmail?: string })._customerEmail;
      if (email) {
        await updateCustomerEmail(customer.id, email);
        logger.info({ customerId: customer.id }, 'Customer email saved');
      }
    }

    // Record an email decline so we stop asking after 3 (R2-6 #20).
    if ((response.nextContext as { _emailDeclined?: boolean })._emailDeclined) {
      await incrementEmailDecline(customer.id);
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
