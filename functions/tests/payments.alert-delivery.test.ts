import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ALERT-DELIVERY CONTRACT for the exhausted-refund outbox.
 *
 * A resolved `captureErrorSnapshot` id is NOT delivery proof: the helper
 * swallows Firestore and webhook failures. This suite pins the opt-in
 * `requireAlertDelivery` contract and the recovery job's use of it:
 *
 *  - no configured channel is never "delivered";
 *  - an HTTP 500 from the transport is not delivery;
 *  - a delivered escalation is not re-sent on later sweeps;
 *  - failed delivery backs off (honoured via the persisted nextAttemptAtMs);
 *  - a staff-resolved case is neither alerted nor reset;
 *  - a row refunded before delivery sends nothing;
 *  - a live `sending` lease is respected;
 *  - no persisted error code ever contains the webhook URL;
 *  - plain `captureErrorSnapshot` still resolves on transport failure.
 */
const { mockDb, docs, writeLog, control, snapshots } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_alert_delivery";

  const docs = new Map<string, any>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const snapshots: any[] = [];
  const control: any = {
    refundPosts: [] as any[],
    refundFailuresRemaining: 0,
  };

  const clone = (v: any) => JSON.parse(JSON.stringify(v));
  const mergeMaps = (base: any, patch: any): any => {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
      out[k] =
        v && typeof v === "object" && !Array.isArray(v)
          ? mergeMaps(base?.[k] || {}, v)
          : v;
    }
    return out;
  };
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    docs.set(path, clone(merge ? mergeMaps(docs.get(path) || {}, data) : data));
    writeLog.push({ path, data: clone(data), merge: !!merge });
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        exists: docs.has(path),
        data: () => (docs.has(path) ? clone(docs.get(path)) : undefined),
        ref: docRef(col, id),
      }),
      set: async (data: any, opts?: any) => applyWrite(path, data, !!opts?.merge),
      create: async (data: any) => {
        if (docs.has(path)) {
          const err: any = new Error("ALREADY_EXISTS: Document already exists");
          err.code = 6;
          throw err;
        }
        applyWrite(path, data, false);
      },
      update: async (data: any) => applyWrite(path, data, true),
      delete: async () => void docs.delete(path),
    };
  };

  const getByPath = (obj: any, path: string) =>
    obj != null && Object.prototype.hasOwnProperty.call(obj, path)
      ? obj[path]
      : path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const collectionMock = (colName: string) => {
    const filters: Array<{ field: string; value: any }> = [];
    let limitN: number | null = null;
    let afterId: string | null = null;
    const q: any = {
      where: (field: string, _op: string, value: any) => {
        filters.push({ field, value });
        return q;
      },
      orderBy: (field: any) => {
        const name = typeof field === "string" ? field : "__name__";
        if (name !== "__name__") throw new Error(`Unsupported fake order: ${name}`);
        return q;
      },
      startAfter: (cursor: any) => {
        afterId = String(typeof cursor === "string" ? cursor : cursor?.id ?? "");
        return q;
      },
      limit: (n: number) => {
        limitN = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
        return q;
      },
      get: async () => {
        const all = [...docs.entries()]
          .filter(([p]) => p.startsWith(`${colName}/`))
          .filter(([, d]) => filters.every((f) => getByPath(d, f.field) === f.value))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([p, d]) => {
            const id = p.slice(colName.length + 1);
            return { id, ref: docRef(colName, id), data: () => clone(d) };
          });
        const after = afterId === null ? all : all.filter((d) => d.id > afterId!);
        const found = limitN === null ? after : after.slice(0, limitN);
        return { empty: found.length === 0, size: found.length, docs: found };
      },
      doc: (docId?: string) =>
        docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= 8; tries++) {
        const reads = new Map<string, string>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            reads.set(ref.path, JSON.stringify(docs.get(ref.path) ?? null));
            const data = docs.get(ref.path);
            return {
              exists: data !== undefined,
              data: () => (data === undefined ? undefined : clone(data)),
              ref,
            };
          },
          set: (ref: any, data: any, opts?: any) =>
            void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
        };
        const result = await fn(tx);
        if ([...reads.entries()].some(([p, v]) => JSON.stringify(docs.get(p) ?? null) !== v)) continue;
        for (const w of writes) applyWrite(w.path, w.data, w.merge);
        return result;
      }
      const err: any = new Error("ABORTED");
      err.code = 10;
      throw err;
    };
    return attempt();
  };

  const mockDb: any = { collection: collectionMock, runTransaction };

  return { mockDb, docs, writeLog, control, snapshots };
});

vi.mock("../src/core/firebase", () => ({ db: mockDb }));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TS",
    increment: (n: number) => n,
    arrayUnion: (i: any) => [i],
    delete: () => "MOCK_DELETE",
  };
  const f: any = vi.fn(() => mockDb);
  f.FieldValue = FieldValue;
  f.FieldPath = { documentId: () => "__name__" };
  return {
    default: {
      firestore: f,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: f,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

vi.mock("../src/modules/payments/razorpayClient", () => ({
  getRazorpayClient: () => ({
    orders: {
      create: vi.fn(async () => ({ id: "order_unused" })),
      fetchPayments: vi.fn(async () => ({ items: [] })),
    },
    payments: { fetch: vi.fn(async () => undefined) },
  }),
  getRazorpayKeyId: () => "rzp_test_alert",
}));

// PARTIAL mock: the real capture function stays usable via importActual, so the
// delivery-contract tests below exercise production code, not a stub.
vi.mock("../src/core/errors", async (io) => {
  const actual = await io<any>();
  return {
    ...actual,
    captureErrorSnapshot: vi.fn(async (snapshot: any) => {
      snapshots.push(snapshot);
      return "snap_1";
    }),
  };
});

import { captureErrorSnapshot } from "../src/core/errors";
import { __setRefundPostForTests } from "../src/modules/payments/razorpay.service";
import {
  recoverStuckCaptureFulfilments,
  alertRetryDelayMs,
} from "../src/modules/payments/captureRecovery";
import {
  CAPTURE_GATE_MAX_ATTEMPTS,
  CAPTURE_RECOVERY_AFTER_MS,
} from "../src/modules/payments/captureFulfillment";
import { config } from "../src/config/env";

const BRANCH = "branch_alert";
const ITEMS = [{ id: "p1", productId: "p1", name: "Burger", price: 100, quantity: 1 }];

const orderOf = (id: string) => docs.get(`orders/${id}`);
const caseOf = (paymentId: string) => docs.get(`unmatched_payments/ump_gate_${paymentId}`);

function seedPaidOrder(orderId: string, paymentId: string) {
  docs.set(`orders/${orderId}`, {
    id: orderId,
    customerId: "cust_alert",
    userId: "cust_alert",
    branchId: BRANCH,
    orderType: "takeaway",
    items: ITEMS,
    payment: {
      method: "online",
      status: "completed",
      razorpayPaymentId: paymentId,
      razorpayOrderId: `rzp_${orderId}`,
      capturedAmountPaise: 10000,
    },
    "payment.status": "completed",
    "payment.razorpayPaymentId": paymentId,
    "payment.capturedAmountPaise": 10000,
    pricing: { grandTotal: 100, split: { branchTransferPaise: 10000 } },
    paymentStatus: "completed",
    routeTransferStatus: "not_required",
    status: { code: "PLACED", label: "Order placed", kind: "upcoming", terminal: false },
  });
}

/** An exhausted row exactly as the REAL capture guard leaves it. */
function seedExhausted(orderId: string, paymentId: string, attempts = CAPTURE_GATE_MAX_ATTEMPTS) {
  seedPaidOrder(orderId, paymentId);
  docs.set(`orders/${orderId}`, {
    ...orderOf(orderId),
    captureFulfillment: {
      state: "refund_exhausted",
      paymentId,
      atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
      attempts,
      detail: "p1",
    },
    captureFulfillmentState: "refund_exhausted",
  });
  docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: false });
}

const realErrors = async () => await vi.importActual<any>("../src/core/errors");

/** Install the REAL captureErrorSnapshot with a controlled transport. */
async function installRealBoundary(mode: "ok" | "no-channel" | "http500" | "throw") {
  const actual = await realErrors();
  const mocked = await import("../src/core/errors");
  const capture = vi.mocked(captureErrorSnapshot);
  const previous = capture.getMockImplementation()!;
  const oldSlack = config.alerts.slackWebhookUrl;
  const oldDiscord = config.alerts.discordWebhookUrl;
  const sends: Array<{ url: string; text: string }> = [];
  let configured = mode !== "no-channel";
  capture.mockImplementation(actual.captureErrorSnapshot);

  config.alerts.slackWebhookUrl = configured ? "https://alerts.invalid/hook" : "";
  config.alerts.discordWebhookUrl = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, options: any) => {
      if (mode === "throw") throw new Error("transport down");
      if (mode === "http500") {
        returns500 = true;
        return { ok: false, status: 500, json: async () => ({}) };
      }
      sends.push({ url: String(url), text: JSON.parse(options.body).text });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    })
  );
  let returns500 = false;
  return {
    sends,
    restore: () => {
      capture.mockImplementation(previous);
      config.alerts.slackWebhookUrl = oldSlack;
      config.alerts.discordWebhookUrl = oldDiscord;
      vi.unstubAllGlobals();
      void configured;
      void returns500;
    },
  };
}

const advance = (ms: number) => vi.advanceTimersByTime(ms);

beforeEach(() => {
  for (const key of [...docs.keys()]) docs.delete(key);
  writeLog.length = 0;
  snapshots.length = 0;
  control.refundPosts = [];
  control.refundFailuresRemaining = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
  config.mock.paymentGateway = false;
  config.mock.petpoojaPos = true;
  docs.set(`branches/${BRANCH}`, { id: BRANCH, isOpen: true, packagingFee: 0, monthlyFee: 0 });
  docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: true });
  __setRefundPostForTests(async (paymentId: string, body: any) => {
    control.refundPosts.push({ paymentId, body });
    return { id: `rfnd_${paymentId}`, payment_id: paymentId, amount: 10000, status: "processed" };
  });
});

afterEach(() => {
  vi.useRealTimers();
  __setRefundPostForTests(null);
});

// ===========================================================================
// The contract itself (REAL core/errors.ts, fetch mocked).
// ===========================================================================
describe("alert delivery contract (real captureErrorSnapshot)", () => {
  it("with NO opts still resolves on a transport failure — legacy behaviour", async () => {
    const actual = await realErrors();
    const oldSlack = config.alerts.slackWebhookUrl;
    config.alerts.slackWebhookUrl = "https://alerts.invalid/hook";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("transport down");
    }));
    try {
      await expect(
        actual.captureErrorSnapshot({
          source: "payments",
          severity: "high",
          message: "legacy caller",
          orderId: "ord_legacy",
        })
      ).resolves.toBeTruthy();
    } finally {
      config.alerts.slackWebhookUrl = oldSlack;
      vi.unstubAllGlobals();
    }
  });

  it("with requireAlertDelivery and NO channel rejects ALERT_NO_CHANNEL", async () => {
    const actual = await realErrors();
    const oldSlack = config.alerts.slackWebhookUrl;
    const oldDiscord = config.alerts.discordWebhookUrl;
    config.alerts.slackWebhookUrl = "";
    config.alerts.discordWebhookUrl = "";
    try {
      const err: any = await actual
        .captureErrorSnapshot(
          { source: "payments", severity: "high", message: "no channel", orderId: "o" },
          { requireAlertDelivery: true }
        )
        .then(
          () => null,
          (e: any) => e
        );
      expect(err?.code).toBe("ALERT_NO_CHANNEL");
      expect(err?.detail?.channelsAcknowledged).toBe(0);
    } finally {
      config.alerts.slackWebhookUrl = oldSlack;
      config.alerts.discordWebhookUrl = oldDiscord;
    }
  });

  it("with requireAlertDelivery and an HTTP 500 rejects ALERT_DELIVERY_FAILED with a sanitized code", async () => {
    const actual = await realErrors();
    const oldSlack = config.alerts.slackWebhookUrl;
    config.alerts.slackWebhookUrl = "https://alerts.invalid/hook";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    try {
      const err: any = await actual
        .captureErrorSnapshot(
          { source: "payments", severity: "high", message: "500", orderId: "o2" },
          { requireAlertDelivery: true }
        )
        .then(
          () => null,
          (e: any) => e
        );
      expect(err?.code).toBe("ALERT_DELIVERY_FAILED");
      expect(err?.detail?.failures).toContain("slack_http_500");
      // Sanitized: never the URL, never provider text.
      expect(JSON.stringify(err?.detail)).not.toContain("alerts.invalid");
    } finally {
      config.alerts.slackWebhookUrl = oldSlack;
      vi.unstubAllGlobals();
    }
  });

  it("with requireAlertDelivery and an acknowledged transport resolves", async () => {
    const actual = await realErrors();
    const oldSlack = config.alerts.slackWebhookUrl;
    config.alerts.slackWebhookUrl = "https://alerts.invalid/hook";
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
    try {
      await expect(
        actual.captureErrorSnapshot(
          { source: "payments", severity: "high", message: "ok", orderId: "o3" },
          { requireAlertDelivery: true }
        )
      ).resolves.toBeTruthy();
    } finally {
      config.alerts.slackWebhookUrl = oldSlack;
      vi.unstubAllGlobals();
    }
  });
});

// ===========================================================================
// The recovery job's outbox behaviour.
// ===========================================================================
describe("recovery escalation outbox", () => {
  it("a guard-created exhausted row gets a case and an alert", async () => {
    seedExhausted("ord_guard", "pay_ord_guard");
    const alerts = await installRealBoundary("ok");
    try {
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      const stats = await recoverStuckCaptureFulfilments();
      expect(stats.escalated).toBe(1);
      expect(alerts.sends.length).toBe(1);
      expect(caseOf("pay_ord_guard")).toMatchObject({
        orderId: "ord_guard",
        status: "needs_review",
        gateState: "refund_exhausted",
      });
      expect(caseOf("pay_ord_guard").alertDelivery.state).toBe("delivered");
      // No financial refund was issued by escalation.
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("with NO channel configured the row stays undelivered and never records delivered", async () => {
    seedExhausted("ord_nochan", "pay_ord_nochan");
    const alerts = await installRealBoundary("no-channel");
    try {
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      const stats = await recoverStuckCaptureFulfilments();
      expect(stats.escalated).toBe(0);
      expect(stats.escalationPending).toBe(1);
      // The CASE exists (a human can act) but delivery is honestly pending.
      expect(caseOf("pay_ord_nochan")).toMatchObject({ orderId: "ord_nochan" });
      expect(caseOf("pay_ord_nochan").alertDelivery.state).toBe("pending");
      expect(caseOf("pay_ord_nochan").alertDelivery.lastError).toContain("ALERT_NO_CHANNEL");
      // Still exhausted — never downgraded or confirmed.
      expect(orderOf("ord_nochan").captureFulfillmentState).toBe("refund_exhausted");
    } finally {
      alerts.restore();
    }
  });

  it("an HTTP 500 from the transport is not delivery", async () => {
    seedExhausted("ord_500", "pay_ord_500");
    const alerts = await installRealBoundary("http500");
    try {
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      const stats = await recoverStuckCaptureFulfilments();
      expect(stats.escalated).toBe(0);
      expect(caseOf("pay_ord_500").alertDelivery.state).toBe("pending");
      expect(caseOf("pay_ord_500").alertDelivery.lastError).toContain("slack_http_500");
      expect(caseOf("pay_ord_500").alertDelivery.deliveredAtMs).toBeUndefined();
    } finally {
      alerts.restore();
    }
  });

  it("a delivered row is not re-sent on later sweeps", async () => {
    seedExhausted("ord_once", "pay_ord_once");
    const alerts = await installRealBoundary("ok");
    try {
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      await recoverStuckCaptureFulfilments();
      const afterFirst = alerts.sends.length;
      const deliveredAt = caseOf("pay_ord_once").alertDelivery.deliveredAtMs;
      expect(afterFirst).toBe(1);

      for (let i = 0; i < 3; i += 1) {
        advance(CAPTURE_RECOVERY_AFTER_MS + 1);
        await recoverStuckCaptureFulfilments();
      }
      expect(alerts.sends.length).toBe(afterFirst);
      expect(caseOf("pay_ord_once").alertDelivery.deliveredAtMs).toBe(deliveredAt);
    } finally {
      alerts.restore();
    }
  });

  it("a failed delivery backs off and is retried only after the pinned delay", async () => {
    seedExhausted("ord_backoff", "pay_ord_backoff");
    const alerts = await installRealBoundary("throw");
    try {
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      const first = await recoverStuckCaptureFulfilments();
      expect(first.escalationPending).toBe(1);
      const nextAt = caseOf("pay_ord_backoff").alertDelivery.nextAttemptAtMs;
      expect(nextAt).toBeGreaterThan(Date.now());
      expect(caseOf("pay_ord_backoff").alertDelivery.lastError).toContain("slack_transport");

      // One sweep INSIDE the backoff window changes nothing: no new send, no
      // new attempt, the pinned retry time is untouched.
      vi.setSystemTime(new Date(nextAt - 1_000));
      const stillBackedOff = caseOf("pay_ord_backoff").alertDelivery.nextAttemptAtMs;
      const during = await recoverStuckCaptureFulfilments();
      expect(caseOf("pay_ord_backoff").alertDelivery.nextAttemptAtMs).toBe(stillBackedOff);
      expect(during.escalated).toBe(0);
      expect(caseOf("pay_ord_backoff").alertDelivery.state).toBe("pending");

      // Past the window it retries; the transport is healthy now.
      const actual = await realErrors();
      vi.mocked(captureErrorSnapshot).mockImplementation(actual.captureErrorSnapshot);
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200 })));
      vi.setSystemTime(new Date(nextAt + 1_000));
      const retried = await recoverStuckCaptureFulfilments();
      expect(retried.escalated).toBe(1);
      expect(caseOf("pay_ord_backoff").alertDelivery.state).toBe("delivered");
    } finally {
      alerts.restore();
    }
    expect(alertRetryDelayMs(1)).toBe(CAPTURE_RECOVERY_AFTER_MS);
    expect(alertRetryDelayMs(99)).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });

  it("a staff-resolved case is neither alerted nor reset", async () => {
    seedExhausted("ord_staff", "pay_ord_staff");
    docs.set("unmatched_payments/ump_gate_pay_ord_staff", {
      orderId: "ord_staff",
      razorpayPaymentId: "pay_ord_staff",
      status: "resolved",
      gateState: "refund_exhausted",
      receivedAt: "STAFF_ORIGINAL",
    });
    const alerts = await installRealBoundary("ok");
    try {
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      const stats = await recoverStuckCaptureFulfilments();
      expect(alerts.sends.length).toBe(0);
      expect(stats.escalated).toBe(0);
      const staffCase = caseOf("pay_ord_staff");
      expect(staffCase.status).toBe("resolved");
      expect(staffCase.receivedAt).toBe("STAFF_ORIGINAL");
      expect(staffCase.alertDelivery).toBeUndefined();
    } finally {
      alerts.restore();
    }
  });

  it("a row refunded before delivery sends nothing", async () => {
    seedExhausted("ord_gone", "pay_ord_gone");
    docs.set("unmatched_payments/ump_gate_pay_ord_gone", {
      orderId: "ord_gone",
      razorpayPaymentId: "pay_ord_gone",
      status: "needs_review",
      gateState: "refund_exhausted",
      alertDelivery: { state: "pending", attempts: 1 },
    });
    // The sibling completed the refund while we were not looking: the row has
    // LEFT the refund_exhausted lane, so the sweep must not alert about it.
    docs.set("orders/ord_gone", {
      ...orderOf("ord_gone"),
      captureFulfillment: {
        state: "refunded",
        paymentId: "pay_ord_gone",
        atMs: Date.now() - 60_000,
        attempts: 2,
      },
      captureFulfillmentState: "refunded",
    });
    const alerts = await installRealBoundary("ok");
    try {
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      const stats = await recoverStuckCaptureFulfilments();
      expect(alerts.sends.length).toBe(0);
      expect(stats.escalated).toBe(0);
      // The staff case is untouched and the refund is not re-labelled.
      expect(caseOf("pay_ord_gone").alertDelivery.state).toBe("pending");
      expect(orderOf("ord_gone").captureFulfillmentState).toBe("refunded");
    } finally {
      alerts.restore();
    }
  });

  it("a live sending lease is respected (no concurrent duplicate send)", async () => {
    seedExhausted("ord_lease", "pay_ord_lease");
    const alerts = await installRealBoundary("ok");
    vi.setSystemTime(new Date(Date.now() + CAPTURE_RECOVERY_AFTER_MS + 1));
    // The lease is live as of the sweep's own clock.
    docs.set("unmatched_payments/ump_gate_pay_ord_lease", {
      orderId: "ord_lease",
      razorpayPaymentId: "pay_ord_lease",
      status: "needs_review",
      gateState: "refund_exhausted",
      alertDelivery: {
        state: "sending",
        attempts: 1,
        leaseUntilMs: Date.now() + 5 * 60_000,
        nextAttemptAtMs: Date.now() + 5 * 60_000,
      },
    });
    try {
      const stats = await recoverStuckCaptureFulfilments();
      expect(alerts.sends.length).toBe(0);
      expect(stats.escalated).toBe(0);
      expect(caseOf("pay_ord_lease").alertDelivery.state).toBe("sending");
    } finally {
      alerts.restore();
    }
  });

  it("persisted lastError never contains the webhook URL", async () => {
    seedExhausted("ord_secret", "pay_ord_secret");
    const alerts = await installRealBoundary("throw");
    try {
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      await recoverStuckCaptureFulfilments();
      const stored = JSON.stringify(caseOf("pay_ord_secret"));
      expect(stored).not.toContain("alerts.invalid");
      expect(stored).not.toContain("https://");
      expect(caseOf("pay_ord_secret").alertDelivery.lastError).toMatch(/ALERT_|slack_/);
    } finally {
      alerts.restore();
    }
  });

  it("a transient case-write failure keeps the row owed and recovers on the next sweep", async () => {
    seedExhausted("ord_casefail", "pay_ord_casefail");
    const alerts = await installRealBoundary("ok");
    // Fail the FIRST transaction that touches the case doc.
    let failed = 0;
    const original = mockDb.runTransaction.bind(mockDb);
    const spy = vi.spyOn(mockDb, "runTransaction").mockImplementation((fn: any) =>
      original(async (tx: any) => {
        const set = tx.set.bind(tx);
        tx.set = (ref: any, ...rest: any[]) => {
          if (String(ref.path).includes("unmatched_payments/ump_gate_") && failed === 0) {
            failed += 1;
            throw new Error("one transient case-write failure");
          }
          return set(ref, ...rest);
        };
        return fn(tx);
      })
    );
    try {
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      const first = await recoverStuckCaptureFulfilments();
      expect(first.escalated).toBe(0);
      // The order must NOT have been left exhausted without a case.
      expect(orderOf("ord_casefail").captureFulfillmentState).toBe("refund_exhausted");
      expect(caseOf("pay_ord_casefail")).toBeUndefined();

      spy.mockRestore();
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      const second = await recoverStuckCaptureFulfilments();
      expect(second.escalated).toBe(1);
      expect(caseOf("pay_ord_casefail").alertDelivery.state).toBe("delivered");
      expect(alerts.sends.length).toBe(1);
    } finally {
      spy.mockRestore();
      alerts.restore();
    }
  });

  it("the alert text names the order, not the case document id", async () => {
    seedExhausted("ord_text", "pay_ord_text");
    const alerts = await installRealBoundary("ok");
    try {
      advance(CAPTURE_RECOVERY_AFTER_MS + 1);
      await recoverStuckCaptureFulfilments();
      const text = alerts.sends[0].text;
      expect(text).toContain("ord_text");
      expect(text).not.toContain("ump_gate_");
    } finally {
      alerts.restore();
    }
  });
});
