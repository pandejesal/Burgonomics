import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// Hermetic optimistic transaction model: reads are snapshots, writes commit
// together only after callback success, and changed read versions retry. This
// is not an emulator or proof of Firestore cross-process behavior.
const h = vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  type Data = Record<string, unknown>;
  const docs = new Map<string, { data: Data; version: number }>();
  const writes: Array<{ path: string; data: Data }> = [];
  const stats = { retries: 0 };
  let competitor: (() => void) | undefined;
  const copy = (data: Data) => structuredClone(data);
  const write = (path: string, data: Data, merge = true) => {
    const previous = docs.get(path);
    docs.set(path, { data: merge ? { ...previous?.data, ...copy(data) } : copy(data), version: (previous?.version ?? 0) + 1 });
    writes.push({ path, data: copy(data) });
  };
  const ref = (path: string) => ({
    id: path.split("/").at(-1)!, path,
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
      const hook = competitor;
      competitor = undefined;
      hook?.();
      if ([...reads].some(([path, version]) => (docs.get(path)?.version ?? -1) !== version)) {
        stats.retries++;
        continue;
      }
      for (const pendingWrite of pending) write(pendingWrite.reference.path, pendingWrite.data, pendingWrite.merge);
      return result;
    }
    throw new Error("Hermetic transaction retries exhausted");
  };
  const tokens: Record<string, Data> = {
    owner: { uid: "customer_a", role: "customer" },
    other: { uid: "customer_b", role: "customer" },
    staff: { uid: "staff_a", role: "branch_staff", branchIds: ["branch_a"] },
    brand: { uid: "brand_a", role: "brand_owner", isBrandAdmin: true },
    guest: { uid: "customer_a", firebase: { sign_in_provider: "anonymous" } },
  };
  const verifyIdToken = vi.fn(async (token: string, checkRevoked: boolean) => {
    if (!checkRevoked || token === "revoked" || !tokens[token]) throw new Error("Token rejected");
    return tokens[token];
  });
  const emptyQuery = { where: () => emptyQuery, limit: () => emptyQuery, orderBy: () => emptyQuery,
    get: async () => ({ empty: true, docs: [] }) };
  const db = { collection: (name: string) => ({ ...emptyQuery, doc: (id: string) => ref(`${name}/${id}`) }), runTransaction };
  return { db, docs, writes, stats, verifyIdToken, write, inject: (hook: () => void) => { competitor = hook; },
    reset: () => { docs.clear(); writes.length = 0; stats.retries = 0; competitor = undefined; } };
});

vi.mock("../src/core/firebase", () => ({
  db: h.db, auth: { verifyIdToken: h.verifyIdToken }, messaging: {},
}));
vi.mock("firebase-admin", () => {
  const firestore = Object.assign(vi.fn(() => h.db), { FieldValue: {
    serverTimestamp: () => "HERMETIC_TIMESTAMP", increment: (value: number) => value,
    arrayUnion: (...values: unknown[]) => values, delete: () => "HERMETIC_DELETE",
  } });
  const admin = { firestore, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})),
    appCheck: vi.fn(() => ({})), apps: [{ name: "test" }], initializeApp: vi.fn() };
  return { ...admin, default: admin };
});
vi.mock("../src/core/errors", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/core/errors")>(),
  captureErrorSnapshot: vi.fn(async () => "hermetic_error_snapshot"),
}));

import { deriveDeliveryOtp, mintDeliveryOtp } from "../src/modules/orders/deliveryOtp";
import { getOwnerDeliveryOtp } from "../src/modules/orders/deliveryHandover.service";
import { app } from "../src/index";
import { captureErrorSnapshot } from "../src/core/errors";
import { verifyDeliveryOtp, OTP_LOCKOUT_MS } from "../src/modules/porter/porter.service";
import { computeHmacSha256 } from "../src/core/security";

const ORDER_ID = "canonical_delivery_order";
const owner = { uid: "customer_a", role: "customer" };
const staff = { uid: "staff_a", role: "branch_staff", branchIds: ["branch_a"] };
let server: Server;
let baseUrl: string;

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

async function post(path: string, body: unknown, token = "owner") {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers: {
    "Content-Type": "application/json", Authorization: `Bearer ${token}`,
  }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
beforeEach(() => {
  vi.stubEnv("OTP_HMAC_SECRET", "hermetic_delivery_handover_secret");
  vi.clearAllMocks();
  h.reset();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("owner-only delivery OTP read", () => {
  it("reopens the same canonical code without writes, resetting attempts, or logging", async () => {
    const code = seed({ deliveryOtpAttempts: 2, deliveryOtpLockedUntil: Date.now() + 100000 });
    const before = structuredClone(h.docs.get(`orders/${ORDER_ID}`));
    const expected = { orderId: ORDER_ID, deliveryOtp: code, version: 2 };
    expect(await getOwnerDeliveryOtp(ORDER_ID, owner)).toEqual(expected);
    expect(await getOwnerDeliveryOtp(ORDER_ID, owner)).toEqual(expected);
    expect(h.docs.get(`orders/${ORDER_ID}`)).toEqual(before);
    expect(h.writes).toEqual([]);
    expect(captureErrorSnapshot).not.toHaveBeenCalled();
  });

  it("supports absent canonical owner only via an unambiguous legacy userId", async () => {
    seed({ customerId: undefined });
    expect((await getOwnerDeliveryOtp(ORDER_ID, owner)).version).toBe(2);
  });

  it.each([
    undefined, { uid: "customer_b" }, staff,
    { uid: "brand_a", role: "brand_owner", isBrandAdmin: true },
    { uid: owner.uid, firebase: { sign_in_provider: "anonymous" } },
  ])("denies unauthenticated/nonowner/anonymous caller %j without writes", async (caller) => {
    seed();
    await expect(getOwnerDeliveryOtp(ORDER_ID, caller)).rejects.toMatchObject({ statusCode: caller ? 403 : 401 });
    expect(h.writes).toEqual([]);
  });

  it.each([
    { customerId: "cust_walkin" }, { customerId: "guest" }, { customerId: "" },
    { customerId: "customer_b", userId: owner.uid }, { customerId: owner.uid, userId: "customer_b" },
    { customerId: null }, { customerId: 123 }, { isGuest: true },
  ])("fails closed on ambiguous or sentinel ownership %j", async (overrides) => {
    seed(overrides);
    await expect(getOwnerDeliveryOtp(ORDER_ID, owner)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.writes).toEqual([]);
  });

  it("trims deliveryOtpHash consistently in readVersionedDeliveryOtp", async () => {
    const code = seed();
    const untrimmed = `  ${h.docs.get(`orders/${ORDER_ID}`)!.data.deliveryOtpHash}  `;
    h.write(`orders/${ORDER_ID}`, { deliveryOtpHash: untrimmed });
    expect(await getOwnerDeliveryOtp(ORDER_ID, owner)).toEqual({ orderId: ORDER_ID, deliveryOtp: code, version: 2 });
  });

  it("leaves random legacy hashes byte-for-byte unchanged and refuses unknown versions", async () => {
    seed({ deliveryOtpVersion: undefined, deliveryOtpHash: "unchanged_random_legacy_hash" });
    const before = structuredClone(h.docs.get(`orders/${ORDER_ID}`));
    await expect(getOwnerDeliveryOtp(ORDER_ID, owner)).rejects.toMatchObject({ code: "LEGACY_OTP_UNAVAILABLE" });
    expect(h.docs.get(`orders/${ORDER_ID}`)).toEqual(before);
    seed({ deliveryOtpVersion: 9 });
    await expect(getOwnerDeliveryOtp(ORDER_ID, owner)).rejects.toMatchObject({ code: "DELIVERY_OTP_UNAVAILABLE" });
    expect(h.writes).toEqual([]);
  });

  it.each([
    { status: "CANCELLED" }, { status: "CANCELLING" }, { status: "REFUNDED" }, { status: "DELIVERED" },
    { status: { code: "OUT_FOR_DELIVERY", terminal: true } }, { deliveryStatus: "cancelled" },
    { status: "PLACED" }, { status: "UNKNOWN" }, { orderType: "takeaway" }, { fulfillment: "dinein" },
    { cancellationStatus: "pending" }, { refundStatus: "refunding" },
    { payment: { status: "refunded", capturedAmountPaise: 15900, razorpayPaymentId: "pay_hermetic" } },
    { "payment.refundStatus": "PENDING_APPROVAL" }, { refundActiveClaim: { claimedAt: 1 } },
    { captureFulfillmentState: "refund_pending" }, { captureFulfillment: { state: "checking" } },
    { refundedTotalPaise: 15900 }, { paymentChannel: undefined },
    { payment: { status: "completed", razorpayPaymentId: "pay_hermetic" } },
    { payment: { status: "completed", capturedAmountPaise: 15900 } },
    { payment: { status: "pending", capturedAmountPaise: 15900, razorpayPaymentId: "pay_hermetic" } },
    { "payment.razorpayPaymentId": "pay_different" }, { deliveryOtpConsumedAt: "consumed" },
    { deliveryOtpHash: "mismatching_verifier" },
  ])("refuses inactive, unpaid, inconsistent, or consumed state %j", async (overrides) => {
    seed(overrides);
    await expect(getOwnerDeliveryOtp(ORDER_ID, owner)).rejects.toBeInstanceOf(Error);
    expect(h.writes).toEqual([]);
  });

  it("does not reinterpret settled partial refunds as fully refunded food", async () => {
    seed({ refundStatus: "partially_refunded", refundedTotalPaise: 1000 });
    expect((await getOwnerDeliveryOtp(ORDER_ID, owner)).version).toBe(2);
  });

  it("uses the real revoked-token-checked route and private no-store response", async () => {
    const code = seed();
    const response = await post("/orders/deliveryOtp", { orderId: ORDER_ID });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(await response.json()).toEqual({ orderId: ORDER_ID, deliveryOtp: code, version: 2 });
    for (const token of ["staff", "other", "brand", "guest", "revoked"]) {
      const denied = await post("/orders/deliveryOtp", { orderId: ORDER_ID }, token);
      expect(denied.status).toBe(token === "revoked" ? 401 : 403);
      expect(JSON.stringify(await denied.json())).not.toContain(code);
    }
    expect(h.verifyIdToken).toHaveBeenCalledWith("revoked", true);
    expect(h.writes).toEqual([]);
  });

  it("rejects malformed order IDs before reads and never accepts a body-supplied owner", async () => {
    seed();
    for (const orderId of ["", "a/b", "../escape", " padded ", "x".repeat(129), 42]) {
      expect((await post("/orders/deliveryOtp", { orderId })).status).toBe(400);
    }
    expect((await post("/orders/deliveryOtp", { orderId: ORDER_ID, customerId: owner.uid }, "other")).status).toBe(400);
    expect(h.writes).toEqual([]);
  });
});

describe("atomic staff delivery handover", () => {
  it("requires an authenticated staff identity even when called without HTTP middleware", async () => {
    const code = seed();
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: undefined }))
      .rejects.toMatchObject({ statusCode: 401 });
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: { ...owner, branchIds: ["branch_a"] } }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(h.writes).toEqual([]);
  });

  it.each(["abcd", "12.3", " 1234", "1234 ", "１２３４", "123", "12345"])("rejects nonexact digits %s without burning attempts", async (otp) => {
    seed();
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp, caller: staff })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.writes).toEqual([]);
  });

  it("burns the verifier, plaintext and counters together with consumption and DELIVERED", async () => {
    const code = seed({ deliveryOtp: "historic_copy", deliveryOtpAttempts: 2 });
    expect((await verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff })).success).toBe(true);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data).toMatchObject({
      status: { code: "DELIVERED", terminal: true }, deliveryStatus: "delivered",
      deliveryOtpHash: null, deliveryOtp: null, deliveryOtpAttempts: 0,
      deliveryOtpLockedUntil: null, deliveryOtpConsumedAt: "HERMETIC_TIMESTAMP", deliveryOtpVersion: 2,
    });
    expect(h.writes.filter(({ path }) => path === `orders/${ORDER_ID}`)).toHaveLength(1);
    await expect(getOwnerDeliveryOtp(ORDER_ID, owner)).rejects.toBeInstanceOf(Error);
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff })).rejects.toBeInstanceOf(Error);
    expect(captureErrorSnapshot).not.toHaveBeenCalled();
    expect(JSON.stringify(h.writes)).not.toContain(code);
  });

  it("serializes two correct attempts: one consumes, the other never reuses", async () => {
    const code = seed();
    const results = await Promise.allSettled([
      verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff }),
      verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(h.stats.retries).toBeGreaterThan(0);
    expect(h.writes.filter(({ data }) => (data.status as { code?: string })?.code === "DELIVERED")).toHaveLength(1);
  });

  it("commits both concurrent wrong guesses before rejecting and locks at the third", async () => {
    const code = seed();
    const results = await Promise.allSettled(["0000", "0001"].map((otp) => verifyDeliveryOtp({ orderId: ORDER_ID, otp, caller: staff })));
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.deliveryOtpAttempts).toBe(2);
    expect(h.stats.retries).toBeGreaterThan(0);
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: "0002", caller: staff })).rejects.toMatchObject({ code: "DELIVERY_OTP_LOCKED" });
    const order = h.docs.get(`orders/${ORDER_ID}`)!.data;
    expect(order.deliveryOtpAttempts).toBe(3);
    expect(Number(order.deliveryOtpLockedUntil)).toBeGreaterThanOrEqual(Date.now() + OTP_LOCKOUT_MS - 1000);
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff })).rejects.toMatchObject({ code: "DELIVERY_OTP_LOCKED" });
    expect(JSON.stringify(vi.mocked(captureErrorSnapshot).mock.calls)).not.toContain(code);
  });

  it("bounds a burst of guesses at three committed attempts, including HTTP errors", async () => {
    seed();
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => post("/orders/verifyDeliveryOtp", {
      orderId: ORDER_ID, otp: `000${index}`,
    }, "staff")));
    expect(responses.every((response) => [400, 429].includes(response.status))).toBe(true);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.deliveryOtpAttempts).toBe(3);
    expect(h.writes.filter(({ path }) => path === `orders/${ORDER_ID}`)).toHaveLength(3);
  });

  it.each([
    { status: { code: "CANCELLED", terminal: true } },
    { refundStatus: "refunding", refundActiveClaim: { claimedAt: 123 } },
    { paymentChannel: null },
    { branchId: "branch_b" },
  ])("retries against a competing cancellation/refund/payment/branch change %j", async (change) => {
    const code = seed();
    h.inject(() => h.write(`orders/${ORDER_ID}`, change));
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff })).rejects.toBeInstanceOf(Error);
    expect(h.stats.retries).toBe(1);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.deliveryOtpHash).not.toBeNull();
    expect(h.writes.some(({ data }) => (data.status as { code?: string })?.code === "DELIVERED")).toBe(false);
  });

  it("reads fallback store-to-branch authorization in the SAME transaction", async () => {
    const code = seed({ branchId: undefined, storeId: "store_a" });
    h.write("stores/store_a", { partnerBranchId: "branch_a" }, false);
    h.writes.length = 0;
    h.inject(() => h.write("stores/store_a", { partnerBranchId: "branch_b" }));
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff })).rejects.toThrow(/outside your assigned branches/);
    expect(h.stats.retries).toBe(1);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.deliveryOtpConsumedAt).toBeUndefined();
  });

  it("still verifies genuine unversioned legacy hashes and burns them without reissue", async () => {
    seed({ deliveryOtpVersion: undefined, deliveryOtpHash: computeHmacSha256("1357", "hermetic_delivery_handover_secret") });
    expect((await verifyDeliveryOtp({ orderId: ORDER_ID, otp: "1357", caller: staff })).success).toBe(true);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.deliveryOtpVersion).toBeUndefined();
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.deliveryOtpHash).toBeNull();
  });

  it("refuses unknown versions or a v2 verifier that does not match canonical derivation", async () => {
    for (const version of [2, 9]) {
      seed({ deliveryOtpVersion: version, deliveryOtpHash: computeHmacSha256("1357", "hermetic_delivery_handover_secret") });
      await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: "1357", caller: staff })).rejects.toMatchObject({ code: "DELIVERY_OTP_UNAVAILABLE" });
      expect(h.writes).toEqual([]);
    }
  });

  it("blocks cross-order inversion: a v2 hash from order A does not verify for order B with code A", async () => {
    const codeA = seed({ id: "order_A" });
    const hashA = h.docs.get(`orders/${ORDER_ID}`)!.data.deliveryOtpHash;
    const orderB = "order_B";
    mintDeliveryOtp({ orderType: "delivery" }, orderB)!;
    h.write(`orders/${orderB}`, {
      ...h.docs.get(`orders/${ORDER_ID}`)!.data,
      id: orderB,
      deliveryOtpHash: hashA,
      deliveryOtpVersion: 2,
    }, false);
    await expect(verifyDeliveryOtp({ orderId: orderB, otp: codeA, caller: staff }))
      .rejects.toMatchObject({ code: "DELIVERY_OTP_UNAVAILABLE" });
  });

  it("resolves branchIds from admins document when staff member has unrefreshed token claims", async () => {
    const code = seed();
    h.write("admins/staff_stale_claims", {
      role: "branch_staff",
      branchIds: ["branch_a"],
    }, false);
    const staleCaller = { uid: "staff_stale_claims" };
    const result = await verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staleCaller });
    expect(result.success).toBe(true);
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.status).toMatchObject({ code: "DELIVERED" });
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.verifiedByStaff).toBe("staff_stale_claims");
  });

  it("resets prior attempts on expired lockout: attempts=3 + expired lock + 1 wrong guess yields attempts=1, not locked", async () => {
    const code = seed({
      deliveryOtpAttempts: 3,
      deliveryOtpLockedUntil: Date.now() - 5000,
    });
    await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: "0000", caller: staff }))
      .rejects.toMatchObject({ code: "DELIVERY_OTP_INVALID" });
    const order = h.docs.get(`orders/${ORDER_ID}`)!.data;
    expect(order.deliveryOtpAttempts).toBe(1);
    expect(order.deliveryOtpLockedUntil).toBeNull();
    expect((await verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff })).success).toBe(true);
  });

  it("binds verifiedByStaff to authenticated caller email or uid rather than request body staffName", async () => {
    const code = seed();
    const callerWithEmail = { uid: "staff_uid_123", email: "staff@burgonomics.test", role: "branch_staff", branchIds: ["branch_a"] };
    await verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: callerWithEmail, staffName: "Spoofed Attacker Name" });
    expect(h.docs.get(`orders/${ORDER_ID}`)?.data.verifiedByStaff).toBe("staff@burgonomics.test");
  });

  it("rejects undispatched, cancelled and unpaid orders even if their method claims cash", async () => {
    for (const change of [
      { status: "PREPARING", deliveryStatus: null },
      { status: "CANCELLED" }, { status: "REFUNDED" },
      { paymentChannel: null, payment: { method: "cash", status: "completed", capturedAmountPaise: 15900, razorpayPaymentId: "pay_hermetic" } },
    ]) {
      const code = seed(change);
      await expect(verifyDeliveryOtp({ orderId: ORDER_ID, otp: code, caller: staff })).rejects.toBeInstanceOf(Error);
      expect(h.writes).toEqual([]);
    }
  });
});
