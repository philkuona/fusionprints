/**
 * Admin consumable-cost overrides (parallel to price-overrides.ts).
 *
 * The per-size consumable cost (ribbon/ink + paper) is admin-editable and stored
 * in product_costs. Like prices, we apply it by mutating the shared in-memory
 * PRODUCTS objects' `costUsd` in place, so order creation (which snapshots cost
 * onto order_items) and any other consumer read the same live value.
 *
 * Call loadAndApplyCostOverrides() once at startup; setProductCost() persists an
 * edit and updates the live cost immediately.
 */
import { db } from '@/db/client.js';
import { productCosts } from '@/db/schema.js';
import { PRODUCTS, getProduct } from '@/config/catalog.js';
import { logger } from '@/utils/logger.js';

export async function loadAndApplyCostOverrides(): Promise<void> {
  try {
    const rows = await db.select().from(productCosts);
    let applied = 0;
    for (const row of rows) {
      const product = PRODUCTS.find((p) => p.sizeCode === row.sizeCode);
      if (product) {
        product.costUsd = Number(row.unitCostUsd);
        applied++;
      }
    }
    logger.info({ applied, rows: rows.length }, 'Applied product cost overrides');
  } catch (err) {
    logger.error({ err }, 'Failed to load cost overrides — using zero cost');
  }
}

/** Persist a consumable cost (USD) for a size and update the live in-memory cost. */
export async function setProductCost(sizeCode: string, costUsd: number): Promise<void> {
  const product = PRODUCTS.find((p) => p.sizeCode === sizeCode);
  if (!product) throw new Error(`Unknown sizeCode: ${sizeCode}`);
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error(`Invalid cost: ${costUsd}`);

  const value = costUsd.toFixed(2);
  await db
    .insert(productCosts)
    .values({ sizeCode, unitCostUsd: value })
    .onConflictDoUpdate({
      target: productCosts.sizeCode,
      set: { unitCostUsd: value, updatedAt: new Date() },
    });

  product.costUsd = costUsd; // live update
  logger.info({ sizeCode, costUsd }, 'Product cost updated');
}

/** Live consumable cost for a size (0 if unset/unknown). */
export function getProductCost(sizeCode: string): number {
  return getProduct(sizeCode)?.costUsd ?? 0;
}
