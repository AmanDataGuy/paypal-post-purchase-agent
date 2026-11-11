/**
 * # cases.test.ts - dispute sync, deterministic evidence, and link-gated submission (fake PayPal)
 */
import { expect, it } from "vitest";
import { buildEvidence, submitEvidence, syncCases, type Dispute } from "./cases";
import { execute } from "./gateway/gateway";
import { makeWorld } from "./testing";
import type { paypal as paypalFn } from "./paypal/client";

// Wrap the world's fake PayPal with a dispute D1 on CAP1; `links` controls what PayPal allows.
function withDispute(base: typeof paypalFn, links: { href: string; rel: string }[], posted: string[]) {
  const dispute: Dispute = {
    dispute_id: "D1",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_amount: { value: "38.00", currency_code: "USD" },
    seller_response_due_date: "2026-11-15T00:00:00Z",
    disputed_transactions: [{ seller_transaction_id: "CAP1" }],
    links,
  };
  return (async (method: string, path: string, opts?: { form?: FormData }) => {
    if (method === "GET" && path === "/v1/customer/disputes?page_size=50") return { items: [{ dispute_id: "D1" }] };
    if (method === "GET" && path === "/v1/customer/disputes/D1") return dispute;
    if (method === "POST" && path === "/v1/customer/disputes/D1/provide-evidence") {
      posted.push(await (opts!.form!.get("input") as Blob).text());
      return {};
    }
    return base(method, path, opts as never);
  }) as typeof paypalFn;
}

const evidenceLink = { href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/D1/provide-evidence", rel: "provide_evidence" };

it("builds evidence from the refund, tracking and audit trail, then submits once", async () => {
  const w = await makeWorld();
  const chat = { conversationId: "chat1", caller: "CUSTOMER" as const };
  await execute("verify_customer", { order_number: "JP-1042", email: "sam@example.test" }, chat, w.deps);
  await execute("issue_refund", { order_number: "JP-1042", amount: "38.00", reason_code: "NOT_RECEIVED", customer_confirmed: true }, chat, w.deps);

  const posted: string[] = [];
  const deps = { ...w.deps, paypal: withDispute(w.deps.paypal, [evidenceLink], posted) };
  expect(await syncCases(deps)).toBe(1);
  const { evidences } = await buildEvidence(deps, "D1");
  expect(evidences.map((e) => e.evidence_type)).toEqual(["PROOF_OF_REFUND", "PROOF_OF_FULFILLMENT", "OTHER"]);
  expect(evidences[0].evidence_info).toEqual({ refund_ids: ["REF1"] });

  expect((await submitEvidence(deps, "D1")).ok).toBe(true);
  expect(JSON.parse(posted[0]).evidences).toHaveLength(3);
  expect((await submitEvidence(deps, "D1")).message).toMatch(/already submitted/);
  expect(posted).toHaveLength(1);
});

it("does not submit when PayPal offers no provide-evidence link", async () => {
  const w = await makeWorld();
  const posted: string[] = [];
  const deps = { ...w.deps, paypal: withDispute(w.deps.paypal, [{ href: "https://x/v1/customer/disputes/D1", rel: "self" }], posted) };
  await syncCases(deps);
  await buildEvidence(deps, "D1");
  expect((await submitEvidence(deps, "D1")).ok).toBe(false);
  expect(posted).toHaveLength(0);
});
