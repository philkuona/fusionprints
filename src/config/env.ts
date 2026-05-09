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

  // Admin
  ADMIN_SESSION_SECRET: z.string().default(''),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default('changeme'),

  // Operator (limited admin role — store attendant)
  OPERATOR_USERNAME: z.string().default('operator'),
  OPERATOR_PASSWORD: z.string().default('changeme-operator'),

  // Payment providers
  PAYMENT_PROVIDER: z.enum(['stub', 'magetsi', 'stripe']).default('stub'),
  MAGETSI_API_BASE: z.string().default(''),
  MAGETSI_API_KEY: z.string().default(''),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

  // Webhook authentication (HTTP Basic auth on /webhook/whatsapp)
  // Set both to enable; leave blank to disable auth (dev only)
  WHATSAPP_WEBHOOK_USER: z.string().default(''),
  WHATSAPP_WEBHOOK_PASS: z.string().default(''),
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
