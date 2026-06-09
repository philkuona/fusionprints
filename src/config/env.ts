/**
 * Environment variable parsing and validation.
 *
 * We use Zod to validate that all required env vars are present and well-typed
 * at startup. If anything is missing or malformed, the app refuses to start
 * with a clear error message — much better than a mysterious crash later.
 *
 * To add a new env var: add it to .env.example AND to the schema below.
 */

import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  // App
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('debug'),

  // Database
  DATABASE_URL: z.string().url(),

  // Business identity
  BUSINESS_NAME: z.string().default('FusionPrints'),
  BUSINESS_PHONE: z.string().default(''),
  BUSINESS_ADDRESS: z.string().default('Harare, Zimbabwe'),
  BUSINESS_HOURS: z.string().default('Mon–Sat 9am–6pm'),
  BUSINESS_LOCATION_NAME: z.string().default('Harare'),
  BUSINESS_COLLECTION_ADDRESS: z.string().default(''),

  // Public URL — used in bot messages for upload links and payment redirects
  // In dev: ngrok URL. In production: https://fusionprints.co.zw
  PUBLIC_URL: z.string().default('http://localhost:3000'),

  // WhatsApp (optional until we wire it up)
  WHATSAPP_BSP: z.string().default('360dialog'),
  WHATSAPP_API_KEY: z.string().default(''),
  WHATSAPP_API_BASE: z.string().default('https://waba-v2.360dialog.io'),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  WHATSAPP_WABA_ID: z.string().default(''),
  // Approved WhatsApp template names for business-initiated order updates
  // (required to message customers outside the 24h service window — e.g. web
  // orders). When a name is blank, that notification falls back to free-form
  // text (only delivered if a service window is open). Roll out per template.
  WHATSAPP_TEMPLATE_PICKUP: z.string().default(''),
  WHATSAPP_TEMPLATE_DELIVERY: z.string().default(''),
  WHATSAPP_TEMPLATE_LANG: z.string().default('en'),

  // Payments (optional until we wire them up)
  PAYNOW_INTEGRATION_ID: z.string().default(''),
  PAYNOW_INTEGRATION_KEY: z.string().default(''),
  PAYNOW_RETURN_URL: z.string().default(''),
  PAYNOW_RESULT_URL: z.string().default(''),

  FLUTTERWAVE_PUBLIC_KEY: z.string().default(''),
  FLUTTERWAVE_SECRET_KEY: z.string().default(''),
  FLUTTERWAVE_WEBHOOK_HASH: z.string().default(''),

  // Storage (optional until we wire it up)
  B2_KEY_ID: z.string().default(''),
  B2_APPLICATION_KEY: z.string().default(''),
  B2_BUCKET_NAME: z.string().default(''),
  B2_ENDPOINT: z.string().default(''),

  // Print agent
  PRINT_AGENT_API_KEY: z.string().default(''),
  // Fallback OS printer name when a job's printer has no osPrinterName set.
  DNP_PRINTER_NAME: z.string().default(''),
  // Virtual printers (service virtualisation): when true, the backend runs an
  // in-process "virtual agent" that drives queued jobs through printing→done so
  // the whole print flow is observable in admin with no hardware and no agent.
  // Keep OFF in real production (it would race a real agent).
  VIRTUAL_PRINTERS: z.string().default('false').transform((v) => v === 'true' || v === '1'),
  VIRTUAL_PRINT_MS: z.coerce.number().int().positive().default(2500), // dwell per job
  VIRTUAL_POLL_MS: z.coerce.number().int().positive().default(1500),  // poll interval

  // Admin
  ADMIN_SESSION_SECRET: z.string().default(''),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default('changeme'),

  // Operator (limited admin role — store attendant)
  OPERATOR_USERNAME: z.string().default('operator'),
  OPERATOR_PASSWORD: z.string().default('changeme-operator'),

  // Beelink autologin token (Chrome shortcut on Harare PC). Min 32 chars.
  BEELINK_AUTOLOGIN_TOKEN: z.string().default(''),

  // Beelink autologin (Chrome shortcut on the Harare Beelink PC)
  // Must be a random string >=32 chars; empty = feature disabled
  

  // Payment providers
  PAYMENT_PROVIDER: z.enum(['stub', 'magetsi', 'stripe', 'payonify']).default('stub'),
  // Payonify gateway (https://docs.payonify.com). Keys from the dashboard;
  // pk_test_/sk_test_ for the test env, pk_live_/sk_live_ for live. The webhook
  // secret (whsec_) comes from registering the webhook URL in the dashboard.
  PAYONIFY_PUBLISHABLE_KEY: z.string().default(''),
  PAYONIFY_SECRET_KEY: z.string().default(''),
  PAYONIFY_WEBHOOK_SECRET: z.string().default(''),
  MAGETSI_API_BASE: z.string().default(''),
  MAGETSI_API_KEY: z.string().default(''),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

  // QuickBooks Online integration
  QBO_CLIENT_ID: z.string().default(''),
  QBO_CLIENT_SECRET: z.string().default(''),

  // Webhook authentication (HTTP Basic auth on /webhook/whatsapp)
  // Set both to enable; leave blank to disable auth (dev only)
  WHATSAPP_WEBHOOK_USER: z.string().default(''),
  WHATSAPP_WEBHOOK_PASS: z.string().default(''),

  // Web platform
  RESEND_API_KEY: z.string().default(''),
  WEB_URL: z.string().default('http://localhost:3001'), // frontend origin for CORS + email links
  WEB_SESSION_SECRET: z.string().default(''), // if empty, falls back to ADMIN_SESSION_SECRET

  // Google OAuth (Phase 2.1.7) — both blank = Google sign-in disabled.
  // The callback is derived from PUBLIC_URL: {PUBLIC_URL}/web/api/auth/google/callback
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),

  // Cloud photo import (runtime feature flags — surfaced via GET /web/api/imports/config
  // so the frontend shows each option without a rebuild).
  // GOOGLE_PHOTOS_IMPORT_ENABLED: turn on only after the Google Cloud setup
  //   (Photos Picker API enabled + scope on the consent screen + redirect URI).
  GOOGLE_PHOTOS_IMPORT_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // Image expiry cleanup (Phase 2.1.6)
  // ENABLED: run the in-process daily cleanup scheduler at all.
  // DRY_RUN: when true (default), the job only LOGS what it would delete and
  //   removes nothing — flip to false to actually delete expired images.
  IMAGE_CLEANUP_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  IMAGE_CLEANUP_DRY_RUN: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
