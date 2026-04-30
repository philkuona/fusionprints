/**
 * FusionPrints Bot — CLI Simulator
 *
 * Runs the bot state machine in your terminal so you can have a full
 * customer conversation without connecting to WhatsApp.
 *
 * Usage: npx tsx scripts/simulate-bot.ts
 *
 * Special commands in the simulator:
 *   /image <width> <height>      — simulate sending a good image (as document)
 *   /compressed <width> <height> — simulate sending a compressed image (as photo)
 *   /lowres <width> <height>     — simulate sending a low-res image
 *   /state                       — show current step and context
 *   /reset                       — restart the conversation
 *   /quit                        — exit the simulator
 *
 * Example session:
 *   > hi
 *   > 1
 *   > 1
 *   > /image 3024 4032
 *   > 5
 *   > 2
 *   > Tendai Moyo
 *   > 1
 *   > PAY
 */

import * as readline from 'readline';
import { handleMessage } from '../src/bot/state-machine.js';
import { emptyContext } from '../src/bot/types.js';
import type { BotStep, BotContext } from '../src/bot/types.js';
import type { IncomingMessage } from '../src/bot/state-machine.js';

// ===== Simulator state =====

let currentStep: BotStep = 'idle';
let currentContext: BotContext = emptyContext();
let customerName: string | null = null;

// Fake order number counter
let orderCounter = 1;

// ===== Display helpers =====

const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GREY = '\x1b[90m';
const BOLD = '\x1b[1m';

function printBot(message: string): void {
  const lines = message.split('\n');
  console.log();
  lines.forEach((line) => {
    // Crude WhatsApp markdown → terminal formatting
    const formatted = line
      .replace(/\*(.+?)\*/g, `${BOLD}$1${RESET}`)
      .replace(/_(.+?)_/g, `${GREY}$1${RESET}`);
    console.log(`${CYAN}  🤖 ${formatted}${RESET}`);
  });
  console.log();
}

function printSystem(message: string): void {
  console.log(`${YELLOW}  ℹ️  ${message}${RESET}`);
}

function printEffect(effect: { type: string; [key: string]: unknown }): void {
  switch (effect.type) {
    case 'CREATE_ORDER': {
      const orderNum = `FP-2026-${String(orderCounter++).padStart(4, '0')}`;
      currentContext = { ...currentContext, orderNumber: orderNum };
      const paymentUrl = `https://pay.fusionprints.co.zw/p/${Math.random().toString(36).slice(2, 8)}`;
      const quote = (effect as { type: string; quote: { ok: boolean; quote: { totalUsd: number } } }).quote;
      if (quote.ok) {
        printSystem(`[ORDER CREATED: ${orderNum}]`);
        printBot(
          `Here's your payment link:\n🔗 ${paymentUrl}\n\nPays via card or EcoCash.\n\n*Order #:* ${orderNum}\n*Amount:* $${quote.quote.totalUsd.toFixed(2)}\n\n_Link expires in 60 minutes._`,
        );
        printSystem(`[In production: customer pays, webhook fires, bot sends confirmation]`);
        printSystem(`[Simulating immediate payment confirmation...]`);
        const hasPosters = currentContext.cart.some((i) => i.requiresManualReview);
        if (hasPosters) {
          printBot(
            `✅ *Payment received!*\n\nOrder *${orderNum}* — your poster will go through a quick quality check before printing _(within 2 hours, business hours)_. I'll message you once it's confirmed.`,
          );
        } else {
          printBot(
            `✅ *Payment received!*\n\nOrder *${orderNum}* is now in the queue.\n\nI'll message you when your prints are ready. Photo prints are usually done within *1 hour* during business hours.`,
          );
        }
        currentStep = 'order_complete';
        currentContext = emptyContext();
      }
      break;
    }
    case 'CANCEL_ORDER':
      printSystem(`[ORDER CANCELLED: ${(effect as { orderNumber: string }).orderNumber}]`);
      break;
    case 'LOOKUP_ORDER_STATUS':
      printSystem(`[LOOKING UP ORDERS for customer]`);
      break;
    case 'INITIATE_PAYMENT':
      printSystem(`[GENERATING NEW PAYMENT LINK for ${(effect as { orderNumber: string }).orderNumber}]`);
      break;
  }
}

function showState(): void {
  console.log(`\n${GREY}  ┌─ Current state ─────────────────────────`);
  console.log(`  │ Step: ${currentStep}`);
  console.log(`  │ Cart: ${currentContext.cart.length} item(s)`);
  currentContext.cart.forEach((item) => {
    console.log(`  │   - ${item.quantity}x ${item.displayLabel} ($${item.lineTotalUsd.toFixed(2)})`);
  });
  if (currentContext.pendingProductType) {
    console.log(`  │ Pending product type: ${currentContext.pendingProductType}`);
  }
  if (currentContext.pendingSize) {
    console.log(`  │ Pending size: ${currentContext.pendingSize}`);
  }
  if (currentContext.fulfillmentMethod) {
    console.log(`  │ Fulfillment: ${currentContext.fulfillmentMethod}`);
  }
  console.log(`  └──────────────────────────────────────────${RESET}\n`);
}

function parseSimulatorCommand(input: string): IncomingMessage | null {
  const parts = input.trim().split(' ');
  const cmd = parts[0].toLowerCase();

  if (cmd === '/image' && parts.length >= 3) {
    const w = parseInt(parts[1], 10);
    const h = parseInt(parts[2], 10);
    printSystem(`[Simulating document upload: ${w}×${h}px, not compressed]`);
    return {
      text: '',
      image: { widthPx: w, heightPx: h, wasCompressed: false, ref: `img_${Date.now()}` },
    };
  }

  if (cmd === '/compressed' && parts.length >= 3) {
    const w = parseInt(parts[1], 10);
    const h = parseInt(parts[2], 10);
    printSystem(`[Simulating photo upload: ${w}×${h}px, COMPRESSED]`);
    return {
      text: '',
      image: { widthPx: w, heightPx: h, wasCompressed: true, ref: `img_${Date.now()}` },
    };
  }

  if (cmd === '/lowres' && parts.length >= 3) {
    const w = parseInt(parts[1], 10);
    const h = parseInt(parts[2], 10);
    printSystem(`[Simulating low-res upload: ${w}×${h}px]`);
    return {
      text: '',
      image: { widthPx: w, heightPx: h, wasCompressed: false, ref: `img_${Date.now()}` },
    };
  }

  return null;
}

// ===== Main loop =====

async function main(): Promise<void> {
  console.clear();
  console.log(`${GREEN}${BOLD}`);
  console.log(`  ╔════════════════════════════════════════╗`);
  console.log(`  ║   FusionPrints Bot — CLI Simulator     ║`);
  console.log(`  ╚════════════════════════════════════════╝${RESET}`);
  console.log();
  console.log(`${GREY}  Type messages as a customer would on WhatsApp.`);
  console.log(`  Special commands:`);
  console.log(`    /image 3024 4032     — send a good image`);
  console.log(`    /compressed 800 600  — send a compressed image`);
  console.log(`    /lowres 400 300      — send a low-res image`);
  console.log(`    /state               — show current state`);
  console.log(`    /reset               — restart conversation`);
  console.log(`    /quit                — exit${RESET}`);
  console.log();
  console.log(`${GREY}  Tip: Try a full order: hi → 1 → 1 → /image 3024 4032 → 5 → 2 → [name] → 1 → PAY${RESET}`);
  console.log();

  // Trigger the initial greeting
  const initial = handleMessage('idle', emptyContext(), { text: 'hi' }, null);
  initial.replies.forEach(printBot);
  currentStep = initial.nextStep;
  currentContext = initial.nextContext;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): void => {
    rl.question(`${GREEN}  You: ${RESET}`, (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // Simulator meta-commands
      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log(`\n  Goodbye!\n`);
        rl.close();
        return;
      }

      if (trimmed === '/state') {
        showState();
        prompt();
        return;
      }

      if (trimmed === '/reset') {
        currentStep = 'idle';
        currentContext = emptyContext();
        customerName = null;
        printSystem('Conversation reset.');
        const greeting = handleMessage('idle', emptyContext(), { text: 'hi' }, null);
        greeting.replies.forEach(printBot);
        currentStep = greeting.nextStep;
        currentContext = greeting.nextContext;
        prompt();
        return;
      }

      // Check for simulator image commands
      const simulatedMessage = parseSimulatorCommand(trimmed);
      const message: IncomingMessage = simulatedMessage ?? { text: trimmed };

      // Process through the state machine
      const customer = customerName ? { name: customerName } : null;
      const response = handleMessage(currentStep, currentContext, message, customer);

      // Handle name collection side effect
      const collectingName = currentStep === 'collecting_name';
      currentStep = response.nextStep;
      currentContext = response.nextContext;

      if (collectingName && trimmed.length >= 2 && !trimmed.startsWith('/')) {
        const formatted = trimmed
          .toLowerCase()
          .replace(/\b\w/g, (c) => c.toUpperCase());
        customerName = formatted;
        printSystem(`[Customer name saved: ${customerName}]`);
      }

      // Send replies
      response.replies.forEach(printBot);

      // Handle effects
      response.effects.forEach(printEffect);

      prompt();
    });
  };

  prompt();
}

main().catch((err: unknown) => {
  console.error('Simulator error:', err);
  process.exit(1);
});
