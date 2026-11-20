import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Settlement WIRING contract (owner decision 2026-11-20).
 *
 * There is no HTTP harness in this repo, so the route list, the scheduler and
 * the App Check enrolment are pinned as text — the same technique the other
 * route suites use. Behavioural coverage for the maths and the service lives in
 * settlements.math.test.ts and settlements.service.test.ts.
 */

const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8").replace(/\r\n/g, "\n");

function routeBlock(path: string): string {
  // Skip the App Check enrolment list (a bare string in an array) and land on
  // the real `app.post("/settlements/...", ...)` registration.
  const start = source.indexOf(`app.post(\n  "${path}"`);
  expect(start, `${path} must be routed`).toBeGreaterThan(-1);
  return source.slice(start, start + 420);
}

describe("settlement routes", () => {
  it("generate + markPaid are brand-only, validated and App Check enrolled", () => {
    for (const path of ["/settlements/generate", "/settlements/markPaid"]) {
      const block = routeBlock(path);
      expect(block).toContain("requireAuth");
      expect(block).toMatch(/requireRole\(\["brand_owner",\s*"developer"\]\)/);
      expect(block).toMatch(/validateBody\(settlement/);
    }
  });

  it("list + csv need auth and validation but no brand role (branch owners read their own)", () => {
    for (const path of ["/settlements/list", "/settlements/csv"]) {
      const block = routeBlock(path);
      expect(block).toContain("requireAuth");
      expect(block).not.toContain('requireRole(["brand_owner", "developer"])');
      expect(block).toMatch(/validateBody\(settlement/);
    }
  });

  it("every settlement route is in the App Check enrolment block", () => {
    const start = source.indexOf("app.use(\n  [");
    const end = source.indexOf("],\n  requireAppCheck", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const enrolment = source.slice(start, end);
    for (const path of [
      "/settlements/generate",
      "/settlements/list",
      "/settlements/csv",
      "/settlements/markPaid",
    ]) {
      expect(enrolment, `${path} must be enrolled`).toContain(`"${path}"`);
    }
  });

  it("csv sends a text/csv attachment, never JSON", () => {
    expect(source).toContain("sendCsvDownload(res, filename, csv)");
  });
});

describe("settlement scheduler", () => {
  it("runs on the 1st at 00:20 Asia/Kolkata and settles the previous month", () => {
    const block = source.slice(
      source.indexOf("export const monthlyBranchSettlements"),
      source.indexOf("export const monthlyBranchSettlements") + 2200
    );
    expect(block).toContain('schedule: "20 0 1 * *"');
    expect(block).toContain('timeZone: "Asia/Kolkata"');
    expect(block).toContain("runMonthlySettlementScheduler()");
    // Overlap guard, like every other scheduled worker.
    expect(block).toContain("withSchedulerLock");
  });

  it("raises when any branch failed to settle instead of logging a partial run", () => {
    const block = source.slice(
      source.indexOf("export const monthlyBranchSettlements"),
      source.indexOf("export const monthlyBranchSettlements") + 2200
    );
    expect(block).toMatch(/throw new Error\(/);
  });
});

describe("settlement validation schemas", () => {
  it("reject shapeless bodies through zod, with month keys restricted to YYYY-MM", async () => {
    const { settlementGenerateSchema, settlementMarkPaidSchema } = await import(
      "../src/core/validation"
    );
    expect(settlementGenerateSchema.safeParse({ branchId: "b1", monthKey: "2026-11" }).success).toBe(true);
    expect(settlementGenerateSchema.safeParse({ branchId: "b1", monthKey: "2026-13" }).success).toBe(false);
    expect(settlementGenerateSchema.safeParse({ branchId: "", monthKey: "2026-11" }).success).toBe(false);

    expect(
      settlementMarkPaidSchema.safeParse({
        statementId: "b1_2026-11_v001",
        reference: "UTR123",
        paidOn: "2026-12-03",
      }).success
    ).toBe(true);
    expect(
      settlementMarkPaidSchema.safeParse({
        statementId: "b1_2026-11_v001",
        reference: "UTR123",
        paidOn: "03-12-2026",
      }).success
    ).toBe(false);
  });
});
