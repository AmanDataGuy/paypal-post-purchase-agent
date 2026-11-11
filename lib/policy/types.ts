/**
 * # types.ts - shared types for the merchant policy engine
 *
 * - `Policy` is the merchant's rulebook (limits, windows). `Decision` is what the engine returns.
 * - Pure types only. Used by the policy functions, the tool gateway and the tests.
 */

export const REASON_CODES = [
  "NOT_RECEIVED",
  "DAMAGED",
  "NOT_AS_DESCRIBED",
  "WRONG_ITEM",
  "DUPLICATE_CHARGE",
  "CHANGED_MIND",
  "LATE_DELIVERY",
  "SUBSCRIPTION_UNWANTED",
  "OTHER",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

// Who is asking: a person in our chat/voice widget, or a buyer's AI agent over MCP.
export type Caller = "CUSTOMER" | "BUYER_AGENT";

export type Policy = {
  currency: "USD";
  refunds: {
    autoApproveMaxCents: number;
    buyerAgentAutoApproveMaxCents: number; // AI agents get a lower auto limit than people
    maxRefundsPerCustomer30d: number;
    maxAutoRefundCentsPerCustomer30d: number;
    stalledShipmentDays: number;
    changedMindWindowDays: number;
    changedMindRequiresReturn: boolean;
  };
};

export type DecisionKind = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

export type Decision = { kind: DecisionKind; reason: string };

// Everything the refund rules need, fetched fresh by the gateway. Never taken from the LLM.
export type RefundFacts = {
  caller: Caller;
  verifiedForOrder: boolean;
  customerConfirmed: boolean;
  requestCurrency: string;
  captureCurrency: string;
  amountCents: number;
  capturedCents: number;
  refundedCents: number;
  openDispute: boolean;
  reason: ReasonCode;
  shipment: { status: "NOT_SHIPPED" | "SHIPPED" | "DELIVERED"; daysSinceUpdate: number };
  daysSinceCapture: number;
  duplicateProvable: boolean;
  customerRefunds30d: { count: number; autoCents: number };
  merchantApproved: boolean;
};
