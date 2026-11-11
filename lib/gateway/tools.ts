/**
 * # tools.ts - the narrow business tools the AI may call, with their input schemas and handlers
 *
 * - Same tools for our chat agent and for buyer AI agents over MCP; `ctx.caller` tells them apart.
 * - Handlers never trust amounts or IDs from the model: they look up the order, fetch fresh PayPal facts, and run
 *   the policy engine before anything moves.
 */
import { createHash } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { fromCents, toCents } from "../money";
import { decideRefund } from "../policy/refund";
import { DEFAULT_POLICY } from "../policy/default-policy";
import { REASON_CODES, type Caller, type ReasonCode } from "../policy/types";
import type { paypal as paypalFn } from "../paypal/client";
import type { Db } from "../db/client";
import { approvals, conversations, customers, idempotencyKeys, orders, refunds, shipments, toolCalls } from "../db/schema";

export type Ctx = { conversationId: string; caller: Caller };
export type Deps = { db: Db; paypal: typeof paypalFn; now: () => Date };
export type ToolResult = { ok: boolean; message: string; data?: unknown; decision?: { kind: string; reason: string } };

const DAY = 86_400_000;
const LOCK_AFTER_FAILS = 3; // per conversation
const ORDER_LOCK_AFTER_FAILS = 5; // per order number, across all conversations and MCP sessions
const LOCK_MINUTES = 15;

// "jp 1042", "JP1042", "j-p-1042" -> "JP-1042"
export function normaliseOrderNumber(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = /^([A-Z]+)(\d+)$/.exec(s);
  return m ? `${m[1]}-${m[2]}` : raw.trim().toUpperCase();
}

const orderNumber = z.string().min(3).max(20).describe("Store order number, e.g. JP-1042");

export const schemas = {
  verify_customer: z.strictObject({ order_number: orderNumber, email: z.string().max(200) }),
  get_order_status: z.strictObject({ order_number: orderNumber }),
  issue_refund: z.strictObject({
    order_number: orderNumber,
    amount: z.string().regex(/^\d+\.\d{2}$/).describe('Amount in USD with two decimals, e.g. "38.00"'),
    reason_code: z.enum(REASON_CODES),
    customer_confirmed: z.boolean().describe("True only if the customer explicitly said yes to this exact amount"),
  }),
  handoff_to_human: z.strictObject({ summary: z.string().max(1000) }),
};

export type ToolName = keyof typeof schemas;

export const descriptions: Record<ToolName, string> = {
  verify_customer:
    "Check that the person owns an order: store order number plus the email used at checkout. Call this before any other tool. On failure, say the details don't match; never reveal whether the order or email exists.",
  get_order_status:
    "Read the real order from PayPal and our shipping records: items, total, amount already refunded, refundable amount, shipment status and days since the last carrier update. Use before suggesting any remedy.",
  issue_refund:
    "Refund part or all of a verified order to the original payment method. Ask the customer to confirm the exact amount first. The shop's policy may allow it, send it to the shop for approval, or deny it; report the result as given.",
  handoff_to_human:
    "Pass the conversation to the shop owner with a short summary. Use when the customer asks for a person or the problem is outside these tools.",
};

// Anthropic tool definitions, built once and in a fixed order so the prompt cache stays valid.
export const anthropicTools = (Object.keys(schemas) as ToolName[]).map((name) => {
  const input_schema = z.toJSONSchema(schemas[name]) as Record<string, unknown>;
  delete input_schema.$schema;
  return { name, description: descriptions[name], strict: true, input_schema };
});

// Look up the order and check this conversation is verified for its customer.
async function ownedOrder(deps: Deps, ctx: Ctx, rawNumber: string) {
  const [conv] = await deps.db.select().from(conversations).where(eq(conversations.id, ctx.conversationId));
  const [order] = await deps.db.select().from(orders).where(eq(orders.orderNumber, normaliseOrderNumber(rawNumber)));
  if (!conv?.verifiedCustomerId || !order || order.customerId !== conv.verifiedCustomerId) return undefined;
  return order;
}

type PayPalOrder = {
  purchase_units: {
    payments?: {
      captures?: { id: string; status: string; amount: { value: string; currency_code: string } }[];
      refunds?: { id: string; status: string; amount: { value: string } }[];
    };
  }[];
};

// Fresh money facts from PayPal: captured amount, currency, total already refunded.
async function paypalFacts(deps: Deps, paypalOrderId: string, captureId: string) {
  const o = await deps.paypal<PayPalOrder>("GET", `/v2/checkout/orders/${paypalOrderId}`);
  const pay = o.purchase_units[0]?.payments;
  const capture = pay?.captures?.find((c) => c.id === captureId);
  if (!capture) throw new Error(`Capture ${captureId} not found on PayPal order`);
  const refundedCents = (pay?.refunds ?? [])
    .filter((r) => r.status !== "FAILED" && r.status !== "CANCELLED")
    .reduce((s, r) => s + toCents(r.amount.value), 0);
  return { capturedCents: toCents(capture.amount.value), currency: capture.amount.currency_code, refundedCents };
}

// Is there an open PayPal dispute on this capture?
async function hasOpenDispute(deps: Deps, captureId: string) {
  const r = await deps.paypal<{ items?: { status: string }[] }>("GET", `/v1/customer/disputes?disputed_transaction_id=${captureId}`);
  return (r.items ?? []).some((d) => d.status !== "RESOLVED");
}

const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / DAY);

type Input<T extends ToolName> = z.infer<(typeof schemas)[T]>;

export const handlers: { [K in ToolName]: (input: Input<K>, ctx: Ctx, deps: Deps) => Promise<ToolResult> } = {
  // Mark the conversation verified for the order's customer, with a lockout after repeated failures.
  async verify_customer(input, ctx, deps) {
    const [conv] = await deps.db.select().from(conversations).where(eq(conversations.id, ctx.conversationId));
    if (!conv) return { ok: false, message: "Unknown conversation." };
    const target = normaliseOrderNumber(input.order_number);
    const locked = { ok: false, message: "Too many failed attempts. Please try again in a few minutes.", data: { order_number: target } };
    if (conv.lockedUntil && conv.lockedUntil > deps.now()) return locked;
    // Lock per order too: opening a new chat or MCP session must not reset the guess budget for one order.
    const [recent] = await deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.tool, "verify_customer"),
          eq(toolCalls.ok, 0),
          sql`${toolCalls.createdAt} > now() - make_interval(mins => ${LOCK_MINUTES})`,
          sql`${toolCalls.result}->'data'->>'order_number' = ${target}`,
        ),
      );
    if ((recent?.n ?? 0) >= ORDER_LOCK_AFTER_FAILS) return locked;
    const [row] = await deps.db
      .select({ customerId: customers.id, email: customers.email, name: customers.name })
      .from(orders)
      .innerJoin(customers, eq(orders.customerId, customers.id))
      .where(eq(orders.orderNumber, target));
    if (!row || row.email.toLowerCase() !== input.email.trim().toLowerCase()) {
      // Atomic increment, so parallel guesses in one session can't share a stale count.
      const [{ fails }] = await deps.db
        .update(conversations)
        .set({ failedVerifications: sql`${conversations.failedVerifications} + 1` })
        .where(eq(conversations.id, conv.id))
        .returning({ fails: conversations.failedVerifications });
      if (fails >= LOCK_AFTER_FAILS)
        await deps.db
          .update(conversations)
          .set({ failedVerifications: 0, lockedUntil: new Date(deps.now().getTime() + LOCK_MINUTES * 60_000) })
          .where(eq(conversations.id, conv.id));
      return { ok: false, message: "Those details don't match our records.", data: { order_number: target } };
    }
    await deps.db
      .update(conversations)
      .set({ verifiedCustomerId: row.customerId, failedVerifications: 0 })
      .where(eq(conversations.id, conv.id));
    return { ok: true, message: "Verified.", data: { customer_name: row.name } };
  },

  // Order facts the agent must quote rather than invent.
  async get_order_status(input, ctx, deps) {
    const order = await ownedOrder(deps, ctx, input.order_number);
    if (!order) return { ok: false, message: "Order not found for this verified customer. Verify first." };
    const [ship] = await deps.db.select().from(shipments).where(eq(shipments.orderId, order.id));
    const pp = await paypalFacts(deps, order.paypalOrderId, order.captureId);
    return {
      ok: true,
      message: "Order facts.",
      data: {
        order_number: order.orderNumber,
        items: order.items.map((i) => `${i.quantity} x ${i.name}`),
        total: fromCents(pp.capturedCents),
        currency: pp.currency,
        paid_on: order.capturedAt.toISOString().slice(0, 10),
        refunded_so_far: fromCents(pp.refundedCents),
        refundable_now: fromCents(pp.capturedCents - pp.refundedCents),
        shipping: ship
          ? {
              status: ship.status,
              carrier: ship.carrier,
              tracking_number: ship.trackingNumber,
              days_since_last_update: daysBetween(ship.lastUpdateAt, deps.now()),
              counts_as_lost_after_days: DEFAULT_POLICY.refunds.stalledShipmentDays,
            }
          : { status: "NOT_SHIPPED" },
      },
    };
  },

  // Policy-gated refund: ALLOW -> PayPal refund now, REQUIRE_APPROVAL -> queue for the merchant, DENY -> explain.
  async issue_refund(input, ctx, deps) {
    const order = await ownedOrder(deps, ctx, input.order_number);
    if (!order) return { ok: false, message: "Not verified for this order.", decision: { kind: "DENY", reason: "not_verified_for_order" } };
    return refundOrder(deps, ctx, order, {
      amountCents: toCents(input.amount),
      reason: input.reason_code,
      customerConfirmed: input.customer_confirmed,
    });
  },

  async handoff_to_human(input) {
    // shortcut: the summary lives in the tool_calls audit row; the merchant inbox reads it from there.
    return { ok: true, message: "Passed to the shop. They will reply by email within one business day.", data: { summary: input.summary } };
  },
};

type OrderRow = typeof orders.$inferSelect;
type RefundRequest = { amountCents: number; reason: ReasonCode; customerConfirmed: boolean; merchantApproved?: boolean };

// shortcut: in-process lock per customer (single Render instance); use pg_advisory_xact_lock if we ever scale out.
const customerLocks = new Map<string, Promise<unknown>>();

// Run fn after any refund already in progress for the same customer, so caps and refundable amounts are read fresh.
function withCustomerLock<T>(customerId: string, fn: () => Promise<T>): Promise<T> {
  const run = (customerLocks.get(customerId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  customerLocks.set(customerId, tail);
  void tail.then(() => customerLocks.get(customerId) === tail && customerLocks.delete(customerId));
  return run;
}

// Gather fresh facts, decide, then refund / queue / deny. Shared by the agent tool and merchant approvals.
export function refundOrder(deps: Deps, ctx: Ctx, order: OrderRow, req: RefundRequest): Promise<ToolResult> {
  return withCustomerLock(order.customerId, () => decideAndRefund(deps, ctx, order, req));
}

async function decideAndRefund(deps: Deps, ctx: Ctx, order: OrderRow, req: RefundRequest): Promise<ToolResult> {
  // The same request in the same conversation maps to one key. Check it before deciding: after the first refund the
  // order is no longer refundable, and a repeat must say "already issued", not "denied".
  const key = createHash("sha256").update([ctx.conversationId, order.id, req.amountCents, req.reason].join("|")).digest("hex");
  const [seen] = await deps.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
  if (seen?.result) return { ...(seen.result as ToolResult), message: "This refund was already issued." };

  const now = deps.now();
  const [ship] = await deps.db.select().from(shipments).where(eq(shipments.orderId, order.id));
  const pp = await paypalFacts(deps, order.paypalOrderId, order.captureId);
  const [recent] = await deps.db
    .select({ count: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
    .from(refunds)
    .innerJoin(orders, eq(refunds.orderId, orders.id))
    .where(and(eq(orders.customerId, order.customerId), gte(refunds.createdAt, new Date(now.getTime() - 30 * DAY)), eq(refunds.source, "AGENT")));
  // A duplicate is provable when the same customer paid the same total twice within 10 minutes.
  const sameTotal = await deps.db
    .select({ capturedAt: orders.capturedAt })
    .from(orders)
    .where(and(eq(orders.customerId, order.customerId), eq(orders.totalCents, order.totalCents)));
  const at = order.capturedAt.getTime();
  const duplicateProvable = sameTotal.some((o) => o.capturedAt.getTime() !== at && Math.abs(o.capturedAt.getTime() - at) < 10 * 60_000);

  const decision = decideRefund(
    {
      caller: ctx.caller,
      verifiedForOrder: true,
      customerConfirmed: req.customerConfirmed,
      requestCurrency: "USD",
      captureCurrency: pp.currency,
      amountCents: req.amountCents,
      capturedCents: pp.capturedCents,
      refundedCents: pp.refundedCents,
      openDispute: await hasOpenDispute(deps, order.captureId),
      reason: req.reason,
      shipment: { status: ship?.status ?? "NOT_SHIPPED", daysSinceUpdate: ship ? daysBetween(ship.lastUpdateAt, now) : 0 },
      daysSinceCapture: daysBetween(order.capturedAt, now),
      duplicateProvable,
      customerRefunds30d: { count: recent?.count ?? 0, autoCents: recent?.cents ?? 0 },
      merchantApproved: req.merchantApproved ?? false,
    },
    DEFAULT_POLICY,
  );

  if (decision.kind === "DENY") return { ok: false, message: `Refund not allowed: ${decision.reason}.`, decision };

  if (decision.kind === "REQUIRE_APPROVAL") {
    const pending = (await deps.db.select().from(approvals).where(and(eq(approvals.orderId, order.id), eq(approvals.status, "PENDING")))).find(
      (a) => a.payload.amountCents === req.amountCents && a.payload.reason === req.reason,
    );
    const approval =
      pending ??
      (
        await deps.db
          .insert(approvals)
          .values({
            orderId: order.id,
            kind: "REFUND",
            payload: { amountCents: req.amountCents, reason: req.reason, caller: ctx.caller },
            decisionReason: decision.reason,
            conversationId: ctx.conversationId,
          })
          .returning()
      )[0];
    return {
      ok: true,
      message: "Sent to the shop for approval. The customer will hear back within one business day.",
      decision,
      data: { approval_id: approval.id },
    };
  }

  // ALLOW. PayPal-Request-Id = our key, so even a crash between this call and our insert cannot refund twice.
  const r = await deps.paypal<{ id: string; status: string }>("POST", `/v2/payments/captures/${order.captureId}/refund`, {
    requestId: key,
    body: { amount: { value: fromCents(req.amountCents), currency_code: pp.currency }, note_to_payer: `Refund for order ${order.orderNumber}` },
  });
  const result: ToolResult = {
    ok: true,
    message: `Refunded ${fromCents(req.amountCents)} ${pp.currency} to the original payment method.`,
    decision,
    data: { refund_id: r.id, status: r.status, amount: fromCents(req.amountCents) },
  };
  await deps.db
    .insert(refunds)
    .values({ orderId: order.id, paypalRefundId: r.id, amountCents: req.amountCents, reason: req.reason, source: req.merchantApproved ? "APPROVAL" : "AGENT" })
    .onConflictDoNothing();
  await deps.db.insert(idempotencyKeys).values({ key, result }).onConflictDoNothing();
  return result;
}
