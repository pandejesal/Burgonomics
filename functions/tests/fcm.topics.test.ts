import { describe, it, expect } from "vitest";
import { filterSubscribableTopics } from "../src/modules/notifications/topics";

// Loop 4/120: branch operational topics are staff-only — customers must never
// attach a branch's KOT/ticket pushes to their own token.
describe("filterSubscribableTopics", () => {
  const branch = ["branch_branch_01_orders", "branch_branch_01_tickets"];

  it("customer role gets NO branch topics", () => {
    expect(filterSubscribableTopics(branch, { role: "customer" })).toEqual([]);
  });

  it("anonymous (no role) gets NO branch topics", () => {
    expect(filterSubscribableTopics(branch, {})).toEqual([]);
  });

  it("branch_staff keeps branch topics", () => {
    expect(filterSubscribableTopics(branch, { role: "branch_staff" })).toEqual(branch);
  });

  it("brand_owner keeps branch topics + superadmins", () => {
    expect(
      filterSubscribableTopics([...branch, "superadmins"], { role: "brand_owner", isBrandAdmin: true })
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
});
