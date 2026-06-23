/**
 * Bot state machine — transition-table tests (audit IMP-1 wave 2).
 *
 * handleMessage is pure (context + message in → response + effects out), so
 * these run without a DB or WhatsApp. Coverage: the happy path to an order,
 * the reset-word guard (audit BUG-5), BACK/CANCEL/HELP global commands,
 * wrong-input re-prompts, image validation outcomes, composite flows
 * (wallet duplicate-mapping and the two-photo mini pair), and EcoCash
 * number/network handling.
 */

import { describe, it, expect } from 'vitest';
import { handleMessage, type IncomingMessage, type BotResponse } from '@/bot/state-machine.js';
import { emptyContext, type BotContext, type BotStep } from '@/bot/types.js';
import { PHOTO_PRODUCTS, getProduct } from '@/config/catalog.js';

const NAMED = { name: 'Rudo', email: 'rudo@example.com' };

/** A photo comfortably above every recommended resolution. */
const GOOD_IMAGE = { widthPx: 4000, heightPx: 3000, wasCompressed: false, ref: 'img-1' };

function text(t: string): IncomingMessage {
  return { text: t };
}
function photo(ref = 'img-1', overrides: Partial<NonNullable<IncomingMessage['image']>> = {}): IncomingMessage {
  return { text: '', image: { ...GOOD_IMAGE, ref, ...overrides } };
}
function run(
  step: BotStep,
  context: BotContext,
  message: IncomingMessage,
  customer: { name: string | null; email: string | null; emailDeclineCount?: number } | null = NAMED,
): BotResponse {
  return handleMessage(step, context, message, customer);
}

describe('happy path: greeting to EcoCash push', () => {
  it('walks a single-print order end to end', () => {
    // hi → product menu
    let r = run('idle', emptyContext(), text('hi'));
    expect(r.nextStep).toBe('choosing_product');

    // photos → size menu
    r = run(r.nextStep, r.nextContext, text('1'));
    expect(r.nextStep).toBe('choosing_size');
    expect(r.nextContext.pendingProductType).toBe('photo_print');

    // first size → straight to the web upload link (the single upload path)
    r = run(r.nextStep, r.nextContext, text('1'));
    expect(r.nextStep).toBe('awaiting_web_upload');
    expect(r.nextContext.pendingSize).toBe(PHOTO_PRODUCTS[0].sizeCode);
    expect(r.effects).toEqual([expect.objectContaining({ type: 'create_upload_link' })]);

    // The upload is resolved by the (DB-backed) handler, which fills the cart;
    // resume the pure flow from a seeded cart.
    const ctx = { ...emptyContext(), cart: [cartItem()] };

    // checkout (customer already has a name) → fulfillment
    r = run('adding_more_or_checkout', ctx, text('2'));
    expect(r.nextStep).toBe('choosing_fulfillment');

    // collection → "who's this for?" (R2-13) → skip → order summary
    r = run(r.nextStep, r.nextContext, text('1'));
    expect(r.nextStep).toBe('collecting_recipient');
    expect(r.nextContext.fulfillmentMethod).toBe('collection');
    r = run(r.nextStep, r.nextContext, text('SKIP'));
    expect(r.nextStep).toBe('confirming_order');

    // PAY → CREATE_ORDER effect, on to payment method
    r = run(r.nextStep, r.nextContext, text('PAY'));
    expect(r.nextStep).toBe('choosing_payment_method');
    expect(r.effects).toEqual([expect.objectContaining({ type: 'CREATE_ORDER' })]);

    // (caller creates the order and stores the number)
    const withOrder = { ...r.nextContext, orderNumber: 'FP-2026-0042' };

    // ecocash → number prompt
    r = run('choosing_payment_method', withOrder, text('1'));
    expect(r.nextStep).toBe('entering_ecocash_number');

    // valid EcoNet number → USSD push effect
    r = run(r.nextStep, r.nextContext, text('0772123456'));
    expect(r.nextStep).toBe('awaiting_ecocash_pin');
    expect(r.effects).toEqual([
      { type: 'INITIATE_ECOCASH_PAYMENT', orderNumber: 'FP-2026-0042', ecocashNumber: '+263772123456' },
    ]);
  });

  it('asks for a name at checkout when the customer has none', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    const r = run('adding_more_or_checkout', ctx, text('2'), { name: null, email: null });
    expect(r.nextStep).toBe('collecting_name');
  });

  it('a named customer WITH an email goes straight to fulfillment at checkout', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    const r = run('adding_more_or_checkout', ctx, text('2'), { name: 'Rudo', email: 'rudo@example.com' });
    expect(r.nextStep).toBe('choosing_fulfillment');
  });

  it('a named customer with no email is asked for it each order (R2-6 #20)', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    const r = run('adding_more_or_checkout', ctx, text('2'), { name: 'Rudo', email: null });
    expect(r.nextStep).toBe('collecting_email');
  });

  it('stops asking for email after 3 declines', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    const r = run('adding_more_or_checkout', ctx, text('2'), { name: 'Rudo', email: null, emailDeclineCount: 3 });
    expect(r.nextStep).toBe('choosing_fulfillment');
  });

  it('after collecting a new customer name, asks for the optional email next', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    const r = run('collecting_name', ctx, text('rudo moyo'), { name: null, email: null });
    expect(r.nextStep).toBe('collecting_email');
    expect((r.nextContext as { _customerName?: string })._customerName).toBe('Rudo Moyo');
  });

  it('email step: SKIP continues to fulfillment without an email', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    const r = run('collecting_email', ctx, text('SKIP'), { name: 'Rudo', email: null });
    expect(r.nextStep).toBe('choosing_fulfillment');
    expect((r.nextContext as { _customerEmail?: string })._customerEmail).toBeUndefined();
  });

  it('email step: rejects an invalid email, accepts a valid one', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    let r = run('collecting_email', ctx, text('not-an-email'), { name: 'Rudo', email: null });
    expect(r.nextStep).toBe('collecting_email');

    r = run('collecting_email', ctx, text('rudo@example.com'), { name: 'Rudo', email: null });
    expect(r.nextStep).toBe('choosing_fulfillment');
    expect((r.nextContext as { _customerEmail?: string })._customerEmail).toBe('rudo@example.com');
  });

  it('delivery asks for an address before the summary', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    let r = run('choosing_fulfillment', ctx, text('2'));
    expect(r.nextStep).toBe('collecting_address');
    expect(r.nextContext.fulfillmentMethod).toBe('delivery');

    r = run(r.nextStep, r.nextContext, text('12 Example Street, Suburbia'));
    // After the address, the recipient question (R2-13) precedes the summary.
    expect(r.nextStep).toBe('collecting_recipient');
    // The address keeps the customer's casing (raw text, not the uppercased command).
    expect(r.nextContext.deliveryAddress).toBe('12 Example Street, Suburbia');
    r = run(r.nextStep, r.nextContext, text('SKIP'));
    expect(r.nextStep).toBe('confirming_order');
  });

  it('captures a gift recipient number and notifies them too (R2-13)', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()], fulfillmentMethod: 'collection' as const };
    // At the recipient step, a valid number is stored on the order context.
    const r = run('collecting_recipient', ctx, text('0772123456'));
    expect(r.nextStep).toBe('confirming_order');
    expect(r.nextContext.recipientPhone).toBe('+263772123456');
  });
});

describe('reset-word guard (audit BUG-5)', () => {
  it('greeting with an empty context restarts cleanly', () => {
    const r = run('choosing_size', { ...emptyContext(), pendingProductType: 'photo_print' }, text('hello'));
    expect(r.nextStep).toBe('choosing_product');
    expect(r.nextContext.pendingProductType).toBeUndefined();
  });

  it.each(['HI', 'MENU', 'START'])('"%s" with a cart does NOT wipe it', (word) => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    const r = run('adding_more_or_checkout', ctx, text(word));
    expect(r.nextStep).toBe('adding_more_or_checkout'); // unchanged
    expect(r.nextContext.cart).toHaveLength(1);
    expect(r.effects).toEqual([]);
  });

  it('greeting mid-payment does not orphan the order', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()], orderNumber: 'FP-2026-0042' };
    const r = run('awaiting_ecocash_pin', ctx, text('hi'));
    expect(r.nextStep).toBe('awaiting_ecocash_pin');
    expect(r.nextContext.orderNumber).toBe('FP-2026-0042');
  });

  it('an explicit RESTART discards even mid-order', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()], orderNumber: 'FP-2026-0042' };
    const r = run('awaiting_ecocash_pin', ctx, text('RESTART'));
    expect(r.nextStep).toBe('choosing_product');
    expect(r.nextContext.cart).toEqual([]);
    expect(r.nextContext.orderNumber).toBeUndefined();
  });
});

describe('global commands', () => {
  it('CANCEL with an order emits CANCEL_ORDER and resets', () => {
    const ctx = { ...emptyContext(), orderNumber: 'FP-2026-0042' };
    const r = run('awaiting_payment', ctx, text('cancel'));
    expect(r.nextStep).toBe('idle');
    expect(r.effects).toEqual([{ type: 'CANCEL_ORDER', orderNumber: 'FP-2026-0042' }]);
    expect(r.nextContext.cart).toEqual([]);
  });

  it('CANCEL without an order emits no effect', () => {
    const r = run('choosing_size', emptyContext(), text('CANCEL'));
    expect(r.nextStep).toBe('idle');
    expect(r.effects).toEqual([]);
  });

  it('HELP keeps the step and context', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    const r = run('choosing_fulfillment', ctx, text('help'));
    expect(r.nextStep).toBe('choosing_fulfillment');
    expect(r.nextContext).toBe(ctx);
  });

  it('BACK from the size menu returns to the product menu', () => {
    const r = run('choosing_size', { ...emptyContext(), pendingProductType: 'photo_print' }, text('back'));
    expect(r.nextStep).toBe('choosing_product');
    expect(r.nextContext.pendingSize).toBeUndefined();
  });

  it('BACK at the root re-shows the greeting', () => {
    const r = run('choosing_product', emptyContext(), text('BACK'));
    expect(r.nextStep).toBe('choosing_product');
  });
});

describe('wrong input re-prompts without state damage', () => {
  it('out-of-range size choice stays on the menu', () => {
    const ctx = { ...emptyContext(), pendingProductType: 'photo_print' as const };
    const r = run('choosing_size', ctx, text('99'));
    expect(r.nextStep).toBe('choosing_size');
    expect(r.replies.length).toBeGreaterThanOrEqual(2); // error + menu again
  });

  it.each(['abc', '0', '-3'])('invalid quantity %p re-prompts', (q) => {
    const ctx = { ...emptyContext(), pendingSize: PHOTO_PRODUCTS[0].sizeCode };
    const r = run('choosing_quantity', ctx, text(q));
    expect(r.nextStep).toBe('choosing_quantity');
    expect(r.nextContext.cart).toEqual([]);
  });

  it('a one-letter name is rejected', () => {
    const r = run('collecting_name', { ...emptyContext(), cart: [cartItem()] }, text('X'));
    expect(r.nextStep).toBe('collecting_name');
  });

  it('typing instead of sending a photo re-prompts for the image', () => {
    const ctx = { ...emptyContext(), pendingSize: PHOTO_PRODUCTS[0].sizeCode };
    const r = run('awaiting_image', ctx, text('here it comes'));
    expect(r.nextStep).toBe('awaiting_image');
  });
});

describe('image validation outcomes (single print)', () => {
  const ctx = { ...emptyContext(), pendingSize: PHOTO_PRODUCTS[0].sizeCode };

  it('a WhatsApp-compressed photo warns and waits', () => {
    const r = run('awaiting_image', ctx, photo('img-c', { wasCompressed: true }));
    expect(r.nextStep).toBe('awaiting_image');
    expect(r.nextContext.acceptedCompressedImage).toBe(false);
  });

  it('USE ANYWAY after the warning proceeds to quantity', () => {
    const warned = { ...ctx, acceptedCompressedImage: false };
    const r = run('awaiting_image', warned, text('USE ANYWAY'));
    expect(r.nextStep).toBe('choosing_quantity');
  });

  it('a too-small photo is rejected and re-prompted', () => {
    const r = run('awaiting_image', ctx, photo('img-tiny', { widthPx: 100, heightPx: 100 }));
    expect(r.nextStep).toBe('awaiting_image');
  });
});

describe('composite products redirect to the web editor', () => {
  // Wallet & mini are now designed in the web editor (multi-cell positioning),
  // not built in-chat. Selecting them hands over a deep link and stays at the menu.
  it('wallet selection hands over the web link, no in-chat flow', () => {
    const r = run('choosing_product', emptyContext(), text('2'));
    expect(r.nextStep).toBe('choosing_product');
    expect(r.nextContext.cart).toEqual([]);
    expect(r.effects).toEqual([]);
    expect(JSON.stringify(r.replies)).toContain('/prints/wallet');
  });

  it('mini selection hands over the web link, no in-chat flow', () => {
    const r = run('choosing_product', emptyContext(), text('4'));
    expect(r.nextStep).toBe('choosing_product');
    expect(r.nextContext.cart).toEqual([]);
    expect(r.effects).toEqual([]);
    expect(JSON.stringify(r.replies)).toContain('/prints/mini');
  });

  it('passport is stubbed — unavailable, no flow started', () => {
    const r = run('choosing_product', emptyContext(), text('3'));
    expect(r.nextStep).toBe('choosing_product');
    expect(r.nextContext.cart).toEqual([]);
    expect(r.effects).toEqual([]);
    expect(JSON.stringify(r.replies).toLowerCase()).toContain('unavailable');
  });
});

// The in-chat composite handlers are retained for conversations already mid-flow
// when the web-redirect change shipped — keep covering the cell-building logic.
describe('in-flight composite handlers (legacy, mid-conversation only)', () => {
  it('wallet: one photo duplicates across every layout cell', () => {
    const ctx = {
      ...emptyContext(),
      pendingProductType: 'composite' as const,
      pendingSize: 'wallet_4up',
      pendingCompositePhotos: [],
    };
    const r = run('choosing_wallet_photo', ctx, photo('wallet-img'));
    expect(r.nextStep).toBe('adding_more_or_checkout');
    const item = r.nextContext.cart[0];
    const layoutCells = getProduct('wallet_4up')!.layout!.cells;
    expect(item.compositeCells).toHaveLength(layoutCells.length);
    expect(item.compositeCells!.map((c) => c.cellIndex)).toEqual(layoutCells.map((_, i) => i));
    expect(item.compositeCells!.every((c) => c.imageRef === 'wallet-img')).toBe(true);
  });

  it('mini: one photo duplicates across all 8 cells (set of 8)', () => {
    // Mini is now a single-image product (set of 8), like wallet — one photo
    // tiled across every cell, not a two-photo pair.
    const mini = getProduct('mini_pair')!;
    expect(mini.layout!.cells).toHaveLength(8);
    expect(mini.layout!.photosRequired).toBe(1);
    expect(mini.layout!.cells.every((c) => c.photoIndex === 0)).toBe(true);
  });

  it('a compressed photo is refused for composites (no USE ANYWAY)', () => {
    const ctx = {
      ...emptyContext(),
      pendingProductType: 'composite' as const,
      pendingSize: 'wallet_4up',
      pendingCompositePhotos: [],
    };
    const r = run('choosing_wallet_photo', ctx, photo('w', { wasCompressed: true }));
    expect(r.nextStep).toBe('choosing_wallet_photo');
    expect(r.nextContext.cart).toEqual([]);
  });
});

describe('EcoCash number handling', () => {
  const ctx = { ...emptyContext(), cart: [cartItem()], orderNumber: 'FP-2026-0042', paymentMethod: 'ecocash' as const };

  it('a NetOne number gets the wrong-network prompt', () => {
    const r = run('entering_ecocash_number', ctx, text('0712345678'));
    expect(r.nextStep).toBe('entering_ecocash_number');
    expect(r.effects).toEqual([]);
  });

  it('garbage is an invalid format, not a crash', () => {
    const r = run('entering_ecocash_number', ctx, text('not a number'));
    expect(r.nextStep).toBe('entering_ecocash_number');
    expect(r.effects).toEqual([]);
  });

  it('a +263 international EcoNet number works', () => {
    const r = run('entering_ecocash_number', ctx, text('+263 78 123 4567'));
    expect(r.nextStep).toBe('awaiting_ecocash_pin');
    expect(r.effects[0]).toMatchObject({ type: 'INITIATE_ECOCASH_PAYMENT', ecocashNumber: '+263781234567' });
  });

  it('PIN timeout option 2 cancels the order (card payment is hidden)', () => {
    const withNumber = { ...ctx, ecocashNumber: '+263772123456' };
    const r = run('awaiting_ecocash_pin', withNumber, text('2'));
    expect(r.nextStep).toBe('idle');
    expect(r.effects).toEqual([{ type: 'CANCEL_ORDER', orderNumber: 'FP-2026-0042' }]);
  });

  it('typing CARD at payment-method choice stays put with no dead link', () => {
    const r = run('choosing_payment_method', ctx, text('CARD'));
    expect(r.nextStep).toBe('choosing_payment_method');
    expect(r.effects).toEqual([]);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

function cartItem() {
  const p = PHOTO_PRODUCTS[0];
  return {
    sizeCode: p.sizeCode,
    displayLabel: p.displayLabel,
    quantity: 2,
    unitPriceUsd: p.unitPriceUsd,
    lineTotalUsd: p.unitPriceUsd * 2,
    requiresManualReview: false,
    imageRef: 'img-x',
  };
}

describe('collection point selection (PR-2b)', () => {
  const point = (id: string, name: string) =>
    ({ id, name, addressLine: `${name} Rd`, hours: 'Mon–Sat', active: true, sortOrder: 0, createdAt: new Date() }) as never;
  const ctx = () => ({ ...emptyContext(), cart: [cartItem()] });

  it('single (or no) point: collect goes to the recipient question, no choice asked', () => {
    const r = handleMessage('choosing_fulfillment', ctx(), text('1'), NAMED, [point('p1', 'Lab')]);
    // Recipient question (R2-13) precedes the summary; point is already resolved.
    expect(r.nextStep).toBe('collecting_recipient');
    expect(r.nextContext.fulfillmentMethod).toBe('collection');
    expect(r.nextContext.selectedCollectionPointId).toBe('p1');
  });

  it('multiple points: collect asks the customer to pick one', () => {
    const points = [point('p1', 'Lab'), point('p2', 'Mall')];
    let r = handleMessage('choosing_fulfillment', ctx(), text('1'), NAMED, points);
    expect(r.nextStep).toBe('choosing_collection_point');
    expect(r.nextContext.selectedCollectionPointId).toBeUndefined();

    // pick #2 → recipient question, then summary, with that point stored
    r = handleMessage('choosing_collection_point', r.nextContext, text('2'), NAMED, points);
    expect(r.nextStep).toBe('collecting_recipient');
    expect(r.nextContext.selectedCollectionPointId).toBe('p2');
    r = handleMessage('collecting_recipient', r.nextContext, text('SKIP'), NAMED, points);
    expect(r.nextStep).toBe('confirming_order');
  });

  it('multiple points: invalid pick re-prompts without losing state', () => {
    const points = [point('p1', 'Lab'), point('p2', 'Mall')];
    const r = handleMessage('choosing_collection_point', { ...ctx(), fulfillmentMethod: 'collection' }, text('9'), NAMED, points);
    expect(r.nextStep).toBe('choosing_collection_point');
    expect(r.nextContext.selectedCollectionPointId).toBeUndefined();
  });
});
