/**
 * canAdvanceToPrinted — the dual-stream rollup gate (Outsource Routing — Phase 5).
 * An order may reach 'printed' only from an actively-producing state, with the
 * outsource stream settled, and no in-house print/slip job still pending.
 */
import { describe, it, expect } from 'vitest';
import { canAdvanceToPrinted } from '@/services/order.js';

describe('canAdvanceToPrinted', () => {
  it('advances when both streams are complete (no outsource items)', () => {
    expect(canAdvanceToPrinted('printing', 'not_applicable', 0)).toBe(true);
  });

  it('advances an outsourced order only once received', () => {
    expect(canAdvanceToPrinted('printing', 'received', 0)).toBe(true);
    expect(canAdvanceToPrinted('printing', 'dispatched', 0)).toBe(false);
    expect(canAdvanceToPrinted('printing', 'pending', 0)).toBe(false);
    expect(canAdvanceToPrinted('printing', 'failed', 0)).toBe(false);
  });

  it('blocks while any in-house job is still pending', () => {
    expect(canAdvanceToPrinted('printing', 'received', 1)).toBe(false);
    expect(canAdvanceToPrinted('printing', 'not_applicable', 2)).toBe(false);
  });

  it('never resurrects a later or terminal status', () => {
    for (const s of ['printed', 'ready_for_pickup', 'shipped', 'fulfilled', 'cancelled', 'failed', 'pending_payment']) {
      expect(canAdvanceToPrinted(s, 'not_applicable', 0)).toBe(false);
    }
  });

  it('allows advancing from the producing states', () => {
    for (const s of ['paid', 'awaiting_approval', 'queued_for_print', 'printing']) {
      expect(canAdvanceToPrinted(s, 'not_applicable', 0)).toBe(true);
    }
  });
});
