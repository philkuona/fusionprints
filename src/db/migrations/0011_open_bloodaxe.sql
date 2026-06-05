CREATE TYPE "public"."order_channel" AS ENUM('whatsapp', 'web');--> statement-breakpoint
ALTER TABLE "order_items" ALTER COLUMN "image_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "processed_image_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "paper" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "web_user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "channel" "order_channel" DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_processed_image_id_processed_images_id_fk" FOREIGN KEY ("processed_image_id") REFERENCES "public"."processed_images"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_web_user_id_web_users_id_fk" FOREIGN KEY ("web_user_id") REFERENCES "public"."web_users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_processed_image_idx" ON "order_items" USING btree ("processed_image_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_web_user_idx" ON "orders" USING btree ("web_user_id");