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
            extraReplies.push(MSG.somethingWentWrong());
            break;
          }

          await touchCustomerLastOrder(customer.id);

          // Store order number in context for payment flow
          response.nextContext.orderNumber = orderResult.orderNumber;

          const total = effect.quote.ok ? String(effect.quote.quote.totalUsd) : '0.00';

          // Tell the customer their order is created and ask how they want to pay
          extraReplies.push({
            text: MSG.choosePaymentMethod(orderResult.orderNumber, total),
            buttons: [
              { id: 'PAY_ECOCASH', title: '📱 EcoCash' },
              { id: 'PAY_CARD', title: '💳 Card' },
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
                paid: 'paid — printing soon',
                awaiting_approval: 'under quality review',
                queued_for_print: 'in the print queue',
                printing: 'printing now',
                ready_for_collection: '✅ ready to collect!',
                shipped: '🚚 on its way to you',
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
          // Legacy: retry generic payment link (kept for backwards compat)
          const paymentUrl = `https://pay.fusionprints.co.zw/p/${generatePaymentRef()}`;
          extraReplies.push(
            `New payment link for order *${effect.orderNumber}*:\n🔗 ${paymentUrl}\n\n_Link expires in 60 minutes._`,
          );
          break;
        }

        case 'INITIATE_CARD_PAYMENT': {
          // Get the order total for the message
          const { getOrderByNumber } = await import('@/services/order.js');
          const order = await getOrderByNumber(effect.orderNumber);
          const total = order ? String(order.totalUsd) : '0.00';

          // Generate a card payment link.
          // TODO: replace with real Stripe Checkout session creation
          const paymentUrl = `https://pay.fusionprints.co.zw/p/${generatePaymentRef()}`;

          extraReplies.push(
            MSG.cardPaymentLink(effect.orderNumber, paymentUrl, total),
          );
          break;
        }

        case 'INITIATE_ECOCASH_PAYMENT': {
          // Initiate the EcoCash USSD push via the payment provider (Magetsi).
          // For now this is a stub — once Magetsi API details are available we
          // POST to their endpoint here. The customer's PIN entry is confirmed
          // via the /webhook/payment/ecocash callback, which calls markOrderPaid.
          const { initiateEcocashPayment } = await import('@/services/payment.js');
          const success = await initiateEcocashPayment({
            orderNumber: effect.orderNumber,
            ecocashNumber: effect.ecocashNumber,
          });

          if (!success) {
            extraReplies.push(
              `⚠️ Couldn't reach EcoCash right now. Reply *1* to try again, *2* to switch to card, or *3* to cancel.`,
            );
          }
          // On success, the bot already showed "waiting" message; nothing to add
          break;
        }

        case 'create_upload_link': {
          // Create a web upload session for this customer
          const { createUploadSession } = await import('@/routes/upload.js');
          const { env } = await import('@/config/env.js');
          const { token } = await createUploadSession(customer.id, effect.sizeCode);
          const uploadUrl = `${env.PUBLIC_URL}/u/${token}`;

          // Store token in context so we can retrieve images later
          (response.nextContext as { _uploadToken?: string })._uploadToken = token;

          // Get product price for the message
          const { getProduct } = await import('@/config/catalog.js');
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

          const { getSessionImages, completeSession } = await import('@/routes/upload.js');
          const sessionData = await getSessionImages(token);

          if (!sessionData || sessionData.imageIds.length === 0) {
            extraReplies.push(MSG.webUploadEmpty());
            break;
          }

          const { getProduct } = await import('@/config/catalog.js');
          const product = getProduct(sessionData.sizeCode);
          if (!product) {
            extraReplies.push(MSG.somethingWentWrong());
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
