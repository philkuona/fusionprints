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
  customer: { name: string | null; email: string | null } | null = NAMED,
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

    // collection → order summary
    r = run(r.nextStep, r.nextContext, text('1'));
    expect(r.nextStep).toBe('confirming_order');
    expect(r.nextContext.fulfillmentMethod).toBe('collection');

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

  it('a named customer goes straight to fulfillment at checkout (email not required)', () => {
    const ctx = { ...emptyContext(), cart: [cartItem()] };
    const r = run('adding_more_or_checkout', ctx, text('2'), { name: 'Rudo', email: null });
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
    expect(r.nextStep).toBe('confirming_order');
    // The address keeps the customer's casing (raw text, not the uppercased command).
    expect(r.nextContext.deliveryAddress).toBe('12 Example Street, Suburbia');
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

describe('composite flows', () => {
  it('wallet: one photo duplicates across every layout cell', () => {
    let r = run('choosing_product', emptyContext(), text('2'));
    expect(r.nextStep).toBe('choosing_wallet_photo');
    expect(r.nextContext.pendingSize).toBe('wallet_4up');

    r = run(r.nextStep, r.nextContext, photo('wallet-img'));
    expect(r.nextStep).toBe('adding_more_or_checkout');
    const item = r.nextContext.cart[0];
    const layoutCells = getProduct('wallet_4up')!.layout!.cells;
    expect(item.compositeCells).toHaveLength(layoutCells.length);
    expect(item.compositeCells!.map((c) => c.cellIndex)).toEqual(layoutCells.map((_, i) => i));
    expect(item.compositeCells!.every((c) => c.imageRef === 'wallet-img')).toBe(true);
  });

  it('mini pair: two photos land in distinct cells', () => {
    let r = run('choosing_product', emptyContext(), text('4'));
    expect(r.nextStep).toBe('choosing_mini_photo_1');

    r = run(r.nextStep, r.nextContext, photo('mini-a'));
    expect(r.nextStep).toBe('choosing_mini_photo_2');
    expect(r.nextContext.pendingCompositePhotos).toEqual(['mini-a']);

    r = run(r.nextStep, r.nextContext, photo('mini-b'));
    expect(r.nextStep).toBe('adding_more_or_checkout');
    const refs = new Set(r.nextContext.cart[0].compositeCells!.map((c) => c.imageRef));
    expect(refs).toEqual(new Set(['mini-a', 'mini-b']));
  });

  it('text instead of a photo re-prompts within the composite step', () => {
    const start = run('choosing_product', emptyContext(), text('3'));
    expect(start.nextStep).toBe('choosing_passport_photo');
    const r = run(start.nextStep, start.nextContext, text('what now?'));
    expect(r.nextStep).toBe('choosing_passport_photo');
    expect(r.nextContext.cart).toEqual([]);
  });

  it('a compressed photo is refused for composites (no USE ANYWAY)', () => {
    const start = run('choosing_product', emptyContext(), text('2'));
    const r = run(start.nextStep, start.nextContext, photo('w', { wasCompressed: true }));
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
