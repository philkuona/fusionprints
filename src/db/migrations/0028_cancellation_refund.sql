CREATE TYPE "public"."cancellation_status" AS ENUM('requested', 'approved', 'declined');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancellation_status" "cancellation_status";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancellation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refund_status" "refund_status";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refund_reference" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refund_amount_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "charge_reference" text;