/**
 * Per-key in-process mutex.
 *
 * Serialises async work that shares the same key so concurrent operations can't
 * interleave. Used to serialise WhatsApp message handling per customer: the bot
 * does a read-modify-write of conversation state, so two near-simultaneous
 * messages from the same number could otherwise clobber each other (lost cart
 * items, double-fired effects). Each key runs its work strictly in arrival order.
 *
 * Single-instance only (the backend runs as one process). If the backend is ever
 * horizontally scaled, replace this with a database/advisory lock keyed the same.
 */

const chains = new Map<string, Promise<unknown>>();

export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  // Run fn after the previous holder settles — success OR failure — so one
  // failed message doesn't permanently block the next for that key.
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {}); // chain continuation that never rejects
  chains.set(key, tail);
  void tail.finally(() => {
    // Drop the entry once this is the last queued work for the key.
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
