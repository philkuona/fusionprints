/**
 * Outsource partners — admin-managed print shops that produce the sizes the DNP
 * can't (8×10 + all wall art). Entirely customer-invisible (Outsource Routing —
 * Phase 2). v1 dispatches to a single active default partner; per-size routing is
 * a later enhancement.
 *
 * Invariants enforced here (not the DB):
 *   - at most one partner has is_default = true
 *   - the default used for dispatch must also be active (getDefaultPartner)
 * Partners are deactivated, never deleted, so historical dispatches stay coherent.
 */
import { eq, asc, ne, and } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { outsourcePartners, type OutsourcePartner } from '@/db/schema.js';
import { OUTSOURCED_PRODUCTS } from '@/config/catalog.js';

export type PartnerChannel = 'email' | 'whatsapp' | 'portal';

export interface PartnerInput {
  name: string;
  shortCode: string;
  active: boolean;
  isDefault: boolean;
  contactEmail?: string | null;
  whatsappNumber?: string | null;
  portalUrl?: string | null;
  preferredChannel: PartnerChannel;
  supportedSizes: string[];
  wholesalePrices: Record<string, number>;
  turnaround?: string | null;
  notes?: string | null;
}

/** The set of size codes that are outsourced (the only valid supported sizes). */
export function outsourcedSizeCodes(): string[] {
  return OUTSOURCED_PRODUCTS.map((p) => p.sizeCode);
}

/**
 * Normalize raw admin-form fields into a clean PartnerInput. Pure (no DB) so it's
 * unit-testable: trims text, coerces the channel + checkboxes, keeps only valid
 * outsourced size codes, and parses per-size wholesale prices (ignoring blanks
 * and non-numbers). `sizes_<code>` = checkbox, `price_<code>` = number input.
 */
export function normalizePartnerInput(f: Record<string, string>): PartnerInput {
  const valid = new Set(outsourcedSizeCodes());
  const supportedSizes = [...valid].filter((code) => f[`size_${code}`] === 'on');

  const wholesalePrices: Record<string, number> = {};
  for (const code of valid) {
    const raw = f[`price_${code}`]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) wholesalePrices[code] = Math.round(n * 100) / 100;
  }

  const channel = (['email', 'whatsapp', 'portal'] as const).includes(
    f.preferredChannel as PartnerChannel,
  )
    ? (f.preferredChannel as PartnerChannel)
    : 'email';

  return {
    name: f.name?.trim() ?? '',
    shortCode: f.shortCode?.trim() ?? '',
    active: f.active === 'on',
    isDefault: f.isDefault === 'on',
    contactEmail: f.contactEmail?.trim() || null,
    whatsappNumber: f.whatsappNumber?.trim() || null,
    portalUrl: f.portalUrl?.trim() || null,
    preferredChannel: channel,
    supportedSizes,
    wholesalePrices,
    turnaround: f.turnaround?.trim() || null,
    notes: f.notes?.trim() || null,
  };
}

/** Every partner (active or not), default first then by name — for the admin list. */
export async function listPartners(): Promise<OutsourcePartner[]> {
  return db
    .select()
    .from(outsourcePartners)
    .orderBy(asc(outsourcePartners.name));
}

export async function getPartnerById(id: string): Promise<OutsourcePartner | null> {
  const [p] = await db.select().from(outsourcePartners).where(eq(outsourcePartners.id, id)).limit(1);
  return p ?? null;
}

/**
 * The active default partner, or null if none is configured. This is what
 * auto-dispatch (Phase 4) sends outsourced items to. A default that has been
 * deactivated does NOT count — dispatch should fall back to manual + alert.
 */
export async function getDefaultPartner(): Promise<OutsourcePartner | null> {
  const [p] = await db
    .select()
    .from(outsourcePartners)
    .where(and(eq(outsourcePartners.isDefault, true), eq(outsourcePartners.active, true)))
    .limit(1);
  return p ?? null;
}

/** Clear the default flag on every partner except `keepId`. */
async function clearOtherDefaults(keepId: string): Promise<void> {
  await db
    .update(outsourcePartners)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(ne(outsourcePartners.id, keepId));
}

export async function createPartner(input: PartnerInput): Promise<void> {
  const [created] = await db
    .insert(outsourcePartners)
    .values({
      name: input.name,
      shortCode: input.shortCode,
      active: input.active,
      isDefault: input.isDefault,
      contactEmail: input.contactEmail ?? null,
      whatsappNumber: input.whatsappNumber ?? null,
      portalUrl: input.portalUrl ?? null,
      preferredChannel: input.preferredChannel,
      supportedSizes: input.supportedSizes,
      wholesalePrices: input.wholesalePrices,
      turnaround: input.turnaround ?? null,
      notes: input.notes ?? null,
    })
    .returning({ id: outsourcePartners.id });
  // A new default (or the only partner being made default) demotes the rest.
  if (input.isDefault && created) await clearOtherDefaults(created.id);
}

export async function updatePartner(id: string, input: PartnerInput): Promise<void> {
  await db
    .update(outsourcePartners)
    .set({
      name: input.name,
      shortCode: input.shortCode,
      active: input.active,
      isDefault: input.isDefault,
      contactEmail: input.contactEmail ?? null,
      whatsappNumber: input.whatsappNumber ?? null,
      portalUrl: input.portalUrl ?? null,
      preferredChannel: input.preferredChannel,
      supportedSizes: input.supportedSizes,
      wholesalePrices: input.wholesalePrices,
      turnaround: input.turnaround ?? null,
      notes: input.notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(outsourcePartners.id, id));
  if (input.isDefault) await clearOtherDefaults(id);
}

/** Make a partner the sole default (and ensure it's active). */
export async function setDefaultPartner(id: string): Promise<void> {
  await db
    .update(outsourcePartners)
    .set({ isDefault: true, active: true, updatedAt: new Date() })
    .where(eq(outsourcePartners.id, id));
  await clearOtherDefaults(id);
}

/** Deactivate (never delete — keeps historical dispatches coherent). */
export async function deactivatePartner(id: string): Promise<void> {
  await db
    .update(outsourcePartners)
    .set({ active: false, isDefault: false, updatedAt: new Date() })
    .where(eq(outsourcePartners.id, id));
}
