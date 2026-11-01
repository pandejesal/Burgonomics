import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the real send path, not fcmClient's NODE_ENV=test/VITEST shortcut.
// Firebase and the messaging transport are fully in-memory; no push is sent.
const h = vi.hoisted(() => {
  const owners = new Map<string, string | undefined>();
  const profiles = new Map<string, string[]>();
  const inbox: Array<{ uid: string; payload: Record<string, unknown> }> = [];
  const updates: Array<{ uid: string; payload: Record<string, any> }> = [];
  const update = vi.fn(async (uid: string, payload: Record<string, any>) => {
    updates.push({ uid, payload });
    // Faithful prune effect: only the addressed doc's list changes.
    const removed: string[] = payload?.fcmTokens?.remove ?? [];
    profiles.set(uid, (profiles.get(uid) || []).filter(t => !removed.includes(t)));
  });
  const getAll = vi.fn(async (...refs: Array<{ id: string }>) =>
    refs.map(({ id }) => {
      const exists = owners.has(id);
      const userId = owners.get(id);
      return { id, exists, data: () => ({ userId }) };
    }),
  );
  type SendResult = {
    successCount: number;
    failureCount: number;
    responses: Array<{ success: boolean; error?: { code: string } }>;
  };
  const send = vi.fn(async ({ tokens }: { tokens: string[] }): Promise<SendResult> => ({
    successCount: tokens.length,
    failureCount: 0,
    responses: tokens.map(() => ({ success: true })),
  }));
  const db = {
    getAll,
    collection(name: string) {
      if (name === "device_tokens") {
        return { doc: (id: string) => ({ id, path: `device_tokens/${id}` }) };
      }
      if (name !== "users") throw new Error(`Unexpected test collection: ${name}`);
      return {
        doc(uid: string) {
          return {
            get: async () => ({ exists: true, data: () => ({ fcmTokens: profiles.get(uid) || [] }) }),
            update: (payload: Record<string, any>) => update(uid, payload),
            collection(child: string) {
              if (child !== "notifications") throw new Error("Unexpected child collection");
              return {
                doc: () => ({
                  set: async (payload: Record<string, unknown>) => { inbox.push({ uid, payload }); },
                }),
              };
            },
          };
        },
      };
    },
  };
  return { owners, profiles, inbox, updates, update, getAll, send, db };
});

vi.mock("../src/core/firebase", () => ({
  db: h.db,
  messaging: { sendEachForMulticast: h.send },
}));
vi.mock("firebase-admin", () => ({
  firestore: {
    FieldValue: {
      serverTimestamp: () => "UNIT_TIMESTAMP",
      arrayRemove: (...tokens: string[]) => ({ remove: tokens }),
    },
  },
}));

import { FCM_SEND_TIMEOUT_MS, pushToCustomer, sendMulticastFcm } from "../src/modules/notifications/fcmClient";

const A = "unit_user_a";
const B = "unit_user_b";
const payload = { notification: { title: "Order update", body: "Your order is ready." } };

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VITEST", "");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  h.owners.clear();
  h.profiles.clear();
  h.inbox.length = 0;
  h.updates.length = 0;
  h.update.mockClear();
  h.getAll.mockClear();
  h.send.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("recipient-bound FCM never trusts a stale profile token list", () => {
  it("sends a token whose current device-token owner is the recipient", async () => {
    h.owners.set("unit_owned", A);
    const result = await sendMulticastFcm(["unit_owned"], payload, A, {
      purpose: "orderUpdates",
    });
    expect(result).toMatchObject({ successCount: 1, failureCount: 0, prunedTokens: [] });
    expect(h.getAll).toHaveBeenCalledWith({ id: "unit_owned", path: "device_tokens/unit_owned" });
    expect(h.send).toHaveBeenCalledOnce();
    const sent = h.send.mock.calls[0][0];
    expect(sent.tokens).toEqual(["unit_owned"]);
    // Contract §11: account payload carries only purpose/category/uid/ref.
    expect(sent.data).toMatchObject({
      purpose: "orderUpdates",
      category: "order",
      recipientUid: A,
    });
    expect(typeof sent.data.ref).toBe("string");
    expect(sent.data).not.toHaveProperty("orderId");
  });

  it("withholds a token rebound to B even when A's stale profile still lists it", async () => {
    h.owners.set("unit_rebound", B);
    h.profiles.set(A, ["unit_rebound"]);
    const result = await sendMulticastFcm(h.profiles.get(A)!, payload, A, {
      purpose: "orderUpdates",
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ successCount: 0, failureCount: 1, prunedTokens: [] });
    // Withholding is not permission to mutate B's membership or prune A blindly.
    expect(h.updates).toEqual([]);
    expect(h.profiles.get(A)).toEqual(["unit_rebound"]);
    expect(h.owners.get("unit_rebound")).toBe(B);
  });

  it("filters foreign, unknown and ownerless tokens while delivering to a proven owner", async () => {
    h.owners.set("unit_owned", A);
    h.owners.set("unit_foreign", B);
    h.owners.set("unit_ownerless", undefined);
    const result = await sendMulticastFcm(
      ["unit_foreign", "unit_owned", "unit_missing", "unit_ownerless"],
      payload,
      A,
      { purpose: "orderUpdates" },
    );
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.send.mock.calls[0][0].tokens).toEqual(["unit_owned"]);
    expect(result).toMatchObject({ successCount: 1, failureCount: 3, prunedTokens: [] });
  });

  it("fails closed on an ownership lookup failure rather than sending unverified tokens", async () => {
    h.getAll.mockRejectedValueOnce(new Error("unit ownership read unavailable"));
    const result = await sendMulticastFcm(["unit_unverified"], payload, A, {
      purpose: "orderUpdates",
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ successCount: 0, failureCount: 1, prunedTokens: [] });
    expect(h.update).not.toHaveBeenCalled();
  });

  it("does not report success for a critical message with no owned destination", async () => {
    h.owners.set("unit_foreign", B);
    await expect(
      sendMulticastFcm(["unit_foreign"], payload, A, { purpose: "orderUpdates", critical: true }),
    ).rejects.toThrow(/critical|ownership|owned/i);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("bounds a stalled ledger read and never sends the unverified destination", async () => {
    vi.useFakeTimers();
    h.getAll.mockReturnValueOnce(new Promise<never>(() => undefined));
    const pending = sendMulticastFcm(["unit_stalled"], payload, A, {
      purpose: "orderUpdates",
    });
    await vi.advanceTimersByTimeAsync(FCM_SEND_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ successCount: 0, failureCount: 1, prunedTokens: [] });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("does not treat an explicitly empty recipient as an unbound broadcast", async () => {
    h.owners.set("unit_ownerless", undefined);
    await expect(
      sendMulticastFcm(["unit_ownerless"], payload, "", { purpose: "orderUpdates" }),
    ).rejects.toThrow(/recipient uid/i);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("preserves the trusted server's explicit generic multicast contract when UID is omitted", async () => {
    const result = await sendMulticastFcm(["unit_broadcast"], payload, undefined, {
      purpose: "operational",
      actor: { trusted: true },
    });
    expect(h.getAll).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith({ ...payload, tokens: ["unit_broadcast"] });
    expect(result.successCount).toBe(1);
  });

  it("maps transport pruning to the filtered token, never to a withheld token", async () => {
    h.owners.set("unit_foreign", B);
    h.owners.set("unit_owned", A);
    // B's profile also carries the token (e.g. seeded before its rebind): the
    // prune must address A's doc only and leave B's list untouched.
    h.profiles.set(A, ["unit_owned"]);
    h.profiles.set(B, ["unit_owned"]);
    h.send.mockResolvedValueOnce({
      successCount: 0,
      failureCount: 1,
      responses: [{ success: false, error: { code: "messaging/registration-token-not-registered" } }],
    });
    const result = await sendMulticastFcm(["unit_foreign", "unit_owned"], payload, A, {
      purpose: "orderUpdates",
    });
    expect(h.send.mock.calls[0][0].tokens).toEqual(["unit_owned"]);
    expect(result.prunedTokens).toEqual(["unit_owned"]);
    expect(result.failureCount).toBe(2);
    // Exactly one profile write, addressed to the recipient A.
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].uid).toBe(A);
    expect(h.updates[0].payload).toEqual({ fcmTokens: { remove: ["unit_owned"] } });
    expect(h.profiles.get(A)).toEqual([]);
    expect(h.profiles.get(B)).toEqual(["unit_owned"]);
  });

  it("verifies and sends each real FCM chunk without exceeding 500 targets", async () => {
    const tokens = Array.from({ length: 501 }, (_, i) => `unit_chunk_${i}`);
    tokens.forEach((t) => h.owners.set(t, A));
    const result = await sendMulticastFcm(tokens, payload, A, { purpose: "orderUpdates" });
    expect(h.getAll.mock.calls.map((args) => args.length)).toEqual([500, 1]);
    expect(h.send.mock.calls.map((args) => args[0].tokens.length)).toEqual([500, 1]);
    expect(result.successCount).toBe(501);
    expect(result.failureCount).toBe(0);
  });

  it("keeps a withheld customer's message in A's inbox without pushing it to B", async () => {
    h.owners.set("unit_rebound", B);
    h.profiles.set(A, ["unit_rebound"]);
    await pushToCustomer(A, "Order update", "Your order is ready.", { orderId: "unit_order" }, {
      badge: 1,
      purpose: "orderUpdates",
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.inbox).toHaveLength(1);
    expect(h.inbox[0].uid).toBe(A);
    expect(h.inbox[0].payload).toMatchObject({ title: "Order update", read: false, targetId: "unit_order" });
  });
});
