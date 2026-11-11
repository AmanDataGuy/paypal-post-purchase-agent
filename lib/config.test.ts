/**
 * # config.test.ts - the sandbox-only guard
 */
import { expect, it } from "vitest";
import { loadEnv } from "./config";

const ok = { PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };

it("defaults to the sandbox", () => {
  expect(loadEnv(ok).PAYPAL_BASE_URL).toBe("https://api-m.sandbox.paypal.com");
});

it("refuses the live API", () => {
  expect(() => loadEnv({ ...ok, PAYPAL_BASE_URL: "https://api-m.paypal.com" })).toThrow(/Bad environment/);
});

it("requires credentials", () => {
  expect(() => loadEnv({})).toThrow(/PAYPAL_CLIENT_ID/);
});
