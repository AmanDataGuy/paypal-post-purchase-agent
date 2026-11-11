/**
 * # money.test.ts - round-trip and rejection cases for money helpers
 */
import { expect, it } from "vitest";
import { fromCents, toCents } from "./money";

it("parses PayPal amounts", () => {
  expect(toCents("38.00")).toBe(3800);
  expect(toCents("0.5")).toBe(50);
  expect(toCents("120")).toBe(12000);
  expect(toCents("0.07")).toBe(7);
});

it("formats cents", () => {
  expect(fromCents(3800)).toBe("38.00");
  expect(fromCents(7)).toBe("0.07");
});

it("rejects junk", () => {
  for (const bad of ["-1.00", "1.234", "1e3", "", "abc"]) expect(() => toCents(bad)).toThrow();
  expect(() => fromCents(1.5)).toThrow();
});
