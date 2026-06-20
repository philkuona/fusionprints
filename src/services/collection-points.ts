/**
 * Collection points — admin-managed pickup locations, surfaced across channels.
 *
 * The "primary" point is the lowest sort_order among active rows; it's what the
 * bot pickup notice, web checkout, and order detail show when there's a single
 * location (the common case). Multiple-point customer selection at checkout is a
 * future enhancement; for now the primary active point is used.
 *
 * `hours` falls back to BUSINESS_HOURS when null so a point only needs a name +
 * address to be useful.
 */
import { eq, asc, and } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { collectionPoints, type CollectionPoint } from '@/db/schema.js';
import { env } from '@/config/env.js';

/** All active points, primary first (by sort_order). */
export async function getActiveCollectionPoints(): Promise<CollectionPoint[]> {
  return db
    .select()
    .from(collectionPoints)
    .where(eq(collectionPoints.active, true))
    .orderBy(asc(collectionPoints.sortOrder), asc(collectionPoints.createdAt));
}

/** The primary active collection point, or null if none configured. */
export async function getPrimaryCollectionPoint(): Promise<CollectionPoint | null> {
  const [p] = await getActiveCollectionPoints();
  return p ?? null;
}

/** A specific point by id (any active state). Null if not found. */
export async function getCollectionPointById(id: string): Promise<CollectionPoint | null> {
  const [p] = await db.select().from(collectionPoints).where(eq(collectionPoints.id, id)).limit(1);
  return p ?? null;
}

/** The order's chosen point if set + still resolvable, else the primary. */
export async function getOrderCollectionPoint(collectionPointId: string | null): Promise<CollectionPoint | null> {
  if (collectionPointId) {
    const p = await getCollectionPointById(collectionPointId);
    if (p) return p;
  }
  return getPrimaryCollectionPoint();
}

/** Every point (active or not), primary order — for the admin list. */
export async function listCollectionPoints(): Promise<CollectionPoint[]> {
  return db
    .select()
    .from(collectionPoints)
    .orderBy(asc(collectionPoints.sortOrder), asc(collectionPoints.createdAt));
}

export interface CollectionPointInput {
  name: string;
  addressLine: string;
  hours?: string | null;
  active?: boolean;
  sortOrder?: number;
}

export async function createCollectionPoint(input: CollectionPointInput): Promise<void> {
  await db.insert(collectionPoints).values({
    name: input.name,
    addressLine: input.addressLine,
    hours: input.hours ?? null,
    active: input.active ?? true,
    sortOrder: input.sortOrder ?? 0,
  });
}

export async function updateCollectionPoint(id: string, input: CollectionPointInput): Promise<void> {
  await db
    .update(collectionPoints)
    .set({
      name: input.name,
      addressLine: input.addressLine,
      hours: input.hours ?? null,
      active: input.active ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    .where(eq(collectionPoints.id, id));
}

export async function deleteCollectionPoint(id: string): Promise<void> {
  await db.delete(collectionPoints).where(and(eq(collectionPoints.id, id)));
}

/** Hours for a point, falling back to the configured business hours. */
export function pointHours(p: CollectionPoint): string {
  return p.hours ?? env.BUSINESS_HOURS;
}
