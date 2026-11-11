/**
 * # cases.ts - PayPal disputes ("cases"): sync them, build evidence from our records, submit on merchant approval
 *
 * - Evidence is assembled deterministically from facts we hold (refund IDs, tracking, the agent's audit trail);
 *   no LLM writes evidence, so nothing can be invented.
 * - Submission checks the dispute's HATEOAS links first: PayPal decides which actions are allowed right now.
 */
import { and, asc, eq } from "drizzle-orm";
import { cases, orders, refunds, shipments, toolCalls } from "./db/schema";
import { toCents } from "./money";
import type { Deps } from "./gateway/tools";

type Link = { href: string; rel: string; method?: string };
export type Dispute = {
  dispute_id: string;
  reason: string;
  status: string;
  dispute_amount: { value: string; currency_code: string };
  seller_response_due_date?: string;
  disputed_transactions?: { seller_transaction_id?: string }[];
  links: Link[];
};
type Evidence = { evidence_type: "PROOF_OF_FULFILLMENT" | "PROOF_OF_REFUND" | "OTHER"; evidence_info?: Record<string, unknown>; notes: string };

// Pull every dispute from PayPal and upsert it, linked to our order by capture (= seller transaction) id.
export async function syncCases(deps: Deps): Promise<number> {
  const list = await deps.paypal<{ items?: { dispute_id: string }[] }>("GET", "/v1/customer/disputes?page_size=50");
  for (const { dispute_id } of list.items ?? []) {
    const d = await deps.paypal<Dispute>("GET", `/v1/customer/disputes/${dispute_id}`);
    const captureId = d.disputed_transactions?.[0]?.seller_transaction_id;
    const [order] = captureId ? await deps.db.select().from(orders).where(eq(orders.captureId, captureId)) : [];
    const row = {
      orderId: order?.id ?? null,
      reason: d.reason,
      status: d.status,
      amountCents: toCents(d.dispute_amount.value),
      dueAt: d.seller_response_due_date ? new Date(d.seller_response_due_date) : null,
      raw: d,
      updatedAt: deps.now(),
    };
    await deps.db.insert(cases).values({ id: d.dispute_id, ...row }).onConflictDoUpdate({ target: cases.id, set: row });
  }
  return list.items?.length ?? 0;
}

// Build the provide-evidence payload for a case from refunds, tracking and the support conversation.
export async function buildEvidence(deps: Deps, caseId: string): Promise<{ evidences: Evidence[] }> {
  const [c] = await deps.db.select().from(cases).where(eq(cases.id, caseId));
  if (!c?.orderId) throw new Error(`Case ${caseId} is not linked to one of our orders`);
  const [order] = await deps.db.select().from(orders).where(eq(orders.id, c.orderId));
  const done = await deps.db.select().from(refunds).where(eq(refunds.orderId, c.orderId));
  const [ship] = await deps.db.select().from(shipments).where(eq(shipments.orderId, c.orderId));
  const trail = await deps.db
    .select()
    .from(toolCalls)
    .where(and(eq(toolCalls.tool, "issue_refund"), eq(toolCalls.ok, 1)))
    .orderBy(asc(toolCalls.createdAt));
  const forOrder = trail.filter((t) => (t.input as { order_number?: string }).order_number === order.orderNumber);

  const evidences: Evidence[] = [];
  if (done.length)
    evidences.push({
      evidence_type: "PROOF_OF_REFUND",
      evidence_info: { refund_ids: done.map((r) => r.paypalRefundId) },
      notes: `Refunded through our support assistant before this case: ${done.map((r) => `${r.paypalRefundId} (${(r.amountCents / 100).toFixed(2)} USD, ${r.createdAt.toISOString().slice(0, 10)})`).join("; ")}.`,
    });
  if (ship?.trackingNumber && ship.status !== "NOT_SHIPPED")
    evidences.push({
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: { tracking_info: [{ carrier_name: "OTHER", carrier_name_other: ship.carrier ?? "Other", tracking_number: ship.trackingNumber }] },
      notes: `Shipped with ${ship.carrier}, tracking ${ship.trackingNumber}; last carrier status ${ship.status} on ${ship.lastUpdateAt.toISOString().slice(0, 10)}.`,
    });
  if (forOrder.length)
    evidences.push({
      evidence_type: "OTHER",
      notes: `Support log: the buyer contacted us ${forOrder.length} time(s) about order ${order.orderNumber}; every refund decision is recorded with its policy reason (${forOrder.map((t) => `${t.createdAt.toISOString().slice(0, 16)} ${t.decisionKind}:${t.decisionReason}`).join("; ")}).`,
    });
  await deps.db.update(cases).set({ evidence: { input: { evidences } } }).where(eq(cases.id, caseId));
  return { evidences };
}

// Submit the prepared evidence, but only if PayPal currently offers provide-evidence on this dispute.
export async function submitEvidence(deps: Deps, caseId: string): Promise<{ ok: boolean; message: string }> {
  const [c] = await deps.db.select().from(cases).where(eq(cases.id, caseId));
  const input = (c?.evidence as { input?: { evidences: Evidence[] }; submittedAt?: string } | null) ?? null;
  if (!input?.input?.evidences.length) return { ok: false, message: "No evidence prepared for this case." };
  if (input.submittedAt) return { ok: true, message: "Evidence was already submitted." };
  const fresh = await deps.paypal<Dispute>("GET", `/v1/customer/disputes/${caseId}`);
  if (!fresh.links.some((l) => l.href.endsWith("/provide-evidence")))
    return { ok: false, message: `PayPal does not accept evidence on this case right now (status ${fresh.status}).` };

  const form = new FormData();
  form.append("input", new Blob([JSON.stringify(input.input)], { type: "application/json" }));
  await deps.paypal("POST", `/v1/customer/disputes/${caseId}/provide-evidence`, { form, requestId: `evidence-${caseId}` });
  await deps.db
    .update(cases)
    .set({ evidence: { ...input, submittedAt: deps.now().toISOString() }, status: "EVIDENCE_SUBMITTED" })
    .where(eq(cases.id, caseId));
  return { ok: true, message: "Evidence submitted to PayPal." };
}
