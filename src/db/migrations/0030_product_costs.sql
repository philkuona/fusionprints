CREATE TABLE IF NOT EXISTS "product_costs" (
	"size_code" text PRIMARY KEY NOT NULL,
	"unit_cost_usd" numeric(10, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "unit_cost_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "line_cost_usd" numeric(10, 2);