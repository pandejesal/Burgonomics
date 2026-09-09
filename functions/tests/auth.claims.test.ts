import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, mockAuth, savedDocs, customClaimsRecord, revokedTokens } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const customClaimsRecord: Record<string, any> = {};
  const revokedTokens: string[] = [];

  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any, options?: any) => {
          const docPath = `${colName}/${docId}`;
          if (options?.merge && savedDocs[docPath]) {
            savedDocs[docPath] = { ...savedDocs[docPath], ...data };
          } else {
            savedDocs[docPath] = data;
          }
        }),
        get: vi.fn(async () => {
          const docPath = `${colName}/${docId}`;
          return {
            exists: !!savedDocs[docPath],
            data: () => savedDocs[docPath] || {},
          };
        }),
        delete: vi.fn(async () => {
          delete savedDocs[`${colName}/${docId}`];
        }),
      }),
    }),
  };

  const mockAuth = {
    setCustomUserClaims: vi.fn(async (uid: string, claims: any) => {
      customClaimsRecord[uid] = claims;
    }),
    revokeRefreshTokens: vi.fn(async (uid: string) => {
      revokedTokens.push(uid);
    }),
  };

  return { mockDb, mockAuth, savedDocs, customClaimsRecord, revokedTokens };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
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

import {
  validateAndNormalizeRole,
  assertCallerCanAssignRole,
  setUserCustomClaims,
  assignUserRole,
  revokeUserRole,
  APP_USER_ROLES,
} from "../src/modules/auth/claimsManager";

describe("Auth Module — Claims Manager & Privilege Escalation Prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    for (const key of Object.keys(customClaimsRecord)) delete customClaimsRecord[key];
    revokedTokens.length = 0;
  });

  describe("1. Role Validation Schema & Normalization", () => {
    it("accepts and validates all 8 canonical Burgonomics roles", () => {
      for (const role of APP_USER_ROLES) {
        expect(validateAndNormalizeRole(role)).toBe(role);
      }
    });

    it("normalizes enterprise and legacy role aliases seamlessly", () => {
      expect(validateAndNormalizeRole("superadmin")).toBe("brand_owner");
      expect(validateAndNormalizeRole("branch_manager")).toBe("branch_owner");
      expect(validateAndNormalizeRole("kitchen")).toBe("branch_staff");
      expect(validateAndNormalizeRole("cashier")).toBe("branch_staff");
      expect(validateAndNormalizeRole("kitchen_staff")).toBe("branch_staff");
      expect(validateAndNormalizeRole("support_agent")).toBe("support");
    });

    it("strictly rejects unapproved or malicious role strings", () => {
      expect(() => validateAndNormalizeRole("root")).toThrow(/Invalid role/);
      expect(() => validateAndNormalizeRole("hacker")).toThrow(/Invalid role/);
      expect(() => validateAndNormalizeRole("")).toThrow(/Invalid role/);
    });
  });

  describe("2. Caller Privilege Verification (Privilege Escalation Prevention)", () => {
    it("allows authorized Superadmins / Brand Owners and Developers", () => {
      expect(() => assertCallerCanAssignRole({ role: "brand_owner" } as any)).not.toThrow();
      expect(() => assertCallerCanAssignRole({ role: "developer" } as any)).not.toThrow();
      expect(() => assertCallerCanAssignRole({ role: "superadmin" } as any)).not.toThrow();
      expect(() => assertCallerCanAssignRole({ isBrandAdmin: true } as any)).not.toThrow();
    });

    it("strictly blocks unauthorized callers (support, branch staff, customer, unauthenticated)", () => {
      expect(() => assertCallerCanAssignRole(null)).toThrow(/Missing authentication token/);
      expect(() => assertCallerCanAssignRole({ role: "customer" } as any)).toThrow(/Permission denied/);
      expect(() => assertCallerCanAssignRole({ role: "branch_staff" } as any)).toThrow(/Permission denied/);
      expect(() => assertCallerCanAssignRole({ role: "branch_owner" } as any)).toThrow(/Permission denied/);
      expect(() => assertCallerCanAssignRole({ role: "support" } as any)).toThrow(/Permission denied/);
    });
  });

  describe("3. Custom Claims Injection & Refresh Token Invalidation", () => {
    it("provisions custom claims, revokes refresh tokens, and updates Firestore", async () => {
      const targetUid = "usr_staff_surat_01";
      const result = await setUserCustomClaims(
        {
          targetUid,
          role: "branch_staff",
          branchIds: ["branch_surat_01"],
          cityIds: ["Surat"],
        },
        { role: "brand_owner", isBrandAdmin: true } as any
      );

      expect(result.success).toBe(true);
      expect(result.role).toBe("branch_staff");
      expect(customClaimsRecord[targetUid]).toEqual({
        role: "branch_staff",
        branchIds: ["branch_surat_01"],
        cityIds: ["Surat"],
        isStaff: true,
        isBrandAdmin: false,
      });

      // Token invalidation check
      expect(revokedTokens).toContain(targetUid);

      // Firestore synchronization check
      const saved = savedDocs[`users/${targetUid}`];
      expect(saved).toBeDefined();
      expect(saved.role).toBe("branch_staff");
      expect(saved.isStaff).toBe(true);
      expect(saved.claimsUpdatedAt).toBe("MOCK_SERVER_TIMESTAMP");
    });

    it("provisions full brand administrator privileges for brand_owner and developer", async () => {
      const targetUid = "usr_founder_01";
      await setUserCustomClaims(
        {
          targetUid,
          role: "brand_owner",
        },
        { role: "developer", isBrandAdmin: true } as any
      );

      expect(customClaimsRecord[targetUid].isBrandAdmin).toBe(true);
      expect(customClaimsRecord[targetUid].isStaff).toBe(true);
    });
  });

  describe("4. End-to-End assignUserRole & revokeUserRole Workflows", () => {
    it("executes full role assignment when called by authorized brand_owner", async () => {
      const callerClaims = { role: "brand_owner", isBrandAdmin: true };
      const result = await assignUserRole(callerClaims as any, {
        targetUid: "usr_kitchen_99",
        role: "kitchen_staff", // alias for branch_staff
        branchIds: ["branch_ahmedabad_01"],
      });

      expect(result.success).toBe(true);
      expect(result.role).toBe("branch_staff");
      expect(customClaimsRecord["usr_kitchen_99"].role).toBe("branch_staff");
    });

    it("rejects role assignment if caller is unauthorized", async () => {
      const callerClaims = { role: "branch_staff" };
      await expect(
        assignUserRole(callerClaims as any, {
          targetUid: "usr_victim_99",
          role: "brand_owner",
        })
      ).rejects.toThrow(/Permission denied/);
    });

    it("revokes user elevated role back to customer", async () => {
      const callerClaims = { role: "developer" };
      const targetUid = "usr_staff_retired";

      // Stale admins doc from the staff era — the classic backdoor remnant.
      savedDocs[`admins/${targetUid}`] = { role: "branch_staff", branchIds: ["branch_surat_01"] };

      const result = await revokeUserRole(callerClaims as any, targetUid);
      expect(result.success).toBe(true);
      expect(result.role).toBe("customer");
      expect(customClaimsRecord[targetUid].isStaff).toBe(false);
      expect(customClaimsRecord[targetUid].isBrandAdmin).toBe(false);
      expect(revokedTokens).toContain(targetUid);
      // The admins-registry doc must die with the demotion, or requireRole()'s
      // fallback keeps the ex-staffer authorized.
      expect(savedDocs[`admins/${targetUid}`]).toBeUndefined();
    });

    it("mirrors operator roles into the admins registry on assignment", async () => {
      const callerClaims = { role: "brand_owner", isBrandAdmin: true };
      const targetUid = "usr_new_manager";
      await assignUserRole(callerClaims as any, {
        targetUid,
        role: "branch_owner",
        branchIds: ["branch_surat_01"],
      });
      expect(savedDocs[`admins/${targetUid}`]?.role).toBe("branch_owner");
    });
  });

  describe("5. In-Function Caller Assert (B3-S1: deny even if the route is miswired)", () => {
    const brandCaller = { role: "brand_owner", isBrandAdmin: true } as any;

    it("denies setUserCustomClaims for every non-brand caller role", async () => {
      for (const role of ["customer", "branch_staff", "branch_owner", "support", "regional_manager", "driver"]) {
        await expect(
          setUserCustomClaims({ targetUid: "usr_victim_1", role: "branch_staff" }, { role } as any)
        ).rejects.toThrow(/Permission denied/);
      }
      // Nothing minted on denial.
      expect(customClaimsRecord["usr_victim_1"]).toBeUndefined();
      expect(savedDocs["users/usr_victim_1"]).toBeUndefined();
    });

    it("denies setUserCustomClaims with no caller (fail-closed, not fail-open)", async () => {
      await expect(
        setUserCustomClaims({ targetUid: "usr_victim_2", role: "support" })
      ).rejects.toThrow(/Caller authorization required/);
      await expect(
        setUserCustomClaims({ targetUid: "usr_victim_2", role: "support" }, null)
      ).rejects.toThrow(/Caller authorization required/);
      expect(customClaimsRecord["usr_victim_2"]).toBeUndefined();
    });

    it("denies a revoked (stale-claim customer) caller attempting to mint roles", async () => {
      // Ex-staffer whose token still carries branch_staff but whose registry
      // was revoked would present customer claims after refresh — either way,
      // a non-brand caller cannot mint.
      await expect(
        assignUserRole({ role: "customer", isBrandAdmin: false } as any, {
          targetUid: "usr_accomplice",
          role: "branch_owner",
        })
      ).rejects.toThrow(/Permission denied/);
      expect(customClaimsRecord["usr_accomplice"]).toBeUndefined();
    });

    it("lets a brand caller mint through the setter directly", async () => {
      const result = await setUserCustomClaims(
        { targetUid: "usr_direct_1", role: "support" },
        brandCaller
      );
      expect(result.success).toBe(true);
      expect(customClaimsRecord["usr_direct_1"].role).toBe("support");
    });
  });
});
