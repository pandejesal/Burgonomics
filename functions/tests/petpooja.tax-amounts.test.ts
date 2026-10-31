import { describe, expect, it } from "vitest";
import { allocatePetpoojaTax } from "../src/modules/petpooja/taxAmounts";

describe("Petpooja minor-unit tax allocation", () => {
  it("conserves an odd-paise total with deterministic row ordering", () => {
    expect(allocatePetpoojaTax(13.95, [2.5, 2.5])).toEqual([6.98, 6.97]);
  });
  it("respects the published weights rather than assuming equal rates", () => {
    expect(allocatePetpoojaTax(5, [1, 4])).toEqual([1, 4]);
  });
  it("does not assign a remainder to a zero-weight line", () => {
    expect(allocatePetpoojaTax(.01, [0, 1, 1])).toEqual([0, .01, 0]);
  });
  it("conserves paise over many quantities, small totals and odd splits", () => {
    for (let minor = 0; minor < 1000; minor++) {
      const parts = allocatePetpoojaTax(minor / 100, [3, 7, 11]);
      expect(parts.reduce((sum, amount) => sum + Math.round(amount * 100), 0)).toBe(minor);
      expect(parts.every((amount) => amount >= 0)).toBe(true);
    }
  });
  it("supports a genuinely zero total without fabricating tax", () => {
    expect(allocatePetpoojaTax(0, [0, 0])).toEqual([0, 0]);
    expect(allocatePetpoojaTax(0, [])).toEqual([]);
  });
  it("fails closed for unrepresentable or non-finite allocation inputs", () => {
    for (const amount of [-1, NaN, Infinity]) expect(() => allocatePetpoojaTax(amount, [1])).toThrow();
    expect(() => allocatePetpoojaTax(1, [])).toThrow();
    expect(() => allocatePetpoojaTax(1, [0])).toThrow();
    expect(() => allocatePetpoojaTax(1, [NaN])).toThrow();
  });
});
