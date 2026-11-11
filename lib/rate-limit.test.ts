/**
 * # rate-limit.test.ts - window counting and reset
 */
import { expect, it } from "vitest";
import { allow, clientIp } from "./rate-limit";

it("allows `limit` requests per window, then resets", () => {
  const t = 1_000_000;
  expect([1, 2, 3].map(() => allow("k", 2, 1000, t))).toEqual([true, true, false]);
  expect(allow("k", 2, 1000, t + 1000)).toBe(true);
});

it("uses the proxy-appended client address", () => {
  expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "6.6.6.6, 1.2.3.4" } }))).toBe("1.2.3.4");
});
