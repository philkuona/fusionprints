/**
 * Outsource dispatch — pure helpers (Outsource Routing — Phase 4): wholesale-cost
 * snapshot, target/channel resolution, and the already-dispatched idempotency
 * guard. The DB + email send path needs a database and is covered by the QA guide.
 */
import { describe, it, expect } from 'vitest';
import {
  computeWholesaleCost,
  resolveDispatchTarget,
  isLiveDispatch,
  alreadyDispatched,
} from '@/services/outsource-dispatch.js';
import type { OutsourcePartner, OutsourceDispatch } from '@/db/schema.js';

function partner(over: Partial<OutsourcePartner> = {}): OutsourcePartner {
  return {
    id: 'p1',
    name: 'Wide Format Co',
    shortCode: 'WFC',
    active: true,
    isDefault: true,
    contactEmail: 'orders@wfc.co.zw',
    whatsappNumber: null,
    portalUrl: null,
    preferredChannel: 'email',
    supportedSizes: ['8x10', '11x14', '12x18', '16x20'],
    wholesalePrices: { '8x10': 2, '11x14': 4.5, '16x20': 9 },
    turnaround: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as OutsourcePartner;
}

describe('computeWholesaleCost', () => {
  it('sums price × qty per size, missing prices count as 0', () => {
    const cost = computeWholesaleCost(
      [
        { sizeCode: '8x10', quantity: 2 }, // 2×2 = 4
        { sizeCode: '11x14', quantity: 1 }, // 4.5
        { sizeCode: '12x18', quantity: 3 }, // no price → 0
      ],
      partner().wholesalePrices,
    );
    expect(cost).toBe(8.5);
  });

  it('rounds away float drift to clean cents', () => {
    // 0.1 × 3 = 0.30000000000000004 in IEEE-754 → must read back as 0.3.
    expect(computeWholesaleCost([{ sizeCode: '8x10', quantity: 3 }], { '8x10': 0.1 })).toBe(0.3);
  });
});

describe('resolveDispatchTarget', () => {
  it('accepts an active email partner with an address', () => {
    const t = resolveDispatchTarget(partner());
    expect(t).toMatchObject({ ok: true, channel: 'email', email: 'orders@wfc.co.zw' });
  });

  it('rejects when there is no partner', () => {
    expect(resolveDispatchTarget(null)).toMatchObject({ ok: false });
  });

  it('rejects an inactive partner', () => {
    expect(resolveDispatchTarget(partner({ active: false })).ok).toBe(false);
  });

  it('rejects a non-email channel in v1', () => {
    const t = resolveDispatchTarget(partner({ preferredChannel: 'whatsapp' }));
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/email only/i);
  });

  it('rejects an email partner with no address', () => {
    expect(resolveDispatchTarget(partner({ contactEmail: null })).ok).toBe(false);
  });
});

describe('idempotency guard', () => {
  const row = (status: OutsourceDispatch['status']) => ({ status }) as Pick<OutsourceDispatch, 'status'>;

  it('live states count as dispatched', () => {
    for (const s of ['sent', 'partner_confirmed', 'partner_ready', 'received_back', 'manually_fulfilled'] as const) {
      expect(isLiveDispatch(s)).toBe(true);
    }
  });

  it('failed / pending / cancelled do NOT count as dispatched', () => {
    for (const s of ['failed', 'pending', 'cancelled'] as const) {
      expect(isLiveDispatch(s)).toBe(false);
    }
  });

  it('alreadyDispatched is true only when a live row exists', () => {
    expect(alreadyDispatched([row('failed'), row('cancelled')])).toBe(false);
    expect(alreadyDispatched([row('failed'), row('sent')])).toBe(true);
    expect(alreadyDispatched([])).toBe(false);
  });
});
