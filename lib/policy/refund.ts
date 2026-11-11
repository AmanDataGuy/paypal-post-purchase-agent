/**
 * # refund.ts - decides whether a refund may run, needs merchant approval, or is denied
 *
 * - Pure function, no I/O. Input: fresh facts from PayPal + our DB, and the merchant policy.
 * - Checks run in a fixed order; the first DENY or REQUIRE_APPROVAL wins.
 * - Merchant approval turns REQUIRE_APPROVAL into ALLOW, never DENY into ALLOW.
 */
import type { Decision, Policy, RefundFacts } from "./types";

const deny = (reason: string): Decision => ({ kind: "DENY", reason });
const approval = (reason: string): Decision => ({ kind: "REQUIRE_APPROVAL", reason });

// Rule for the stated reason. null means the reason is fine for an automatic refund.
function reasonRule(f: RefundFacts, p: Policy): Decision | null {
  switch (f.reason) {
    case "NOT_RECEIVED":
    case "LATE_DELIVERY": // same tracking rule, or "late" would dodge the not-stalled-yet denial
      if (f.shipment.status === "NOT_SHIPPED") return null;
      if (f.shipment.status === "DELIVERED") return approval("delivered_per_tracking");
      return f.shipment.daysSinceUpdate >= p.refunds.stalledShipmentDays ? null : deny("shipment_not_stalled_yet");
    case "DUPLICATE_CHARGE":
      return f.duplicateProvable ? null : approval("duplicate_not_provable");
    case "CHANGED_MIND":
      if (f.daysSinceCapture > p.refunds.changedMindWindowDays) return deny("changed_mind_window_passed");
      return p.refunds.changedMindRequiresReturn ? approval("return_required") : null;
    case "DAMAGED":
      return null;
    default:
      return approval("reason_needs_review");
  }
}

// Run every refund check in order and return the decision.
export function decideRefund(f: RefundFacts, p: Policy): Decision {
  const refundable = f.capturedCents - f.refundedCents;
  const autoMax = f.caller === "BUYER_AGENT" ? p.refunds.buyerAgentAutoApproveMaxCents : p.refunds.autoApproveMaxCents;
  const capReached =
    f.customerRefunds30d.count >= p.refunds.maxRefundsPerCustomer30d ||
    f.customerRefunds30d.autoCents + f.amountCents > p.refunds.maxAutoRefundCentsPerCustomer30d;

  const checks: (() => Decision | null)[] = [
    () => (f.verifiedForOrder ? null : deny("not_verified_for_order")),
    () => (f.customerConfirmed ? null : deny("customer_not_confirmed")),
    () => (f.requestCurrency === f.captureCurrency ? null : deny("currency_mismatch")),
    () => (f.amountCents > 0 && f.amountCents <= refundable ? null : deny("amount_exceeds_refundable")),
    // Refunding outside an open dispute can pay the buyer twice.
    () => (f.openDispute ? deny("dispute_open_use_dispute_flow") : null),
    () => reasonRule(f, p),
    () => (capReached ? approval("customer_cap_reached") : null),
    () => (f.amountCents <= autoMax ? null : approval("over_auto_limit")),
  ];

  let lifted = false;
  for (const check of checks) {
    const d = check();
    if (!d) continue;
    if (d.kind === "REQUIRE_APPROVAL" && f.merchantApproved) {
      lifted = true;
      continue;
    }
    return d;
  }
  return { kind: "ALLOW", reason: lifted ? "merchant_approved" : "auto_refund_under_limit" };
}
