CREATE TYPE "public"."outsource_dispatch_status" AS ENUM('pending', 'sent', 'failed', 'partner_confirmed', 'partner_ready', 'received_back', 'manually_fulfilled', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outsource_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"partner_id" uuid,
	"channel" "partner_channel" DEFAULT 'email' NOT NULL,
	"status" "outsource_dispatch_status" DEFAULT 'pending' NOT NULL,
	"line_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_ref" text,
	"wholesale_cost_usd" numeric(10, 2),
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outsource_dispatches" ADD CONSTRAINT "outsource_dispatches_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outsource_dispatches" ADD CONSTRAINT "outsource_dispatches_partner_id_outsource_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."outsource_partners"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outsource_dispatches_order_idx" ON "outsource_dispatches" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outsource_dispatches_status_idx" ON "outsource_dispatches" USING btree ("status");