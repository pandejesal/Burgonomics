import { describe, it, expect, vi, beforeEach } from "vitest";

// Loop 50/120: account erasure must delete the caller's own Auth user and
// refuse without one — the DPDP right must actually work.

const deleted: string[] = [];

vi.mock("firebase-admin", () => {
  const firestoreFn: any = vi.fn(() => ({}));
  firestoreFn.FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
  };
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({
        deleteUser: vi.fn(async (uid: string) => {
          deleted.push(uid);
        }),
        revokeRefreshTokens: vi.fn(async () => {}),
      })),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({
      deleteUser: vi.fn(async (uid: string) => {
        deleted.push(uid);
      }),
    })),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { deleteUserAccount } from "../src/modules/auth/accountDeletion";

describe("deleteUserAccount", () => {
  beforeEach(() => {
    deleted.length = 0;
  });

  it("deletes the caller's own Auth user", async () => {
    deleted.length = 0;
    const res = await deleteUserAccount("user_1");
    expect(res).toMatchObject({ success: true, uid: "user_1" });
    expect(deleted).toContain("user_1");
  });

  it("refuses without an authenticated uid", async () => {
    await expect(deleteUserAccount("")).rejects.toMatchObject({ statusCode: 401 });
    expect(deleted).toEqual([]);
  });
});
