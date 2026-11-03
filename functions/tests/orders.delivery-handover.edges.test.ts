/**
 * Delivery OTP / handover — EDGE CASES not covered by
 * orders.delivery-handover.test.ts.
 *
 * The harness is the same hermetic optimistic-transaction fake used there:
 * reads are versioned snapshots, writes commit only after the callback
 * succeeds, and a changed read version forces a retry. It is not an emulator
 * and proves nothing about cross-process Firestore behaviour.
 *
 * Covered here:
 *   • fulfilment-type variants (dinein / takeaway / absent) at the HANDOVER gate
 *   • a capture amount stored as a numeric string (type confusion)
 *   • `deliveryOtpVersion: "2"` (string, not number) — must fail closed
 *   • a verifier hash padded with surrounding whitespace at handover
 *   • a legacy plaintext code coexisting with a v2 hash — the hash wins
 *   • a bare-string `status` versus an object `status` on the same flow
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  type Data = Record<string, unknown>;
  const docs = new Map<string, { data: Data; version: number }>();
  const writes: Array<{ path: string; data: Data }> = [];
  const stats = { retries: 0 };
  const copy = (data: Data) => structuredClone(data);
  const write = (path: string, data: Data, merge = true) => {
    const previous = docs.get(path);
    docs.set(path, {
      data: merge ? { ...previous?.data, ...copy(data) } : copy(data),
      version: (previous?.version ?? 0) + 1,
    });
    writes.push({ path, data: copy(data) });
  };
  const ref = (path: string) => ({
    id: path.split("/").at(-1)!,
    path,
    get: async () => {
      const data = docs.has(path) ? copy(docs.get(path)!.data) : undefined;
      return { exists: data !== undefined, id: path.split("/").at(-1)!, data: () => data, ref: ref(path) };
    },
    set: async (data: Data, options?: { merge?: boolean }) => write(path, data, options?.merge),
  });
  type Ref = ReturnType<typeof ref>;
  type Transaction = {
    get: (reference: Ref) => ReturnType<Ref["get"]>;
    set: (reference: Ref, data: Data, options?: { merge?: boolean }) => void;
  };
  const runTransaction = async <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const reads = new Map<string, number>();
      const pending: Array<{ reference: Ref; data: Data; merge?: boolean }> = [];
      const result = await callback({
        get: async (reference) => {
          if (pending.length) throw new Error("READ_AFTER_WRITE");
          reads.set(reference.path, docs.get(reference.path)?.version ?? -1);
          return reference.get();
        },
        set: (reference, data, options) => { pending.push({ reference, data, merge: options?.merge }); },
      });
      if ([...reads].some(([path, version]) => (docs.get(path)?.version ?? -1) !== version)) {
        stats.retries++;
        continue;
      }
      for (const pendingWrite of pending) write(pendingWrite.reference.path, pendingWrite.data, pendingWrite.merge);
      return result;
    }
    throw new Error("Hermetic transaction retries exhausted");
  };
  const emptyQuery = {
    where: () => emptyQuery, limit: () => emptyQuery, orderBy: () => emptyQuery,
    get: async () => ({ empty: true, docs: [] }),
  };
  const db = {
    collection: (name: string) => ({ ...emptyQuery, doc: (id: string) => ref(`${name}/${id}`) }),
    runTransaction,
  };
  return {
    db, docs, writes, stats, write,
    reset: () => { docs.clear(); writes.length = 0; stats.retries = 0; },
  };
});

vi.mock("../src/core/firebase", () => ({ db: h.db, auth: {}, messaging: {} }));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(vi.fn(() => h.db), {
    FieldValue: {
      serverTimestamp: () => "HERMETIC_TIMESTAMP",
      increment: (value: number) => value,
      arrayUnion: (...values: unknown[]) => values,
      delete: () => "HERMETIC_DELETE",
    },
  });
  const admin = {
    firestore, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})),
    appCheck: vi.fn(() => ({})), apps: [{ name: "test" }], initializeApp: vi.fn(),
  };
  return { ...admin, default: admin };
});
vi.mock("../src/core/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core/errors")>()),
  captureErrorSnapshot: vi.fn(async () => "hermetic_error_snapshot"),
}));

import { deriveDeliveryOtp, mintDeliveryOtp } from "../src/modules/orders/deliveryOtp";
import { getOwnerDeliveryOtp } from "../src/modules/orders/deliveryHandover.service";
import { verifyDeliveryOtp } from "../src/modules/porter/porter.service";

const ORDER_ID = "canonical_delivery_order";
const owner = { uid: "customer_a", role: "customer" };
const staff = { uid: "staff_a", role: "branch_staff", branchIds: ["branch_a"] };

function seed(overrides: Record<string, unknown> = {}) {
  const minted = mintDeliveryOtp({ orderType: "delivery" }, ORDER_ID)!;
  h.write(`orders/${ORDER_ID}`, {
    id: "untrusted_copied_id", customerId: owner.uid, userId: owner.uid, branchId: "branch_a", orderType: "delivery",
    paymentChannel: "razorpay", paymentStatus: "completed",
    payment: { status: "completed", capturedAmountPaise: 15900, razorpayPaymentId: "pay_hermetic" },
    status: { code: "OUT_FOR_DELIVERY", kind: "in_progress", terminal: false }, deliveryStatus: "dispatched",
    deliveryOtpHash: minted.deliveryOtpHash, deliveryOtpVersion: minted.deliveryOtpVersion,
    ...overrides,
  }, false);
  h.writes.length = 0;
  return deriveDeliveryOtp(ORDER_ID);
}

beforeEach(() => {
  vi.stubEnv("OTP_HMAC_SECRET", "hermetic_delivery_handover_secret");
  vi.clearAllMocks();
  h.reset();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("fulfilment type at the handover gate", () => {
  it.each(["dinein", "takeaway", undefined])(
    "refuses a handover for an order whose type is %s",
    async (orderType) => {
      const code = seed({ orderType });
      await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff }))
        .rejects.toMatchObject({ code: "DELIVERY_OTP_UNAVAILABLE" });
      // A non-delivery order must never burn its verifier or its attempts.
      expect(h.writes).toEqual([]);
      expect(h.docs.get(`orders/${ORDER_ID}`)?.data.deliveryOtpHash).toBeTruthy();
    }
  );

  it("also refuses the owner read for a dinein order", async () => {
    seed({ orderType: "dinein" });
    await expect(getOwnerDeliveryOtp(ORDER_ID, owner)).rejects.toMatchObject({
      code: "DELIVERY_OTP_UNAVAILABLE",
    });
    expect(h.writes).toEqual([]);
  });
});

describe("payment proof shape", () => {
  it("refuses a captured amount stored as a numeric string", async () => {
    const code = seed({
      payment: { status: "completed", razorpayPaymentId: "pay_hermetic", capturedAmountPaise: "15900" },
    });
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff }))
      .rejects.toMatchObject({ code: "ORDER_NOT_PAID" });
    expect(h.writes).toEqual([]);
  });
});

describe("verifier version typing", () => {
  it("fails closed on `deliveryOtpVersion: \"2\"` (string, not number)", async () => {
    const code = seed({ deliveryOtpVersion: "2" });
    const before = structuredClone(h.docs.get(`orders/${ORDER_ID}`));
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff }))
      .rejects.toMatchObject({ code: "DELIVERY_OTP_UNAVAILABLE" });
    await expect(getOwnerDeliveryOtp(ORDER_ID, owner))
      .rejects.toMatchObject({ code: "DELIVERY_OTP_UNAVAILABLE" });
    // Nothing was consumed, and the stored hash was not rewritten.
    expect(h.docs.get(`orders/${ORDER_ID}`)).toEqual(before);
    expect(h.writes).toEqual([]);
  });

  it("verifies through a hash padded with surrounding whitespace", async () => {
    const code = seed();
    const hash = h.docs.get(`orders/${ORDER_ID}`)!.data.deliveryOtpHash as string;
    h.write(`orders/${ORDER_ID}`, { deliveryOtpHash: `  ${hash}\n` });
    h.writes.length = 0;

    expect((await verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff })).success).toBe(true);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data).toMatchObject({
      status: { code: "DELIVERED" },
      deliveryOtpHash: null,
      deliveryOtpVersion: 2,
    });
  });
});

describe("a legacy plaintext copy beside a v2 hash", () => {
  it("ignores the plaintext and verifies only against the v2 hash", async () => {
    const derived = deriveDeliveryOtp(ORDER_ID);
    const plaintext = derived === "1357" ? "2468" : "1357";
    seed({ deliveryOtp: plaintext });

    // The owner read reopens the derived canonical code, never the copy.
    expect((await getOwnerDeliveryOtp(ORDER_ID, owner)).deliveryOtp).toBe(derived);
    expect(h.writes).toEqual([]);

    // The plaintext copy is not a fallback credential.
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: plaintext, caller: staff }))
      .rejects.toMatchObject({ code: "DELIVERY_OTP_INVALID" });
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.deliveryOtpAttempts).toBe(1);

    // The derived code still completes the handover and burns the copy.
    expect((await verifyDeliveryOtp({ orderId: ORDER_ID, otp: derived, caller: staff })).success).toBe(true);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data).toMatchObject({
      deliveryOtp: null,
      deliveryOtpHash: null,
      deliveryOtpAttempts: 0,
    });
  });
});

describe("status storage shape", () => {
  it.each([
    ["bare string", "OUT_FOR_DELIVERY"],
    ["object", { code: "OUT_FOR_DELIVERY", kind: "in_progress", terminal: false }],
  ])("verifies an order whose status is a %s", async (_label, status) => {
    const code = seed({ status });
    expect((await verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff })).success).toBe(true);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.status).toMatchObject({ code: "DELIVERED" });
  });
});

describe("capture-amount presence, not just type", () => {
  it("refuses a razorpay order with NO captured amount in either store shape", async () => {
    // paymentChannel is the server marker, but absence of a captured amount in
    // BOTH the nested and dotted form is an unpaid order — never a handover.
    const code = seed({
      payment: { status: "completed", razorpayPaymentId: "pay_hermetic" },
      "payment.capturedAmountPaise": undefined,
    });
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff }))
      .rejects.toMatchObject({ code: "ORDER_NOT_PAID" });
    await expect(getOwnerDeliveryOtp(ORDER_ID, owner))
      .rejects.toMatchObject({ code: "ORDER_NOT_PAID" });
    expect(h.writes).toEqual([]);
  });

  it("accepts the dotted-form capture amount when the nested map omits it", async () => {
    // Writers from the webhook path stamp the flattened key; the gate must
    // treat it as equal proof to the nested map.
    const code = seed({
      payment: { status: "completed", razorpayPaymentId: "pay_hermetic" },
      "payment.capturedAmountPaise": 15900,
    });
    expect((await verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff })).success)
      .toBe(true);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.status).toMatchObject({ code: "DELIVERED" });
  });
});

describe("two concurrent correct verifications", () => {
  it("delivers exactly once: the loser retries, sees the consumed order, and fails closed", async () => {
    const code = seed();

    // Both transactions read the same pre-delivery snapshot. The optimistic
    // fake forces the stale winner-side to retry; on retry the order already
    // carries deliveryOtpConsumedAt, so the active-order gate refuses it.
    const [a, b] = await Promise.allSettled([
      verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff }),
      verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff }),
    ]);

    expect(a.status).not.toBe(b.status);
    const fulfilled = [a, b].find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any> | undefined;
    const rejected = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(fulfilled).toBeDefined();
    expect(rejected).toBeDefined();
    expect((fulfilled as PromiseFulfilledResult<any>).value.success).toBe(true);
    // The stale transaction must NOT fail as an invalid OTP (which would count
    // a correct code as a wrong guess); it fails at the consumed-order gate.
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: "DELIVERY_OTP_UNAVAILABLE",
    });
    // One delivery, one attempt counter untouched, no lockout.
    const order = h.docs.get(`orders/${ORDER_ID}`)!.data;
    expect(order.status).toMatchObject({ code: "DELIVERED" });
    expect(order.deliveryOtpHash).toBeNull();
    expect(order.deliveryOtpAttempts).toBe(0);
    expect(order.deliveryOtpLockedUntil).toBeNull();
    expect(h.stats.retries).toBeGreaterThanOrEqual(1);
  });
});
