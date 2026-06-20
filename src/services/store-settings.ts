/**
 * Store-wide settings (singleton row, id=1).
 *
 * Currently the DNP's loaded-media mode. There is ONE physical DNP, which prints
 * one media family at a time: '6x8' (default → 4×6/6×6/6×8) or '5x7'. The agent
 * job-serving endpoint (routes/agent-api.ts) only hands out dye-sub jobs whose
 * media matches the current mode, so flipping to '5x7' releases the held 5×7
 * batch and auto-pauses the 4×6 family (and vice versa). See the spec in memory
 * five-by-seven-handling.md.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { storeSettings } from '../db/schema.js';

export type DnpMediaMode = '6x8' | '5x7';

/** Read the DNP's current loaded-media mode. Defaults to '6x8' if unset. */
export async function getDnpMediaMode(): Promise<DnpMediaMode> {
  const [row] = await db
    .select({ mode: storeSettings.dnpMediaMode })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1))
    .limit(1);
  return (row?.mode as DnpMediaMode) ?? '6x8';
}

/** Set the DNP's media mode (operator toggle after a physical media swap). */
export async function setDnpMediaMode(mode: DnpMediaMode): Promise<void> {
  // Upsert the singleton so it works even if the row was never seeded.
  await db
    .insert(storeSettings)
    .values({ id: 1, dnpMediaMode: mode, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: storeSettings.id,
      set: { dnpMediaMode: mode, updatedAt: new Date() },
    });
}

/** Which media family a dye-sub job needs, derived from its target printer type. */
export function mediaForPrinterType(targetPrinterType: string): DnpMediaMode {
  return targetPrinterType === 'dye_sub_5x7' ? '5x7' : '6x8';
}

export interface OrderMinimums {
  /** Minimum order total (USD) for a collection/pickup order. */
  pickupUsd: number;
  /** Minimum order total (USD) for a delivery order. */
  deliveryUsd: number;
}

/** Read the admin-set order minimums. Defaults: pickup $2, delivery $5. */
export async function getOrderMinimums(): Promise<OrderMinimums> {
  const [row] = await db
    .select({ pickup: storeSettings.minPickupUsd, delivery: storeSettings.minDeliveryUsd })
    .from(storeSettings)
    .where(eq(storeSettings.id, 1))
    .limit(1);
  return {
    pickupUsd: row ? parseFloat(row.pickup) : 2,
    deliveryUsd: row ? parseFloat(row.delivery) : 5,
  };
}

/** Set the order minimums (admin). Upserts the singleton. */
export async function setOrderMinimums(m: OrderMinimums): Promise<void> {
  const values = {
    minPickupUsd: m.pickupUsd.toFixed(2),
    minDeliveryUsd: m.deliveryUsd.toFixed(2),
    updatedAt: new Date(),
  };
  await db
    .insert(storeSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: storeSettings.id, set: values });
}
