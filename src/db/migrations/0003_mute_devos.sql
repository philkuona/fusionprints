ALTER TYPE "public"."order_status" ADD VALUE 'shipped' BEFORE 'fulfilled';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "receipt_sent_at" timestamp with time zone;