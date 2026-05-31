-- Migration: add web_users table for the FusionPrints web platform
-- Web platform accounts are separate from WhatsApp customers.

CREATE TABLE IF NOT EXISTS web_users (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                        TEXT NOT NULL,
  password_hash                TEXT NOT NULL,
  email_verified               BOOLEAN NOT NULL DEFAULT FALSE,
  email_verification_token     TEXT,
  email_verification_expires_at TIMESTAMPTZ,
  whatsapp_number              TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at                TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS web_users_email_idx ON web_users (email);
CREATE INDEX IF NOT EXISTS web_users_verification_token_idx ON web_users (email_verification_token);
