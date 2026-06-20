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
import { getActiveCollectionPoints, pointHours } from '@/services/collection-points.js';

export async function registerWebCatalogRoutes(app: FastifyInstance): Promise<void> {
  // Active collection points for the storefront (checkout collection note,
  // order detail). Public — no internal fields. Primary is the first entry.
  app.get('/web/api/collection-points', async (_request, reply) => {
    const points = await getActiveCollectionPoints();
    return reply.send(
      points.map((p) => ({ id: p.id, name: p.name, address: p.addressLine, hours: pointHours(p) })),
    );
  });

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

  // Composite layouts/prices — the backend catalog is the single source of
  // truth (audit IMP-3). The web editor keeps a local copy for offline render,
  // guarded against drift by tests/composite-parity.test.ts; this endpoint lets
  // it consume the geometry at runtime instead. Internal render fields
  // (photoMapping, gutter, printer routing) are stripped — customers only need
  // the geometry, price, and how many photos to provide.
  app.get('/web/api/composites', async (_request, reply) => {
    const composites = PRODUCTS.filter((p) => p.productType === 'composite' && p.layout).map((p) => ({
      sizeCode: p.sizeCode,
      displayName: p.displayName ?? p.displayLabel,
      description: p.description ?? null,
      priceUsd: p.unitPriceUsd,
      photosRequired: p.layout!.photosRequired,
      layout: {
        sheetWidth: p.layout!.sheetWidth,
        sheetHeight: p.layout!.sheetHeight,
        printRotation: p.layout!.printRotation,
        cells: p.layout!.cells.map((c) => ({ x: c.x, y: c.y, width: c.width, height: c.height })),
      },
    }));
    return reply.send(composites);
  });
}
