ALTER TABLE "orders" ADD COLUMN "public_ref" text;--> statement-breakpoint
-- Backfill existing rows with an opaque value (legacy orders predate the
-- code-side Crockford generator; hex from a per-row hash is unique enough).
UPDATE "orders" SET "public_ref" = upper(substr(md5(random()::text || id::text), 1, 10)) WHERE "public_ref" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_public_ref_idx" ON "orders" USING btree ("public_ref");