import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A2 #3, #4, #5 + owner decision 2026-11-25 #3 (preprod audit cycle 11).
 *
 *  #3 a walk-in counter order must not land in the booking staff member's own
 *     customer history (`userId: actorUid` did exactly that, and the customer
 *     read rule + the app's `where("userId","==",uid)` query both key on it);
 *  #4 `shortCode` must be a SERVER-generated code with a uniqueness reservation,
 *     not the last six characters of a caller-chosen order id;
 *  #5 WhatsApp opt-in defaults to FALSE and consent is only recorded when the
 *     customer explicitly said yes, with a server-stamped consent time.
 */
const state = vi.hoisted(() => {
  const docs = new Map<string, any>();
  const copy = (value: any) => (value === undefined ? undefined : structuredClone(value));
  const apply = (path: string, data: any, merge?: boolean) => {
    docs.set(path, merge ? { ...(docs.get(path) ?? {}), ...copy(data) } : copy(data));
  };
  const ref = (collection: string, id: string) => {
    const path = `${collection}/${id}`;
    const self: any = {
      id,
      path,
      get: async () => ({ exists: docs.has(path), id, ref: self, data: () => copy(docs.get(path)) }),
      set: async (data: any, options?: { merge?: boolean }) => apply(path, data, options?.merge),
      create: async (data: any) => {
        if (docs.has(path)) {
          const err: any = new Error(`ALREADY_EXISTS: ${path}`);
          err.code = 6;
          throw err;
        }
        apply(path, data, false);
      },
      update: async (data: any) => apply(path, data, true),
      delete: async () => docs.delete(path),
    };
    return self;
  };
  const db: any = {
    collection: (name: string) => ({ doc: (id: string) => ref(name, id) }),
    runTransaction: async (callback: (tx: any) => Promise<any>) => {
      const pending: Array<() => void> = [];
      let wrote = false;
      const result = await callback({
        get: async (reference: any) => {
          if (wrote) throw new Error("FIRESTORE_READ_AFTER_WRITE");
          return reference.get();
        },
        set: (reference: any, data: any, options?: { merge?: boolean }) => {
          wrote = true;
          pending.push(() => apply(reference.path, data, options?.merge));
        },
        create: (reference: any, data: any) => {
          wrote = true;
          pending.push(() => {
            if (docs.has(reference.path)) throw new Error(`already exists: ${reference.path}`);
            apply(reference.path, data, false);
          });
        },
        update: (reference: any, data: any) => {
          wrote = true;
          pending.push(() => apply(reference.path, data, true));
        },
        delete: (reference: any) => {
          wrote = true;
          pending.push(() => docs.delete(reference.path));
        },
      });
      for (const write of pending) write();
      return result;
    },
  };
  return { docs, db, reset: () => docs.clear() };
});

vi.mock("../src/core/firebase", () => ({ db: state.db }));
vi.mock("firebase-admin", () => {
  const firestore: any = vi.fn(() => state.db);
  firestore.FieldPath = { documentId: () => "__name__" };
  firestore.FieldValue = {
    // A realistic server timestamp shape: the consent guard must accept what the
    // production Admin SDK writes (a Firestore Timestamp carries `seconds` and
    // `nanoseconds`), never a sentinel string. Plain data only, because this
    // harness clones every written value the way Firestore does.
    serverTimestamp: () => ({ seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 }),
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "DELETE",
  };
  return {
    default: { firestore, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }] },
    firestore, auth: vi.fn(() => ({})), messaging: vi.fn(() => ({})), initializeApp: vi.fn(), apps: [{ name: "mock" }],
  };
});

import { createCashOrder } from "../src/modules/orders/createCashOrder";
import { createWalkIn } from "../src/modules/orders/createWalkIn";
import { createOnlineDraft } from "../src/modules/orders/createOnlineDraft";

/**
 * The two new server authorities are imported LAZILY so this file still runs
 * its document-shape assertions on the base commit (where they do not exist
 * yet): a RED run then shows real behavioural failures, not a module error.
 */
async function shortCodeCandidates(orderId: string): Promise<string[]> {
  const mod: any = await import("../src/modules/orders/shortCode");
  return mod.shortCodeCandidates(orderId);
}
async function hasConsent(order: any): Promise<boolean> {
  const mod: any = await import("../src/modules/notifications/whatsappConsent");
  return mod.hasWhatsappConsent(order);
}

const STAFF = "staff_owner_1";
const CUSTOMER = "customer_a";

function seed() {
  state.docs.set("branches/branch_a", {
    name: "Surat Adajan",
    city: "Surat",
    packagingFee: 15,
    cashOnDelivery: { enabled: true, maxOrderValuePaise: 500000 },
  });
  state.docs.set("products/p1", {
    name: "Paneer Makhani Burger",
    branchId: "branch_a",
    price: 100,
    inStock: true,
    petpoojaItemId: "PP-1",
  });
  state.docs.set("stores/s1", { id: "s1", name: "Demo", partnerBranchId: "branch_a", isOpen: true });
  state.docs.set("admins/staff_owner_1", { role: "branch_owner", branchId: "branch_a", branchIds: ["branch_a"] });
  state.docs.set("users/staff_owner_1", { active: true });
}

const cashRequest = (over: Record<string, any> = {}) => ({
  orderId: "ord_cash_fields",
  storeId: "s1",
  orderType: "takeaway" as const,
  items: [{ productId: "p1", quantity: 1 }],
  expectedTotalPaise: 11500,
  ...over,
});

const walkInRequest = (over: Record<string, any> = {}) => ({
  requestId: "request-fields",
  branchId: "branch_a",
  orderType: "dinein" as const,
  tender: "cash" as const,
  items: [{ productId: "p1", quantity: 1 }],
  expectedTotalPaise: 10000,
  ...over,
});

beforeEach(() => {
  state.reset();
  seed();
});

describe("walk-in ownership (#3)", () => {
  it("never stamps the booking staff member's uid as the order's customer", async () => {
    const receipt = await createWalkIn(STAFF, walkInRequest());
    const order: any = state.docs.get(`orders/${receipt.orderId}`);

    expect(order.customerId).toBe("cust_walkin");
    // The staff uid must appear NOWHERE in the customer identity fields: the
    // rules read arm and the app's history query both match on them.
    expect(order.userId).not.toBe(STAFF);
    expect(order.userId).toBe("cust_walkin");
    // The real actor is still recorded where it belongs: the immutable audit row.
    expect(state.docs.get(`admin_audit_logs/${receipt.orderId}`).actorUid).toBe(STAFF);
  });

  it("keeps every walk-in order out of the staff member's customer identity", async () => {
    const first = await createWalkIn(STAFF, walkInRequest());
    const second = await createWalkIn(STAFF, walkInRequest({ requestId: "request-fields-2" }));
    for (const id of [first.orderId, second.orderId]) {
      const order: any = state.docs.get(`orders/${id}`);
      expect([order.customerId, order.userId]).not.toContain(STAFF);
    }
  });
});

describe("server-generated shortCode (#4)", () => {
  it("is not the last six characters of the caller's order id", async () => {
    // Two ids that the OLD derivation collapsed onto the same code.
    const a = await createCashOrder(CUSTOMER, cashRequest({ orderId: "ord_1234_ABC123" }));
    const b = await createCashOrder(CUSTOMER, cashRequest({ orderId: "ord_999_abc123" }));
    const codeA = state.docs.get(`orders/${a.orderId}`).shortCode;
    const codeB = state.docs.get(`orders/${b.orderId}`).shortCode;

    expect(codeA).toMatch(/^BG-[0-9A-Z]{6}$/);
    expect(codeB).toMatch(/^BG-[0-9A-Z]{6}$/);
    expect(codeA).not.toBe("BG-ABC123");
    expect(codeA).not.toBe(codeB);
  });

  it("reserves the code so a second order can never share it", async () => {
    const orderId = "ord_reservation_test";
    const candidates = await shortCodeCandidates(orderId, "branch_a");
    // Someone else already holds the first candidate.
    state.docs.set(`shorts/${candidates[0].slice(3)}`, { orderId: "ord_someone_else", branchId: "branch_b" });
    const receipt = await createCashOrder(CUSTOMER, cashRequest({ orderId }));
    const stored = state.docs.get(`orders/${receipt.orderId}`).shortCode;

    expect(stored).toBe(candidates[1]);
    expect(state.docs.get(`shorts/${stored.slice(3)}`)).toMatchObject({ orderId, branchId: "branch_a" });
  });

  it("keeps the same code across an idempotent replay", async () => {
    const first = await createCashOrder(CUSTOMER, cashRequest());
    const code = state.docs.get(`orders/${first.orderId}`).shortCode;
    const replay = await createCashOrder(CUSTOMER, cashRequest());

    expect(replay.replayed).toBe(true);
    expect(state.docs.get(`orders/${first.orderId}`).shortCode).toBe(code);
  });

  it("allocates one for a walk-in and an online draft too", async () => {
    const walkIn = await createWalkIn(STAFF, walkInRequest());
    expect(state.docs.get(`orders/${walkIn.orderId}`).shortCode).toMatch(/^BG-[0-9A-Z]{6}$/);

    const draft = await createOnlineDraft(CUSTOMER, {
      orderId: "ord_online_fields",
      attemptId: "attempt_fields",
      storeId: "s1",
      orderType: "takeaway",
      items: [{ productId: "p1", quantity: 1 }],
    });
    expect(state.docs.get(`orders/${draft.orderId}`).shortCode).toMatch(/^BG-[0-9A-Z]{6}$/);
  });
});

describe("WhatsApp consent defaults OFF (owner decision 2026-11-25 #3)", () => {
  it("stores false and no consent stamp when the field is omitted", async () => {
    const receipt = await createCashOrder(CUSTOMER, cashRequest());
    const order: any = state.docs.get(`orders/${receipt.orderId}`);

    expect(order.whatsappOptIn).toBe(false);
    expect(order).not.toHaveProperty("whatsappOptInAt");
    expect(await hasConsent(order)).toBe(false);
  });

  it("stores false and no consent stamp for an explicit false", async () => {
    const receipt = await createCashOrder(CUSTOMER, cashRequest({ whatsappOptIn: false }));
    const order: any = state.docs.get(`orders/${receipt.orderId}`);

    expect(order.whatsappOptIn).toBe(false);
    expect(order).not.toHaveProperty("whatsappOptInAt");
    expect(await hasConsent(order)).toBe(false);
  });

  it("records an explicit true WITH a server-stamped consent time", async () => {
    const receipt = await createCashOrder(CUSTOMER, cashRequest({ whatsappOptIn: true }));
    const order: any = state.docs.get(`orders/${receipt.orderId}`);

    expect(order.whatsappOptIn).toBe(true);
    // The stamp is the SERVER's clock (a Firestore timestamp), never a value the
    // request carried.
    expect(order.whatsappOptInAt).toEqual(
      expect.objectContaining({ seconds: expect.any(Number) })
    );
    expect(await hasConsent(order)).toBe(true);
  });

  it("defaults the online draft to false as well", async () => {
    const off = await createOnlineDraft(CUSTOMER, {
      orderId: "ord_online_off",
      attemptId: "attempt_off",
      storeId: "s1",
      orderType: "takeaway",
      items: [{ productId: "p1", quantity: 1 }],
    });
    const offOrder: any = state.docs.get(`orders/${off.orderId}`);
    expect(offOrder.whatsappOptIn).toBe(false);
    expect(await hasConsent(offOrder)).toBe(false);

    const on = await createOnlineDraft(CUSTOMER, {
      orderId: "ord_online_on",
      attemptId: "attempt_on",
      storeId: "s1",
      orderType: "takeaway",
      items: [{ productId: "p1", quantity: 1 }],
      whatsappOptIn: true,
    });
    const onOrder: any = state.docs.get(`orders/${on.orderId}`);
    expect(onOrder.whatsappOptIn).toBe(true);
    expect(onOrder.whatsappOptInAt).toEqual(
      expect.objectContaining({ seconds: expect.any(Number) })
    );
  });

  it("never treats a legacy defaulted record as consent", async () => {
    // Pre-fix documents were stamped `true` without ever asking the customer.
    expect(await hasConsent({ whatsappOptIn: true })).toBe(false);
    expect(await hasConsent({ whatsappOptIn: true, whatsappOptInAt: null })).toBe(false);
    expect(await hasConsent({ whatsappOptIn: "true", whatsappOptInAt: 1 })).toBe(false);
    expect(await hasConsent({})).toBe(false);
    expect(await hasConsent(null)).toBe(false);
    expect(await hasConsent({ whatsappOptIn: true, whatsappOptInAt: { seconds: 1 } })).toBe(true);
  });
});
