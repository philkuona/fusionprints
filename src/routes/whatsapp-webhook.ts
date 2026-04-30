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

/**
 * Send a WhatsApp message via 360dialog API.
 * Called after the bot handler returns replies.
 */
async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const url = `${env.WHATSAPP_API_BASE}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text },
  };

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
      { to, status: response.status, error },
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

type WhatsAppMessage =
  | WhatsAppTextMessage
  | WhatsAppImageMessage
  | WhatsAppDocumentMessage
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
   */
  app.post(
    '/webhook/whatsapp',
    async (request: FastifyRequest, reply: FastifyReply) => {
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
              // Build the IncomingMessage for the bot handler
              let botMessage: IncomingMessage;

              if (waMessage.type === 'text') {
                const textMsg = waMessage as WhatsAppTextMessage & { from: string };
                botMessage = { text: textMsg.text.body };

              } else if (waMessage.type === 'document') {
                // Document = sent as file = NOT compressed = good quality
                const docMsg = waMessage as WhatsAppDocumentMessage & { from: string };
                const mediaData = await downloadAndStoreMedia(
                  docMsg.document.id,
                  '', // customerId resolved inside handler — placeholder for now
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
                  '', // customerId resolved inside handler
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
              for (const reply_text of result.replies) {
                if (reply_text) {
                  await sendWhatsAppMessage(phoneNumber, reply_text);
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
