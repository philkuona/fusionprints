CREATE TABLE IF NOT EXISTS "web_sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "web_sessions_expire_idx" ON "web_sessions" USING btree ("expire");