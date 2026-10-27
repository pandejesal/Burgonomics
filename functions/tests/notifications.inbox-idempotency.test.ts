/**
 * N-05 inbox persistence: every account send writes exactly ONE
 * users/{uid}/notifications/{ref} row BEFORE FCM, injects only
 * purpose/category/recipientUid/ref, and failure/suppression updates the same
 * ref (never a second dangling row).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const events: string[] = [];
  const inbox = new Map<string, any>();
  const updates: Array<{ ref: string; patch: any }> = [];
  const owners = new Map<string, any>();
  const prefDocs = new Map<string, any>();
  let failInboxWrite = false;
  let sendResult = { successCount: 1, failureCount: 0, responses: [{ success: true }] };

  const db = {
    collection(name: string) {
      if (name === "device_tokens") {
        return { doc: (id: string) => ({ id, path: `device_tokens/${id}` }) };
      }
      if (name === "users") {
        return {
          doc(uid: string) {
            return {
              get: async () => ({ exists: true, data: () => ({ fcmTokens: [] }) }),
              update: async () => undefined,
              collection(sub: string) {
                if (sub === "notifications") {
                  return {
                    doc(ref: string) {
                      return {
                        set: async (doc: any) => {
                          if (failInboxWrite) throw new Error("unit inbox unavailable");
                          events.push("inbox:set");
                          inbox.set(`${uid}/${ref}`, doc);
                        },
                        update: async (patch: any) => {
                          events.push("inbox:update");
                          updates.push({ ref: `${uid}/${ref}`, patch });
                          const cur = inbox.get(`${uid}/${ref}`) || {};
                          inbox.set(`${uid}/${ref}`, { ...cur, ...patch });
                        },
                      };
                    },
                  };
                }
                if (sub === "device_prefs") {
                  return {
                    limit: (_n: number) => ({
                      get: async () => {
                        events.push("prefs:read");
                        const docs = [...prefDocs.entries()]
                          .filter(([key]) => key.startsWith(`${uid}/`))
                          .map(([key, data]) => ({ id: key.split("/")[1], data: () => data }));
                        return { docs, size: docs.length };
                      },
                    }),
                  };
                }
                throw new Error(`unexpected subcollection: ${sub}`);
              },
            };
          },
        };
      }
      if (name === "notification_quarantine") {
        return { doc: () => ({ set: async () => undefined }) };
      }
      if (name === "admin_audit_logs") return { add: async () => undefined };
      if (name === "dev_error_snapshots") return { doc: () => ({ set: async () => undefined }) };
      throw new Error(`unexpected collection: ${name}`);
    },
    getAll: async (...refs: any[]) =>
      refs.map((ref: any) => ({
        id: ref.id,
        exists: owners.has(ref.id),
        data: () => owners.get(ref.id) || {},
      })),
  };

  const sendEachForMulticast = vi.fn(async (payload: any) => {
    events.push("fcm");
    return {
      successCount: sendResult.successCount,
      failureCount: sendResult.failureCount,
      responses: payload.tokens.map(() => sendResult.responses[0]),
    };
  });

  return {
    events,
    inbox,
    updates,
    owners,
    prefDocs,
    db,
    sendEachForMulticast,
    setFailInboxWrite: (value: boolean) => {
      failInboxWrite = value;
    },
    setSendResult: (value: typeof sendResult) => {
      sendResult = value;
    },
  };
});

vi.mock("../src/core/firebase", () => ({
  db: h.db,
  messaging: { send: vi.fn(async () => "id"), sendEachForMulticast: h.sendEachForMulticast },
}));
vi.mock("firebase-admin", () => ({
  firestore: {
    FieldValue: {
      serverTimestamp: () => "UNIT_TIMESTAMP",
      arrayRemove: (...tokens: string[]) => ({ remove: tokens }),
    },
  },
}));

import { pushToCustomer, sendMulticastFcm } from "../src/modules/notifications/fcmClient";

const UID = "unit_customer";
const TOKEN = "unit_device_token_123456";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VITEST", "");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  h.events.length = 0;
  h.inbox.clear();
  h.updates.length = 0;
  h.owners.clear();
  h.prefDocs.clear();
  h.sendEachForMulticast.mockClear();
  h.setFailInboxWrite(false);
  h.setSendResult({ successCount: 1, failureCount: 0, responses: [{ success: true }] });
  h.owners.set(TOKEN, { userId: UID });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("inbox row is written before FCM", () => {
  it("persists one ref first, sends the minimal account payload, then marks the same ref sent", async () => {
    const result = await sendMulticastFcm(
      [TOKEN],
      { notification: { title: "Order update", body: "Your order is on the way." } },
      UID,
      { purpose: "orderUpdates" }
    );

    expect(h.events[0]).toBe("inbox:set");
    expect(h.events).toContain("fcm");
    expect(h.events.indexOf("inbox:set")).toBeLessThan(h.events.indexOf("fcm"));

    expect(h.inbox.size).toBe(1);
    const [[path, doc]] = [...h.inbox.entries()];
    const ref = path.split("/")[1];
    expect(doc).toMatchObject({
      id: ref,
      title: "Order update",
      purpose: "orderUpdates",
      read: false,
      type: "orderUpdates",
      targetId: null,
    });

    const sent = h.sendEachForMulticast.mock.calls[0][0];
    expect(sent.data).toEqual({
      purpose: "orderUpdates",
      category: "order",
      recipientUid: UID,
      ref,
    });
    expect(result.inboxRef).toBe(ref);
    expect(result.inboxPersisted).toBe(true);
    // Same ref, no second row.
    expect(h.inbox.size).toBe(1);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].ref).toBe(path);
    expect(h.updates[0].patch.delivery).toBe("sent");
  });

  it("maps sender ticket/order ids to targetId and keeps type as the compatibility alias", async () => {
    await sendMulticastFcm(
      [TOKEN],
      {
        notification: { title: "Support reply", body: "We replied." },
        data: { ticketId: "ticket_unit_1", type: "ticket_reply" },
      },
      UID,
      { purpose: "supportReplies" }
    );
    const doc = [...h.inbox.values()][0];
    expect(doc.targetId).toBe("ticket_unit_1");
    expect(doc.type).toBe("ticket_reply");
    expect(doc.purpose).toBe("supportReplies");
  });

  it("updates the SAME ref to failed when the provider accepts nothing", async () => {
    h.setSendResult({
      successCount: 0,
      failureCount: 1,
      responses: [{ success: false, error: { code: "messaging/internal-error" } }],
    });
    const result = await sendMulticastFcm(
      [TOKEN],
      { notification: { title: "Order update", body: "Body" } },
      UID,
      { purpose: "orderUpdates" }
    );
    expect(h.inbox.size).toBe(1);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].patch.delivery).toBe("failed");
    expect(result.successCount).toBe(0);
    expect(result.inboxRef).toBe([...h.inbox.keys()][0].split("/")[1]);
  });

  it("withholds the push when the inbox write fails (critical throws)", async () => {
    h.setFailInboxWrite(true);
    await expect(
      sendMulticastFcm(
        [TOKEN],
        { notification: { title: "Order update", body: "Body" } },
        UID,
        { purpose: "orderUpdates", critical: true }
      )
    ).rejects.toThrow(/inbox write failed/i);
    expect(h.sendEachForMulticast).not.toHaveBeenCalled();
    expect(h.inbox.size).toBe(0);
  });
});

describe("canonical suppression keeps the inbox row", () => {
  it("all-suppressed offers: zero FCM calls, one inbox row marked suppressed", async () => {
    h.prefDocs.set(`${UID}/install_unit`, { notificationPrefs: { offers: false } });
    h.owners.set(TOKEN, { userId: UID, installationId: "install_unit" });

    const result = await sendMulticastFcm(
      [TOKEN],
      { notification: { title: "Offer", body: "Today only" } },
      UID,
      { purpose: "offers" }
    );

    expect(h.sendEachForMulticast).not.toHaveBeenCalled();
    expect(h.inbox.size).toBe(1);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].patch.delivery).toBe("suppressed");
    expect(result).toMatchObject({ successCount: 0, suppressedAll: true, suppressedCount: 1 });
    expect(result.inboxPersisted).toBe(true);
  });

  it("a critical all-suppressed send does not throw (customer choice, inbox persists)", async () => {
    h.prefDocs.set(`${UID}/install_unit`, { notificationPrefs: { orderUpdates: false } });
    h.owners.set(TOKEN, { userId: UID, installationId: "install_unit" });

    await expect(
      sendMulticastFcm(
        [TOKEN],
        { notification: { title: "Order update", body: "Body" } },
        UID,
        { purpose: "orderUpdates", critical: true }
      )
    ).resolves.toMatchObject({ suppressedAll: true, inboxPersisted: true });
    expect(h.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it("reads canonical prefs exactly once per account send", async () => {
    h.prefDocs.set(`${UID}/install_unit`, { notificationPrefs: { orderUpdates: true } });
    h.owners.set(TOKEN, { userId: UID, installationId: "install_unit" });
    await sendMulticastFcm(
      [TOKEN, "unit_second_token"],
      { notification: { title: "Order", body: "Body" } },
      UID,
      { purpose: "orderUpdates" }
    );
    expect(h.events.filter((event) => event === "prefs:read")).toHaveLength(1);
  });
});

describe("pushToCustomer routes through the same inbox contract", () => {
  it("does not create a second row or send when the purpose is absent (fail closed)", async () => {
    await pushToCustomer(UID, "Title", "Body", { orderId: "unit_order" });
    expect(h.sendEachForMulticast).not.toHaveBeenCalled();
    expect(h.inbox.size).toBe(0);
  });
});
