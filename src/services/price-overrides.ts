/**
 * Admin price overrides.
 *
 * The catalog structure lives in config/catalog.ts; prices can be overridden
 * from the admin and stored in the product_prices table. To keep display, the
 * WhatsApp bot, and order totals all consistent, we apply overrides by mutating
 * the shared in-memory PRODUCTS objects' unitPriceUsd in place — every consumer
 * (getProduct, PHOTO_PRODUCTS, pricing, the catalog API) reads the same objects,
 * so one update propagates everywhere. Single backend instance, so no cross-node
 * cache concern.
 *
 * Call loadAndApplyPriceOverrides() once at startup; setProductPrice() persists
 * an edit and updates the live price immediately (no redeploy).
 */
import { db } from '@/db/client.js';
import { productPrices } from '@/db/schema.js';
import { PRODUCTS } from '@/config/catalog.js';
import { logger } from '@/utils/logger.js';

export async function loadAndApplyPriceOverrides(): Promise<void> {
  try {
    const rows = await db.select().from(productPrices);
    let applied = 0;
    for (const row of rows) {
      const product = PRODUCTS.find((p) => p.sizeCode === row.sizeCode);
      if (product) {
        product.unitPriceUsd = Number(row.unitPriceUsd);
        applied++;
      }
    }
    logger.info({ applied, rows: rows.length }, 'Applied product price overrides');
  } catch (err) {
    logger.error({ err }, 'Failed to load price overrides — using catalog defaults');
  }
}

/** Persist a price (USD) for a size and update the live in-memory price. */
export async function setProductPrice(sizeCode: string, priceUsd: number): Promise<void> {
  const product = PRODUCTS.find((p) => p.sizeCode === sizeCode);
  if (!product) throw new Error(`Unknown sizeCode: ${sizeCode}`);
  if (!Number.isFinite(priceUsd) || priceUsd < 0) throw new Error(`Invalid price: ${priceUsd}`);

  const value = priceUsd.toFixed(2);
  await db
    .insert(productPrices)
    .values({ sizeCode, unitPriceUsd: value })
    .onConflictDoUpdate({
      target: productPrices.sizeCode,
      set: { unitPriceUsd: value, updatedAt: new Date() },
    });

  product.unitPriceUsd = priceUsd; // live update — propagates to all consumers
  logger.info({ sizeCode, priceUsd }, 'Product price updated');
}
