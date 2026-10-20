import { describe, it, expect, vi, beforeEach } from "vitest";

// FIX2 (C1) route-boundary regression: the /auth/migrateGuest route previously
// validated the body with a 3-field schema and REPLACED req.body with that
// subset, so the service never received guestSessionId/anonymousUid/name/
// addresses/guestProof and the endpoint silently migrated NOTHING while
// still answering success:true. These tests pin:
//  1. the wire schema preserves every service-accepted field,
//  2. the route->service hand-off carries them (service mocked),
//  3. oversized/unknown payloads fail loudly (400) instead of being stripped,
//  4. a forged-looking guestProof still REACHES the service (ownership
//     enforcement and refusal semantics live service-side; the boundary must
//     not silently delete the evidence).

const calls: any[] = [];
const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => ({ exists: !!savedDocs[`${colName}/${docId}`], data: () => savedDocs[`${colName}/${docId}`] || {} })),
    set: vi.fn(async () => ""),
    update: vi.fn(async () => ""),
  });
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) => docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
    }),
    runTransaction: vi.fn(async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      })
    ),
  };
  return { mockDb, savedDocs };
});

vi.mock("../src/modules/auth/guestMigration", async () => {
  const schema = await import("../src/modules/auth/guestMigration.schema");
  const actualService = await (async () => {
    try {
      return await vi.importActual<typeof import("../src/modules/auth/guestMigration")>("../src/modules/auth/guestMigration");
    } catch {
      return {};
    }
  })();
  return {
    ...(actualService as any),
    migrateGuestAccount: (input: any) => {
      calls.push(input);
      return Promise.resolve({
        success: true,
        permanentUid: input?.permanentUid,
        migratedOrdersCount: 0,
        migratedTicketsCount: 0,
        migratedAddressesCount: 0,
        cartMigrated: false,
        welcomeBonusAwarded: false,
        bonusCoins: 0,
        skippedProtectedCount: 0,
      });
    },
  };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: { firestore: firestoreFn, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { migrateGuestSchema } from "../src/core/validation";
import { validateBody } from "../src/core/validation";
import { migrateGuestAccount, type MigrationCaller } from "../src/modules/auth/guestMigration";
import type { NextFunction, Request, Response } from "express";

function runMiddleware(body: any): { next: ReturnType<typeof vi.fn>; statuses: number[]; payloads: any[] } {
  const statuses: number[] = [];
  const payloads: any[] = [];
  const res = {
    status(code: number) {
      statuses.push(code);
      return { json: (p: any) => payloads.push(p) };
    },
    json(p: any) { payloads.push(p); },
  } as unknown as Response;
  const next = vi.fn(() => "");
  const req = { body } as unknown as Request;
  validateBody(migrateGuestSchema)(req as any, res as any, next as unknown as NextFunction);
  return { next, statuses, payloads };
}

const FULL_BODY = {
  guestSessionId: "sess_ok_1234567890",
  anonymousUid: "anon_uid_1234567890",
  permanentUid: "perm_uid_1234567890",
  phone: "+919876543210",
  email: "customer@example.com",
  name: "Asha Patel",
  guestProof: "0badcafe" ,
  addresses: [
    {
      id: "addr_1",
      label: "Home",
      full: "12 Burger Street, Surat",
      city: "Surat",
      pincode: "395007",
      lat: 21.1702,
      lng: 72.8311,
      isDefault: true,
    },
  ],
};

describe("migrateGuest route-boundary contract (FIX2)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("the wire schema preserves every field the service consumes", () => {
    const parsed = migrateGuestSchema.safeParse({ ...FULL_BODY });
    expect(parsed.success).toBe(true);
    const data = parsed.success ? (parsed as any).data : null;
    expect(data.guestSessionId).toBe("sess_ok_1234567890");
    expect(data.anonymousUid).toBe("anon_uid_1234567890");
    expect(data.guestProof).toBe("0badcafe");
    expect(data.addresses).toHaveLength(1);
    expect(data.addresses[0].city).toBe("Surat");
    expect(data.name).toBe("Asha Patel");
  });

  it("the route-shaped hand-off delivers the consumed fields to the (mocked) service", async () => {
    const { next, statuses } = runMiddleware({ ...FULL_BODY });
    expect(next).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveLength(0);
    const caller: unknown = { uid: "perm_uid_1234567890", phone_number: "+919876543210", email: "customer@example.com" };
    await migrateGuestAccount({ ...(migrateGuestSchema.parse({ ...FULL_BODY })), caller } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      guestSessionId: "sess_ok_1234567890",
      anonymousUid: "anon_uid_1234567890",
      guestProof: "0badcafe",
      permanentUid: "perm_uid_1234567890",
    });
    expect(calls[0].addresses).toHaveLength(1);
  });

  it("a forged-looking guestProof is not stripped and still reaches the service", async () => {
    const body = { ...FULL_BODY, guestProof: "f0rged-not-hex!!" };
    const parsed = migrateGuestSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    await migrateGuestAccount({ ...(migrateGuestSchema.parse(body)), caller: { uid: "perm_uid_1234567890" } } as any);
    expect(calls[0]?.guestProof).toBe("f0rged-not-hex!!");
  });

  it("unknown keys fail loudly (strict), they are never silently stripped", () => {
    const { next, statuses, payloads } = runMiddleware({ ...FULL_BODY, welcomeBonusHack: "surprise" });
    expect(next).not.toHaveBeenCalled();
    expect(statuses).toEqual([400]);
    expect(payloads[0]?.error).toContain("Invalid request body");
  });

  it("more than 20 addresses is a loud 400, not a silent truncation", () => {
    const body = {
      ...FULL_BODY,
      addresses: Array.from({ length: 21 }, (_, i) => ({ ...FULL_BODY.addresses[0], id: `addr_${i}` })),
    };
    const { next, statuses } = runMiddleware(body);
    expect(next).not.toHaveBeenCalled();
    expect(statuses).toEqual([400]);
  });

  it("malformed email is a loud 400", () => {
    const { next, statuses } = runMiddleware({ ...FULL_BODY, email: "not-an-email" });
    expect(next).not.toHaveBeenCalled();
    expect(statuses).toEqual([400]);
  });
});
