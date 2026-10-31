import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * The dispatch numeric env guards.
 *
 * `functions/src/config/env.ts` reads `process.env` at module load, so each case
 * re-imports a fresh copy with the variable set.
 *
 * Two bugs of the same shape are pinned here:
 *   - audit finding 13: `Number("6s")` is NaN and `setTimeout(fn, NaN)` fires
 *     IMMEDIATELY, so every dispatch quote would time out at once;
 *   - review finding on 39efc40: the same NaN in DISPATCH_FARE_CONFIRM_DELTA_INR
 *     silently disables the DR7 fare-confirmation gate, because every
 *     `|delta| > NaN` comparison is false.
 */

async function freshDispatchConfig(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  vi.resetModules();
  try {
    const mod = await import("../src/config/env");
    return mod.config.dispatch as { quoteTimeoutMs: number; fareConfirmDeltaInr: number };
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("dispatch numeric env guards (finding 13 + review on 39efc40)", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("falls back to 6000 when DISPATCH_QUOTE_TIMEOUT_MS is not a number (finding 13)", async () => {
    const cfg = await freshDispatchConfig({ DISPATCH_QUOTE_TIMEOUT_MS: "6s" });
    expect(cfg.quoteTimeoutMs).toBe(6000);
    expect(Number.isFinite(cfg.quoteTimeoutMs)).toBe(true); // never NaN -> setTimeout would fire now
  });

  it("honours a valid DISPATCH_QUOTE_TIMEOUT_MS", async () => {
    const cfg = await freshDispatchConfig({ DISPATCH_QUOTE_TIMEOUT_MS: "1500" });
    expect(cfg.quoteTimeoutMs).toBe(1500);
  });

  it("falls back to 20 when DISPATCH_FARE_CONFIRM_DELTA_INR is not a number (review)", async () => {
    const cfg = await freshDispatchConfig({ DISPATCH_FARE_CONFIRM_DELTA_INR: "20rs" });
    expect(cfg.fareConfirmDeltaInr).toBe(20);
    expect(Number.isFinite(cfg.fareConfirmDeltaInr)).toBe(true);
    // The failure mode the guard removes: a NaN threshold makes the DR7 gate
    // compare false forever, so a large fare delta would never be confirmed.
    expect(Math.abs(150 - cfg.fareConfirmDeltaInr) > cfg.fareConfirmDeltaInr).toBe(true);
  });

  it("honours a valid DISPATCH_FARE_CONFIRM_DELTA_INR and rejects 0 / negative", async () => {
    expect(
      (await freshDispatchConfig({ DISPATCH_FARE_CONFIRM_DELTA_INR: "150" })).fareConfirmDeltaInr
    ).toBe(150);
    // 0 would mean "confirm on any change" and is not supported; use a positive
    // threshold. Both fall back to the documented default rather than disabling
    // the gate.
    expect(
      (await freshDispatchConfig({ DISPATCH_FARE_CONFIRM_DELTA_INR: "0" })).fareConfirmDeltaInr
    ).toBe(20);
    expect(
      (await freshDispatchConfig({ DISPATCH_FARE_CONFIRM_DELTA_INR: "-5" })).fareConfirmDeltaInr
    ).toBe(20);
  });

  it("uses the documented defaults when both variables are unset", async () => {
    const cfg = await freshDispatchConfig({
      DISPATCH_QUOTE_TIMEOUT_MS: undefined,
      DISPATCH_FARE_CONFIRM_DELTA_INR: undefined,
    });
    expect(cfg.quoteTimeoutMs).toBe(6000);
    expect(cfg.fareConfirmDeltaInr).toBe(20);
  });
});
