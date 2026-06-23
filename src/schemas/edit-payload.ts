/**
 * Edit payload — the contract between the web editor (client) and the Sharp
 * applier (server). CANONICAL COPY. The frontend mirrors this verbatim at
 * fusionprints-web/lib/edit/payload-schema.ts; keep the two in sync (bump
 * EDIT_SCHEMA_VERSION on any breaking change). The server is the enforcing
 * authority — it validates every payload with editPayloadSchema before applying.
 *
 * All coordinates are normalized [0,1] against the UPRIGHT original image, taken
 * AFTER rotate/flip are conceptually applied (the applier rotates/flips first,
 * then extracts the crop), so the crop is resolution-independent.
 */

import { z } from 'zod';

export const EDIT_SCHEMA_VERSION = 1 as const;

const unit = z.number().min(0).max(1);
const signed = z.number().min(-1).max(1);

export const cropSchema = z.object({
  x: unit,
  y: unit,
  width: unit,
  height: unit,
  orientation: z.enum(['portrait', 'landscape', 'square']),
});

export const adjustmentsSchema = z.object({
  brightness: signed.default(0),
  contrast: signed.default(0),
  saturation: signed.default(0),
  exposure: z.number().min(-2).max(2).default(0), // stops
});

export const editPayloadSchema = z
  .object({
    schemaVersion: z.literal(EDIT_SCHEMA_VERSION),
    sourceImageId: z.string().uuid(),
    // Standard sizes look like "4x6"; composite "set" products (wallet/mini)
    // are named codes like "wallet_4up". The route re-checks the code against
    // the catalog, so accept any short slug here.
    sizeCode: z.string().min(1).max(40),
    crop: cropSchema,
    rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    flipH: z.boolean().default(false),
    flipV: z.boolean().default(false),
    adjustments: adjustmentsSchema.default({}),
    autoEnhance: z.boolean().default(false),
    filterId: z.enum(['none', 'bw', 'sepia', 'vintage']).default('none'),
    border: z.boolean().default(false),
    paper: z.enum(['glossy', 'satin', 'lustre']).default('glossy'),
  })
  .strict();

export type EditPayload = z.infer<typeof editPayloadSchema>;
export type EditCrop = z.infer<typeof cropSchema>;
export type EditAdjustments = z.infer<typeof adjustmentsSchema>;
