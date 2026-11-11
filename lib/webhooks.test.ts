/**
 * # webhooks.test.ts - signature check, duplicate drop, dispute events trigger a sync
 */
import { expect, it } from "vitest";
import { handleWebhook } from "./webhooks";
import { makeWorld } from "./testing";
import type { paypal as paypalFn } from "./paypal/client";

// Fake PayPal that answers signature checks with `status` and counts dispute list calls.
async function setup(status: "SUCCESS" | "FAILURE") {
  const w = await makeWorld();
  const seen = { syncs: 0 };
  const paypal = (async (method: string, path: string) => {
    if (path === "/v1/notifications/verify-webhook-signature") return { verification_status: status };
    if (path.startsWith("/v1/customer/disputes?")) return (seen.syncs++, { items: [] });
    throw new Error(`unexpected ${method} ${path}`);
  }) as typeof paypalFn;
  return { deps: { ...w.deps, paypal }, seen };
}

const post = (body: unknown, signed = true) =>
  new Request("http://x/api/webhooks/paypal", {
    method: "POST",
    body: JSON.stringify(body),
    headers: signed ? { "paypal-transmission-sig": "sig", "paypal-cert-url": "https://api.sandbox.paypal.com/cert" } : {},
  });
const disputeEvent = { id: "WH-1", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "D1" } };

it("accepts a verified dispute event once and syncs cases", async () => {
  const { deps, seen } = await setup("SUCCESS");
  expect(await (await handleWebhook(post(disputeEvent), deps, "WHID")).json()).toEqual({ ok: true, duplicate: false });
  expect(await (await handleWebhook(post(disputeEvent), deps, "WHID")).json()).toEqual({ ok: true, duplicate: true });
  expect(seen.syncs).toBe(1);
});

it("rejects events PayPal does not verify", async () => {
  const { deps, seen } = await setup("FAILURE");
  expect((await handleWebhook(post(disputeEvent), deps, "WHID")).status).toBe(400);
  expect(seen.syncs).toBe(0);
});

it("rejects unsigned junk without calling PayPal", async () => {
  const { deps } = await setup("SUCCESS");
  const calls: string[] = [];
  const spy = { ...deps, paypal: (async (m: string, p: string) => (calls.push(p), deps.paypal(m, p))) as typeof deps.paypal };
  expect((await handleWebhook(post(disputeEvent, false), spy, "WHID")).status).toBe(400);
  expect(calls).toHaveLength(0);
});
