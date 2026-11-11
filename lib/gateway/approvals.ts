/**
 * # approvals.ts - the merchant approves or denies a refund the policy held back
 *
 * - Approve re-runs the policy on fresh PayPal facts with merchantApproved = true: that lifts REQUIRE_APPROVAL but
 *   never a DENY (e.g. a dispute opened meanwhile, or the order was refunded elsewhere).
 */
import { and, eq } from "drizzle-orm";
import { approvals, orders } from "../db/schema";
import type { Caller, ReasonCode } from "../policy/types";
import { refundOrder, type Deps, type ToolResult } from "./tools";

// Apply the merchant's decision to one pending approval and return what happened.
export async function decideApproval(id: string, approve: boolean, deps: Deps): Promise<ToolResult> {
  // Claim it atomically: only one of two simultaneous clicks (approve/approve or approve/deny) gets the row.
  const [a] = await deps.db
    .update(approvals)
    .set({ status: approve ? "APPROVED" : "DENIED", decidedAt: deps.now() })
    .where(and(eq(approvals.id, id), eq(approvals.status, "PENDING")))
    .returning();
  if (!a) return { ok: false, message: "This request is no longer pending." };
  if (!approve) return { ok: true, message: "Request denied." };
  const [order] = await deps.db.select().from(orders).where(eq(orders.id, a.orderId));
  const result = await refundOrder(
    deps,
    { conversationId: a.conversationId ?? `approval:${a.id}`, caller: a.payload.caller as Caller },
    order,
    { amountCents: a.payload.amountCents, reason: a.payload.reason as ReasonCode, customerConfirmed: true, merchantApproved: true },
  );
  const executed = result.ok && result.decision?.kind === "ALLOW";
  await deps.db.update(approvals).set({ status: executed ? "EXECUTED" : "FAILED", result }).where(eq(approvals.id, id));
  return result;
}
