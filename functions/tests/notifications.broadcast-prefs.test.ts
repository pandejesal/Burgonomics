/**
 * N-06 broadcast category defaults: `all_devices` includes staff, absent
 * records use documented defaults (offers/order true, announcements false),
 * and staff topic sends never consult prefs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const devices: any[] = [];
  const prefDocs = new Map<string, any>();
  const sends: Array<{ tokens: string[]; opts: any; payload: any }> = [];

  const db = {
    collection(name: string) {
      if (name === "device_tokens") {
        return {
          limit: (_n: number) => ({
            get: async () => ({
              forEach: (cb: (doc: any) => void) =>
                devices.forEach((device) => cb({ id: device.token, data: () => device })),
            }),
          }),
        };
      }
      if (name === "broadcasts") {
        return { doc: () => ({ id: "unit_broadcast", set: async () => undefined }) };
      }
      if (name === "users") {
        return {
          doc: (uid: string) => ({
            collection: (sub: string) => ({
              doc: (installationId: string) => ({
                id: installationId,
                path: `users/${uid}/${sub}/${installationId}`,
              }),
            }),
          }),
        };
      }
      if (name === "admin_audit_logs") return { add: async () => undefined };
      throw new Error(`unexpected collection: ${name}`);
    },
    getAll: async (...refs: any[]) =>
      refs.map((ref: any) => {
        const [, uid, , installationId] = ref.path.split("/");
        const found = prefDocs.get(`${uid}/${installationId}`);
        return { exists: !!found, data: () => found || {} };
      }),
  };

  const sendMulticastFcm = vi.fn(async (tokens: string[], payload: any, _uid: any, opts: any) => {
    sends.push({ tokens, opts, payload });
    return {
      successCount: tokens.length,
      failureCount: 0,
      prunedTokens: [],
      providerAccepted: tokens.length,
      providerFailed: 0,
    };
  });

  return { devices, prefDocs, sends, db, sendMulticastFcm };
});

vi.mock("../src/core/firebase", () => ({ db: h.db }));
vi.mock("firebase-admin", () => ({
  firestore: { FieldValue: { serverTimestamp: () => "UNIT_TIMESTAMP" } },
}));
vi.mock("../src/modules/notifications/fcmClient", () => ({
  sendMulticastFcm: h.sendMulticastFcm,
}));

import { broadcastToDevices } from "../src/modules/notifications/broadcast";

beforeEach(() => {
  h.devices.length = 0;
  h.prefDocs.clear();
  h.sends.length = 0;
  h.sendMulticastFcm.mockClear();
});

describe("broadcast category defaults", () => {
  it("announcements defaults OFF for legacy and staff devices, ON only when canonical", async () => {
    h.devices.push(
      { token: "tok_legacy", userId: "customer_legacy" },
      { token: "tok_staff", userId: "staff_uid", role: "branch_staff" },
      { token: "tok_optin", userId: "customer_optin", installationId: "install_1" }
    );
    h.prefDocs.set("customer_optin/install_1", {
      notificationPrefs: { announcements: true },
    });

    const result = await broadcastToDevices(
      { title: "Announcement", body: "New menu", purpose: "announcements" },
      { uid: "brand_uid", email: "owner@burgonomics.in" }
    );

    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].tokens).toEqual(["tok_optin"]);
    expect(h.sends[0].opts).toMatchObject({
      purpose: "announcements",
      audience: "all_devices",
      actor: { trusted: true },
    });
    expect(result).toMatchObject({
      targeted: 3,
      eligible: 1,
      staffDevices: 1,
      customerEligible: 1,
      suppressedCount: 2,
      suppressedAll: false,
      legacyUnresolved: 2,
      providerAccepted: 1,
      providerFailed: 0,
    });
  });

  it("offers defaults ON for every device, staff included", async () => {
    h.devices.push(
      { token: "tok_customer", userId: "customer_legacy" },
      { token: "tok_staff", userId: "staff_uid", isStaff: true }
    );
    const result = await broadcastToDevices(
      { title: "Offer", body: "Today only", purpose: "offers" },
      { uid: "brand_uid" }
    );
    expect(h.sends[0].tokens).toEqual(["tok_customer", "tok_staff"]);
    expect(result).toMatchObject({
      targeted: 2,
      eligible: 2,
      staffDevices: 1,
      suppressedCount: 0,
      legacyUnresolved: 2,
    });
  });

  it("all-suppressed broadcast performs zero transport calls and reports the suppression", async () => {
    h.devices.push({ token: "tok_legacy", userId: "customer_legacy" });
    const result = await broadcastToDevices(
      { title: "Announcement", body: "Nothing to send", purpose: "announcements" },
      { uid: "brand_uid" }
    );
    expect(h.sendMulticastFcm).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      targeted: 1,
      eligible: 0,
      suppressedCount: 1,
      suppressedAll: true,
      successCount: 0,
    });
  });

  it("an omitted purpose falls back to the opt-in announcements category and is marked defaulted", async () => {
    h.devices.push({ token: "tok_legacy", userId: "customer_legacy" });
    const result = await broadcastToDevices({ title: "Promo", body: "Body" }, { uid: "brand_uid" });
    // `announcements` defaults OFF for a legacy device, so an unlabeled send
    // cannot bypass the opt-in or be recorded as promotional `offers`.
    expect(result).toMatchObject({
      purpose: "announcements",
      purposeDefaulted: true,
      targeted: 1,
      eligible: 0,
      suppressedCount: 1,
      suppressedAll: true,
    });
    expect(h.sendMulticastFcm).not.toHaveBeenCalled();
  });
});
