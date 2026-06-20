ALTER TABLE "orders" ADD COLUMN "collection_point_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_collection_point_id_collection_points_id_fk" FOREIGN KEY ("collection_point_id") REFERENCES "public"."collection_points"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
