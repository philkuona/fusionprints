/**
 * Customer service.
 *
 * Handles all database operations for customers.
 * Customers are identified by their WhatsApp phone number (E.164 format).
 *
 * Key behaviour:
 *   - First contact: creates a new customer record
 *   - Returning customer: returns existing record
 *   - Name update: saved when collected during order flow
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { customers, conversationState } from '@/db/schema.js';
import { emptyContext } from '@/bot/types.js';
import { logger } from '@/utils/logger.js';
import type { Customer } from '@/db/schema.js';

/**
 * Find a customer by phone number, or create one if they don't exist.
 * Also ensures they have a conversation_state row.
 *
 * @param phoneNumber - E.164 format e.g. +263771234567
 */
export async function findOrCreateCustomer(phoneNumber: string): Promise<Customer> {
  // Try to find existing customer
  const existing = await db
    .select()
    .from(customers)
    .where(eq(customers.phoneNumber, phoneNumber))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  // Create new customer
  logger.info({ phoneNumber }, 'New customer — creating record');

  const [newCustomer] = await db
    .insert(customers)
    .values({ phoneNumber })
    .returning();

  // Create their conversation state row (starts at idle)
  await db.insert(conversationState).values({
    customerId: newCustomer.id,
    currentStep: 'idle',
    context: emptyContext(),
  });

  return newCustomer;
}

/**
 * Update a customer's name.
 * Called when the bot collects it during the first order.
 */
export async function updateCustomerName(
  customerId: string,
  name: string,
): Promise<void> {
  await db
    .update(customers)
    .set({
      name,
      lastOrderAt: new Date(),
    })
    .where(eq(customers.id, customerId));

  logger.info({ customerId, name }, 'Customer name updated');
}

/**
 * Update a customer's email.
 * Called when the bot collects it during the first order (for receipts + QBO).
 */
export async function updateCustomerEmail(
  customerId: string,
  email: string,
): Promise<void> {
  await db
    .update(customers)
    .set({ email })
    .where(eq(customers.id, customerId));

  logger.info({ customerId }, 'Customer email updated');
}

/**
 * Update the lastOrderAt timestamp.
 * Called when an order is confirmed.
 */
export async function touchCustomerLastOrder(customerId: string): Promise<void> {
  await db
    .update(customers)
    .set({ lastOrderAt: new Date() })
    .where(eq(customers.id, customerId));
}
