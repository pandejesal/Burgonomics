import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioural coverage for the REAL requireRole() middleware
 * (src/core/middleware.ts:68-113) — the role guard that fronts the
 * role-mutation routes.
 *
 * Existing coverage is a source-text pin (security.route-rbac.test.ts) plus a
 * mocked middleware in petpooja.resolve-kot-route.test.ts, so a wrong-role
 * caller reaching the handler was never observed. These tests drive the actual
 * exported factory with a real request/response/next triple: every denial
 * asserts the handler (`next`) was never reached, so a schema/body rejection
 * elsewhere cannot masquerade as a pass.
 *
 * Only the datastore boundary is stubbed. The admins/{uid} fallback is the
 * Firestore read the ROLE decision performs, and it is stubbed per test so the
 * stale-claim path is exercised rather than mocked away.
 *
 * F06 adds a SECOND read: `users/{uid}.active` is the server-owned suspension
 * state, and a caller whose role test passes is only admitted when that profile
 * exists AND is active (fail closed). The activation read is lazy — it runs
 * exactly once, and only on a path that would otherwise have been admitted — so
 * a denied role test still costs no extra read, and no customer route is
 * affected. Each test pins the exact read sequence it caused.
 */

const h = vi.hoisted(() => {
  const state = {
    // What admins/{uid}.get() returns; null means "document does not exist".
    adminDoc: null as { exists: boolean; role?: string } | null,
    // What users/{uid}.get() returns (F06 activation profile); null = missing.
    userDoc: null as { exists: boolean; active?: boolean } | null,
    throwOnRead: false,
    throwOnUserRead: false,
    reads: [] as string[],
  };

  const db = {
    collection: (collectionName: string) => ({
      doc: (docId: string) => ({
        get: async () => {
          state.reads.push(`${collectionName}/${docId}`);
          if (collectionName === "users") {
            if (state.throwOnUserRead) throw new Error("firestore unavailable");
            const profile = state.userDoc;
            return {
              exists: Boolean(profile?.exists),
              id: docId,
              data: () => (profile?.exists ? { active: profile.active } : undefined),
            };
          }
          if (state.throwOnRead) throw new Error("firestore unavailable");
          const doc = state.adminDoc;
          return {
            exists: Boolean(doc?.exists),
            id: docId,
            data: () => (doc?.exists ? { role: doc.role } : undefined),
          };
        },
      }),
    }),
  };

  return { state, db };
});

vi.mock("../src/core/firebase", () => ({
  db: h.db,
  auth: { verifyIdToken: vi.fn() },
  messaging: {},
}));

import { requireRole } from "../src/core/middleware";

function makeRes() {
  const res: any = { statusCode: undefined as number | undefined, body: undefined as any };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: any) => {
    res.body = body;
    return res;
  });
  return res;
}

/** Run the real middleware. `undefined` user means req.user was never set. */
async function invoke(user: Record<string, unknown> | undefined, allowedRoles: string[]) {
  const req: any = user === undefined ? {} : { user };
  const res = makeRes();
  const next = vi.fn();
  await requireRole(allowedRoles)(req, res, next);
  return { res, next };
}

function expectDenied(res: any, next: any, status: number) {
  expect(res.status).toHaveBeenCalledTimes(1);
  expect(res.status).toHaveBeenCalledWith(status);
  expect(res.json).toHaveBeenCalledTimes(1);
  expect(res.body?.error).toEqual(expect.any(String));
  expect(next).not.toHaveBeenCalled();
}

function expectAdmitted(res: any, next: any) {
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
}

describe("requireRole — real middleware, role-mutation guard", () => {
  beforeEach(() => {
    h.state.adminDoc = null;
    // F06 default: the staff profile exists and is ACTIVE, so the pre-existing
    // positive controls keep their meaning. Tests that care about the gate set
    // it explicitly.
    h.state.userDoc = { exists: true, active: true };
    h.state.throwOnRead = false;
    h.state.throwOnUserRead = false;
    h.state.reads = [];
  });

  it("401s without calling next when req.user is absent", async () => {
    const { res, next } = await invoke(undefined, ["branch_staff"]);

    expectDenied(res, next, 401);
    expect(res.body.error).toMatch(/Authentication required/);
    // No authenticated uid exists, so the admins fallback must not be read.
    expect(h.state.reads).toEqual([]);
  });

  it("403s a customer claim when no admins doc grants access", async () => {
    const { res, next } = await invoke(
      { uid: "cust_1", role: "customer" },
      ["branch_staff"]
    );

    expectDenied(res, next, 403);
    expect(res.body.error).toMatch(/Insufficient privileges/);
    expect(h.state.reads).toEqual(["admins/cust_1"]);
  });

  it("403s a support claim when no admins doc grants access", async () => {
    const { res, next } = await invoke(
      { uid: "support_1", role: "support" },
      ["branch_staff"]
    );

    expectDenied(res, next, 403);
    expect(h.state.reads).toEqual(["admins/support_1"]);
  });

  it("403s a token with no role claim when no admins doc exists", async () => {
    const { res, next } = await invoke({ uid: "norole_1" }, ["branch_staff"]);

    expectDenied(res, next, 403);
    expect(h.state.reads).toEqual(["admins/norole_1"]);
  });

  it("admits branch_staff when it is an allowed role", async () => {
    const { res, next } = await invoke(
      { uid: "staff_1", role: "branch_staff" },
      ["branch_staff"]
    );

    expectAdmitted(res, next);
    // Allowed by the claim: the admins fallback read is unnecessary. F06 adds
    // exactly the one activation read — and it now proves the gate ran.
    expect(h.state.reads).toEqual(["users/staff_1"]);
  });

  it("admits branch_owner when it is an allowed role (positive control)", async () => {
    // branch_owner is a scoped role, not a bypass: the middleware's bypass is
    // brand_owner/developer/isBrandAdmin only. Admission here is genuine
    // allowedRoles list membership.
    const { res, next } = await invoke(
      { uid: "owner_1", role: "branch_owner" },
      ["branch_owner", "developer"]
    );

    expectAdmitted(res, next);
    // Allowed by the claim: no admins fallback read; only the F06 activation read.
    expect(h.state.reads).toEqual(["users/owner_1"]);
  });

  it("403s branch_owner when the allowed list omits it and no admins doc grants it", async () => {
    // Negative control for the list check: branch_owner must NOT ride the
    // brand-level bypass, so an allowed list of ["branch_staff"] denies it.
    const { res, next } = await invoke(
      { uid: "owner_3", role: "branch_owner" },
      ["branch_staff"]
    );

    expectDenied(res, next, 403);
    expect(res.body.error).toMatch(/Insufficient privileges/);
    expect(h.state.reads).toEqual(["admins/owner_3"]);
  });

  it("admits a brand_owner claim even when allowedRoles excludes it (global bypass)", async () => {
    const { res, next } = await invoke(
      { uid: "owner_2", role: "brand_owner" },
      ["branch_staff"]
    );

    expectAdmitted(res, next);
  });

  it("admits a developer claim even when allowedRoles excludes it (global bypass)", async () => {
    const { res, next } = await invoke(
      { uid: "dev_1", role: "developer" },
      ["branch_staff"]
    );

    expectAdmitted(res, next);
  });

  it("admits an isBrandAdmin claim even when allowedRoles excludes it (global bypass)", async () => {
    const { res, next } = await invoke(
      { uid: "brand_flag_1", isBrandAdmin: true },
      ["branch_staff"]
    );

    expectAdmitted(res, next);
  });

  it("admits a stale-claim caller whose admins doc holds an allowed role", async () => {
    h.state.adminDoc = { exists: true, role: "branch_staff" };
    const { res, next } = await invoke({ uid: "stale_1" }, ["branch_staff"]);

    expectAdmitted(res, next);
    // Proves the positive result came from the admins fallback, then the F06
    // activation read (one profile read, on an otherwise-admitted path).
    expect(h.state.reads).toEqual(["admins/stale_1", "users/stale_1"]);
  });

  it("403s when the admins doc role is not allowed", async () => {
    h.state.adminDoc = { exists: true, role: "customer" };
    const { res, next } = await invoke({ uid: "stale_2" }, ["branch_staff"]);

    expectDenied(res, next, 403);
    expect(h.state.reads).toEqual(["admins/stale_2"]);
  });

  it("403s and fails closed when the admins read throws", async () => {
    h.state.throwOnRead = true;
    const { res, next } = await invoke(
      { uid: "stale_3", role: "customer" },
      ["branch_staff"]
    );

    expectDenied(res, next, 403);
    expect(res.body.error).toMatch(/Insufficient privileges/);
    expect(h.state.reads).toEqual(["admins/stale_3"]);
  });

  // -------------------------------------------------------------------------
  // F06 — suspension is an authorization input, not a roster label.
  //
  // Before this gate: `requireRole` admitted on the token claim ALONE (zero
  // reads), and the admins fallback ignored `users/{uid}.active` entirely. A
  // suspended operator therefore kept every role-gated route for the life of
  // their ID token. These cases pin the fail-closed profile gate.
  // -------------------------------------------------------------------------
  describe("F06 — account activation gate", () => {
    it("403s a SUSPENDED staff claim even though the role is allowed", async () => {
      h.state.userDoc = { exists: true, active: false };
      const { res, next } = await invoke({ uid: "staff_1", role: "branch_staff" }, ["branch_staff"]);

      expectDenied(res, next, 403);
      expect(res.body.error).toMatch(/suspended/i);
      expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
      // Exactly one activation read; no admins fallback was needed.
      expect(h.state.reads).toEqual(["users/staff_1"]);
    });

    it("403s a staff claim whose profile document is MISSING (fail closed)", async () => {
      h.state.userDoc = null;
      const { res, next } = await invoke({ uid: "staff_1", role: "branch_staff" }, ["branch_staff"]);

      expectDenied(res, next, 403);
      expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
    });

    it("403s a staff claim whose profile carries no active flag (legacy provisioning)", async () => {
      h.state.userDoc = { exists: true };
      const { res, next } = await invoke({ uid: "staff_1", role: "branch_staff" }, ["branch_staff"]);

      expectDenied(res, next, 403);
      expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
    });

    it("403s a staff claim when the profile read throws (fail closed)", async () => {
      h.state.throwOnUserRead = true;
      const { res, next } = await invoke({ uid: "staff_1", role: "branch_staff" }, ["branch_staff"]);

      expectDenied(res, next, 403);
      expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
    });

    it("admits an ACTIVE staff claim and performs exactly one extra read", async () => {
      h.state.userDoc = { exists: true, active: true };
      const { res, next } = await invoke({ uid: "staff_1", role: "branch_staff" }, ["branch_staff"]);

      expectAdmitted(res, next);
      expect(h.state.reads).toEqual(["users/staff_1"]);
    });

    it("brand bypass also requires an active profile", async () => {
      h.state.userDoc = { exists: true, active: false };
      const { res, next } = await invoke(
        { uid: "brand_1", role: "brand_owner", isBrandAdmin: true },
        ["branch_staff"]
      );

      expectDenied(res, next, 403);
      expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
      expect(h.state.reads).toEqual(["users/brand_1"]);
    });

    it("the admins-doc fallback cannot override suspension", async () => {
      h.state.adminDoc = { exists: true, role: "branch_staff" };
      h.state.userDoc = { exists: true, active: false };
      const { res, next } = await invoke({ uid: "norole_1" }, ["branch_staff"]);

      expectDenied(res, next, 403);
      expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
    });

    it("a denied role test performs NO activation read (no extra cost on refusals)", async () => {
      const { res, next } = await invoke({ uid: "cust_1", role: "customer" }, ["branch_staff"]);

      expectDenied(res, next, 403);
      // Only the admins fallback ran; the gate is reached only when a role arm
      // would otherwise have admitted.
      expect(h.state.reads).toEqual(["admins/cust_1"]);
    });
  });
});
