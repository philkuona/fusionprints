/**
 * Outsource print-ready package — pure helpers (Outsource Routing — Phase 3).
 * Pins the filename convention, spec shape + PII-safety, the spec SVG content,
 * and the zip round-trip. The DB/render functions need a database and are not
 * covered here.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  printReadyFilename,
  buildSpec,
  buildSpecSvg,
  itemInstructions,
  zipFiles,
  type SpecLineItem,
} from '@/services/outsource-package.js';

function specItem(over: Partial<SpecLineItem> = {}): SpecLineItem {
  const border = over.border ?? false;
  return {
    lineItemId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    fileName: 'FP-2026-0001_aaaaaaaa_11x14_lustre_x2.jpg',
    sizeCode: '11x14',
    sizeLabel: '11×14 in (28×36 cm)',
    finish: 'lustre',
    quantity: 2,
    border,
    instructions: itemInstructions({ border }),
    ...over,
  };
}

describe('printReadyFilename', () => {
  it('packs order ref, line item, size, finish, quantity', () => {
    const name = printReadyFilename('FP-2026-0001', {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      sizeCode: '11x14',
      finish: 'lustre',
      quantity: 2,
    });
    expect(name).toBe('FP-2026-0001_aaaaaaaa_11x14_lustre_x2.jpg');
  });

  it('has no characters that break email/WhatsApp attachments', () => {
    const name = printReadyFilename('FP/2026 #1', {
      id: '12345678-0000-0000-0000-000000000000',
      sizeCode: '8x10',
      finish: 'lustre',
      quantity: 1,
    });
    expect(name).toMatch(/^[A-Za-z0-9_.-]+\.jpg$/);
  });
});

describe('buildSpec', () => {
  it('sums quantities and tags the schema version', () => {
    const spec = buildSpec({ orderRef: 'FP-2026-0001', items: [specItem({ quantity: 2 }), specItem({ quantity: 3, sizeCode: '8x10' })] });
    expect(spec.schemaVersion).toBe('fusionprints.outsource.v1');
    expect(spec.itemCount).toBe(5);
    expect(spec.orderRef).toBe('FP-2026-0001');
  });

  it('carries no customer-identifying or price fields (privacy)', () => {
    const spec = buildSpec({ orderRef: 'FP-2026-0001', items: [specItem()] });
    const json = JSON.stringify(spec).toLowerCase();
    // 'filename' is allowed (it's a key); the concern is customer/commercial data.
    for (const banned of ['phone', 'customer', 'contactname', 'price', 'total', 'usd', 'email', 'address']) {
      expect(json).not.toContain(banned);
    }
  });

  it('border instruction differs by border flag', () => {
    expect(itemInstructions({ border: true }).join(' ')).toContain('White border');
    expect(itemInstructions({ border: false }).join(' ')).toContain('Full-bleed');
  });
});

describe('buildSpecSvg', () => {
  it('shows the order ref and each size, but no customer data', () => {
    const spec = buildSpec({ orderRef: 'FP-2026-0042', items: [specItem({ sizeLabel: '16×20 in (40×50 cm)' })] });
    const svg = buildSpecSvg(spec);
    expect(svg).toContain('FP-2026-0042');
    expect(svg).toContain('16×20');
    expect(svg.toLowerCase()).not.toContain('phone');
  });
});

describe('zipFiles', () => {
  it('round-trips multiple in-memory files', async () => {
    const buf = await zipFiles([
      { name: 'a.jpg', buffer: Buffer.from('image-a') },
      { name: 'spec.json', buffer: Buffer.from('{"x":1}') },
    ]);
    const zip = await JSZip.loadAsync(buf);
    expect(Object.keys(zip.files).sort()).toEqual(['a.jpg', 'spec.json']);
    expect(await zip.file('spec.json')!.async('string')).toBe('{"x":1}');
  });
});
