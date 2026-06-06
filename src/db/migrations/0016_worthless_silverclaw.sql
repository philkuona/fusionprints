ALTER TYPE "public"."slip_type" ADD VALUE 'promo';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "promo_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"slot1" jsonb NOT NULL,
	"slot2" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slip_jobs" ADD COLUMN "template_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "slip_jobs" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promo_campaigns_active_idx" ON "promo_campaigns" USING btree ("active");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "slip_jobs" ADD CONSTRAINT "slip_jobs_campaign_id_promo_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."promo_campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
