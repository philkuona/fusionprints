CREATE TYPE "public"."partner_channel" AS ENUM('email', 'whatsapp', 'portal');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outsource_partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"short_code" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"contact_email" text,
	"whatsapp_number" text,
	"portal_url" text,
	"preferred_channel" "partner_channel" DEFAULT 'email' NOT NULL,
	"supported_sizes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"wholesale_prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"turnaround" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outsource_partners_short_code_unique" UNIQUE("short_code")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outsource_partners_active_idx" ON "outsource_partners" USING btree ("active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outsource_partners_default_idx" ON "outsource_partners" USING btree ("is_default");