-- Phase D.1 — multi-printer routing + slip orchestration foundation
-- This migration adds the schema needed for Phase D without changing behavior.
-- After this migration, the database supports the new structure but no code uses it yet.
-- Phase D.2 will add the slip rendering + orchestration code.
-- Phase D.3 will add the agent routing + admin release flow + customer notifications.

-- New enums for Phase D
CREATE TYPE "public"."target_printer_type" AS ENUM('dye_sub_4x6', 'dye_sub_5x7', 'inkjet', 'thermal_label');--> statement-breakpoint
CREATE TYPE "public"."slip_type" AS ENUM('order_info', 'end_separator', 'envelope_label');--> statement-breakpoint

-- Add new order status values to existing enum
ALTER TYPE "public"."order_status" ADD VALUE IF NOT EXISTS 'printed';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE IF NOT EXISTS 'ready_for_pickup';--> statement-breakpoint

-- Add target_printer_type column to print_jobs (nullable for backward compat with existing rows)
ALTER TABLE "print_jobs" ADD COLUMN IF NOT EXISTS "target_printer_type" "target_printer_type";--> statement-breakpoint

-- Index for routing queries (agent fetches jobs by printer type)
CREATE INDEX IF NOT EXISTS "print_jobs_target_printer_idx" ON "print_jobs" USING btree ("target_printer_type");--> statement-breakpoint

-- Slip jobs table — operational/branded prints separate from customer prints
CREATE TABLE IF NOT EXISTS "slip_jobs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "order_id" uuid NOT NULL,
    "printer_id" uuid,
    "slip_type" "slip_type" NOT NULL,
    "target_printer_type" "target_printer_type" NOT NULL,
    "sequence_position" integer DEFAULT 50 NOT NULL,
    "status" "print_job_status" DEFAULT 'queued' NOT NULL,
    "print_ready_file_url" text,
    "payload_json" jsonb,
    "attempts" integer DEFAULT 0 NOT NULL,
    "error_message" text,
    "queued_at" timestamp with time zone DEFAULT now() NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone
);
--> statement-breakpoint

-- Foreign key constraints for slip_jobs
DO $$ BEGIN
    ALTER TABLE "slip_jobs" ADD CONSTRAINT "slip_jobs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
    ALTER TABLE "slip_jobs" ADD CONSTRAINT "slip_jobs_printer_id_printers_id_fk" FOREIGN KEY ("printer_id") REFERENCES "public"."printers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Indexes for slip_jobs
CREATE INDEX IF NOT EXISTS "slip_jobs_status_idx" ON "slip_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slip_jobs_order_idx" ON "slip_jobs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slip_jobs_target_printer_idx" ON "slip_jobs" USING btree ("target_printer_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slip_jobs_sequence_idx" ON "slip_jobs" USING btree ("order_id", "sequence_position");
