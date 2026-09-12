import { describe, it, expect, vi, beforeEach } from "vitest";

// Readiness-6 rig: staff invites mint Auth accounts + role claims through
// the guarded setter. Mocks Admin Auth (lookup/create/claims) and an
// in-memory Firestore.
const { mockDb, savedDocs, mockAuth } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({
      exists: !!savedDocs[`${colName}/${docId}`],
      data: () => savedDocs[`${colName}/${docId}`] || {},
    })),
    set: vi.fn(async (data: any, options?: any) => {
      const p = `${colName}/${docId}`;
      savedDocs[p] =
        options?.merge && savedDocs[p] ? { ...savedDocs[p], ...data } : data;
    }),
  });
  const mockDb: any = {
    collection: (colName: string) => ({
      doc: (docId: string) => docRef(colName, docId),
    }),
  };
  const mockAuth: any = {
    getUserByEmail: vi.fn(),
    createUser: vi.fn(),
    setCustomUserClaims: vi.fn(async () => undefined),
    revokeRefreshTokens: vi.fn(async () => undefined),
  };
  return { mockDb, savedDocs, mockAuth };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
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

import { inviteStaffMember } from "../src/modules/auth/staffInvite";

const BRAND_CALLER: any = { uid: "brand_1", role: "brand_owner" };

const invite = (over: Record<string, any> = {}) =>
  inviteStaffMember(
    {
      name: "New Staffer",
      email: "staffer@burgonomics.in",
      phone: "+919876543210",
      role: "branch_staff",
      branchIds: ["branch_surat_01"],
      cityIds: [],
      ...over,
    },
    BRAND_CALLER
  );

describe("Readiness-6: server staff invite", () => {
  beforeEach(() => {
    for (const key of Object.keys(savedDocs)) delete savedDocs[key];
    vi.clearAllMocks();
  });

  it("creates an Auth account, applies claims, and writes the staff profile", async () => {
    mockAuth.getUserByEmail.mockRejectedValueOnce({ code: "auth/user-not-found" });
    mockAuth.createUser.mockResolvedValueOnce({ uid: "uid_new_1" });
    const res = await invite();
    expect(res).toMatchObject({
      success: true,
      uid: "uid_new_1",
      email: "staffer@burgonomics.in",
      role: "branch_staff",
      invited: true,
    });
    expect(mockAuth.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: "staffer@burgonomics.in" })
    );
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith(
      "uid_new_1",
      expect.objectContaining({ role: "branch_staff", isStaff: true })
    );
    expect(savedDocs["users/uid_new_1"].role).toBe("branch_staff");
    expect(savedDocs["users/uid_new_1"].active).toBe(true);
    expect(savedDocs["admins/uid_new_1"].role).toBe("branch_staff");
  });

  it("re-inviting an existing email updates claims instead of duplicating", async () => {
    mockAuth.getUserByEmail.mockResolvedValueOnce({ uid: "uid_old_9" });
    const res = await invite({ email: "veteran@burgonomics.in" });
    expect(res.invited).toBe(false);
    expect(res.uid).toBe("uid_old_9");
    expect(mockAuth.createUser).not.toHaveBeenCalled();
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalled();
  });

  it("denies non-brand callers before touching Auth", async () => {
    await expect(
      inviteStaffMember(
        { name: "X", email: "x@burgonomics.in", role: "branch_staff" },
        { uid: "staff_1", role: "branch_staff" } as any
      )
    ).rejects.toThrow(/Permission denied/);
    expect(mockAuth.getUserByEmail).not.toHaveBeenCalled();
    expect(mockAuth.createUser).not.toHaveBeenCalled();
  });

  it("refuses customer role and client-supplied PINs loudly", async () => {
    await expect(invite({ role: "customer" })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(invite({ pin: "4321" } as any)).rejects.toThrow();
    expect(mockAuth.createUser).not.toHaveBeenCalled();
  });

  it("rejects malformed email and unknown roles", async () => {
    await expect(invite({ email: "not-an-email" })).rejects.toThrow();
    await expect(invite({ role: "ceo_of_everything" })).rejects.toThrow(/Invalid role/);
    expect(mockAuth.createUser).not.toHaveBeenCalled();
  });
});
