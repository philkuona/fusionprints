ALTER TYPE "public"."product_type" ADD VALUE 'composite';--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "layout_payload" jsonb;