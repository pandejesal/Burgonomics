import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * STUCK-DECISION ESCALATION (`checking` / `fulfillable`).
 *
 * A paid order whose automatic recovery keeps failing must reach a human, and
 * automatic recovery must KEEP RUNNING. The reviewer's finding: a failed
 * confirmation only bumped `stats.retried` forever — no attempt counter, no ops
 * case, no alert — so a paid customer could sit in limbo indefinitely.
 *
 * Contract pinned here (real recovery + real capture gate; only Firestore, the
 * alert transport and the provider are faked):
 *  - escalation happens AFTER ~1 hour of failures, never before;
 *  - a lease refusal or skipped sweep does not count;
 *  - recovery continues after escalation, and a later success supersedes an
 *    undelivered alert;
 *  - a later success AFTER delivery records recovery on the case (so nobody
 *    refunds an order that was actually fulfilled);
 *  - NO refund POST and NO gate-state change ever happens from this lane;
 *  - a healthy order that confirms immediately never gets a case.
 */
const { mockDb, docs, writeLog, control, snapshots } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_stall";

  const docs = new Map<string, any>();
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const snapshots: any[] = [];
  const control: any = {
    refundPosts: [] as any[],
    /** Force `completeRecoveredCapture` to fail for these order ids. */
    confirmFailsFor: new Set<string>(),
    /** Orders whose next confirmation should succeed (recovery wins). */
    confirmSucceedsOnce: new Set<string>(),
    /** Orders whose confirmation THROWS (the exception path). */
    confirmThrowsFor: new Set<string>(),
    /** One failed transactional read for this order (the guard throws). */
    failNextTxReadFor: null as string | null,
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
  getRazorpayKeyId: () => "rzp_test_stall",
}));

// The confirmation seam: real recovery decides, only the final write is faked so
// a "permanently failing confirm" is reproducible without a provider.
vi.mock("../src/modules/payments/razorpay.service", async (io) => {
  const actual = await io<any>();
  return {
    ...actual,
    completeRecoveredCapture: vi.fn(async (args: any) => {
      if (control.confirmThrowsFor.has(args.orderId)) {
        // The exception path: a malformed order / datastore fault THROWS rather
        // than returning false.
        throw new Error(`malformed order ${args.orderId} cannot be confirmed`);
      }
      if (control.confirmSucceedsOnce.has(args.orderId)) {
        control.confirmSucceedsOnce.delete(args.orderId);
        docs.set(`orders/${args.orderId}`, {
          ...docs.get(`orders/${args.orderId}`),
          paymentStatus: "completed",
          captureFulfillmentState: "confirmed",
        });
        return true;
      }
      if (control.confirmFailsFor.has(args.orderId)) return false;
      return false;
    }),
  };
});

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
import {
  __setPaymentsFetchForTests,
  __setRefundPostForTests,
} from "../src/modules/payments/razorpay.service";
import {
  recoverStuckCaptureFulfilments,
  CAPTURE_STALL_ESCALATE_AFTER_MS,
} from "../src/modules/payments/captureRecovery";
import { CAPTURE_RECOVERY_AFTER_MS } from "../src/modules/payments/captureFulfillment";
import { config } from "../src/config/env";

const BRANCH = "branch_stall";
const ITEMS = [{ id: "p1", productId: "p1", name: "Burger", price: 100, quantity: 1 }];

const orderOf = (id: string) => docs.get(`orders/${id}`);
const caseOf = (paymentId: string) => docs.get(`unmatched_payments/ump_gate_${paymentId}`);

function seedOrder(orderId: string, state: "checking" | "fulfillable", over: Record<string, any> = {}) {
  const paymentId = `pay_${orderId}`;
  docs.set(`orders/${orderId}`, {
    id: orderId,
    customerId: "cust_stall",
    userId: "cust_stall",
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
    captureFulfillment: {
      state,
      paymentId,
      atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
      attempts: 1,
      detail: "p1",
    },
    captureFulfillmentState: state,
    ...over,
  });
  docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: true });
}

/** Real alert boundary: acknowledged transport, real captureErrorSnapshot. */
async function installRealAlerts(mode: "ok" | "no-channel" = "ok") {
  const actual = await vi.importActual<any>("../src/core/errors");
  const mocked = await import("../src/core/errors");
  const capture = vi.mocked(captureErrorSnapshot);
  const previous = capture.getMockImplementation()!;
  const oldSlack = config.alerts.slackWebhookUrl;
  const oldDiscord = config.alerts.discordWebhookUrl;
  const sends: Array<{ text: string }> = [];
  capture.mockImplementation(actual.captureErrorSnapshot);
  config.alerts.slackWebhookUrl = mode === "ok" ? "https://stall.invalid/hook" : "";
  config.alerts.discordWebhookUrl = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: any, options: any) => {
      sends.push({ text: JSON.parse(options.body).text });
      return { ok: true, status: 200 };
    })
  );
  return {
    sends,
    restore: () => {
      capture.mockImplementation(previous);
      config.alerts.slackWebhookUrl = oldSlack;
      config.alerts.discordWebhookUrl = oldDiscord;
      vi.unstubAllGlobals();
    },
  };
}

/** Run sweeps until `ms` of wall clock has passed, in 5-minute steps. */
async function sweepFor(ms: number, stepMs = 5 * 60_000) {
  let elapsed = 0;
  while (elapsed < ms) {
    await recoverStuckCaptureFulfilments();
    vi.advanceTimersByTime(stepMs);
    elapsed += stepMs;
  }
}

beforeEach(() => {
  for (const key of [...docs.keys()]) docs.delete(key);
  writeLog.length = 0;
  snapshots.length = 0;
  control.refundPosts = [];
  control.confirmFailsFor = new Set<string>();
  control.confirmSucceedsOnce = new Set<string>();
  control.confirmThrowsFor = new Set<string>();
  control.failNextTxReadFor = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T09:00:00Z"));
  config.mock.paymentGateway = false;
  config.mock.petpoojaPos = true;
  docs.set(`branches/${BRANCH}`, { id: BRANCH, isOpen: true, packagingFee: 0, monthlyFee: 0 });
  docs.set("products/p1", { id: "p1", name: "Burger", price: 100, inStock: true });
  __setRefundPostForTests(async (paymentId: string, body: any) => {
    control.refundPosts.push({ paymentId, body });
    return { id: `rfnd_${paymentId}`, payment_id: paymentId, amount: 10000, status: "processed" };
  });
  // Default gateway truth: captured, NO refund. A specific test overrides this to
  // simulate a dashboard refund or an unreadable gateway.
  __setPaymentsFetchForTests(async (paymentId: string) => ({
    id: paymentId,
    order_id: `rzp_${paymentId}`,
    amount: 10000,
    currency: "INR",
    status: "captured",
    amount_refunded: 0,
    notes: {},
  }));
});

afterEach(() => {
  vi.useRealTimers();
  __setRefundPostForTests(null);
  __setPaymentsFetchForTests(null);
});

describe("stuck DECISION escalation (checking / fulfillable)", () => {
  it("a failing `fulfillable` confirmation escalates only AFTER the threshold", async () => {
    seedOrder("ord_fail", "fulfillable");
    control.confirmFailsFor.add("ord_fail");
    const alerts = await installRealAlerts();
    try {
      // Well inside the threshold: failures are counted, nobody is paged.
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS - 10 * 60_000);
      expect(alerts.sends).toHaveLength(0);
      expect(caseOf("pay_ord_fail")).toBeUndefined();
      expect(orderOf("ord_fail").captureStall.failedAttempts).toBeGreaterThan(1);

      // Past the threshold: the durable case and a real transport delivery.
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS);
      expect(alerts.sends.length).toBeGreaterThan(0);
      expect(caseOf("pay_ord_fail")).toMatchObject({
        orderId: "ord_fail",
        razorpayPaymentId: "pay_ord_fail",
        reason: "capture_decision_stuck",
        gateState: "fulfillable",
        status: "needs_review",
        staffAction: "confirm_or_refund_manually",
      });
      // Wording must describe a stuck decision, never a refund instruction.
      expect(alerts.sends[0].text).toContain("ord_fail");
      expect(alerts.sends[0].text.toLowerCase()).toContain("neither");
      expect(alerts.sends[0].text.toLowerCase()).not.toContain("refund required");
      // No financial action, no gate change.
      expect(control.refundPosts).toHaveLength(0);
      expect(orderOf("ord_fail").captureFulfillment.state).toBe("fulfillable");
      expect(orderOf("ord_fail").captureFulfillmentState).toBe("fulfillable");
    } finally {
      alerts.restore();
    }
  });

  it("a `checking` row ALWAYS resolves to a terminal gate in one sweep, so it cannot stall (proven, not assumed)", async () => {
    // PROVEN FROM THE CODE, deliberately not a hollow "checking escalates" test:
    // `guardCaptureFulfillment` claims the `checking` lease and, in the SAME call,
    // unconditionally writes a terminal decision (`fulfillable`, `refund_pending`
    // or `refunded`) via recordGateState. A `checking` row therefore cannot
    // survive a completed sweep — its only stall mode is a CRASH between the
    // claim write and that decision, which surfaces through the sweep's outer
    // catch as `stats.failed` and is reported as a residual limit rather than
    // pretended to be covered by the stall counter.
    seedOrder("ord_check", "checking");
    const alerts = await installRealAlerts();
    try {
      await recoverStuckCaptureFulfilments();

      const gateState = orderOf("ord_check").captureFulfillment.state;
      expect(["fulfillable", "refund_pending", "refunded"]).toContain(gateState);
      expect(orderOf("ord_check").captureFulfillment.state).not.toBe("checking");
      // No human is paged for a decision that resolved itself, and no money moved.
      expect(caseOf("pay_ord_check")).toBeUndefined();
      expect(alerts.sends).toHaveLength(0);
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("a lease refusal never counts toward the stall", async () => {
    seedOrder("ord_lease", "fulfillable");
    const alerts = await installRealAlerts();
    try {
      // Keep the lease live for the whole run: every sweep must SKIP the row,
      // and a skip is never a recovery failure.
      for (let tick = 0; tick < 6; tick += 1) {
        docs.set("orders/ord_lease", {
          ...orderOf("ord_lease"),
          captureFulfillment: {
            ...orderOf("ord_lease").captureFulfillment,
            atMs: Date.now(),
          },
        });
        await recoverStuckCaptureFulfilments();
        vi.advanceTimersByTime(5 * 60_000);
      }
      expect(orderOf("ord_lease").captureStall).toBeUndefined();
      expect(caseOf("pay_ord_lease")).toBeUndefined();
      expect(alerts.sends).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("recovery keeps running after escalation, and a later success supersedes an undelivered alert", async () => {
    seedOrder("ord_late", "fulfillable");
    control.confirmFailsFor.add("ord_late");
    const alerts = await installRealAlerts("no-channel");
    try {
      // Escalate with NO channel: the case exists but nothing was delivered.
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS + 10 * 60_000);
      expect(caseOf("pay_ord_late")).toBeDefined();
      expect(caseOf("pay_ord_late").alertDelivery.state).toBe("pending");
      expect(alerts.sends).toHaveLength(0);

      // Automatic recovery keeps trying and finally succeeds.
      control.confirmFailsFor.delete("ord_late");
      control.confirmSucceedsOnce.add("ord_late");
      await sweepFor(10 * 60_000);

      expect(orderOf("ord_late").paymentStatus).toBe("completed");
      // Undelivered alert retired; nobody should be paged for a resolved case.
      expect(caseOf("pay_ord_late").alertDelivery.state).toBe("superseded");
      expect(caseOf("pay_ord_late").alertDelivery.lastError).toBe("gate_recovered");
      expect(orderOf("ord_late").captureStall).toBeNull();
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("a later success AFTER delivery sends a follow-up 'do NOT refund' alert on the same outbox", async () => {
    seedOrder("ord_after", "fulfillable");
    control.confirmFailsFor.add("ord_after");
    const alerts = await installRealAlerts("ok");
    try {
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS + 10 * 60_000);
      const firstAlertCount = alerts.sends.length;
      expect(firstAlertCount).toBeGreaterThan(0);
      expect(caseOf("pay_ord_after").alertDelivery.state).toBe("delivered");

      control.confirmFailsFor.delete("ord_after");
      control.confirmSucceedsOnce.add("ord_after");
      await sweepFor(10 * 60_000);

      // The case stays for staff AND a SECOND, follow-up alert really went out:
      // stamping the case alone is not enough, nobody re-reads a case.
      const staffCase = caseOf("pay_ord_after");
      expect(staffCase.status).toBe("needs_review");
      expect(staffCase.recovered).toMatchObject({ outcome: "confirmed" });
      expect(staffCase.recovered.note).toContain("do NOT refund");
      expect(staffCase.alertDelivery.alertKind).toBe("recovered_confirmed");
      expect(staffCase.alertDelivery.state).toBe("delivered");
      expect(alerts.sends.length).toBe(firstAlertCount + 1);
      const followUp = alerts.sends[alerts.sends.length - 1].text;
      expect(followUp).toContain("ord_after");
      expect(followUp.toLowerCase()).toContain("do not refund");
      expect(followUp.toLowerCase()).toContain("confirmed");
      expect(orderOf("ord_after").captureStall).toBeNull();
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("a healthy order that confirms at once never gets a case", async () => {
    seedOrder("ord_ok", "fulfillable");
    control.confirmSucceedsOnce.add("ord_ok");
    const alerts = await installRealAlerts();
    try {
      await sweepFor(10 * 60_000);
      expect(caseOf("pay_ord_ok")).toBeUndefined();
      expect(orderOf("ord_ok").captureStall).toBeUndefined();
      expect(alerts.sends).toHaveLength(0);
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("an unconfigured channel keeps the stale case visibly undelivered", async () => {
    seedOrder("ord_nochan", "fulfillable");
    control.confirmFailsFor.add("ord_nochan");
    const alerts = await installRealAlerts("no-channel");
    try {
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS + 10 * 60_000);
      const staffCase = caseOf("pay_ord_nochan");
      expect(staffCase).toBeDefined();
      expect(staffCase.alertDelivery.state).toBe("pending");
      expect(staffCase.alertDelivery.lastError).toContain("ALERT_NO_CHANNEL");
      expect(staffCase.alertDelivery.deliveredAtMs).toBeUndefined();
      // Still retrying automatically; the row is not silently dropped.
      expect(orderOf("ord_nochan").captureFulfillment.state).toBe("fulfillable");
    } finally {
      alerts.restore();
    }
  });
});

// ===========================================================================
// FED AND REFUNDED — real guards, not wording.
// ===========================================================================
describe("fed-and-refunded guards (escalated rows only)", () => {
  it("a gateway refund BLOCKS confirmation: no confirm, no KOT, case marked refunded_externally", async () => {
    seedOrder("ord_gwrefund", "fulfillable");
    control.confirmFailsFor.add("ord_gwrefund");
    const alerts = await installRealAlerts("ok");
    try {
      // Escalate first, so the order carries a delivered staff case.
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS + 10 * 60_000);
      expect(alerts.sends.length).toBeGreaterThan(0);

      // Staff refund it in the Razorpay dashboard.
      __setPaymentsFetchForTests(async (paymentId: string) => ({
        id: paymentId,
        order_id: `rzp_${paymentId}`,
        amount: 10000,
        amount_refunded: 10000,
        refund_status: "full",
        currency: "INR",
        status: "refunded",
        notes: {},
      }));

      // Recovery would now succeed — but must stand down.
      control.confirmFailsFor.delete("ord_gwrefund");
      control.confirmSucceedsOnce.add("ord_gwrefund");

      const stats = await recoverStuckCaptureFulfilments();

      expect(stats.confirmed).toBe(0);
      expect(orderOf("ord_gwrefund").status.code).not.toBe("CONFIRMED");
      expect(orderOf("ord_gwrefund").petpoojaOrderId).toBeUndefined();
      expect(caseOf("pay_ord_gwrefund").status).toBe("refunded_externally");
      expect(caseOf("pay_ord_gwrefund").staffAction).toBe(
        "refund_already_issued_do_not_confirm"
      );
      // Never issues a refund of its own; the refund webhook owns that.
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("an UNREADABLE gateway blocks confirmation, and is not counted as a recovery failure", async () => {
    seedOrder("ord_gwfail", "fulfillable");
    control.confirmFailsFor.add("ord_gwfail");
    const alerts = await installRealAlerts("ok");
    try {
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS + 10 * 60_000);
      const stallBefore = orderOf("ord_gwfail").captureStall.failedAttempts;

      __setPaymentsFetchForTests(async () => {
        throw new Error("gateway unavailable");
      });
      control.confirmFailsFor.delete("ord_gwfail");
      control.confirmSucceedsOnce.add("ord_gwfail");

      const stats = await recoverStuckCaptureFulfilments();

      // Fail closed for the tick…
      expect(stats.confirmed).toBe(0);
      expect(orderOf("ord_gwfail").status.code).not.toBe("CONFIRMED");
      // …but an unreadable gateway is NOT evidence the customer is stuck.
      expect(orderOf("ord_gwfail").captureStall.failedAttempts).toBe(stallBefore);
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("a healthy never-escalated row skips the extra gateway read", async () => {
    seedOrder("ord_noprobe", "fulfillable");
    control.confirmSucceedsOnce.add("ord_noprobe");
    const alerts = await installRealAlerts("ok");
    let probeCalls = 0;
    __setPaymentsFetchForTests(async (paymentId: string) => {
      probeCalls += 1;
      return {
        id: paymentId,
        order_id: `rzp_${paymentId}`,
        amount: 10000,
        currency: "INR",
        status: "captured",
        amount_refunded: 0,
        notes: {},
      };
    });
    try {
      await sweepFor(10 * 60_000);
      expect(orderOf("ord_noprobe").paymentStatus).toBe("completed");
      // No escalated case existed, so no extra gateway read was paid for.
      expect(probeCalls).toBe(0);
      expect(caseOf("pay_ord_noprobe")).toBeUndefined();
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("the recovered follow-up alert actually transmits and retries after one transport failure", async () => {
    seedOrder("ord_follow", "fulfillable");
    control.confirmFailsFor.add("ord_follow");
    const actual = await vi.importActual<any>("../src/core/errors");
    const capture = vi.mocked(captureErrorSnapshot);
    const previous = capture.getMockImplementation()!;
    const oldSlack = config.alerts.slackWebhookUrl;
    const sends: Array<{ text: string }> = [];
    let failuresRemaining = 0;
    capture.mockImplementation(actual.captureErrorSnapshot);
    config.alerts.slackWebhookUrl = "https://follow.invalid/hook";
    config.alerts.discordWebhookUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, options: any) => {
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("one transient transport failure");
        }
        sends.push({ text: JSON.parse(options.body).text });
        return { ok: true, status: 200 };
      })
    );
    try {
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS + 10 * 60_000);
      expect(sends.length).toBeGreaterThan(0);

      // The FIRST follow-up send fails at the transport.
      failuresRemaining = 1;
      control.confirmFailsFor.delete("ord_follow");
      control.confirmSucceedsOnce.add("ord_follow");
      await sweepFor(5 * 60_000);

      const pendingFollowUp = caseOf("pay_ord_follow");
      expect(pendingFollowUp.alertDelivery.alertKind).toBe("recovered_confirmed");
      expect(pendingFollowUp.alertDelivery.state).toBe("pending");
      expect(pendingFollowUp.alertDelivery.lastError).toContain("slack_transport");

      // It retries on its own and finally lands.
      const before = sends.length;
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS * 2);
      expect(sends.length).toBeGreaterThan(before);
      expect(caseOf("pay_ord_follow").alertDelivery.state).toBe("delivered");
      expect(sends[sends.length - 1].text.toLowerCase()).toContain("do not refund");
    } finally {
      capture.mockImplementation(previous);
      config.alerts.slackWebhookUrl = oldSlack;
      vi.unstubAllGlobals();
    }
  });

  it("a reason upgrade (decision stuck -> refund exhausted) re-alerts ONCE", async () => {
    seedOrder("ord_upgrade", "fulfillable");
    control.confirmFailsFor.add("ord_upgrade");
    const alerts = await installRealAlerts("ok");
    try {
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS + 10 * 60_000);
      const firstCount = alerts.sends.length;
      expect(firstCount).toBeGreaterThan(0);
      const caseBefore = caseOf("pay_ord_upgrade");
      expect(caseBefore.reason).toBe("capture_decision_stuck");
      expect(caseBefore.alertDelivery.state).toBe("delivered");

      // The refund lane now exhausts its own budget on the SAME payment.
      docs.set("orders/ord_upgrade", {
        ...orderOf("ord_upgrade"),
        captureFulfillment: {
          state: "refund_exhausted",
          paymentId: "pay_ord_upgrade",
          atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
          attempts: 5,
          detail: "p1",
        },
        captureFulfillmentState: "refund_exhausted",
      });
      await recoverStuckCaptureFulfilments();

      const upgraded = caseOf("pay_ord_upgrade");
      expect(upgraded.reason).toBe("refund_retries_exhausted");
      expect(upgraded.gateState).toBe("refund_exhausted");
      expect(upgraded.staffAction).toBe("refund_manually_or_repair_gate");
      expect(alerts.sends.length).toBe(firstCount + 1);

      // An IDENTICAL reason never re-alerts.
      const afterUpgrade = alerts.sends.length;
      await sweepFor(20 * 60_000);
      expect(alerts.sends.length).toBe(afterUpgrade);
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });

  it("a staff-resolved case is never reopened by a reason upgrade", async () => {
    seedOrder("ord_settled", "fulfillable");
    docs.set("unmatched_payments/ump_gate_pay_ord_settled", {
      orderId: "ord_settled",
      razorpayPaymentId: "pay_ord_settled",
      status: "resolved",
      reason: "capture_decision_stuck",
      staffAction: "confirm_or_refund_manually",
      receivedAt: "STAFF_ORIGINAL",
      alertDelivery: { state: "delivered", attempts: 1, deliveredAtMs: 1 },
    });
    const alerts = await installRealAlerts("ok");
    try {
      docs.set("orders/ord_settled", {
        ...orderOf("ord_settled"),
        captureFulfillment: {
          state: "refund_exhausted",
          paymentId: "pay_ord_settled",
          atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
          attempts: 5,
        },
        captureFulfillmentState: "refund_exhausted",
      });
      await recoverStuckCaptureFulfilments();

      const staffCase = caseOf("pay_ord_settled");
      expect(staffCase.status).toBe("resolved");
      expect(staffCase.reason).toBe("capture_decision_stuck");
      expect(staffCase.receivedAt).toBe("STAFF_ORIGINAL");
      expect(alerts.sends).toHaveLength(0);
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });
});

// ===========================================================================
// EXCEPTION PATH — a row that THROWS every sweep is just as stuck as one whose
// confirmation returns false, and used to loop forever without a case.
// ===========================================================================
describe("a row that THROWS on every sweep escalates through the same outbox", () => {
  it("a `fulfillable` row whose confirmation throws escalates after the hour, not before", async () => {
    seedOrder("ord_throw", "fulfillable");
    control.confirmThrowsFor.add("ord_throw");
    const alerts = await installRealAlerts("ok");
    try {
      // Before the threshold: failures counted, nobody paged, still non-terminal.
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS - 10 * 60_000);
      expect(caseOf("pay_ord_throw")).toBeUndefined();
      expect(alerts.sends).toHaveLength(0);
      expect(orderOf("ord_throw").captureStall.failedAttempts).toBeGreaterThan(1);
      expect(orderOf("ord_throw").captureFulfillmentState).toBe("fulfillable");

      // After the threshold: a durable case and a real transport delivery.
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS);
      expect(caseOf("pay_ord_throw")).toMatchObject({
        orderId: "ord_throw",
        reason: "capture_decision_stuck",
        gateState: "fulfillable",
        status: "needs_review",
        staffAction: "confirm_or_refund_manually",
      });
      expect(alerts.sends.length).toBeGreaterThan(0);
      expect(alerts.sends[0].text).toContain("ord_throw");
      // The customer is never auto-refunded and the gate never moves.
      expect(control.refundPosts).toHaveLength(0);
      expect(orderOf("ord_throw").captureFulfillmentState).toBe("fulfillable");
      expect(orderOf("ord_throw").captureFulfillment.state).toBe("fulfillable");
    } finally {
      alerts.restore();
    }
  });

  it("a `checking` row whose GUARD throws escalates the same way", async () => {
    seedOrder("ord_guardthrow", "checking");
    const alerts = await installRealAlerts("ok");
    // Force the guard's own transaction to throw for this row only, so the outer
    // catch — not the normal decision path — is what runs.
    const originalTx = mockDb.runTransaction.bind(mockDb);
    const spy = vi.spyOn(mockDb, "runTransaction").mockImplementation((fn: any) =>
      originalTx(async (tx: any) => {
        const get = tx.get.bind(tx);
        tx.get = async (ref: any) => {
          if (
            String(ref.path) === "orders/ord_guardthrow" &&
            control.failNextTxReadFor === "ord_guardthrow"
          ) {
            control.failNextTxReadFor = null;
            throw new Error("malformed order document");
          }
          return get(ref);
        };
        return fn(tx);
      })
    );
    try {
      // Every sweep throws for this row.
      for (let tick = 0; tick < 14; tick += 1) {
        control.failNextTxReadFor = "ord_guardthrow";
        await recoverStuckCaptureFulfilments();
        vi.advanceTimersByTime(5 * 60_000);
      }

      const staffCase = caseOf("pay_ord_guardthrow");
      expect(staffCase).toBeTruthy();
      expect(staffCase).toMatchObject({
        orderId: "ord_guardthrow",
        reason: "capture_decision_stuck",
        status: "needs_review",
      });
      expect(alerts.sends.length).toBeGreaterThan(0);
      expect(alerts.sends[0].text).toContain("ord_guardthrow");
      // Never auto-refunded, gate never moved.
      expect(control.refundPosts).toHaveLength(0);
      expect(orderOf("ord_guardthrow").captureFulfillmentState).toBe("checking");
      expect(orderOf("ord_guardthrow").captureFulfillment.state).toBe("checking");
    } finally {
      spy.mockRestore();
      alerts.restore();
    }
  });

  it("a recording failure inside the catch does not stop the next order in the same sweep", async () => {
    seedOrder("ord_badrecord", "fulfillable");
    control.confirmThrowsFor.add("ord_badrecord");
    // A HEALTHY row later in the same sweep must still be confirmed.
    seedOrder("ord_after_bad", "fulfillable");
    control.confirmSucceedsOnce.add("ord_after_bad");

    const alerts = await installRealAlerts("ok");
    // Make the stall recorder THROW for the first order only.
    const original = mockDb.runTransaction.bind(mockDb);
    let thrown = 0;
    const spy = vi.spyOn(mockDb, "runTransaction").mockImplementation((fn: any) =>
      original(async (tx: any) => {
        if (thrown === 0 && control.confirmThrowsFor.has("ord_badrecord")) {
          const set = tx.set.bind(tx);
          tx.set = (ref: any, ...rest: any[]) => {
            const data = rest[0] as any;
            if (
              String(ref.path) === "orders/ord_badrecord" &&
              data?.captureStall &&
              data.captureStall.failedAttempts >= 1
            ) {
              thrown += 1;
              throw new Error("stall recorder unavailable");
            }
            return set(ref, ...rest);
          };
        }
        return fn(tx);
      })
    );
    try {
      await sweepFor(10 * 60_000);
      spy.mockRestore();

      // The sweep kept going: the healthy order was confirmed in the same tick.
      expect(orderOf("ord_after_bad").paymentStatus).toBe("completed");
      expect(orderOf("ord_after_bad").captureFulfillmentState).toBe("confirmed");
      expect(caseOf("pay_ord_after_bad")).toBeUndefined();
      expect(control.refundPosts).toHaveLength(0);
    } finally {
      spy.mockRestore();
      alerts.restore();
    }
  });

  it("an OWED-lane row that throws gets NO stuck-decision case (its own budget owns it)", async () => {
    seedOrder("ord_owed_throw", "checking");
    // A refund lane row that THROWS on its own path (malformed cart).
    docs.set("orders/ord_owed_throw", {
      ...orderOf("ord_owed_throw"),
      items: "not-an-array",
      captureFulfillment: {
        state: "refund_failed",
        paymentId: "pay_ord_owed_throw",
        atMs: Date.now() - CAPTURE_RECOVERY_AFTER_MS - 60_000,
        attempts: 1,
        detail: "p1",
      },
      captureFulfillmentState: "refund_failed",
    });
    const alerts = await installRealAlerts("ok");
    try {
      await sweepFor(CAPTURE_STALL_ESCALATE_AFTER_MS + 10 * 60_000);

      // The decision-lane exception path must NOT adopt an owed refund row: its
      // budget/escalation lives in the refund lane.
      const staffCase = caseOf("pay_ord_owed_throw");
      expect(staffCase?.reason).not.toBe("capture_decision_stuck");
      // The row stayed in the REFUND lane end-to-end (settled by its own path,
      // never reclassified as a stuck decision) and no stuck-decision page fired.
      expect(["refund_failed", "refunded"]).toContain(
        orderOf("ord_owed_throw").captureFulfillmentState
      );
      expect(alerts.sends.filter((s) => s.text.includes("capture_decision_stuck"))).toHaveLength(0);
      expect(
        alerts.sends.filter((s) => s.text.includes("neither a confirmed order"))
      ).toHaveLength(0);
    } finally {
      alerts.restore();
    }
  });
});
