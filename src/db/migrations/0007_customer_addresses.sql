-- Migration: add customer_addresses table for web platform delivery addresses
-- Zimbabwe addresses use suburb + city + delivery instructions (no postal codes).

CREATE TABLE IF NOT EXISTS customer_addresses (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  web_user_id           UUID NOT NULL REFERENCES web_users(id) ON DELETE CASCADE,
  label                 TEXT NOT NULL DEFAULT 'Home',
  recipient_name        TEXT NOT NULL,
  address_line1         TEXT NOT NULL,
  suburb                TEXT,
  city                  TEXT NOT NULL,
  delivery_instructions TEXT,
  is_default            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_addresses_web_user_idx ON customer_addresses (web_user_id);
