CREATE TABLE IF NOT EXISTS "processed_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_image_id" uuid NOT NULL,
	"web_user_id" uuid NOT NULL,
	"size_code" text NOT NULL,
	"edit_payload" jsonb NOT NULL,
	"processed_storage_key" text NOT NULL,
	"processed_storage_url" text NOT NULL,
	"width_px" integer NOT NULL,
	"height_px" integer NOT NULL,
	"format" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delete_after" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "processed_images" ADD CONSTRAINT "processed_images_source_image_id_images_id_fk" FOREIGN KEY ("source_image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "processed_images" ADD CONSTRAINT "processed_images_web_user_id_web_users_id_fk" FOREIGN KEY ("web_user_id") REFERENCES "public"."web_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processed_images_source_idx" ON "processed_images" USING btree ("source_image_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processed_images_web_user_idx" ON "processed_images" USING btree ("web_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "processed_images_key_idx" ON "processed_images" USING btree ("processed_storage_key");