CREATE TYPE "public"."fulfillment_method" AS ENUM('collection', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'paid', 'awaiting_approval', 'queued_for_print', 'printing', 'ready_for_collection', 'fulfilled', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('paynow', 'flutterwave');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'success', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."print_job_status" AS ENUM('queued', 'awaiting_approval', 'printing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."printer_status" AS ENUM('online', 'offline', 'media_low', 'error');--> statement-breakpoint
CREATE TYPE "public"."printer_type" AS ENUM('dye_sub', 'inkjet');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('photo_print', 'poster');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_state" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"current_step" text DEFAULT 'idle' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number" text NOT NULL,
	"name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_order_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"storage_url" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text,
	"width_px" integer,
	"height_px" integer,
	"file_size_bytes" bigint,
	"format" text,
	"was_compressed" boolean DEFAULT false NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_after" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	"product_type" "product_type" NOT NULL,
	"size_code" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_usd" numeric(10, 2) NOT NULL,
	"line_total_usd" numeric(10, 2) NOT NULL,
	"requires_manual_review" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"subtotal_usd" numeric(10, 2) NOT NULL,
	"delivery_fee_usd" numeric(10, 2) DEFAULT '0' NOT NULL,
	"total_usd" numeric(10, 2) NOT NULL,
	"fulfillment_method" "fulfillment_method" NOT NULL,
	"delivery_address" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_reference" text,
	"amount_usd" numeric(10, 2) NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"payment_method" text,
	"initiated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"webhook_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"printer_id" uuid,
	"status" "print_job_status" DEFAULT 'queued' NOT NULL,
	"print_ready_file_url" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"printer_type" "printer_type" NOT NULL,
	"os_printer_name" text NOT NULL,
	"current_media" text,
	"status" "printer_status" DEFAULT 'online' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversation_state" ADD CONSTRAINT "conversation_state_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "images" ADD CONSTRAINT "images_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_phone_idx" ON "customers" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "images_customer_idx" ON "images" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "images_delete_after_idx" ON "images" USING btree ("delete_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_order_number_idx" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_provider_ref_idx" ON "payments" USING btree ("provider_reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_status_idx" ON "print_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_order_item_idx" ON "print_jobs" USING btree ("order_item_id");