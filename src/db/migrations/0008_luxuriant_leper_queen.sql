-- Make the images table polymorphic: an image is owned by EITHER a WhatsApp
-- customer (customer_id) OR a web platform user (web_user_id), never both.
-- This lets web uploads and WhatsApp uploads share the same table and the
-- order_items -> images relation.
--
-- Hand-authored: drizzle-kit's snapshot history was missing 0004-0007, so an
-- auto-generated diff re-emitted already-applied changes. This file contains
-- only the images changes; 0008_snapshot.json captures the full current schema
-- so future `drizzle-kit generate` runs diff cleanly.

ALTER TABLE "images" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN IF NOT EXISTS "web_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "images" ADD CONSTRAINT "images_web_user_id_web_users_id_fk" FOREIGN KEY ("web_user_id") REFERENCES "public"."web_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "images_web_user_idx" ON "images" USING btree ("web_user_id");
