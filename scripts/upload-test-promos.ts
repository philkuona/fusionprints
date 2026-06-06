/**
 * One-off: upload the TEST promo card PNGs to B2 under campaigns/.
 * Run LOCALLY (where the rendered PNGs live + B2 creds are in .env):
 *
 *   npx tsx scripts/upload-test-promos.ts [referralPng] [upsellPng]
 *
 * Defaults to the headless-Edge render output. These are PLACEHOLDER cards —
 * replaced by real launch creative later (see docs/slip-system.md §6 step 2).
 */
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { env } from '../src/config/env.js';

const s3 = new S3Client({
  endpoint: `https://${env.B2_ENDPOINT}`,
  region: 'auto',
  credentials: { accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APPLICATION_KEY },
});

const uploads = [
  { file: process.argv[2] ?? '/mnt/c/temp/slipbuild/referral.png', key: 'campaigns/test-referral.png' },
  { file: process.argv[3] ?? '/mnt/c/temp/slipbuild/upsell.png', key: 'campaigns/test-upsell.png' },
];

async function main() {
  for (const u of uploads) {
    const body = readFileSync(u.file);
    await s3.send(
      new PutObjectCommand({
        Bucket: env.B2_BUCKET_NAME,
        Key: u.key,
        Body: body,
        ContentType: 'image/png',
      }),
    );
    const head = await s3.send(new HeadObjectCommand({ Bucket: env.B2_BUCKET_NAME, Key: u.key }));
    console.log(`uploaded ${u.key} (${head.ContentLength} bytes)`);
    console.log(`  url: https://${env.B2_BUCKET_NAME}.${env.B2_ENDPOINT}/${u.key}`);
  }
  console.log('DONE');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
