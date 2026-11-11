/**
 * # testing.ts - shared test world: in-memory DB seeded with one customer/order, plus a fake PayPal
 *
 * - Used by gateway and agent tests (and later evals) so all of them exercise the same world.
 * - The fake PayPal keeps refunds per capture and replays on the same PayPal-Request-Id, like the real API.
 */
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createDb, type Db } from "./db/client";
import * as schema from "./db/schema";
import { conversations, customers, orders, shipments } from "./db/schema";
import type { Deps } from "./gateway/tools";
import type { paypal as paypalFn } from "./paypal/client";

export const NOW = new Date("2026-11-05T12:00:00Z");
export const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

// Migrate one in-memory DB per test worker, then hand each test a cheap clone of it.
let template: Promise<PGlite> | undefined;
async function freshDb(): Promise<Db> {
  template ??= createDb("memory://").then((db) => (db as unknown as { $client: PGlite }).$client);
  return drizzle((await (await template).clone()) as PGlite, { schema }) as unknown as Db;
}

export type WorldOptions = { cents?: number; ship?: "NOT_SHIPPED" | "SHIPPED" | "DELIVERED"; daysSinceUpdate?: number; daysSinceCapture?: number };

// Build a fresh world: JP-1042 for sam@example.test (default $38, shipped, stalled 9 days), conversations chat1 + mcp1.
export async function makeWorld({ cents = 3800, ship = "SHIPPED", daysSinceUpdate = 9, daysSinceCapture = 12 }: WorldOptions = {}) {
  const value = (cents / 100).toFixed(2);
  const db = await freshDb();
  const paypalCalls: string[] = [];
  const openDisputes: string[] = [];
  const refundsByCapture: Record<string, { id: string; status: string; amount: { value: string } }[]> = { CAP1: [] };
  const byRequestId: Record<string, unknown> = {};

  const paypal = (async (method: string, path: string, opts: { body?: { amount: { value: string } }; requestId?: string } = {}) => {
    paypalCalls.push(`${method} ${path}`);
    if (method === "GET" && path === "/v2/checkout/orders/PPO1")
      return {
        purchase_units: [
          { payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { value, currency_code: "USD" } }], refunds: refundsByCapture.CAP1 } },
        ],
      };
    if (method === "GET" && path.startsWith("/v1/customer/disputes")) return { items: openDisputes.map(() => ({ status: "OPEN" })) };
    if (method === "POST" && path === "/v2/payments/captures/CAP1/refund") {
      if (opts.requestId && byRequestId[opts.requestId]) return byRequestId[opts.requestId];
      const r = { id: `REF${refundsByCapture.CAP1.length + 1}`, status: "COMPLETED", amount: { value: opts.body!.amount.value } };
      refundsByCapture.CAP1.push(r);
      if (opts.requestId) byRequestId[opts.requestId] = r;
      return r;
    }
    throw new Error(`fake PayPal: unexpected ${method} ${path}`);
  }) as typeof paypalFn;

  const [c] = await db.insert(customers).values({ email: "sam@example.test", name: "Sam" }).returning();
  const [o] = await db
    .insert(orders)
    .values({
      orderNumber: "JP-1042",
      customerId: c.id,
      paypalOrderId: "PPO1",
      captureId: "CAP1",
      totalCents: cents,
      currency: "USD",
      items: [{ name: "Mug set", quantity: 1, unitCents: cents }],
      capturedAt: daysAgo(daysSinceCapture),
    })
    .returning();
  await db.insert(shipments).values({ orderId: o.id, status: ship, carrier: "Fern Post", trackingNumber: "FP123", lastUpdateAt: daysAgo(daysSinceUpdate) });
  await db.insert(conversations).values([
    { id: "chat1", channel: "CHAT" },
    { id: "mcp1", channel: "MCP" },
  ]);

  const deps: Deps = { db, paypal, now: () => NOW };
  return { db, deps, paypalCalls, openDisputes, refundPosts: () => paypalCalls.filter((x) => x.startsWith("POST")).length };
}
