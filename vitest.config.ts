import { defineConfig } from 'vitest/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': resolve(root, 'src') },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // config/env.ts validates on import — give the pure-function tests a
    // minimal, obviously-fake environment so no .env file is needed (CI).
    // dotenv does not override pre-set values, so these always win.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/fusionprints_test',
      PAYONIFY_WEBHOOK_SECRET: 'whsec_test_secret',
    },
  },
});
