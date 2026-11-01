/**
 * N-03 notification schemas: strict bodies, caller-bound uid, no client
 * `category`/`security` injection, and expectedVersion CAS on preferences.
 */
import { describe, expect, it } from "vitest";
import {
  dispatchNotificationSchema,
  registerTokenSchema,
  unregisterTokenSchema,
  updateNotificationPreferencesSchema,
} from "../src/core/validation";

const VALID_PREFS = {
  installationId: "install_unit_1",
  notificationPrefs: { offers: false },
  expectedVersion: 0,
};

describe("preferences schema", () => {
  it("accepts a strict, caller-bound preference patch", () => {
    expect(updateNotificationPreferencesSchema.safeParse(VALID_PREFS).success).toBe(true);
  });

  it("rejects a body-supplied uid", () => {
    expect(
      updateNotificationPreferencesSchema.safeParse({ ...VALID_PREFS, uid: "victim_uid" }).success
    ).toBe(false);
  });

  it("rejects a body-supplied category or security field", () => {
    for (const injected of [
      { category: "offers" },
      { security: { bypass: true } },
      { prefs: { offers: true } },
    ]) {
      expect(
        updateNotificationPreferencesSchema.safeParse({ ...VALID_PREFS, ...injected }).success
      ).toBe(false);
    }
  });

  it("requires expectedVersion and a non-empty preference patch", () => {
    expect(
      updateNotificationPreferencesSchema.safeParse({
        installationId: "install_unit_1",
        notificationPrefs: { offers: false },
      }).success
    ).toBe(false);
    expect(
      updateNotificationPreferencesSchema.safeParse({
        ...VALID_PREFS,
        notificationPrefs: {},
      }).success
    ).toBe(false);
  });

  it("rejects an unbounded or malformed installationId", () => {
    expect(
      updateNotificationPreferencesSchema.safeParse({
        ...VALID_PREFS,
        installationId: "short",
      }).success
    ).toBe(false);
    expect(
      updateNotificationPreferencesSchema.safeParse({
        ...VALID_PREFS,
        installationId: "install with spaces",
      }).success
    ).toBe(false);
  });
});

describe("dispatch schema", () => {
  const base = {
    token: "unit_token_123456",
    title: "Order update",
    body: "Generic copy",
  };

  it("accepts a token send with an explicit purpose", () => {
    expect(
      dispatchNotificationSchema.safeParse({ ...base, purpose: "orderUpdates" }).success
    ).toBe(true);
  });

  it("rejects body uid/category/security and unknown purposes", () => {
    for (const extra of [
      { uid: "victim_uid" },
      { category: "support" },
      { security: true },
      { purpose: "NEW_KOT" },
    ]) {
      expect(dispatchNotificationSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });

  it("still requires exactly one of topic or token", () => {
    expect(
      dispatchNotificationSchema.safeParse({ ...base, topic: "branch_b1_orders" }).success
    ).toBe(false);
    expect(
      dispatchNotificationSchema.safeParse({ title: "x", body: "y" }).success
    ).toBe(false);
  });
});

describe("token registration schemas", () => {
  it("accepts an optional installationId and still rejects a body uid", () => {
    expect(
      registerTokenSchema.safeParse({
        token: "unit_token_123456",
        platform: "web",
        installationId: "install_unit_1",
      }).success
    ).toBe(true);
    expect(
      registerTokenSchema.safeParse({ token: "unit_token_123456", uid: "victim" }).success
    ).toBe(false);
    expect(
      unregisterTokenSchema.safeParse({ token: "unit_token_123456", uid: "victim" }).success
    ).toBe(false);
  });
});
