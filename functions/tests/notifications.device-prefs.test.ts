/**
 * N-01/N-05 canonical preference semantics: documented defaults, explicit
 * false preservation, one-recipient canonical read, legacyUnresolved
 * accounting, and zero preference reads for staff purposes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prefDocs = new Map<string, any>();
  const queries: string[] = [];
  const getAllCalls: number[] = [];
  const conflicts: string[] = [];

  const db = {
    collection(name: string) {
      if (name !== "users") throw new Error(`unexpected collection: ${name}`);
      return {
        doc(uid: string) {
          return {
            collection(sub: string) {
              if (sub !== "device_prefs") throw new Error(`unexpected sub: ${sub}`);
              return {
                limit: (n: number) => ({
                  get: async () => {
                    queries.push(uid);
                    const docs = [...prefDocs.entries()]
                      .filter(([key]) => key.startsWith(`${uid}/`))
                      .slice(0, n)
                      .map(([key, data]) => ({
                        id: key.split("/")[1],
                        data: () => data,
                      }));
                    return { docs, size: docs.length };
                  },
                }),
                doc: (id: string) => ({
                  id,
                  path: `users/${uid}/device_prefs/${id}`,
                  get: async () => {
                    const found = prefDocs.get(`${uid}/${id}`);
                    return { exists: !!found, data: () => found || {} };
                  },
                }),
              };
            },
          };
        },
      };
    },
    getAll: async (...refs: any[]) => {
      getAllCalls.push(refs.length);
      return refs.map((ref: any) => {
        const uid = ref.path.split("/")[1];
        const id = ref.id;
        const found = prefDocs.get(`${uid}/${id}`);
        return { exists: !!found, data: () => found || {} };
      });
    },
  };

  return { prefDocs, queries, getAllCalls, conflicts, db };
});

vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => ({
  firestore: {
    FieldValue: {
      serverTimestamp: () => "UNIT_TIMESTAMP",
    },
  },
}));

import {
  DEFAULT_NOTIFICATION_PREFS,
  filterTokensByPrefs,
  getDevicePreferences,
  loadCanonicalPrefs,
  normalizeNotificationPrefs,
  updateDevicePreferences,
} from "../src/modules/notifications/devicePrefs";
import { isPurposeEnabled } from "../src/modules/notifications/devicePrefs";

beforeEach(() => {
  h.prefDocs.clear();
  h.queries.length = 0;
  h.getAllCalls.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("category defaults (contract §9)", () => {
  it("absent keys resolve offers/orderUpdates/supportReplies true and announcements false", () => {
    const prefs = normalizeNotificationPrefs(undefined);
    expect(prefs).toEqual({
      offers: true,
      orderUpdates: true,
      announcements: false,
      supportReplies: true,
    });
    expect(isPurposeEnabled(prefs, "offers")).toBe(true);
    expect(isPurposeEnabled(prefs, "orderUpdates")).toBe(true);
    expect(isPurposeEnabled(prefs, "supportReplies")).toBe(true);
    expect(isPurposeEnabled(prefs, "announcements")).toBe(false);
  });

  it("preserves an explicit false (a stored decision is never coerced back)", () => {
    const prefs = normalizeNotificationPrefs({
      offers: false,
      orderUpdates: false,
      announcements: true,
      supportReplies: false,
      junk: "ignored",
    });
    expect(prefs).toEqual({
      offers: false,
      orderUpdates: false,
      announcements: true,
      supportReplies: false,
    });
  });

  it("staff and system purposes are never preference-gated", () => {
    expect(isPurposeEnabled(DEFAULT_NOTIFICATION_PREFS, "operational")).toBe(true);
    expect(isPurposeEnabled(DEFAULT_NOTIFICATION_PREFS, "system")).toBe(true);
  });
});

describe("canonical read at send time", () => {
  it("reads the recipient's device_prefs once and honours per-installation values", async () => {
    h.prefDocs.set("unit_user/install_a", { notificationPrefs: { offers: false } });
    h.prefDocs.set("unit_user/install_b", { notificationPrefs: { offers: true } });
    const snapshot = await loadCanonicalPrefs("unit_user");
    expect(snapshot.docsRead).toBe(2);
    expect(snapshot.byInstallation.get("install_a")?.offers).toBe(false);
    expect(snapshot.byInstallation.get("install_b")?.offers).toBe(true);

    const result = filterTokensByPrefs(
      "offers",
      [
        { token: "tok_a", installationId: "install_a" },
        { token: "tok_b", installationId: "install_b" },
      ],
      snapshot
    );
    expect(result.eligible).toEqual(["tok_b"]);
    expect(result.suppressed).toEqual(["tok_a"]);
    expect(result.legacyUnresolved).toBe(0);
  });

  it("defaults a token with no installationId and counts legacyUnresolved", async () => {
    const snapshot = await loadCanonicalPrefs("unit_user");
    const result = filterTokensByPrefs(
      "announcements",
      [{ token: "tok_legacy", installationId: undefined }],
      snapshot
    );
    expect(result.eligible).toEqual([]);
    expect(result.suppressed).toEqual(["tok_legacy"]);
    expect(result.legacyUnresolved).toBe(1);
    expect(result.suppressedAll).toBe(true);
  });

  it("defaults a token whose installationId has no canonical row", async () => {
    const snapshot = await loadCanonicalPrefs("unit_user");
    const result = filterTokensByPrefs(
      "orderUpdates",
      [{ token: "tok_rotated", installationId: "install_missing" }],
      snapshot
    );
    expect(result.eligible).toEqual(["tok_rotated"]);
    expect(result.legacyUnresolved).toBe(1);
  });

  it("a read failure is reported and falls back to documented defaults", async () => {
    const original = h.db.collection;
    (h.db as any).collection = () => {
      throw new Error("prefs read unavailable");
    };
    const snapshot = await loadCanonicalPrefs("unit_user");
    (h.db as any).collection = original;
    expect(snapshot.readFailed).toBe(true);
    const result = filterTokensByPrefs(
      "orderUpdates",
      [{ token: "tok_1", installationId: "install_a" }],
      snapshot
    );
    expect(result.eligible).toEqual(["tok_1"]);
    expect(result.legacyUnresolved).toBe(1);
  });

  it("never reads preference documents for staff topics", () => {
    const result = filterTokensByPrefs(
      "operational",
      [{ token: "tok_staff", installationId: "install_a" }],
      { byInstallation: new Map(), docsRead: 0, truncated: false, readFailed: false }
    );
    expect(result.eligible).toEqual(["tok_staff"]);
    expect(result.docsRead).toBe(0);
    expect(h.queries).toHaveLength(0);
  });
});

describe("preference write CAS (contract §7)", () => {
  const transactionDb = (seed?: any) => {
    const stored: { value: any } = { value: seed };
    let written: any = null;
    return {
      stored,
      getWritten: () => written,
      runTransaction: async (fn: any) =>
        fn({
          get: async () => ({
            exists: stored.value !== undefined,
            data: () => stored.value || {},
          }),
          set: (_ref: any, data: any) => {
            written = data;
          },
        }),
    };
  };

  it("expectedVersion 0 creates the first record at v1", async () => {
    const fake = transactionDb();
    (h.db as any).runTransaction = fake.runTransaction;
    const result = await updateDevicePreferences({
      uid: "unit_user",
      installationId: "install_a",
      notificationPrefs: { announcements: true },
      expectedVersion: 0,
    });
    expect(result).toMatchObject({ replicated: false, version: 1, stale: false });
    expect(result.prefs).toEqual({
      offers: true,
      orderUpdates: true,
      announcements: true,
      supportReplies: true,
    });
  });

  it("expectedVersion 1 on an empty record is a 409 conflict", async () => {
    const fake = transactionDb();
    (h.db as any).runTransaction = fake.runTransaction;
    await expect(
      updateDevicePreferences({
        uid: "unit_user",
        installationId: "install_a",
        notificationPrefs: { offers: false },
        expectedVersion: 1,
      })
    ).rejects.toMatchObject({ code: "PREF_VERSION_CONFLICT" });
  });

  it("replays a mutationId without writing a second version", async () => {
    const fake = transactionDb({
      version: 2,
      notificationPrefs: { offers: false, orderUpdates: true },
      recentMutations: [
        {
          mutationId: "mutation_unit_1",
          version: 2,
          prefsHash: "offers:0",
          prefs: { offers: false, orderUpdates: true, announcements: false, supportReplies: true },
        },
      ],
    });
    (h.db as any).runTransaction = fake.runTransaction;
    const result = await updateDevicePreferences({
      uid: "unit_user",
      installationId: "install_a",
      notificationPrefs: { offers: false },
      expectedVersion: 2,
      mutationId: "mutation_unit_1",
    });
    expect(result).toMatchObject({ replicated: true, version: 2 });
    expect(fake.getWritten()).toBeNull();
  });

  it("hashes only supplied keys: replaying a mutationId with a changed patch is a 409, not replicated", async () => {
    let state: any;
    (h.db as any).runTransaction = async (fn: any) =>
      fn({
        get: async () => ({
          exists: state !== undefined,
          data: () => state || {},
        }),
        set: (_ref: any, data: any) => {
          state = { ...(state || {}), ...data };
        },
      });

    const first = await updateDevicePreferences({
      uid: "unit_user",
      installationId: "install_a",
      notificationPrefs: {},
      expectedVersion: 0,
      mutationId: "mutation_unit_empty",
    });
    expect(first).toMatchObject({ replicated: false, version: 1, stale: false });

    await expect(
      updateDevicePreferences({
        uid: "unit_user",
        installationId: "install_a",
        notificationPrefs: { announcements: false },
        expectedVersion: 1,
        mutationId: "mutation_unit_empty",
      })
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
      statusCode: 409,
      currentVersion: 1,
      currentPrefs: {
        offers: true,
        orderUpdates: true,
        announcements: false,
        supportReplies: true,
      },
    });
  });

  it("carries the server version/prefs on a CAS conflict for the customer rebase card", async () => {
    const fake = transactionDb({
      version: 4,
      notificationPrefs: { offers: false, announcements: true },
    });
    (h.db as any).runTransaction = fake.runTransaction;
    await expect(
      updateDevicePreferences({
        uid: "unit_user",
        installationId: "install_a",
        notificationPrefs: { offers: true },
        expectedVersion: 3,
      })
    ).rejects.toMatchObject({
      code: "PREF_VERSION_CONFLICT",
      currentVersion: 4,
      currentPrefs: {
        offers: false,
        orderUpdates: true,
        announcements: true,
        supportReplies: true,
      },
    });
  });
});

describe("canonical read (GET contract)", () => {
  it("returns the stored prefs and version for an existing record", async () => {
    h.prefDocs.set("unit_user/install_a", {
      version: 3,
      notificationPrefs: { announcements: true, supportReplies: false },
    });
    const result = await getDevicePreferences({
      uid: "unit_user",
      installationId: "install_a",
    });
    expect(result).toEqual({
      installationId: "install_a",
      version: 3,
      exists: true,
      notificationPrefs: {
        offers: true,
        orderUpdates: true,
        announcements: true,
        supportReplies: false,
      },
    });
  });

  it("returns documented defaults at version 0 for an absent record (never a 404)", async () => {
    const result = await getDevicePreferences({
      uid: "unit_user",
      installationId: "install_absent",
    });
    expect(result).toEqual({
      installationId: "install_absent",
      version: 0,
      exists: false,
      notificationPrefs: {
        offers: true,
        orderUpdates: true,
        announcements: false,
        supportReplies: true,
      },
    });
  });

  it("rejects a missing uid or installationId rather than reading a wrong path", async () => {
    await expect(
      getDevicePreferences({ uid: "", installationId: "install_a" })
    ).rejects.toThrow(/uid/i);
    await expect(
      getDevicePreferences({ uid: "unit_user", installationId: "" })
    ).rejects.toThrow(/installationId/i);
  });
});
