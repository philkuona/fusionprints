import { db } from '../src/db/client.js';
import { webUsers } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function run() {
  await db.update(webUsers).set({ emailVerified: true }).where(eq(webUsers.email, 'phil.tina18@gmail.com'));
  console.log('verified');
  process.exit(0);
}
run();
