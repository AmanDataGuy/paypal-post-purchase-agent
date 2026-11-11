/**
 * # client.test.ts - PayPal client behaviour with a fake fetch (no network)
 */
import { beforeEach, expect, it, vi } from "vitest";

vi.stubEnv("PAYPAL_CLIENT_ID", "id");
vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");

const { paypal, PayPalError } = await import("./client");

type Call = { url: string; init: RequestInit };
let calls: Call[];

// Queue of fake responses for non-token calls; token calls always succeed.
function fakeFetch(queue: Response[]) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: `t${calls.length}`, expires_in: 32400 });
    return queue.shift()!;
  });
}
const apiCalls = () => calls.filter((c) => !c.url.endsWith("/oauth2/token"));
const header = (c: Call, k: string) => (c.init.headers as Record<string, string>)[k];

beforeEach(() => vi.restoreAllMocks());

it("sends PayPal-Request-Id and returns JSON", async () => {
  fakeFetch([Response.json({ id: "R1" }, { status: 201 })]);
  const r = await paypal<{ id: string }>("POST", "/v2/payments/captures/C1/refund", { body: {}, requestId: "k1" });
  expect(r.id).toBe("R1");
  expect(header(apiCalls()[0], "PayPal-Request-Id")).toBe("k1");
});

it("retries 5xx then succeeds", async () => {
  fakeFetch([new Response("", { status: 503 }), Response.json({ ok: true })]);
  await expect(paypal("GET", "/v2/checkout/orders/O1")).resolves.toEqual({ ok: true });
  expect(apiCalls()).toHaveLength(2);
});

it("refreshes the token once on 401", async () => {
  fakeFetch([new Response("", { status: 401 }), Response.json({ ok: true })]);
  await paypal("GET", "/v2/checkout/orders/O1");
  const [first, second] = apiCalls();
  expect(header(first, "Authorization")).not.toBe(header(second, "Authorization"));
});

it("throws a typed error with the debug id", async () => {
  fakeFetch([
    Response.json({ name: "UNPROCESSABLE_ENTITY", message: "too much" }, { status: 422, headers: { "paypal-debug-id": "dbg1" } }),
  ]);
  const err = await paypal("POST", "/v2/payments/captures/C1/refund", { body: {} }).catch((e) => e);
  expect(err).toBeInstanceOf(PayPalError);
  expect(err).toMatchObject({ status: 422, code: "UNPROCESSABLE_ENTITY", debugId: "dbg1" });
});
