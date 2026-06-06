CREATE TABLE IF NOT EXISTS "product_prices" (
	"size_code" text PRIMARY KEY NOT NULL,
	"unit_price_usd" numeric(10, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
