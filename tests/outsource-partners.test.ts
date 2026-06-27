/**
 * normalizePartnerInput — pure parsing of the admin partner form (Outsource
 * Routing — Phase 2). Pins: trimming, checkbox coercion, channel validation,
 * supported-size filtering to real outsourced codes, and per-size price parsing.
 */
import { describe, it, expect } from 'vitest';
import { normalizePartnerInput, outsourcedSizeCodes } from '@/services/outsource-partners.js';

describe('outsourcedSizeCodes', () => {
  it('is exactly the catalog outsourced sizes', () => {
    expect([...outsourcedSizeCodes()].sort()).toEqual(['11x14', '12x18', '16x20', '8x10'].sort());
  });
});

describe('normalizePartnerInput', () => {
  const base = { name: '  Harare Wide-Format  ', shortCode: ' HWF ', preferredChannel: 'email' };

  it('trims text and coerces checkboxes', () => {
    const r = normalizePartnerInput({ ...base, active: 'on', isDefault: 'on' });
    expect(r.name).toBe('Harare Wide-Format');
    expect(r.shortCode).toBe('HWF');
    expect(r.active).toBe(true);
    expect(r.isDefault).toBe(true);
  });

  it('defaults unchecked flags to false and blanks to null', () => {
    const r = normalizePartnerInput({ ...base });
    expect(r.active).toBe(false);
    expect(r.isDefault).toBe(false);
    expect(r.contactEmail).toBeNull();
    expect(r.notes).toBeNull();
  });

  it('keeps only valid outsourced supported sizes', () => {
    const r = normalizePartnerInput({
      ...base,
      size_8x10: 'on',
      size_11x14: 'on',
      size_4x6: 'on', // not outsourced — must be ignored
    });
    expect([...r.supportedSizes].sort()).toEqual(['11x14', '8x10'].sort());
  });

  it('parses per-size wholesale prices, rounding and ignoring junk', () => {
    const r = normalizePartnerInput({
      ...base,
      price_8x10: '3.005',
      price_11x14: '',
      price_12x18: 'abc',
      price_16x20: '-2',
      price_4x6: '9', // not outsourced — ignored
    });
    expect(r.wholesalePrices['8x10']).toBe(3.01);
    expect(r.wholesalePrices['11x14']).toBeUndefined();
    expect(r.wholesalePrices['12x18']).toBeUndefined();
    expect(r.wholesalePrices['16x20']).toBeUndefined();
    expect(r.wholesalePrices['4x6']).toBeUndefined();
  });

  it('falls back to email for an invalid channel', () => {
    expect(normalizePartnerInput({ ...base, preferredChannel: 'pigeon' }).preferredChannel).toBe('email');
    expect(normalizePartnerInput({ ...base, preferredChannel: 'whatsapp' }).preferredChannel).toBe('whatsapp');
  });
});
