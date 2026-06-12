/**
 * payonify.verifyWebhookSignature — the fraud guard (audit IMP-1, wave 1).
 *
 * The webhook secret comes from vitest.config.ts test env
 * (PAYONIFY_WEBHOOK_SECRET=whsec_test_secret); config/env.ts reads it at
 * import time, so signing here with the same value exercises the real path.
 *
 * Payonify sends `t` in NANOSECONDS; the verifier normalises ns/µs/ms/s
 * before the replay-window check while HMACing the literal `t` string.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '@/services/payonify.js';

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ type: 'charge.succeeded', data: { id: 'ch_1' } });

function sign(t: string | number, body: string, secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

describe('verifyWebhookSignature — accepts', () => {
  it('a valid signature with a seconds timestamp', () => {
    expect(verifyWebhookSignature(BODY, sign(nowSec(), BODY))).toBe(true);
  });

  it('a valid signature with a milliseconds timestamp', () => {
    expect(verifyWebhookSignature(BODY, sign(Date.now(), BODY))).toBe(true);
  });

  it('a valid signature with a microseconds timestamp', () => {
    expect(verifyWebhookSignature(BODY, sign(Date.now() * 1000, BODY))).toBe(true);
  });

  it('a valid signature with a nanoseconds timestamp (what Payonify actually sends)', () => {
    expect(verifyWebhookSignature(BODY, sign(`${nowSec()}000000000`, BODY))).toBe(true);
  });

  it('a timestamp just inside the tolerance window', () => {
    expect(verifyWebhookSignature(BODY, sign(nowSec() - 290, BODY))).toBe(true);
  });
});

describe('verifyWebhookSignature — rejects', () => {
  it('a stale seconds timestamp (replay)', () => {
    expect(verifyWebhookSignature(BODY, sign(nowSec() - 600, BODY))).toBe(false);
  });

  it('a stale nanoseconds timestamp (replay)', () => {
    expect(verifyWebhookSignature(BODY, sign(`${nowSec() - 600}000000000`, BODY))).toBe(false);
  });

  it('a future timestamp beyond tolerance', () => {
    expect(verifyWebhookSignature(BODY, sign(nowSec() + 600, BODY))).toBe(false);
  });

  it('a tampered body', () => {
    const header = sign(nowSec(), BODY);
    expect(verifyWebhookSignature(BODY.replace('ch_1', 'ch_2'), header)).toBe(false);
  });

  it('a signature made with the wrong secret', () => {
    expect(verifyWebhookSignature(BODY, sign(nowSec(), BODY, 'whsec_attacker'))).toBe(false);
  });

  it('a tampered v1 of the right length', () => {
    const header = sign(nowSec(), BODY);
    const flipped = header.replace(/v1=(.)/, (_, c: string) => `v1=${c === 'a' ? 'b' : 'a'}`);
    expect(verifyWebhookSignature(BODY, flipped)).toBe(false);
  });

  it.each([
    undefined,
    '',
    'garbage',
    't=123', // missing v1
    'v1=abc', // missing t
    `t=notanumber,v1=${'0'.repeat(64)}`,
    `t=${Math.floor(Date.now() / 1000)},v1=short`, // wrong length
  ])('a malformed header: %p', (header) => {
    expect(verifyWebhookSignature(BODY, header as string | undefined)).toBe(false);
  });
});
