/**
 * WhatsApp messaging service.
 *
 * Wraps the 360dialog API for sending text and interactive messages.
 * This is exported so other parts of the system (payment webhooks,
 * order notifications) can send messages without going through the bot
 * conversation handler.
 */

import { env } from '@/config/env.js';
import { logger } from '@/utils/logger.js';

/**
 * A reply the bot wants to send. Can be plain text, an interactive
 * button message, or an interactive list.
 *
 * NOTE: This type is also defined locally in whatsapp-webhook.ts —
 * keep them in sync. (Future cleanup: move BotReply here.)
 */
export type BotReply =
  | string
  | {
      text: string;
      buttons: Array<{ id: string; title: string }>;
    }
  | {
      text: string;
      list: {
        buttonText: string;
        sections: Array<{
          title?: string;
          rows: Array<{ id: string; title: string; description?: string }>;
        }>;
      };
    };

/**
 * Send a WhatsApp message via 360dialog.
 * Throws on API errors.
 */
export async function sendWhatsAppMessage(to: string, message: BotReply): Promise<void> {
  const url = `${env.WHATSAPP_API_BASE}/messages`;

  let body: Record<string, unknown>;

  if (typeof message === 'string') {
    body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: message },
    };
  } else if ('buttons' in message) {
    const buttons = message.buttons.slice(0, 3).map((b) => ({
      type: 'reply',
      reply: {
        id: b.id,
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
    throw new Error('Unsupported BotReply shape');
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
    const errBody = await response.text();
    logger.error({ status: response.status, error: errBody, to }, 'WhatsApp API error');
    throw new Error(`WhatsApp API error: ${response.status}`);
  }
}

/**
 * Send a pre-approved WhatsApp template message via 360dialog.
 *
 * Templates are the ONLY messages WhatsApp lets a business send outside the
 * 24-hour customer-service window — required to notify web-order customers who
 * have never messaged us. `bodyParams` fill the template's {{1}}, {{2}}, …
 * placeholders, in order.
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  bodyParams: string[],
  languageCode: string = env.WHATSAPP_TEMPLATE_LANG,
): Promise<void> {
  const url = `${env.WHATSAPP_API_BASE}/messages`;

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: [
        {
          type: 'body',
          parameters: bodyParams.map((text) => ({ type: 'text', text })),
        },
      ],
    },
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
    const errBody = await response.text();
    logger.error({ status: response.status, error: errBody, to, templateName }, 'WhatsApp template API error');
    throw new Error(`WhatsApp template API error: ${response.status}`);
  }
}
