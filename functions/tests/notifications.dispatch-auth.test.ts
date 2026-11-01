/**
 * N-04 dispatch authorization matrix (contract §3). The pure decision function
 * is the route's authority; the route resolves the token owner and maps every
 * denial to one generic 403 body.
 */
import { describe, expect, it } from "vitest";
import {
  authorizeDispatch,
  type DispatchCaller,
} from "../src/modules/notifications/registry";

const STAFF_TOKEN = { uid: "staff_uid", role: "branch_staff", branchIds: ["b1"] };
const CUSTOMER_TOKEN = { uid: "customer_uid", role: "customer", branchIds: [] };

function decide(caller: DispatchCaller, tokenOwner: any, requestedPurpose?: unknown) {
  return authorizeDispatch({ caller, tokenOwner, requestedPurpose });
}

describe("dispatch matrix: global staff roles", () => {
  it("support with an empty branchIds claim reaches any staff token (brand-global)", () => {
    const decision = decide(
      { uid: "support_uid", role: "support", branchIds: [] },
      { uid: "staff_uid", role: "branch_owner", branchIds: ["b2"] }
    );
    expect(decision).toMatchObject({
      allowed: true,
      purpose: "operational",
      targetClass: "staff",
    });
  });

  it("brand_owner reaches a staff token in any branch", () => {
    const decision = decide(
      { uid: "owner_uid", role: "brand_owner", branchIds: [] },
      STAFF_TOKEN
    );
    expect(decision.allowed).toBe(true);
  });

  it("support is forbidden from a customer token", () => {
    const decision = decide(
      { uid: "support_uid", role: "support", branchIds: [] },
      CUSTOMER_TOKEN
    );
    expect(decision).toMatchObject({ allowed: false, reason: "customer_token_forbidden" });
  });
});

describe("dispatch matrix: branch-scoped staff roles", () => {
  it("branch_owner[b1] may reach staff in b1", () => {
    const decision = decide(
      { uid: "bo_uid", role: "branch_owner", branchIds: ["b1"] },
      { uid: "staff_uid", role: "branch_staff", branchIds: ["b1"] }
    );
    expect(decision.allowed).toBe(true);
  });

  it("branch_owner[b1] cannot reach staff in b2", () => {
    const decision = decide(
      { uid: "bo_uid", role: "branch_owner", branchIds: ["b1"] },
      { uid: "staff_uid", role: "branch_staff", branchIds: ["b2"] }
    );
    expect(decision).toMatchObject({ allowed: false, reason: "staff_outside_branch" });
  });

  it("empty caller or recipient branch scope fails closed", () => {
    expect(
      decide({ uid: "bo_uid", role: "branch_owner", branchIds: [] }, STAFF_TOKEN)
    ).toMatchObject({ allowed: false, reason: "staff_outside_branch" });
    expect(
      decide(
        { uid: "bo_uid", role: "branch_owner", branchIds: ["b1"] },
        { uid: "staff_uid", role: "branch_staff", branchIds: [] }
      )
    ).toMatchObject({ allowed: false, reason: "staff_outside_branch" });
  });

  it("branch roles are forbidden from customer tokens", () => {
    expect(
      decide({ uid: "bo_uid", role: "branch_owner", branchIds: ["b1"] }, CUSTOMER_TOKEN)
    ).toMatchObject({ allowed: false, reason: "customer_token_forbidden" });
  });
});

describe("dispatch matrix: brand admins to customer tokens", () => {
  it("brand_owner may send orderUpdates to a customer token and must audit", () => {
    const decision = decide(
      { uid: "owner_uid", role: "brand_owner", branchIds: [] },
      CUSTOMER_TOKEN,
      "orderUpdates"
    );
    expect(decision).toMatchObject({
      allowed: true,
      purpose: "orderUpdates",
      targetClass: "customer",
      auditRequired: true,
    });
  });

  it("brand_owner may send supportReplies", () => {
    expect(
      decide({ uid: "owner_uid", role: "developer" }, CUSTOMER_TOKEN, "supportReplies")
    ).toMatchObject({ allowed: true, purpose: "supportReplies", auditRequired: true });
  });

  it("offers/announcements are not admin-dispatch purposes", () => {
    for (const purpose of ["offers", "announcements"]) {
      expect(
        decide({ uid: "owner_uid", role: "brand_owner" }, CUSTOMER_TOKEN, purpose)
      ).toMatchObject({ allowed: false, reason: "purpose_not_permitted" });
    }
  });

  it("a customer token with no explicit customer purpose is denied (operational is not inferred)", () => {
    expect(
      decide({ uid: "owner_uid", role: "brand_owner" }, CUSTOMER_TOKEN)
    ).toMatchObject({ allowed: false, reason: "purpose_not_permitted" });
  });
});

describe("dispatch matrix: unknowns and body attempts", () => {
  it("unknown or ownerless token denies with no existence oracle", () => {
    expect(decide({ uid: "owner_uid", role: "brand_owner" }, null)).toMatchObject({
      allowed: false,
      reason: "unknown_device",
    });
    expect(
      decide({ uid: "owner_uid", role: "brand_owner" }, { uid: undefined })
    ).toMatchObject({ allowed: false, reason: "ambiguous_device_owner" });
  });

  it("an unauthenticated caller is denied", () => {
    expect(decide({ uid: undefined, role: "brand_owner" }, STAFF_TOKEN)).toMatchObject({
      allowed: false,
      reason: "caller_unauthenticated",
    });
  });

  it("an unknown purpose value cannot widen scope", () => {
    expect(
      decide({ uid: "owner_uid", role: "brand_owner" }, CUSTOMER_TOKEN, "NEW_KOT")
    ).toMatchObject({ allowed: false, reason: "purpose_not_permitted" });
  });

  it("a customer-purpose attempt on a staff token is denied", () => {
    expect(
      decide({ uid: "owner_uid", role: "brand_owner" }, STAFF_TOKEN, "orderUpdates")
    ).toMatchObject({ allowed: false, reason: "purpose_not_permitted" });
  });
});
