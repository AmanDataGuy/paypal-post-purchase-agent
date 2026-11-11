/**
 * # approvals.test.ts - merchant approve/deny of held refunds
 */
import { beforeEach, expect, it } from "vitest";
import { approvals } from "../db/schema";
import { makeWorld } from "../testing";
import { decideApproval } from "./approvals";
import { execute } from "./gateway";
import type { Ctx } from "./tools";

const agent: Ctx = { conversationId: "mcp1", caller: "BUYER_AGENT" };
let w: Awaited<ReturnType<typeof makeWorld>>;

// A buyer agent asks for $38: over its limit, so it waits for the merchant.
async function pendingApprovalId() {
  await execute("verify_customer", { order_number: "JP-1042", email: "sam@example.test" }, agent, w.deps);
  const r = await execute("issue_refund", { order_number: "JP-1042", amount: "38.00", reason_code: "NOT_RECEIVED", customer_confirmed: true }, agent, w.deps);
  return (r.data as { approval_id: string }).approval_id;
}

beforeEach(async () => {
  w = await makeWorld();
});

it("approve executes the refund once", async () => {
  const id = await pendingApprovalId();
  const r = await decideApproval(id, true, w.deps);
  expect(r.decision).toEqual({ kind: "ALLOW", reason: "merchant_approved" });
  expect(w.refundPosts()).toBe(1);
  expect((await decideApproval(id, true, w.deps)).message).toMatch(/no longer pending/);
  expect((await w.db.select().from(approvals))[0].status).toBe("EXECUTED");
});

it("approve never overrides a deny (dispute opened meanwhile)", async () => {
  const id = await pendingApprovalId();
  w.openDisputes.push("D1");
  const r = await decideApproval(id, true, w.deps);
  expect(r.decision?.kind).toBe("DENY");
  expect(w.refundPosts()).toBe(0);
  expect((await w.db.select().from(approvals))[0].status).toBe("FAILED");
});

it("deny moves no money", async () => {
  const id = await pendingApprovalId();
  await decideApproval(id, false, w.deps);
  expect(w.refundPosts()).toBe(0);
  expect((await w.db.select().from(approvals))[0].status).toBe("DENIED");
});
