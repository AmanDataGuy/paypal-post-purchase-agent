/**
 * # default-policy.ts - the demo merchant's refund rules
 *
 * - One constant, used by the gateway and the tests.
 */
import type { Policy } from "./types";

export const DEFAULT_POLICY: Policy = {
  currency: "USD",
  refunds: {
    autoApproveMaxCents: 5000,
    buyerAgentAutoApproveMaxCents: 3000,
    maxRefundsPerCustomer30d: 2,
    maxAutoRefundCentsPerCustomer30d: 8000,
    stalledShipmentDays: 7,
    changedMindWindowDays: 30,
    changedMindRequiresReturn: true,
  },
};
