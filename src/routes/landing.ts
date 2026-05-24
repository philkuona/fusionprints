/**
 * Landing page routes.
 *
 * Routes:
 *   GET  /api/track    — 1x1 pixel tracker (called by landing page on load)
 *   POST /api/waitlist — capture name + WhatsApp from the coming-soon form
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '@/db/client.js';
import { siteVisits, waitlist } from '@/db/schema.js';
import { logger } from '@/utils/logger.js';
import { createHash } from 'crypto';

// 1×1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function hashIp(ip: string): string {
  return createHash('sha256').update(ip + 'fp-salt-2026').digest('hex').slice(0, 16);
}

export async function registerLandingRoutes(app: FastifyInstance): Promise<void> {

  // Tracking pixel — fires on every landing page load
  app.get('/api/track', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const ip = (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        ?? request.ip
        ?? '';
      await db.insert(siteVisits).values({
        referrer:  (request.headers.referer ?? request.headers.referrer ?? null) as string | null,
        userAgent: (request.headers['user-agent'] ?? null) as string | null,
        ipHash:    hashIp(ip),
      });
    } catch (err) {
      // Never fail a page load over tracking
      logger.debug({ err }, 'Visit tracking insert failed');
    }
    return reply
      .header('Content-Type', 'image/gif')
      .header('Cache-Control', 'no-store, no-cache, must-revalidate')
      .header('Pragma', 'no-cache')
      .send(PIXEL);
  });

  // Waitlist form submission
  app.post('/api/waitlist', async (request: FastifyRequest, reply: FastifyReply) => {
    const { name, whatsapp } = request.body as { name?: string; whatsapp?: string };

    if (!name?.trim() || !whatsapp?.trim()) {
      return reply.status(400).send({ ok: false, message: 'Name and WhatsApp number are required.' });
    }

    // Normalise WhatsApp — strip spaces and dashes, ensure + prefix
    const normalised = whatsapp.trim().replace(/[\s\-]/g, '');
    const phone = normalised.startsWith('+') ? normalised : `+${normalised}`;

    try {
      await db.insert(waitlist).values({
        name:     name.trim(),
        whatsapp: phone,
      });
      logger.info({ name: name.trim(), phone }, 'Waitlist signup');
      return { ok: true };
    } catch (err: any) {
      // Unique constraint = already signed up
      if (err?.code === '23505') {
        return { ok: true, already: true };
      }
      logger.error({ err }, 'Waitlist insert failed');
      return reply.status(500).send({ ok: false, message: 'Something went wrong. Please try again.' });
    }
  });
}
