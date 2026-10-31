import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  filterSubscribableTopics,
  normalizeBranchScope,
  topicCallerFromClaims,
} from "../src/modules/notifications/topics";

const { docs, control } = vi.hoisted(() => ({
  docs: {} as Record<string, any>,
  control: { failColumns: [] as string[], reads: [] as string[] },
}));

vi.mock("../src/core/firebase", () => ({
  db: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          control.reads.push(`${name}/${id}`);
          if (control.failColumns.includes(name)) throw new Error("read unavailable");
          const key = `${name}/${id}`;
          return { exists: key in docs, data: () => docs[key] };
        },
      }),
    }),
  },
}));
vi.mock("firebase-functions/logger", () => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  log: vi.fn(),
}));

import * as logger from "firebase-functions/logger";
import { resolveTopicCaller } from "../src/modules/notifications/topicCaller";

// Loop 4/120: branch operational topics are staff-only — customers must never
// attach a branch's KOT/ticket pushes to their own token. SEC-01: staff are
// additionally scoped to their assigned branch ids.
describe("filterSubscribableTopics", () => {
  const branch = ["branch_branch_01_orders", "branch_branch_01_tickets"];

  it("customer role gets NO branch topics", () => {
    expect(filterSubscribableTopics(branch, { role: "customer", branchIds: ["branch_01"] })).toEqual([]);
  });

  it("anonymous (no role) gets NO branch topics", () => {
    expect(filterSubscribableTopics(branch, {})).toEqual([]);
  });

  it("branch_staff keeps only their own branch topics", () => {
    expect(
      filterSubscribableTopics(branch, { role: "branch_staff", branchIds: ["branch_01"] })
    ).toEqual(branch);
  });

  it("refuses another branch's topics to branch staff (SEC-01)", () => {
    const topics = ["branch_branch_A_orders", "branch_branch_B_orders", "branch_branch_A_tickets"];
    expect(
      filterSubscribableTopics(topics, { role: "branch_staff", branchIds: ["branch_A"] })
    ).toEqual(["branch_branch_A_orders", "branch_branch_A_tickets"]);
  });

  it("lets brand admins and support observe every branch (SEC-01)", () => {
    const topics = ["branch_branch_A_orders", "branch_branch_B_orders"];
    expect(
      filterSubscribableTopics(topics, { role: "brand_owner", isBrandAdmin: true })
    ).toEqual(topics);
    expect(filterSubscribableTopics(topics, { role: "support" })).toEqual(topics);
  });

  it("brand_owner keeps branch topics + superadmins", () => {
    expect(
      filterSubscribableTopics([...branch, "superadmins"], {
        role: "brand_owner",
        isBrandAdmin: true,
      })
    ).toEqual([...branch, "superadmins"]);
  });

  it("regional_manager keeps regional_managers but not superadmins", () => {
    expect(
      filterSubscribableTopics(["regional_managers", "superadmins"], { role: "regional_manager" })
    ).toEqual(["regional_managers"]);
  });

  it("rejects garbage topics, non-strings, and caps at 12", () => {
    const many = Array.from({ length: 20 }, (_, i) => `branch_b${i}_orders`);
    const out = filterSubscribableTopics(
      ["../../etc", 42 as any, "branch_!_orders", ...many],
      { role: "support" }
    );
    expect(out).toHaveLength(12);
    expect(out.every((t) => /^branch_b\d+_orders$/.test(t))).toBe(true);
  });

  it("tickets_escalated stays staff-only (unchanged by SEC-01)", () => {
    expect(filterSubscribableTopics(["tickets_escalated"], { role: "customer" })).toEqual([]);
    expect(
      filterSubscribableTopics(["tickets_escalated"], { role: "branch_staff", branchIds: [] })
    ).toEqual(["tickets_escalated"]);
  });

  it("builds the caller from existing claims only (SEC-01)", () => {
    expect(
      topicCallerFromClaims({ role: "branch_staff", branchIds: ["b1", 42], isBrandAdmin: false })
    ).toEqual({ role: "branch_staff", isBrandAdmin: false, branchIds: ["b1"] });
    expect(topicCallerFromClaims({ role: "developer" }).isBrandAdmin).toBe(true);
    expect(topicCallerFromClaims({ role: "customer" }).branchIds).toEqual([]);
  });
});

describe("legacy scope shapes and doc fallback (SEC-01b)", () => {
  const topicsFor = (branch: string) => [
    `branch_${branch}_orders`,
    "branch_branch_B_orders",
  ];
  const ownBranchTopics = (caller: any) =>
    filterSubscribableTopics(topicsFor("branch_A"), caller);

  beforeEach(() => {
    for (const key of Object.keys(docs)) delete docs[key];
    control.failColumns = [];
    control.reads = [];
    vi.mocked(logger.warn).mockClear();
  });

  it("normalizes array, string-shaped plural and singular claims, deduped and trimmed", () => {
    expect(normalizeBranchScope(["a", " b ", "", "a"])).toEqual(["a", "b"]);
    expect(normalizeBranchScope("branch_A")).toEqual(["branch_A"]);
    expect(normalizeBranchScope(undefined, "branch_A", null)).toEqual(["branch_A"]);
  });

  it.each([
    ["array plural", { branchIds: ["branch_A"] }],
    ["string plural", { branchIds: "branch_A" }],
    ["singular", { branchId: "branch_A" }],
  ])("keeps the caller's own branch and refuses another (%s)", (_label, claims) => {
    const caller = topicCallerFromClaims({ role: "branch_staff", ...(claims as any) });
    expect(caller.branchIds).toEqual(["branch_A"]);
    expect(ownBranchTopics(caller)).toEqual(["branch_branch_A_orders"]);
  });

  it("never reads or trusts a client-writable users/{uid} branch (SEC-01c)", async () => {
    // firestore.rules does not mask branchId on users/{uid}, so a staffer can
    // write their own branchId. Topic scope must never be read from there.
    docs["users/u1"] = { branchId: "branch_B" };
    const caller = await resolveTopicCaller({ uid: "u1", role: "branch_staff" });
    expect(caller.branchIds).toEqual([]);
    expect(ownBranchTopics(caller)).toEqual([]);
    expect(control.reads).not.toContain("users/u1");
  });

  it("falls back to admins/{uid} when the claims carry no scope", async () => {
    docs["users/u2"] = { role: "branch_staff" };
    docs["admins/u2"] = { branchIds: "branch_A" };
    const caller = await resolveTopicCaller({ uid: "u2", role: "branch_staff" });
    expect(caller.branchIds).toEqual(["branch_A"]);
    expect(ownBranchTopics(caller)).toEqual(["branch_branch_A_orders"]);
  });

  it("fails closed (no branch topics) when the fallback read fails", async () => {
    control.failColumns = ["users", "admins"];
    const caller = await resolveTopicCaller({ uid: "u3", role: "branch_staff" });
    expect(caller.branchIds).toEqual([]);
    expect(ownBranchTopics(caller)).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("never widens scope for customers or when claims already have it", async () => {
    docs["users/u4"] = { branchId: "branch_A" };
    const customer = await resolveTopicCaller({ uid: "u4", role: "customer" });
    expect(customer.branchIds).toEqual([]);
    const scoped = await resolveTopicCaller({
      uid: "u5",
      role: "branch_staff",
      branchIds: ["branch_B"],
    });
    expect(scoped.branchIds).toEqual(["branch_B"]);
  });
});
