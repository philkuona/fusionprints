ALTER TABLE "web_users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "web_users" ADD COLUMN "google_id" text;--> statement-breakpoint
ALTER TABLE "web_users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "web_users" ADD COLUMN "avatar_url" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "web_users_google_id_idx" ON "web_users" USING btree ("google_id");