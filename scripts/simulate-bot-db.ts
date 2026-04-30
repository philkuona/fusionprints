/**
 * FusionPrints Bot — Database-backed CLI Simulator
 *
 * Like simulate-bot.ts but uses the REAL database.
 * Tests the full stack: state machine + Postgres persistence.
 *
 * Usage: npm run db:migrate && npx tsx scripts/simulate-bot-db.ts
 *
 * What this proves:
 *   - Conversation state persists between messages
 *   - Orders are created in the database
 *   - Customers are created and recognised
 *   - You can quit mid-order, restart, and pick up where you left off
 *
 * Special commands:
 *   /phone +263771234567  — switch to a different simulated phone number
 *   /db orders            — show recent orders in the database
 *   /db customers         — show customers in the database
 *   /quit                 — exit (state is saved — restart to continue)
 */

import * as readline from 'readline';
process.env['LOG_LEVEL'] = 'silent';
import { handleIncomingMessage } from '../src/bot/handler.js';
import { db, closeDatabase } from '../src/db/client.js';
import { orders, customers } from '../src/db/schema.js';
import { desc } from 'drizzle-orm';
import type { IncomingMessage } from '../src/bot/state-machine.js';

// ===== Simulator config =====

let currentPhone = '+263771000001'; // default test number

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

async function showDbOrders(): Promise<void> {
  const rows = await db
    .select()
    .from(orders)
    .orderBy(desc(orders.createdAt))
    .limit(10);

  console.log(`\n${GREY}  ┌─ Database: orders (last 10) ────────────`);
  if (rows.length === 0) {
    console.log(`  │ (none)`);
  } else {
    rows.forEach((o) => {
      console.log(`  │ ${o.orderNumber}  ${o.status.padEnd(22)}  $${o.totalUsd}`);
    });
  }
  console.log(`  └──────────────────────────────────────────${RESET}\n`);
}

async function showDbCustomers(): Promise<void> {
  const rows = await db
    .select()
    .from(customers)
    .orderBy(desc(customers.createdAt))
    .limit(10);

  console.log(`\n${GREY}  ┌─ Database: customers ───────────────────`);
  if (rows.length === 0) {
    console.log(`  │ (none)`);
  } else {
    rows.forEach((c) => {
      const name = c.name ?? '(no name yet)';
      console.log(`  │ ${c.phoneNumber}  ${name}`);
    });
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
  console.log(`  ║  FusionPrints Bot — DB Simulator       ║`);
  console.log(`  ╚════════════════════════════════════════╝${RESET}`);
  console.log();
  console.log(`${GREY}  Using phone: ${currentPhone}`);
  console.log(`  State persists to Postgres between messages.`);
  console.log(`  Quit and restart to test persistence.`);
  console.log();
  console.log(`  Commands:`);
  console.log(`    /image 3024 4032      — simulate good document upload`);
  console.log(`    /compressed 800 600   — simulate compressed photo`);
  console.log(`    /phone +263771000002  — switch test phone number`);
  console.log(`    /db orders            — show orders in database`);
  console.log(`    /db customers         — show customers in database`);
  console.log(`    /quit                 — exit (state is saved)${RESET}`);
  console.log();

  // Send initial "hi" to trigger the greeting
  printSystem(`Sending initial greeting for ${currentPhone}...`);
  const initial = await handleIncomingMessage({
    phoneNumber: currentPhone,
    message: { text: 'hi' },
  });
  initial.replies.forEach(printBot);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): void => {
    rl.question(`${GREEN}  You: ${RESET}`, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // Meta commands
      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log(`\n  State saved. Goodbye!\n`);
        await closeDatabase();
        rl.close();
        return;
      }

      if (trimmed.startsWith('/phone ')) {
        currentPhone = trimmed.replace('/phone ', '').trim();
        printSystem(`Switched to phone: ${currentPhone}`);
        const greeting = await handleIncomingMessage({
          phoneNumber: currentPhone,
          message: { text: 'hi' },
        });
        greeting.replies.forEach(printBot);
        prompt();
        return;
      }

      if (trimmed === '/db orders') {
        await showDbOrders();
        prompt();
        return;
      }

      if (trimmed === '/db customers') {
        await showDbCustomers();
        prompt();
        return;
      }

      // Check for image simulation commands
      const simulatedMessage = parseSimulatorCommand(trimmed);
      const message: IncomingMessage = simulatedMessage ?? { text: trimmed };

      try {
        const result = await handleIncomingMessage({
          phoneNumber: currentPhone,
          message,
        });
        result.replies.forEach(printBot);
      } catch (err) {
        console.error(`${YELLOW}  Error: ${err}${RESET}`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch((err: unknown) => {
  console.error('Simulator error:', err);
  process.exit(1);
});
