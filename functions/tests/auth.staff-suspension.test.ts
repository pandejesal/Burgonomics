import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * F06 — "Suspend" used to be a bare client write (`users/{uid}.active`) that
 * NO authorization path consulted: `requireRole` admitted on the token claim
 * alone and Firestore's `hasRole` read only `admins/{uid}`. A suspended
 * operator therefore kept every role-gated API route and every branch read.
 *
 * This suite pins the authoritative server writer:
 *   POST /auth/suspendStaff  ->  setStaffActive(body, caller)
 *
 * Safety properties asserted here (all inside ONE transaction):
 *   - the actor is re-read from `admins/{uid}` AND `users/{uid}` and must be
 *     an ACTIVE brand owner/developer (a stale client claim suspends nobody);
 *   - self-suspension is refused;
 *   - the target must exist and must be staff;
 *   - the audit row is committed with the state change, never after it;
 *   - repeating the stored value is a no-op with no duplicate audit row;
 *   - refresh-token revocation is secondary and never fails the suspension.
 *
 * Only the datastore + Admin-Auth boundaries are stubbed.
 */

const { mockDb, mockAuth, savedDocs, auditWrites, authCalls, state } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const auditWrites: any[] = [];
  const authCalls: Array<{ fn: string; uid: string }> = [];
  const state = { throwOnRevoke: false };
  let seq = 0;

  const makeRef = (path: string) => ({
    __path: path,
    id: path.split("/").pop()!,
    get: vi.fn(async () => ({
      exists: savedDocs[path] !== undefined,
      data: () => savedDocs[path],
      ref: makeRef(path),
    })),
    set: vi.fn(async (d: any, o?: any) => {
      const next: any = o?.merge ? { ...(savedDocs[path] || {}), ...d } : { ...d };
      savedDocs[path] = next;
      if (path.startsWith("admin_audit_logs/")) auditWrites.push(next);
    }),
    update: vi.fn(async (d: any) => {
      if (savedDocs[path] === undefined) throw new Error(`No document: ${path}`);
      savedDocs[path] = { ...savedDocs[path], ...d };
    }),
    create: vi.fn(async (d: any) => {
      if (savedDocs[path] !== undefined) throw new Error("ALREADY_EXISTS");
      savedDocs[path] = { ...d };
    }),
  });

  const mockDb: any = {
    collection: (col: string) => ({
      doc: (id?: string) => makeRef(`${col}/${id ?? `auto_${++seq}`}`),
      add: async (d: any) => {
        auditWrites.push(d);
        return { id: `log_${auditWrites.length}` };
      },
    }),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, d: any, o?: any) => ref.set(d, o),
        update: (ref: any, d: any) => ref.update(d),
        create: (ref: any, d: any) => ref.create(d),
      }),
  };

  // Admin-Auth seam: revocation is secondary, so a failure must be observable
  // AND survivable (the suspension still commits).
  const mockAuth = {
    revokeRefreshTokens: vi.fn(async (uid: string) => {
      authCalls.push({ fn: "revokeRefreshTokens", uid });
      if (state.throwOnRevoke) throw new Error("admin sdk down");
    }),
  };

  return { mockDb, mockAuth, savedDocs, auditWrites, authCalls, state };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (i: any) => i,
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => mockAuth),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => mockAuth),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

vi.mock("../src/core/firebase", () => ({
  db: mockDb,
  auth: mockAuth,
  messaging: {},
}));

import { setStaffActive } from "../src/modules/auth/staffSuspension";

const ACTOR = "brand_owner_1";
const TARGET = "staff_1";
const BRAND_CALLER = {
  uid: ACTOR,
  role: "brand_owner",
  isBrandAdmin: true,
  email: "brand@fixture.test",
} as any;

describe("F06 setStaffActive — authoritative, atomic, audited", () => {
  beforeEach(() => {
    for (const k of Object.keys(savedDocs)) delete savedDocs[k];
    auditWrites.length = 0;
    authCalls.length = 0;
    state.throwOnRevoke = false;
    savedDocs[`admins/${ACTOR}`] = { role: "brand_owner" };
    savedDocs[`users/${ACTOR}`] = { role: "brand_owner", active: true };
    savedDocs[`users/${TARGET}`] = { role: "branch_staff", active: true, branchIds: ["b1"] };
  });

  it("suspends a staff member and writes the audit row in the SAME transaction", async () => {
    const res = await setStaffActive(
      { targetUid: TARGET, active: false, reason: "left the company" },
      BRAND_CALLER
    );
    expect(res).toMatchObject({ success: true, targetUid: TARGET, active: false, changed: true });
    expect(savedDocs[`users/${TARGET}`].active).toBe(false);
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]).toMatchObject({
      action: "staff_suspended",
      targetId: TARGET,
      actorUid: ACTOR,
    });
  });

  it("reactivates and audits the opposite action", async () => {
    savedDocs[`users/${TARGET}`].active = false;
    const res = await setStaffActive({ targetUid: TARGET, active: true }, BRAND_CALLER);
    expect(res.active).toBe(true);
    expect(auditWrites[0].action).toBe("staff_reactivated");
  });

  it("denies SELF-suspension", async () => {
    await expect(
      setStaffActive({ targetUid: ACTOR, active: false }, BRAND_CALLER)
    ).rejects.toMatchObject({ statusCode: 403, code: "SELF_SUSPENSION_DENIED" });
    expect(savedDocs[`users/${ACTOR}`].active).toBe(true);
    expect(auditWrites).toHaveLength(0);
  });

  it("denies a non-brand actor even with a stale client claim", async () => {
    savedDocs[`admins/${ACTOR}`] = { role: "branch_owner" };
    await expect(
      setStaffActive({ targetUid: TARGET, active: false }, BRAND_CALLER)
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(savedDocs[`users/${TARGET}`].active).toBe(true);
    expect(auditWrites).toHaveLength(0);
  });

  it("denies a caller with no verified caller object at all", async () => {
    await expect(
      setStaffActive({ targetUid: TARGET, active: false }, undefined)
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(savedDocs[`users/${TARGET}`].active).toBe(true);
  });

  it("denies an already-suspended actor (concurrent cross-suspension cannot consume the last actor)", async () => {
    savedDocs[`users/${ACTOR}`].active = false;
    await expect(
      setStaffActive({ targetUid: TARGET, active: false }, BRAND_CALLER)
    ).rejects.toMatchObject({ statusCode: 403, code: "ACTOR_SUSPENDED" });
    expect(savedDocs[`users/${TARGET}`].active).toBe(true);
  });

  it("denies a missing target profile (fail closed, no partial state)", async () => {
    delete savedDocs[`users/${TARGET}`];
    await expect(
      setStaffActive({ targetUid: TARGET, active: false }, BRAND_CALLER)
    ).rejects.toMatchObject({ statusCode: 404, code: "TARGET_PROFILE_MISSING" });
    expect(auditWrites).toHaveLength(0);
  });

  it("refuses to suspend a customer account (staff only)", async () => {
    savedDocs[`users/${TARGET}`] = { role: "customer", active: true };
    await expect(
      setStaffActive({ targetUid: TARGET, active: false }, BRAND_CALLER)
    ).rejects.toMatchObject({ statusCode: 409, code: "TARGET_NOT_STAFF" });
    expect(auditWrites).toHaveLength(0);
  });

  it("is idempotent: repeating the same value writes no second audit row", async () => {
    savedDocs[`users/${TARGET}`].active = false;
    const res = await setStaffActive({ targetUid: TARGET, active: false }, BRAND_CALLER);
    expect(res.changed).toBe(false);
    expect(auditWrites).toHaveLength(0);
    expect(authCalls).toHaveLength(0);
  });

  it("never fails the suspension when token revocation throws (secondary, alerted)", async () => {
    state.throwOnRevoke = true;
    const res = await setStaffActive({ targetUid: TARGET, active: false }, BRAND_CALLER);
    expect(res.success).toBe(true);
    expect(savedDocs[`users/${TARGET}`].active).toBe(false);
    expect(auditWrites).toHaveLength(1);
  });

  it("does not touch role, branchIds or claims while changing active", async () => {
    await setStaffActive({ targetUid: TARGET, active: false }, BRAND_CALLER);
    expect(savedDocs[`users/${TARGET}`].role).toBe("branch_staff");
    expect(savedDocs[`users/${TARGET}`].branchIds).toEqual(["b1"]);
    expect(savedDocs[`users/${TARGET}`].active).toBe(false);
  });

  it("rejects an actorUid smuggled through the request body (strict schema)", async () => {
    await expect(
      setStaffActive({ targetUid: TARGET, active: false, actorUid: "someone_else" }, BRAND_CALLER)
    ).rejects.toThrow();
    expect(savedDocs[`users/${TARGET}`].active).toBe(true);
  });
});
