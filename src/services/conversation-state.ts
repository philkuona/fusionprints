/**
 * Conversation state service.
 *
 * Reads and writes the bot's conversation state to the database.
 * This is what makes the bot "remember" where a customer is in the flow
 * between messages — even if hours pass between them.
 *
 * The state machine itself is stateless (pure functions).
 * This service is the persistence layer around it.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { conversationState } from '@/db/schema.js';
import { emptyContext } from '@/bot/types.js';
import { logger } from '@/utils/logger.js';
import type { BotStep, BotContext } from '@/bot/types.js';

export interface ConversationStateData {
  currentStep: BotStep;
  context: BotContext;
}

/**
 * Load the current conversation state for a customer.
 * Returns idle + empty context if no state exists yet.
 */
export async function loadConversationState(
  customerId: string,
): Promise<ConversationStateData> {
  const rows = await db
    .select()
    .from(conversationState)
    .where(eq(conversationState.customerId, customerId))
    .limit(1);

  if (rows.length === 0) {
    // Shouldn't happen if findOrCreateCustomer was called first, but be safe
    logger.warn({ customerId }, 'No conversation state found — returning idle');
    return { currentStep: 'idle', context: emptyContext() };
  }

  const row = rows[0];

  return {
    currentStep: row.currentStep as BotStep,
    context: row.context as BotContext,
  };
}

/**
 * Save updated conversation state after processing a message.
 * Uses upsert so it works whether or not the row already exists.
 */
export async function saveConversationState(
  customerId: string,
  step: BotStep,
  context: BotContext,
): Promise<void> {
  await db
    .insert(conversationState)
    .values({
      customerId,
      currentStep: step,
      context: context as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: conversationState.customerId,
      set: {
        currentStep: step,
        context: context as Record<string, unknown>,
        updatedAt: new Date(),
      },
    });

  logger.debug({ customerId, step }, 'Conversation state saved');
}

/**
 * Reset a customer's conversation to idle.
 * Called after an order is complete, or on explicit CANCEL.
 */
export async function resetConversationState(customerId: string): Promise<void> {
  await saveConversationState(customerId, 'idle', emptyContext());
  logger.info({ customerId }, 'Conversation state reset to idle');
}
