/**
 * # refund.test.ts - table-driven tests for the refund policy
 *
 * - One row per rule, plus boundary rows (exactly at a limit, one cent over).
 * - Run with `npm test`.
 */
import { describe, expect, it } from "vitest";
import { decideRefund } from "./refund";
import { DEFAULT_POLICY } from "./default-policy";
import type { RefundFacts } from "./types";

// A clean auto-approvable request: stalled $38 order, verified, confirmed.
const base: RefundFacts = {
  caller: "CUSTOMER",
  verifiedForOrder: true,
  customerConfirmed: true,
  requestCurrency: "USD",
  captureCurrency: "USD",
  amountCents: 3800,
  capturedCents: 3800,
  refundedCents: 0,
  openDispute: false,
  reason: "NOT_RECEIVED",
  shipment: { status: "SHIPPED", daysSinceUpdate: 9 },
  daysSinceCapture: 12,
  duplicateProvable: false,
  customerRefunds30d: { count: 0, autoCents: 0 },
  merchantApproved: false,
};

const rows: [string, Partial<RefundFacts>, string][] = [
  ["happy path", {}, "ALLOW:auto_refund_under_limit"],
  ["not verified", { verifiedForOrder: false }, "DENY:not_verified_for_order"],
  ["not confirmed", { customerConfirmed: false }, "DENY:customer_not_confirmed"],
  ["currency trick", { requestCurrency: "EUR" }, "DENY:currency_mismatch"],
  ["zero amount", { amountCents: 0 }, "DENY:amount_exceeds_refundable"],
  ["one cent over refundable", { amountCents: 2901, refundedCents: 900 }, "DENY:amount_exceeds_refundable"],
  ["exactly the remaining refundable", { amountCents: 2900, refundedCents: 900 }, "ALLOW:auto_refund_under_limit"],
  ["open dispute", { openDispute: true }, "DENY:dispute_open_use_dispute_flow"],
  ["not received, not stalled yet", { shipment: { status: "SHIPPED", daysSinceUpdate: 6 } }, "DENY:shipment_not_stalled_yet"],
  ["late delivery, not stalled yet", { reason: "LATE_DELIVERY", shipment: { status: "SHIPPED", daysSinceUpdate: 2 } }, "DENY:shipment_not_stalled_yet"],
  ["not received, stalled exactly at threshold", { shipment: { status: "SHIPPED", daysSinceUpdate: 7 } }, "ALLOW:auto_refund_under_limit"],
  ["not received, never shipped", { shipment: { status: "NOT_SHIPPED", daysSinceUpdate: 0 } }, "ALLOW:auto_refund_under_limit"],
  ["not received but tracking says delivered", { shipment: { status: "DELIVERED", daysSinceUpdate: 1 } }, "REQUIRE_APPROVAL:delivered_per_tracking"],
  ["duplicate provable", { reason: "DUPLICATE_CHARGE", duplicateProvable: true }, "ALLOW:auto_refund_under_limit"],
  ["duplicate not provable", { reason: "DUPLICATE_CHARGE" }, "REQUIRE_APPROVAL:duplicate_not_provable"],
  ["changed mind, window passed", { reason: "CHANGED_MIND", daysSinceCapture: 31 }, "DENY:changed_mind_window_passed"],
  ["changed mind, return required", { reason: "CHANGED_MIND" }, "REQUIRE_APPROVAL:return_required"],
  ["damaged, auto", { reason: "DAMAGED" }, "ALLOW:auto_refund_under_limit"],
  ["not as described needs review", { reason: "NOT_AS_DESCRIBED" }, "REQUIRE_APPROVAL:reason_needs_review"],
  ["refund count cap", { customerRefunds30d: { count: 2, autoCents: 0 } }, "REQUIRE_APPROVAL:customer_cap_reached"],
  ["refund amount cap", { customerRefunds30d: { count: 1, autoCents: 5000 } }, "REQUIRE_APPROVAL:customer_cap_reached"],
  ["exactly at auto limit", { amountCents: 5000, capturedCents: 6000 }, "ALLOW:auto_refund_under_limit"],
  ["one cent over auto limit", { amountCents: 5001, capturedCents: 6000 }, "REQUIRE_APPROVAL:over_auto_limit"],
  ["buyer agent over its lower limit", { caller: "BUYER_AGENT" }, "REQUIRE_APPROVAL:over_auto_limit"],
  ["buyer agent under its limit", { caller: "BUYER_AGENT", amountCents: 2500 }, "ALLOW:auto_refund_under_limit"],
  ["merchant approval lifts approval", { amountCents: 12000, capturedCents: 12000, merchantApproved: true }, "ALLOW:merchant_approved"],
  ["merchant approval never lifts a deny", { openDispute: true, merchantApproved: true }, "DENY:dispute_open_use_dispute_flow"],
];

describe("decideRefund", () => {
  it.each(rows)("%s", (_name, patch, expected) => {
    const d = decideRefund({ ...base, ...patch }, DEFAULT_POLICY);
    expect(`${d.kind}:${d.reason}`).toBe(expected);
  });
});
