import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// /auth/migrateGuest ROUTE WIRING (M4) — behavioural.
//
// The regression this pins: the route called `migrateGuestAccount(body)` with
// no second argument, so the service's caller/target bind and the
// OTP-verified-phone contradiction guard were dead code. Pinning handler source
// text could not catch that (a dead or reordered branch keeps the text
// matching), so this suite boots the real express app from src/index.ts and
// drives the actual middleware chain over HTTP with the service stubbed.

const { verifyIdToken, migrateGuestAccount } = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  migrateGuestAccount: vi.fn(),
}));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => {
    const doc = () => ({
      get: async () => ({ exists: false, data: () => undefined }),
      set: async () => undefined,
    });
    const collection = () => ({
      doc,
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
      get: async () => ({ empty: true, docs: [] }),
    });
    return { collection, runTransaction: async (fn: any) => fn({ get: async () => ({ exists: false }), set: () => undefined }) };
  });
  firestoreFn.FieldValue = FieldValue;
  const authFn: any = vi.fn(() => ({ verifyIdToken, getUser: vi.fn() }));
  return {
    default: {
      firestore: firestoreFn,
      auth: authFn,
      messaging: vi.fn(() => ({ send: vi.fn() })),
      appCheck: vi.fn(() => ({ verifyToken: vi.fn() })),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
      credential: { cert: vi.fn() },
    },
    firestore: firestoreFn,
    auth: authFn,
    messaging: vi.fn(() => ({ send: vi.fn() })),
    appCheck: vi.fn(() => ({ verifyToken: vi.fn() })),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
    credential: { cert: vi.fn() },
  };
});

vi.mock("../src/modules/auth", () => ({
  migrateGuestAccount,
  setUserCustomClaims: vi.fn(),
  assignUserRole: vi.fn(),
  revokeUserRole: vi.fn(),
  verifyBonusEligibility: vi.fn(),
  cleanupExpiredGuestSessionsWorker: vi.fn(),
  onUserDeletedCleanup: vi.fn(),
}));

import { app } from "../src/index";

const VERIFIED_USER = {
  uid: "perm_uid_verified",
  phone_number: "+919812345678",
  email: "verified@example.com",
};

let server: Server;
let baseUrl: string;
let previousDeployEnv: string | undefined;

beforeAll(async () => {
  previousDeployEnv = process.env.BURGONOMICS_ENV;
  process.env.BURGONOMICS_ENV = "dev";
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousDeployEnv === undefined) delete process.env.BURGONOMICS_ENV;
  else process.env.BURGONOMICS_ENV = previousDeployEnv;
});

beforeEach(() => {
  verifyIdToken.mockReset();
  migrateGuestAccount.mockReset();
  verifyIdToken.mockResolvedValue(VERIFIED_USER);
  migrateGuestAccount.mockResolvedValue({ success: true, migrated: true });
});

function postMigrateGuest(body: Record<string, any>, token = "id-token-1") {
  return fetch(`${baseUrl}/auth/migrateGuest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe("/auth/migrateGuest route wiring (M4)", () => {
  it("passes the ID-token-verified caller as the SECOND argument", async () => {
    const res = await postMigrateGuest({ permanentUid: "body_supplied_uid", phone: "+919800000000" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });

    expect(migrateGuestAccount).toHaveBeenCalledTimes(1);
    const [payload, caller] = migrateGuestAccount.mock.calls[0];
    // The verified token binds the target uid; a body-supplied uid cannot.
    expect(payload.permanentUid).toBe(VERIFIED_USER.uid);
    expect(caller).toMatchObject({ uid: VERIFIED_USER.uid, phone_number: VERIFIED_USER.phone_number });
    // The caller is never smuggled into the strict payload.
    expect(payload).not.toHaveProperty("caller");
  });

  it("fails closed at 401 when the ID token cannot be verified", async () => {
    verifyIdToken.mockRejectedValueOnce(new Error("token revoked"));
    const res = await postMigrateGuest({ permanentUid: "body_uid" });
    expect(res.status).toBe(401);
    expect(migrateGuestAccount).not.toHaveBeenCalled();
  });

  it("maps a typed 403 refusal through so the client can re-auth", async () => {
    migrateGuestAccount.mockRejectedValueOnce(
      Object.assign(new Error("Caller does not own the migration target"), {
        statusCode: 403,
        code: "CALLER_TARGET_MISMATCH",
      })
    );
    const res = await postMigrateGuest({ permanentUid: "other_uid" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "CALLER_TARGET_MISMATCH" });
  });

  it("maps an unexpected failure to a fail-closed 500", async () => {
    migrateGuestAccount.mockRejectedValueOnce(new Error("firestore unavailable"));
    const res = await postMigrateGuest({ permanentUid: "body_uid" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "firestore unavailable" });
  });
});
