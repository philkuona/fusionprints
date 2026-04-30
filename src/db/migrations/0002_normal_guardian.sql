CREATE TABLE IF NOT EXISTS "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"size_code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"image_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "upload_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "image_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "upload_sessions_token_idx" ON "upload_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_customer_idx" ON "upload_sessions" USING btree ("customer_id");