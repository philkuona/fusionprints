CREATE TYPE "public"."dnp_media_mode" AS ENUM('6x8', '5x7');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "holidays_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "store_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"dnp_media_mode" "dnp_media_mode" DEFAULT '6x8' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "scheduled_ready_at" timestamp with time zone;