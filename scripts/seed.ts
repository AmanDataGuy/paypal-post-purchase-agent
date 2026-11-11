/**
 * # seed.ts - creates the demo orders in the PayPal sandbox and mirrors them in our DB
 *
 * - Run: `npm run seed`. Prints a PayPal approve link per order; log in as the SANDBOX BUYER and approve each one.
 *   The script waits, captures each approved order, and writes customers / orders / shipments.
 * - Server-side card orders are not available on this sandbox account (spike S2), hence the buyer approval step.
 * - Idempotent: order numbers already in the DB are skipped. Shipping dates are simulated relative to today.
 * - Hosted DB: `DATABASE_URL=<external url> SEED_RUN=render npm run seed` (fresh PayPal orders for that DB).
 */
import { eq } from "drizzle-orm";
import { createDb } from "../lib/db/client";
import { customers, orders, shipments } from "../lib/db/schema";
import { fromCents } from "../lib/money";
import { paypal } from "../lib/paypal/client";

type Demo = {
  number: string;
  email: string;
  name: string;
  item: string;
  cents: number;
  ship: "NOT_SHIPPED" | "SHIPPED" | "DELIVERED";
  daysSinceUpdate: number;
  why: string;
};

// One order per demo beat; emails are what customers type to verify (fictional).
const DEMO: Demo[] = [
  { number: "JP-1042", email: "sam@example.test", name: "Sam", item: "Speckled mug set", cents: 3800, ship: "SHIPPED", daysSinceUpdate: 9, why: "stalled, under limit -> auto refund" },
  { number: "JP-1017", email: "priya@example.test", name: "Priya", item: "Large serving bowl", cents: 12000, ship: "SHIPPED", daysSinceUpdate: 10, why: "stalled, over $50 -> merchant approval" },
  { number: "JP-1023", email: "alex@example.test", name: "Alex", item: "Bud vase pair", cents: 5400, ship: "DELIVERED", daysSinceUpdate: 3, why: "delivered per tracking -> approval, not auto" },
  { number: "JP-1050", email: "lee@example.test", name: "Lee", item: "Teapot", cents: 4500, ship: "SHIPPED", daysSinceUpdate: 8, why: "buyer AI agent asks: over agent limit -> approval" },
  { number: "JP-1061", email: "sam@example.test", name: "Sam", item: "Spoon rest", cents: 2200, ship: "NOT_SHIPPED", daysSinceUpdate: 0, why: "not shipped, small -> agent auto refund" },
];

type PPOrder = { id: string; status: string; links: { rel: string; href: string }[] };
type Captured = { purchase_units: { payments: { captures: { id: string; status: string }[] } }[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = await createDb();
  const todo: { demo: Demo; order: PPOrder }[] = [];

  for (const demo of DEMO) {
    const [exists] = await db.select().from(orders).where(eq(orders.orderNumber, demo.number));
    if (exists) {
      console.log(`skip ${demo.number} (already seeded)`);
      continue;
    }
    const order = await paypal<PPOrder>("POST", "/v2/checkout/orders", {
      // Fixed id so a crashed run can resume the same orders. SEED_RUN gives a second database its own orders:
      // PayPal refuses to replay a create for an order that is already captured.
      requestId: `seed-${demo.number}${process.env.SEED_RUN ? `-${process.env.SEED_RUN}` : ""}`,
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: demo.number,
            description: demo.item,
            amount: { currency_code: "USD", value: fromCents(demo.cents), breakdown: { item_total: { currency_code: "USD", value: fromCents(demo.cents) } } },
            items: [{ name: demo.item, quantity: "1", unit_amount: { currency_code: "USD", value: fromCents(demo.cents) } }],
          },
        ],
        payment_source: {
          paypal: { experience_context: { brand_name: "Juniper & Pine", user_action: "PAY_NOW", return_url: "https://example.com/approved", cancel_url: "https://example.com/cancelled" } },
        },
      },
    });
    todo.push({ demo, order });
    const link = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    console.log(`\n${demo.number} $${fromCents(demo.cents)} (${demo.why})\n  approve: ${link}`);
  }
  if (todo.length) console.log("\nLog in with the SANDBOX BUYER account and approve each link. Waiting...");

  for (const { demo, order } of todo) {
    for (;;) {
      // A network blip while waiting for the buyer is not fatal: check again next tick.
      const o = await paypal<PPOrder>("GET", `/v2/checkout/orders/${order.id}`).catch((e) => (console.warn(`  (retrying: ${e.message})`), null));
      if (o?.status === "APPROVED") break;
      await sleep(4000);
    }
    const cap = await paypal<Captured>("POST", `/v2/checkout/orders/${order.id}/capture`, { requestId: `capture-${order.id}`, body: {} });
    const captureId = cap.purchase_units[0].payments.captures[0].id;

    const [c] = await db.insert(customers).values({ email: demo.email, name: demo.name }).onConflictDoNothing().returning();
    const customerId = c?.id ?? (await db.select().from(customers).where(eq(customers.email, demo.email)))[0].id;
    const now = Date.now();
    const [row] = await db
      .insert(orders)
      .values({
        orderNumber: demo.number,
        customerId,
        paypalOrderId: order.id,
        captureId,
        totalCents: demo.cents,
        currency: "USD",
        items: [{ name: demo.item, quantity: 1, unitCents: demo.cents }],
        capturedAt: new Date(now - (demo.daysSinceUpdate + 3) * 86_400_000), // shortcut: simulated purchase date
      })
      .returning();
    await db.insert(shipments).values({
      orderId: row.id,
      status: demo.ship,
      carrier: demo.ship === "NOT_SHIPPED" ? null : "Fern Post",
      trackingNumber: demo.ship === "NOT_SHIPPED" ? null : `FP${demo.number.slice(3)}US`,
      lastUpdateAt: new Date(now - demo.daysSinceUpdate * 86_400_000),
    });
    console.log(`captured ${demo.number}: capture ${captureId}`);
  }
  console.log("\nDone. Verify in chat with an order number and its email, e.g. JP-1042 + sam@example.test");
}

// Exit explicitly: the open embedded-Postgres handle would otherwise keep Node running.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
