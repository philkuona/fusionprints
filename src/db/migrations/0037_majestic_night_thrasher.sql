CREATE TABLE IF NOT EXISTS "web_carts" (
	"web_user_id" uuid PRIMARY KEY NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "web_carts" ADD CONSTRAINT "web_carts_web_user_id_web_users_id_fk" FOREIGN KEY ("web_user_id") REFERENCES "public"."web_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
