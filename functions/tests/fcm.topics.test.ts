import { describe, it, expect } from "vitest";
import {
  filterSubscribableTopics,
  topicCallerFromClaims,
} from "../src/modules/notifications/topics";

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
