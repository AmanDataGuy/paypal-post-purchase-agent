/**
 * # gateway.test.ts - tool gateway end to end: in-memory Postgres (PGlite) + the fake PayPal from lib/testing
 */
import { beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvals, conversations, toolCalls } from "../db/schema";
import { pathTemplate } from "../paypal/client";
import { makeWorld } from "../testing";
import { execute } from "./gateway";
import { normaliseOrderNumber, type Ctx } from "./tools";

let w: Awaited<ReturnType<typeof makeWorld>>;
beforeEach(async () => {
  w = await makeWorld();
});

const chat: Ctx = { conversationId: "chat1", caller: "CUSTOMER" };
const agent: Ctx = { conversationId: "mcp1", caller: "BUYER_AGENT" };
const verify = (ctx = chat) => execute("verify_customer", { order_number: "jp 1042", email: "SAM@example.test" }, ctx, w.deps);
const refund = (amount: string, ctx = chat) =>
  execute("issue_refund", { order_number: "JP-1042", amount, reason_code: "NOT_RECEIVED", customer_confirmed: true }, ctx, w.deps);

it("normalises spoken and typed order numbers", () => {
  expect(normaliseOrderNumber("jp 1042")).toBe("JP-1042");
  expect(normaliseOrderNumber("J-P-1042")).toBe("JP-1042");
});

it("refuses to act before verification", async () => {
  const r = await refund("38.00");
  expect(r.decision).toEqual({ kind: "DENY", reason: "not_verified_for_order" });
  expect(w.refundPosts()).toBe(0);
});

it("locks the conversation after three wrong emails", async () => {
  for (let i = 0; i < 3; i++) await execute("verify_customer", { order_number: "JP-1042", email: "x@x.test" }, chat, w.deps);
  expect((await verify()).message).toMatch(/Too many failed attempts/);
});

it("reports real order facts after verification", async () => {
  expect((await verify()).ok).toBe(true);
  const r = await execute("get_order_status", { order_number: "JP-1042" }, chat, w.deps);
  expect(r.data).toMatchObject({ total: "38.00", refundable_now: "38.00", shipping: { status: "SHIPPED", days_since_last_update: 9 } });
});

it("refunds a stalled order once, even when asked twice", async () => {
  await verify();
  const first = await refund("38.00");
  expect(first.decision).toEqual({ kind: "ALLOW", reason: "auto_refund_under_limit" });
  expect(first.data).toMatchObject({ refund_id: "REF1" });
  expect((await refund("38.00")).message).toMatch(/already issued/);
  expect(w.refundPosts()).toBe(1);
});

it("denies an injected oversized refund without calling PayPal", async () => {
  await verify();
  expect((await refund("500.00")).decision).toEqual({ kind: "DENY", reason: "amount_exceeds_refundable" });
  expect(w.refundPosts()).toBe(0);
});

it("denies while a PayPal dispute is open", async () => {
  await verify();
  w.openDisputes.push("D1");
  expect((await refund("38.00")).decision?.reason).toBe("dispute_open_use_dispute_flow");
});

it("sends a buyer agent's $38 request to merchant approval (lower agent limit)", async () => {
  await verify(agent);
  expect((await refund("38.00", agent)).decision).toEqual({ kind: "REQUIRE_APPROVAL", reason: "over_auto_limit" });
  expect(await w.db.select().from(approvals)).toHaveLength(1);
  expect(w.refundPosts()).toBe(0);
});

it("locks an order after 5 failed guesses spread over new conversations (no reset by reconnecting)", async () => {
  const ids = ["g1", "g2", "g3", "g4", "g5", "g6"];
  await w.db.insert(conversations).values(ids.map((id) => ({ id, channel: "MCP" as const })));
  for (const id of ids.slice(0, 5))
    await execute("verify_customer", { order_number: "JP-1042", email: "guess@x.test" }, { conversationId: id, caller: "BUYER_AGENT" }, w.deps);
  const right = await execute("verify_customer", { order_number: "JP 1042", email: "sam@example.test" }, { conversationId: "g6", caller: "BUYER_AGENT" }, w.deps);
  expect(right.message).toMatch(/Too many failed attempts/);
});

it("serialises concurrent refunds so per-customer caps hold", async () => {
  const ids = ["p1", "p2", "p3"];
  await w.db.insert(conversations).values(ids.map((id) => ({ id, channel: "CHAT" as const })));
  const ctxs = ids.map((id): Ctx => ({ conversationId: id, caller: "CUSTOMER" }));
  for (const c of ctxs) await verify(c);
  const results = await Promise.all(
    ctxs.map((c) => execute("issue_refund", { order_number: "JP-1042", amount: "10.00", reason_code: "DAMAGED", customer_confirmed: true }, c, w.deps)),
  );
  expect(results.map((r) => r.decision?.kind).sort()).toEqual(["ALLOW", "ALLOW", "REQUIRE_APPROVAL"]);
  expect(w.refundPosts()).toBe(2);
});

it("keeps PayPal ids out of the live trace", () => {
  expect(pathTemplate("/v2/payments/captures/3C679366HH908993F/refund")).toBe("/v2/payments/captures/:id/refund");
  expect(pathTemplate("/v1/customer/disputes/PP-D-12345?x=1")).toBe("/v1/customer/disputes/:id");
  expect(pathTemplate("/v2/checkout/orders")).toBe("/v2/checkout/orders");
});

it("rejects malformed input at the boundary and audits every call", async () => {
  const r = await execute("issue_refund", { order_number: "JP-1042", amount: "38", reason_code: "NOT_RECEIVED", customer_confirmed: true }, chat, w.deps);
  expect(r.message).toMatch(/Invalid input/);
  await execute("drop_tables", {}, chat, w.deps);
  const rows = await w.db.select().from(toolCalls).where(eq(toolCalls.conversationId, "chat1"));
  expect(rows.map((x) => x.tool)).toEqual(["issue_refund", "drop_tables"]);
});
