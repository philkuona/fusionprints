ALTER TABLE "order_items" DROP CONSTRAINT "order_items_image_id_images_id_fk";
--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT "order_items_processed_image_id_processed_images_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_processed_image_id_processed_images_id_fk" FOREIGN KEY ("processed_image_id") REFERENCES "public"."processed_images"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
