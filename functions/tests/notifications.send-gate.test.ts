/**
 * N-01 send gate: one authority for purpose/recipient/audience, zero
 * transport calls on any violation, deterministic quarantine rows.
 *
 * Hermetic: firebase-admin and the Firestore/messaging boundary are faked
 * in-memory. No network, no emulator, no device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const quarantine = new Map<string, any>();
  const audit: any[] = [];
  const snapshots: any[] = [];
  const inbox: Array<{ uid: string; ref: string; doc: any; updates: any[] }> = [];
  const owners = new Map<string, { userId?: string; installationId?: string }>();
  const prefsQueries: string[] = [];
  const prefDocs = new Map<string, any>();

  const notificationsDoc = (uid: string, ref: string) => {
    const entry = { uid, ref, doc: null as any, updates: [] as any[] };
    inbox.push(entry);
    return {
      set: async (doc: any) => {
        entry.doc = doc;
      },
      update: async (patch: any) => {
        entry.updates.push(patch);
      },
    };
  };

  const usersDoc = (uid: string) => ({
    get: async () => ({ exists: true, data: () => ({ fcmTokens: [] }) }),
    update: async () => undefined,
    collection(sub: string) {
      if (sub === "notifications") {
        return { doc: (ref: string) => notificationsDoc(uid, ref) };
      }
      if (sub === "device_prefs") {
        return {
          limit: (n: number) => ({
            get: async () => {
              prefsQueries.push(uid);
              const ids = [...prefDocs.keys()]
                .filter((key) => key.startsWith(`${uid}/`))
                .map((key) => key.split("/")[1]);
              const docs = ids.slice(0, n).map((id) => ({
                id,
                data: () => prefDocs.get(`${uid}/${id}`) || {},
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
      }
      throw new Error(`unexpected user subcollection: ${sub}`);
    },
  });

  const db = {
    collection(name: string) {
      if (name === "notification_quarantine") {
        return {
          doc: (id: string) => ({
            id,
            set: async (doc: any) => quarantine.set(id, doc),
          }),
        };
      }
      if (name === "admin_audit_logs") {
        return { add: async (row: any) => audit.push(row) };
      }
      if (name === "dev_error_snapshots") {
        return {
          doc: (id: string) => ({ id, set: async (doc: any) => snapshots.push(doc) }),
        };
      }
      if (name === "device_tokens") {
        return { doc: (id: string) => ({ id, path: `device_tokens/${id}` }) };
      }
      if (name === "users") {
        return { doc: (uid: string) => usersDoc(uid) };
      }
      throw new Error(`unexpected collection: ${name}`);
    },
    getAll: async (...refs: any[]) =>
      refs.map((ref: any) => ({
        id: ref.id,
        exists: owners.has(ref.id),
        data: () => owners.get(ref.id) || {},
      })),
    runTransaction: async (fn: any) => fn({ get: async () => ({ exists: false, data: () => ({}) }), set: () => undefined }),
  };

  const send = vi.fn(async () => "mock_message_id");
  const sendEachForMulticast = vi.fn(async (payload: any) => ({
    successCount: payload.tokens.length,
    failureCount: 0,
    responses: payload.tokens.map(() => ({ success: true })),
  }));

  return {
    quarantine,
    audit,
    snapshots,
    inbox,
    owners,
    prefDocs,
    prefsQueries,
    db,
    send,
    sendEachForMulticast,
  };
});

vi.mock("../src/core/firebase", () => ({
  db: h.db,
  messaging: { send: h.send, sendEachForMulticast: h.sendEachForMulticast },
}));
vi.mock("firebase-admin", () => ({
  firestore: {
    FieldValue: {
      serverTimestamp: () => "UNIT_TIMESTAMP",
      arrayRemove: (...tokens: string[]) => ({ remove: tokens }),
    },
  },
}));

import {
  SendGateError,
  resolveSend,
  sendFcmMessage,
  sendMulticastFcm,
} from "../src/modules/notifications/index";
import { buildParityExtras } from "../src/modules/notifications/templates";

const payload = { notification: { title: "Order update", body: "Your order moved." } };

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VITEST", "");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.quarantine.clear();
  h.audit.length = 0;
  h.snapshots.length = 0;
  h.inbox.length = 0;
  h.owners.clear();
  h.prefDocs.clear();
  h.prefsQueries.length = 0;
  h.send.mockClear();
  h.sendEachForMulticast.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("send gate: customer purpose requires a server-resolved recipient", () => {
  it("customer purpose with no uid quarantines and performs ZERO transport calls", async () => {
    await expect(
      sendMulticastFcm(["unit_token"], payload, undefined, { purpose: "orderUpdates" })
    ).rejects.toBeInstanceOf(SendGateError);

    expect(h.sendEachForMulticast).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.quarantine.size).toBe(1);
    const row = [...h.quarantine.values()][0];
    expect(row.reason).toBe("customer_recipient_missing");
    expect(row.purpose).toBe("orderUpdates");
    expect(h.audit.map((entry) => entry.action)).toContain("notification_quarantined");
    expect(h.snapshots).toHaveLength(1);
  });

  it("a repeated violation maps to ONE quarantine row (deterministic id)", async () => {
    await expect(
      sendMulticastFcm(["unit_token"], payload, undefined, { purpose: "offers" })
    ).rejects.toBeInstanceOf(SendGateError);
    await expect(
      sendMulticastFcm(["unit_token"], payload, undefined, { purpose: "offers" })
    ).rejects.toBeInstanceOf(SendGateError);
    expect(h.quarantine.size).toBe(1);
    expect(h.sendEachForMulticast).not.toHaveBeenCalled();
  });
});

describe("send gate: unknown purpose is never inferred from data.type", () => {
  it("rejects an unregistered purpose with a NEW_KOT payload type and zero sends", async () => {
    await expect(
      resolveSend({
        purpose: "NEW_KOT",
        recipientUid: "unit_user",
        tokens: ["unit_token"],
        payloadType: "NEW_KOT",
        source: "unit_test",
      })
    ).rejects.toBeInstanceOf(SendGateError);

    const row = [...h.quarantine.values()][0];
    expect(row.reason).toBe("unknown_purpose");
    // data.type is audit context only — never a classifier.
    expect(row.payloadType).toBe("NEW_KOT");
    expect(h.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it("rejects a missing purpose even when data.type names a customer status", async () => {
    await expect(
      sendMulticastFcm(
        ["unit_token"],
        { ...payload, data: { type: "ORDER_STATUS_UPDATE" } },
        "unit_user",
        { purpose: undefined as any }
      )
    ).rejects.toBeInstanceOf(SendGateError);
    expect(h.sendEachForMulticast).not.toHaveBeenCalled();
  });
});

describe("send gate: staff purpose needs a trusted actor", () => {
  it("rejects an operational topic send from an untrusted actor", async () => {
    await expect(
      sendFcmMessage(
        { topic: "branch_b1_orders", notification: { title: "KOT", body: "New order" } } as any,
        { purpose: "operational" }
      )
    ).rejects.toBeInstanceOf(SendGateError);
    expect(h.send).not.toHaveBeenCalled();
    expect([...h.quarantine.values()][0].reason).toBe("untrusted_actor");
  });

  it("allows a trusted operational topic send (no prefs read, no inbox row)", async () => {
    const result = await sendFcmMessage(
      { topic: "branch_b1_orders", notification: { title: "KOT", body: "New order" } } as any,
      { purpose: "operational", actor: { trusted: true } }
    );
    expect(result).toBe(true);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.inbox).toHaveLength(0);
    expect(h.prefsQueries).toHaveLength(0);
  });
});

describe("send gate: system badge clear", () => {
  it("sends badge 0 even with every category disabled, writes no inbox row and reads no prefs", async () => {
    h.owners.set("unit_token", { userId: "unit_user", installationId: "install_unit" });
    h.prefDocs.set("unit_user/install_unit", {
      notificationPrefs: {
        offers: false,
        orderUpdates: false,
        announcements: false,
        supportReplies: false,
      },
    });

    const result = await sendMulticastFcm(
      ["unit_token"],
      {
        data: { type: "badge_clear", badge: "0" },
        ...buildParityExtras("", "", { badge: 0 }),
      },
      "unit_user",
      { purpose: "system" }
    );

    expect(result.successCount).toBe(1);
    const sent = h.sendEachForMulticast.mock.calls[0][0];
    expect(sent.data.badge).toBe("0");
    expect(sent.apns.payload.aps.badge).toBe(0);
    expect(h.inbox).toHaveLength(0);
    expect(h.prefsQueries).toHaveLength(0);
  });

  it("refuses a system badge that would increment", async () => {
    h.owners.set("unit_token", { userId: "unit_user" });
    await expect(
      sendMulticastFcm(
        ["unit_token"],
        { data: { type: "badge_clear", badge: "1" } },
        "unit_user",
        { purpose: "system" }
      )
    ).rejects.toThrow(/badge 0/i);
    expect(h.sendEachForMulticast).not.toHaveBeenCalled();
  });
});
