-- Migration: add site_visits and waitlist tables
-- For the FusionPrints coming-soon landing page

CREATE TABLE IF NOT EXISTS site_visits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  referrer    TEXT,
  user_agent  TEXT,
  ip_hash     TEXT  -- hashed for privacy, never raw IP
);

CREATE INDEX IF NOT EXISTS site_visits_visited_at_idx ON site_visits (visited_at);

CREATE TABLE IF NOT EXISTS waitlist (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  whatsapp     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_whatsapp_idx ON waitlist (whatsapp);
