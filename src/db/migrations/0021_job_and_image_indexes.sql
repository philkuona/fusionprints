CREATE INDEX IF NOT EXISTS "order_items_image_idx" ON "order_items" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "print_jobs_status_target_idx" ON "print_jobs" USING btree ("status","target_printer_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slip_jobs_status_target_idx" ON "slip_jobs" USING btree ("status","target_printer_type");