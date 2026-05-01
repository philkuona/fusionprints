/**
 * WhatsApp Webhook Handler
 *
 * This is the HTTP endpoint that 360dialog calls when:
 *   1. A customer sends a message to your WhatsApp number
 *   2. A message status update occurs (delivered, read, failed)
 *
 * Two routes:
 *   GET  /webhook/whatsapp  — webhook verification (360dialog checks this on setup)
 *   POST /webhook/whatsapp  — incoming messages and status updates
 *
 * Flow:
 *   360dialog receives message from customer
 *   → POST to your webhook URL
 *   → this handler parses it
 *   → calls handleIncomingMessage()
 *   → sends replies back via 360dialog API
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';
import { handleIncomingMessage } from '@/bot/handler.js';
import { storeImage } from '@/services/image-storage.js';
import type { IncomingMessage } from '@/bot/state-machine.js';

// ===== 360dialog API sender =====

import type { BotReply } from '@/bot/state-machine.js';

/**
 * Send a WhatsApp message via 360dialog API.
 * Supports plain text, button messages, and list messages.
 */
async function sendWhatsAppMessage(to: string, message: BotReply): Promise<void> {
  const url = `${env.WHATSAPP_API_BASE}/messages`;

  let body: Record<string, unknown>;

  if (typeof message === 'string') {
    // Plain text message
    body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: message },
    };
  } else if ('buttons' in message) {
    // Reply buttons (max 3 — WhatsApp limit)
    const buttons = message.buttons.slice(0, 3).map((b) => ({
      type: 'reply',
      reply: {
        id: b.id,
        // WhatsApp limits button title to 20 chars
        title: b.title.length > 20 ? b.title.slice(0, 20) : b.title,
      },
    }));

    body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: message.text },
        action: { buttons },
      },
    };
  } else if ('list' in message) {
    // List message (max 10 rows total across all sections)
    body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: message.text },
        action: {
          button: message.list.buttonText.slice(0, 20),
          sections: message.list.sections.map((s) => ({
            title: s.title?.slice(0, 24),
            rows: s.rows.slice(0, 10).map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              description: r.description?.slice(0, 72),
            })),
          })),
        },
      },
    };
  } else {
    logger.error({ message }, 'Unknown reply type');
    return;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'D360-API-KEY': env.WHATSAPP_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    logger.error(
      { to, status: response.status, error, messageType: typeof message === 'string' ? 'text' : 'interactive' },
      'Failed to send WhatsApp message',
    );
    throw new Error(`WhatsApp send failed: ${response.status} ${error}`);
  }

  logger.debug({ to }, 'WhatsApp message sent');
}

// ===== Webhook payload types =====

interface WhatsAppTextMessage {
  type: 'text';
  text: { body: string };
}

interface WhatsAppImageMessage {
  type: 'image';
  image: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
}

interface WhatsAppDocumentMessage {
  type: 'document';
  document: {
    id: string;
    mime_type: string;
    sha256: string;
    filename?: string;
  };
}

interface WhatsAppInteractiveMessage {
  type: 'interactive';
  interactive:
    | {
        type: 'button_reply';
        button_reply: { id: string; title: string };
      }
    | {
        type: 'list_reply';
        list_reply: { id: string; title: string; description?: string };
      };
}

type WhatsAppMessage =
  | WhatsAppTextMessage
  | WhatsAppImageMessage
  | WhatsAppDocumentMessage
  | WhatsAppInteractiveMessage
  | { type: string };

interface WhatsAppContact {
  profile: { name: string };
  wa_id: string;
}

interface WhatsAppValue {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: WhatsAppContact[];
  messages?: Array<
    WhatsAppMessage & {
      from: string;
      id: string;
      timestamp: string;
    }
  >;
  statuses?: Array<{
    id: string;
    status: string;
    timestamp: string;
    recipient_id: string;
  }>;
}

interface WebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: WhatsAppValue;
      field: string;
    }>;
  }>;
}

// ===== Image download helper =====

/**
 * Download a media file from WhatsApp and return basic metadata.
 * In Phase 1 we get dimensions from the file itself using sharp.
 * For now we return placeholder dimensions — this gets replaced
 * when Backblaze B2 storage is wired up.
 *
 * WhatsApp media download flow:
 *   1. Get media URL from WhatsApp using the media ID
 *   2. Download the file
 *   3. Upload to B2 storage
 *   4. Return the B2 URL and image dimensions
 */
async function downloadAndStoreMedia(
  mediaId: string,
  customerId: string,
  isDocument: boolean,
): Promise<{
  ref: string;
  widthPx: number;
  heightPx: number;
  wasCompressed: boolean;
  mimeType: string;
} | null> {
  try {
    // Step 1: Get the media URL from 360dialog
    const mediaInfoResponse = await fetch(
      `${env.WHATSAPP_API_BASE}/${mediaId}`,
      { headers: { 'D360-API-KEY': env.WHATSAPP_API_KEY } },
    );

    if (!mediaInfoResponse.ok) {
      logger.error({ mediaId, status: mediaInfoResponse.status }, 'Failed to get media info');
      return null;
    }

    const mediaInfo = await mediaInfoResponse.json() as {
      url: string;
      mime_type: string;
      file_size: number;
    };

    // Step 2: Replace Facebook CDN hostname with 360dialog proxy
    const downloadUrl = mediaInfo.url.replace(
      'https://lookaside.fbsbx.com',
      'https://waba-v2.360dialog.io',
    );

    // Step 3: Download the file
    const fileResponse = await fetch(downloadUrl, {
      headers: { 'D360-API-KEY': env.WHATSAPP_API_KEY },
    });

    if (!fileResponse.ok) {
      logger.error({ mediaId, status: fileResponse.status }, 'Failed to download media');
      return null;
    }

    const buffer = Buffer.from(await fileResponse.arrayBuffer());

    // Documents sent as files are NOT compressed; images sent as photos ARE compressed
    const wasCompressed = !isDocument;

    // Step 4: Store in Backblaze B2 and get real dimensions
    const stored = await storeImage(
      buffer,
      customerId,
      mediaInfo.mime_type,
      wasCompressed,
    );

    if (!stored) {
      return null;
    }

    return {
      ref: stored.imageId, // real database UUID now
      widthPx: stored.widthPx,
      heightPx: stored.heightPx,
      wasCompressed: stored.wasCompressed,
      mimeType: mediaInfo.mime_type,
    };

  } catch (err) {
    logger.error({ err, mediaId }, 'Error downloading/storing WhatsApp media');
    return null;
  }
}

// ===== Route registration =====

export async function registerWhatsAppWebhook(app: FastifyInstance): Promise<void> {
  /**
   * GET /webhook/whatsapp
   *
   * Webhook verification — 360dialog/Meta calls this when you first
   * configure the webhook URL. Must respond with the challenge string.
   */
  app.get(
    '/webhook/whatsapp',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, string>;

      const mode = query['hub.mode'];
      const token = query['hub.verify_token'];
      const challenge = query['hub.challenge'];

      logger.info({ mode, token }, 'Webhook verification request');

      if (mode === 'subscribe' && token === env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
        logger.info('Webhook verified successfully');
        reply.status(200).send(challenge);
        return;
      }

      logger.warn({ mode, token }, 'Webhook verification failed — token mismatch');
      reply.status(403).send('Forbidden');
    },
  );

  /**
   * POST /webhook/whatsapp
   *
   * Incoming messages from customers (and status updates).
   * Must respond with 200 quickly — processing happens async.
   *
   * Authentication: 360dialog sends webhooks with HTTP Basic auth credentials
   * configured in their Hub. We require these to match what's set in the env.
   * If WHATSAPP_WEBHOOK_USER/PASS are unset, auth is skipped (dev mode).
   */
  app.post(
    '/webhook/whatsapp',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Verify Basic auth if credentials are configured
      if (env.WHATSAPP_WEBHOOK_USER && env.WHATSAPP_WEBHOOK_PASS) {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Basic ')) {
          logger.warn({ ip: request.ip }, 'Webhook rejected — missing Basic auth');
          reply.status(401).send({ error: 'Unauthorized' });
          return;
        }
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
        const [user, pass] = decoded.split(':');
        if (user !== env.WHATSAPP_WEBHOOK_USER || pass !== env.WHATSAPP_WEBHOOK_PASS) {
          logger.warn({ ip: request.ip, user }, 'Webhook rejected — invalid Basic auth');
          reply.status(401).send({ error: 'Unauthorized' });
          return;
        }
      }

      // Always respond 200 immediately — 360dialog will retry if we don't
      reply.status(200).send({ status: 'ok' });

      const payload = request.body as WebhookPayload;

      // Validate it's a WhatsApp webhook
      if (payload.object !== 'whatsapp_business_account') {
        return;
      }

      // Process each entry (usually just one)
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field !== 'messages') continue;

          const value = change.value;

          // Process status updates (delivered, read, failed)
          for (const status of value.statuses ?? []) {
            logger.info(
              { messageId: status.id, status: status.status },
              'Message status update',
            );
            // TODO: update payment status if message was a payment confirmation
          }

          // Process incoming messages
          for (const waMessage of value.messages ?? []) {
            const phoneNumber = `+${waMessage.from}`;

            logger.info(
              { phoneNumber, type: waMessage.type },
              'Processing incoming message',
            );

            try {
              // Resolve customer ID from phone number before processing media
              const { findOrCreateCustomer } = await import('@/services/customer.js');
              const customer = await findOrCreateCustomer(phoneNumber);
              const customerId = customer.id;

              // Build the IncomingMessage for the bot handler
              let botMessage: IncomingMessage;

              if (waMessage.type === 'text') {
                const textMsg = waMessage as WhatsAppTextMessage & { from: string };
                botMessage = { text: textMsg.text.body };

              } else if (waMessage.type === 'interactive') {
                // Customer tapped a button or selected a list item.
                // Convert the selection to the same text they would have typed,
                // so the existing state machine logic works unchanged.
                const intMsg = waMessage as WhatsAppInteractiveMessage & { from: string };
                let selectedId = '';
                if (intMsg.interactive.type === 'button_reply') {
                  selectedId = intMsg.interactive.button_reply.id;
                } else if (intMsg.interactive.type === 'list_reply') {
                  selectedId = intMsg.interactive.list_reply.id;
                }

                logger.info(
                  { phoneNumber, selectedId },
                  'Customer tapped interactive option',
                );
                botMessage = { text: selectedId };

              } else if (waMessage.type === 'document') {
                // Document = sent as file = NOT compressed = good quality
                const docMsg = waMessage as WhatsAppDocumentMessage & { from: string };
                const mediaData = await downloadAndStoreMedia(
                  docMsg.document.id,
                  customerId,
                  true, // isDocument = true, not compressed
                );

                if (!mediaData) {
                  await sendWhatsAppMessage(
                    phoneNumber,
                    'Sorry, I had trouble receiving that file. Please try sending it again.',
                  );
                  continue;
                }

                botMessage = {
                  text: '',
                  image: {
                    widthPx: mediaData.widthPx,
                    heightPx: mediaData.heightPx,
                    wasCompressed: false,
                    ref: mediaData.ref,
                  },
                };

              } else if (waMessage.type === 'image') {
                // Image = sent as photo = compressed by WhatsApp
                const imgMsg = waMessage as WhatsAppImageMessage & { from: string };
                const mediaData = await downloadAndStoreMedia(
                  imgMsg.image.id,
                  customerId,
                  false, // isDocument = false, compressed
                );

                if (!mediaData) {
                  await sendWhatsAppMessage(
                    phoneNumber,
                    'Sorry, I had trouble receiving that photo. Please try sending it again.',
                  );
                  continue;
                }

                botMessage = {
                  text: '',
                  image: {
                    widthPx: mediaData.widthPx,
                    heightPx: mediaData.heightPx,
                    wasCompressed: true,
                    ref: mediaData.ref,
                  },
                };

              } else {
                // Unsupported message type (video, audio, sticker, etc.)
                botMessage = { text: '' };
                await sendWhatsAppMessage(
                  phoneNumber,
                  `Sorry, I can only process text messages and photos. Type *1* to order photo prints or *2* for posters.`,
                );
                continue;
              }

              // Run through the bot handler
              const result = await handleIncomingMessage({
                phoneNumber,
                message: botMessage,
              });

              // Send all replies back to the customer
              for (const reply of result.replies) {
                // Skip empty strings, but always send objects (interactive)
                const isEmpty = typeof reply === 'string' && reply.length === 0;
                if (!isEmpty) {
                  await sendWhatsAppMessage(phoneNumber, reply);
                  // Small delay between messages to preserve order
                  await new Promise((resolve) => setTimeout(resolve, 300));
                }
              }

            } catch (err) {
              logger.error({ err, phoneNumber }, 'Error processing message');
              try {
                await sendWhatsAppMessage(
                  phoneNumber,
                  'Something went wrong on my end. Please try again or type HELP.',
                );
              } catch {
                // If we can't even send the error message, just log it
                logger.error({ phoneNumber }, 'Failed to send error message to customer');
              }
            }
          }
        }
      }
    },
  );
}
