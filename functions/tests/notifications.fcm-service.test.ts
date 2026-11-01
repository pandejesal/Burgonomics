/**
 * M2: `dispatchFCM({ purpose: "system" })` must be badge-0 on BOTH the APNs
 * payload and the data payload. The pre-fix code only rewrote data.badge, so a
 * system dispatch could ship APNs badge 1 while claiming to clear the badge.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const owners = new Map<string, string>();
  const multicast: any[] = [];
  const unexpected: string[] = [];

  const db = {
    collection(name: string) {
      if (name === "device_tokens") {
        return { doc: (id: string) => ({ id, path: `device_tokens/${id}` }) };
      }
      // System sends must not write inbox rows or read device_prefs.
      unexpected.push(name);
      throw new Error(`unexpected collection in system dispatch: ${name}`);
    },
    getAll: async (...refs: any[]) =>
      refs.map((ref: any) => ({
        id: ref.id,
        exists: owners.has(ref.id),
        data: () => ({ userId: owners.get(ref.id) }),
      })),
  };

  const sendEachForMulticast = vi.fn(async (payload: any) => {
    multicast.push(payload);
    return {
      successCount: payload.tokens.length,
      failureCount: 0,
      responses: payload.tokens.map(() => ({ success: true })),
    };
  });

  return { owners, multicast, unexpected, db, sendEachForMulticast };
});

vi.mock("../src/core/firebase", () => ({
  db: h.db,
  messaging: { sendEachForMulticast: h.sendEachForMulticast },
}));
vi.mock("firebase-admin", () => ({
  firestore: {
    FieldValue: {
      serverTimestamp: () => "UNIT_TIMESTAMP",
      arrayRemove: (...tokens: string[]) => ({ remove: tokens }),
    },
  },
}));

import { dispatchFCM } from "../src/modules/notifications/fcm.service";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VITEST", "");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  h.owners.clear();
  h.multicast.length = 0;
  h.unexpected.length = 0;
  h.sendEachForMulticast.mockClear();
  h.owners.set("unit_system_token", "unit_user");
});

describe("system dispatch badge clear", () => {
  it("forces APNs badge 0 and data.badge 0 even without an explicit badge", async () => {
    const ok = await dispatchFCM({
      token: "unit_system_token",
      recipientUid: "unit_user",
      title: "",
      body: "",
      purpose: "system",
    });

    expect(ok).toBe(true);
    expect(h.sendEachForMulticast).toHaveBeenCalledOnce();
    const sent = h.multicast[0];
    expect(sent.apns?.payload?.aps?.badge).toBe(0);
    expect(sent.data).toMatchObject({ badge: "0", type: "badge_clear" });
    // No inbox write, no prefs read.
    expect(h.unexpected).toEqual([]);
  });
});
