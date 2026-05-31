/**
 * Web platform catalog route — /web/api/catalog
 *
 * Public endpoint — no auth required.
 * Returns the product catalog stripped of internal fields
 * (printer routing, outsourced flag, etc. — internal only).
 * Customers never see which printer handles their order.
 */

import type { FastifyInstance } from 'fastify';
import { PRODUCTS } from '@/config/catalog.js';

export async function registerWebCatalogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/web/api/catalog', async (_request, reply) => {
    const catalog = PRODUCTS.map((p) => ({
      sizeCode: p.sizeCode,
      productType: p.productType,
      labelInches: p.labelInches,
      labelCm: p.labelCm,
      displayLabel: p.displayLabel,
      unitPriceUsd: p.unitPriceUsd,
      finish: p.finish,
      requiresManualReview: p.requiresManualReview,
      minResolution: p.minResolution,
      recommendedResolution: p.recommendedResolution,
    }));
    return reply.send(catalog);
  });
}
