/**
 * # deps.ts - the real dependencies (DB, PayPal client, clock) handed to the gateway by route handlers
 */
import { getDb } from "./db/client";
import { paypal } from "./paypal/client";
import type { Deps } from "./gateway/tools";

// Build Deps for a request. Tests build their own with a fake PayPal (lib/testing.ts).
export async function realDeps(): Promise<Deps> {
  return { db: await getDb(), paypal, now: () => new Date() };
}
