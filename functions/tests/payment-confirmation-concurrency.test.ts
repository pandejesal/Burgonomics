import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * R21 — payment confirmation concurrency evidence (client `verifyPayment` path).
 *
 * The previous revision of this suite installed a *passthrough* `runTransaction`
 * that simply ran the callback with `get`/`set` delegates. That validated only
 * single-threaded branch selection: no commit serialization, no optimistic-
 * concurrency conflict, no retry, no re-read of a competing writer's snapshot.
 *
 * This revision replaces it with a self-contained in-memory document store that
 * models the two properties the R06 guard actually depends on:
 *
 *   1. COMMIT QUEUE — every transaction commit is appended to a single queue and
 *      applied strictly one at a time, in arrival order.
 *   2. OPTIMISTIC CONCURRENCY — each transaction records the version of every
 *      document it read. At commit time, if any read document's version advanced
 *      (a competing writer committed in between), the commit is aborted and the
 *      transaction callback is RE-INVOKED against the CHANGED snapshot. This is
 *      the retry path the idempotent confirmation guards exist to survive.
 *
 * A test can also force the conflict deterministically via
 * `control.injectCompetingCommit(fn)`, which simulates a competing writer
 * committing between our read and our commit.
 *
 * HONESTY LIMIT: this is an in-process model. It proves the guards are
 * retry-safe against an in-memory conflict; it does NOT prove real Firebase
 * cross-process transaction/retry semantics, which remain a runtime hypothesis.
 */
const { mockDb, docs, writeLog, commitStats, control } = vi.hoisted(() => {
  process.env.OTP_HMAC_SECRET = "test_otp_r21_verify";

  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  /** R29: EVERY store write in arrival order (path + merged payload). Doc
   *  keys alone cannot count two writes that collide on one id — the audit id
   *  is `aud_${Date.now()}_${paymentId}`, so two confirmations inside one
   *  millisecond overwrite the same key. Counting write events closes that
   *  window independently of the id scheme. */
  const writeLog: Array<{ path: string; data: any; merge?: boolean }> = [];
  const commitStats = { commits: 0, retries: 0, contentions: 0 };
  const MAX_RETRIES = 8;
  let pendingCompetingWrite: (() => void) | null = null;

  const versionOf = (path: string): number => {
    const rec = docs.get(path);
    return rec ? rec.version : -1;
  };
  const dataOf = (path: string): any => {
    const rec = docs.get(path);
    return rec ? rec.data : undefined;
  };
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
    writeLog.push({ path, data: next, merge: !!merge });
  };

  // Serialized commit queue: commits run strictly one at a time, in arrival
  // order (Firestore commit semantics).
  let commitTail: Promise<unknown> = Promise.resolve();
  const enqueueCommit = <T>(task: () => T): Promise<T> => {
    const run = commitTail.then(task, task);
    commitTail = run.then(() => undefined, () => undefined);
    return run;
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= MAX_RETRIES; tries++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            readVersions.set(ref.path, versionOf(ref.path));
            const data = dataOf(ref.path);
            return { exists: data !== undefined, data: () => data, ref };
          },
          set: (ref: any, data: any, opts?: any) =>
            void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
        };

        const result = await fn(tx);
        const conflicted = (): boolean =>
          [...readVersions.entries()].some(([path, v]) => versionOf(path) !== v);

        // Read-only transaction: still version-checked, nothing to commit.
        if (writes.length === 0) {
          if (conflicted()) {
            commitStats.retries += 1;
            continue;
          }
          return result;
        }

        const outcome = await enqueueCommit(() => {
          // Deterministic competing writer: mutates the store AFTER our read but
          // BEFORE our commit — the exact TOCTOU the guard exists for.
          if (pendingCompetingWrite) {
            const hook = pendingCompetingWrite;
            pendingCompetingWrite = null;
            hook();
          }
          if (conflicted()) {
            commitStats.contentions += 1;
            return { conflicted: true as const };
          }
          for (const w of writes) applyWrite(w.path, w.data, w.merge);
          commitStats.commits += 1;
          return { conflicted: false as const, result };
        });
        if (!outcome.conflicted) return outcome.result;
        commitStats.retries += 1;
      }
      const err: any = new Error("SIMULATED_TRANSACTION_CONTENTION: retries exhausted");
      err.code = "ABORTED";
      throw err;
    };
    return attempt();
  };

  const docRef = (colName: string, docId: string) => {
    const path = `${colName}/${docId}`;
    return {
      id: docId,
      path,
      get: async () => {
        const data = dataOf(path);
        return { exists: data !== undefined, data: () => data, ref: docRef(colName, docId) };
      },
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
    };
  };

  const getByPath = (obj: any, path: string) =>
    path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const collectionMock = (colName: string) => {
    const filters: Array<{ field: string; value: any }> = [];
    const q: any = {
      where: (field: string, _op: string, value: any) => {
        filters.push({ field, value });
        return q;
      },
      limit: () => q,
      get: async () => {
        const found = [...docs.entries()]
          .filter(([path]) => path.startsWith(`${colName}/`))
          .filter(([, rec]) => filters.every((f) => getByPath(rec.data, f.field) === f.value))
          .map(([path, rec]) => {
            const [col, id] = path.split("/");
            return { id, ref: docRef(col, id), data: () => rec.data };
          });
        return { empty: found.length === 0, size: found.length, docs: found };
      },
      doc: (docId?: string) =>
        docRef(colName, docId || `auto_${Math.random().toString(36).slice(2, 8)}`),
    };
    return q;
  };

  const mockDb: any = { collection: collectionMock, runTransaction };

  return {
    mockDb,
    docs,
    writeLog,
    commitStats,
    control: {
      seed: (path: string, data: any, merge = false) => applyWrite(path, data, merge),
      injectCompetingCommit: (fn: () => void) => {
        pendingCompetingWrite = fn;
      },
      reset: () => {
        docs.clear();
        writeLog.length = 0;
        commitStats.commits = 0;
        commitStats.retries = 0;
        commitStats.contentions = 0;
        pendingCompetingWrite = null;
      },
    },
  };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

import { verifyPayment } from "../src/modules/payments/razorpay.service";
import { config } from "../src/config/env";

/** Confirmation audit docs are `aud_<ts>_<payid>`; webhook claim docs are `aud_evt_*`. */
const confirmAudits = () =>
  [...docs.keys()].filter(
    (k) => k.startsWith("payment_audits/aud_") && !k.startsWith("payment_audits/aud_evt_")
  );
/**
 * R29 — count of confirmation-audit WRITES (events), not distinct doc ids.
 * Two confirmations of one payment inside the same millisecond share the doc
 * id `aud_${Date.now()}_${paymentId…}` (razorpay.service.ts:1406), so a
 * key-based count reports 1 even when 2 confirmations ran. This count is
 * immune to that collision and is what pins "exactly one" below.
 */
const confirmAuditWrites = () =>
  writeLog.filter(
    (e) => e.path.startsWith("payment_audits/aud_") && !e.path.startsWith("payment_audits/aud_evt_")
  );
const keysWithPrefix = (prefix: string) => [...docs.keys()].filter((k) => k.startsWith(prefix));

/**
 * R29 — deterministic audit-id clock.
 *
 * `finishVerifiedPayment` keys its audit `aud_${Date.now()}_${paymentId…}`,
 * so a wall clock that does not advance between two confirmations produces
 * ONE document for TWO confirmations (the R27 "collision window"). Every test
 * in this file therefore runs on a clock that never repeats a value:
 *   - monotonic by default, seeded from the real wall clock BEFORE the spy is
 *     installed, so production time windows (claim TTLs, freshness) keep
 *     reading realistic values and nothing time-based is masked;
 *   - `freezeClock(ms)` pins every later `Date.now()` to one known value when
 *     a test wants to assert the FULL expected audit document id.
 * `nowIssued` lets a test prove an id came from this clock rather than from
 * wall time.
 */
let nowSpy: { mockRestore: () => void } | null = null;
let nowNext = 0;
let nowFrozen: number | null = null;
const nowIssued = new Set<number>();
const installClock = () => {
  nowSpy?.mockRestore();
  nowNext = Date.now(); // real time, read BEFORE the spy is in place
  nowFrozen = null;
  nowIssued.clear();
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
    const value = nowFrozen === null ? (nowNext += 1) : nowFrozen;
    nowIssued.add(value);
    return value;
  });
};
const freezeClock = (ms: number) => {
  nowFrozen = ms;
  nowIssued.add(ms);
};
const uninstallClock = () => {
  nowSpy?.mockRestore();
  nowSpy = null;
};

/** Delivery order already settled by the Route split — isolates the confirm guard. */
const transferredOrder = (extra: Record<string, any> = {}) => ({
  branchId: "branch_test_1",
  orderType: "delivery",
  routeTransferStatus: "transferred",
  pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } },
  ...extra,
});

const validParams = (orderId: string, paymentId: string) => ({
  orderId,
  razorpayOrderId: "order_rzp_1",
  razorpayPaymentId: paymentId,
  razorpaySignature: "mock_signature_valid",
});

describe("payment confirmation concurrency (verify path)", () => {
  let prevMock: boolean;
  beforeEach(() => {
    installClock();
    control.reset();
    prevMock = config.mock.paymentGateway;
    config.mock.paymentGateway = true;
  });
  afterEach(() => {
    uninstallClock();
    config.mock.paymentGateway = prevMock;
  });

  it("does not regenerate the OTP hash on a repeated confirmation", async () => {
    control.seed(
      "orders/order_repeat_1",
      transferredOrder({
        paymentStatus: "completed",
        "payment.status": "completed",
        status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
        deliveryOtpHash: "ORIGINAL_HASH",
      })
    );

    const first = await verifyPayment(validParams("order_repeat_1", "pay_repeat_1"));
    const second = await verifyPayment(validParams("order_repeat_1", "pay_repeat_1"));

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(docs.get("orders/order_repeat_1")!.data.deliveryOtpHash).toBe("ORIGINAL_HASH");
    // No fresh audit: the repeat performed no confirmation work.
    expect(confirmAudits()).toHaveLength(0);
  });

  it("isolated later-status guard: pending + PREPARING preserves status and hash (paymentStatus NOT completed)", async () => {
    control.seed(
      "orders/order_later_1",
      transferredOrder({
        paymentStatus: "pending",
        status: { code: "PREPARING", label: "Preparing", kind: "in_progress", terminal: false },
        deliveryOtpHash: "LATER_HASH",
      })
    );

    const res: any = await verifyPayment(validParams("order_later_1", "pay_later_1"));

    const order = docs.get("orders/order_later_1")!.data;
    expect(order.status).toMatchObject({ code: "PREPARING" });
    expect(order.deliveryOtpHash).toBe("LATER_HASH");
    expect(order.paymentStatus).not.toBe("completed");
    expect(res.deliveryOtp).toBeUndefined();
    // The later-status branch is now the DECIDING factor (not `alreadyCompleted`),
    // and it also suppressed downstream split/audit work.
    expect(confirmAudits()).toHaveLength(0);
    expect(keysWithPrefix("coin_transactions/")).toHaveLength(0);
  });

  it("isolated terminal guard: pending + DELIVERED (terminal) is not regressed by a late verify", async () => {
    control.seed(
      "orders/order_term_1",
      transferredOrder({
        paymentStatus: "pending",
        status: { code: "DELIVERED", label: "Delivered", kind: "completed", terminal: true },
        deliveryOtpHash: "TERM_HASH",
      })
    );

    const res: any = await verifyPayment(validParams("order_term_1", "pay_term_1"));

    const order = docs.get("orders/order_term_1")!.data;
    expect(order.status).toMatchObject({ code: "DELIVERED", terminal: true });
    expect(order.deliveryOtpHash).toBe("TERM_HASH");
    expect(order.paymentStatus).not.toBe("completed");
    expect(res.deliveryOtp).toBeUndefined();
    expect(confirmAudits()).toHaveLength(0);
  });

  it("first confirmation generates an OTP hash, records ONE priced audit, and debits no coins", async () => {
    control.seed(
      "orders/order_first_1",
      transferredOrder({ paymentStatus: "pending", pricing: { grandTotal: 250, split: { branchTransferPaise: 9000 } } })
    );
    // R29: freeze the audit-id clock so the EXPECTED audit document id is
    // exact and independent of wall time (no dynamic collision). The write
    // count below stays exact even under a frozen clock.
    const auditTs = Date.now();
    freezeClock(auditTs);

    const res: any = await verifyPayment(validParams("order_first_1", "pay_first_1"));

    expect(res.success).toBe(true);
    const order = docs.get("orders/order_first_1")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    expect(order.deliveryOtpHash).toBeDefined();
    expect(res.deliveryOtp).toMatch(/^\d{4}$/);
    expect(order["payment.razorpayPaymentId"]).toBe("pay_first_1");

    // Exact expected id: `aud_<frozen ts>_<paymentId truncated to 10 chars>`
    // (`pay_first_1` -> `pay_first_`) — asserted as a literal, not as a count.
    const expectedAudit = `payment_audits/aud_${auditTs}_pay_first_`;
    expect(
      confirmAuditWrites(),
      "exactly ONE confirmation audit was written (a second write cannot hide behind a collided doc id)"
    ).toHaveLength(1);
    expect(confirmAudits()).toEqual([expectedAudit]);
    // Amount binding preserved: the audit carries the server-priced total in paise.
    expect(docs.get(expectedAudit)!.data.amountPaise).toBe(25000);
    // No intent exists → no redemption → no coin ledger / customer write.
    expect(keysWithPrefix("coin_transactions/")).toHaveLength(0);
    expect(keysWithPrefix("customers/")).toHaveLength(0);
  });

  it("heals a webhook-first confirmation's missing OTP hash exactly once", async () => {
    // Webhook confirmed the order but wrote no deliveryOtpHash (webhookHandler
    // intentionally does not mint a browser-channel OTP).
    control.seed(
      "orders/order_backfill_1",
      transferredOrder({
        paymentStatus: "completed",
        "payment.status": "completed",
        status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
      })
    );

    const first: any = await verifyPayment(validParams("order_backfill_1", "pay_backfill_1"));
    expect(first.success).toBe(true);
    expect(first.deliveryOtp).toMatch(/^\d{4}$/);
    const hash = docs.get("orders/order_backfill_1")!.data.deliveryOtpHash;
    expect(hash).toBeDefined();

    const second: any = await verifyPayment(validParams("order_backfill_1", "pay_backfill_1"));
    expect(second.deliveryOtp).toBeUndefined();
    expect(docs.get("orders/order_backfill_1")!.data.deliveryOtpHash).toBe(hash);
    // The heal performs no confirmation write → no confirmation audit.
    expect(confirmAudits()).toHaveLength(0);
  });

  it("reports non-success for a cancelled order and parks the captured payment", async () => {
    // SCOPE NOTE (R29): this fixture settles the Route split up front
    // (`transferred`), so `executeRouteSplit` short-circuits
    // (razorpay.service.ts:961) whatever the ordering of the terminal check
    // and the split is — it proves the park + 409, NOT the ordering. The
    // ordering is pinned by the R29 regression below, which keeps the split
    // UNRESOLVED.
    control.seed(
      "orders/order_cancel_1",
      transferredOrder({
        paymentStatus: "pending",
        status: { code: "CANCELLED", label: "Cancelled", kind: "cancelled", terminal: true },
      })
    );

    const err: any = await verifyPayment(validParams("order_cancel_1", "pay_cancel_1")).then(
      (x) => x,
      (e) => e
    );
    expect(err?.code).toBe("ORDER_TERMINAL");
    expect(err?.statusCode).toBe(409);
    expect(docs.get("unmatched_payments/ump_term_pay_cancel_1")).toBeDefined();
    expect(confirmAudits()).toHaveLength(0);
    // B5: the payer's own money moved against a cancelled order, so the order
    // doc — their one readable surface — must carry the reconciliation marker.
    // Without it only support could ever know the money was taken.
    expect(docs.get("orders/order_cancel_1")!.data.reconciliation).toMatchObject({
      state: "payment_review",
      reason: "capture_on_cancelled_order",
      razorpayPaymentId: "pay_cancel_1",
    });
  });

  /**
   * R29 — ORDERING regression (R27 third pass, blocker #2).
   *
   * Requirement: terminal captured-payment detection must complete BEFORE
   * `executeRouteSplit` (razorpay.service.ts:788-826 runs ahead of :832).
   *
   * Why the previous cancelled test could not fail on ordering: it seeded
   * `routeTransferStatus: "transferred"`, and `executeRouteSplit` returns the
   * stored receipt without any claim/POST in that state — so moving the
   * terminal check after the split would still pass it.
   *
   * This fixture instead leaves the split UNRESOLVED (`pending_retry`, the
   * retry worker's own lane — razorpay.service.ts:1117) and links the branch
   * to a Razorpay account, so a production path that splits first really
   * claims + POSTs the payout (`trf_mock_*`, status `transferred`) for an
   * order the customer's money must NOT be split on. There is no passing
   * alternative here: every assertion below fails loudly with an explicit
   * ordering message if `executeRouteSplit` runs first or the terminal guard
   * is skipped.
   */
  it.each([
    ["CANCELLED", "capture_on_cancelled_order", "Cancelled"],
    ["REFUNDED", "capture_on_refunded_order", "Refunded"],
  ] as const)(
    "R29 ordering: %s + captured payment + UNRESOLVED split parks BEFORE executeRouteSplit (split never runs)",
    async (code, parkReason, label) => {
      const orderId = `order_r29_${code.toLowerCase()}`;
      const paymentId = `pay_r29_${code.toLowerCase()}`;
      control.seed(`orders/${orderId}`, {
        id: orderId,
        branchId: "branch_test_1",
        orderType: "delivery",
        customerId: "cust_r29",
        // Capture is proven upstream: the gateway signature check already ran
        // (razorpay.service.ts:628-678; production additionally binds the live
        // captured amount in :770-779) before the terminal read.
        paymentStatus: "pending",
        // UNRESOLVED split: not `transferred`, so executeRouteSplit has no
        // short-circuit and would really claim + POST if it ran first.
        routeTransferStatus: "pending_retry",
        routeTransferError: "Route transfer failed",
        routeTransferRetryCount: 0,
        pricing: {
          grandTotal: 250,
          split: { branchTransferPaise: 9000, brandRoyaltyPaise: 1600, totalAmountPaise: 25000 },
        },
        status: { code, label, kind: code === "CANCELLED" ? "cancelled" : "completed", terminal: true },
      });
      // Linked payout account: without it a split-first ordering would only
      // FLAG the order; with it the mock gateway accepts and the payout really
      // lands (`transferred`) — the money-risky outcome this test forbids.
      control.seed("branches/branch_test_1", { razorpayAccountId: "acc_test_1" });

      const outcome: any = await verifyPayment(validParams(orderId, paymentId)).then(
        (x) => x,
        (e) => e
      );

      const ORDERING_DEFECT =
        `R29 ORDERING DEFECT: executeRouteSplit ran (or was reached) for a ${code} order whose ` +
        `split is unresolved — terminal captured-payment detection must complete BEFORE ` +
        `executeRouteSplit (razorpay.service.ts:788-826 precedes :832). No split execution is ` +
        `acceptable on this path; park and refuse instead.`;

      // The park document and the 409 refusal prove the terminal guard RAN —
      // both exist only inside that block (:794-826); a guard dropped in
      // favour of finishVerifiedPayment's later, non-throwing terminal result
      // would produce no park and no statusCode at all.
      const park = docs.get(`unmatched_payments/ump_term_${paymentId}`);
      expect(park, `R29 ORDERING DEFECT: the ${code} capture was not parked by the pre-split terminal guard`).toBeDefined();
      // 409 ORDER_TERMINAL is thrown ONLY by that pre-split block; the split
      // assertions below are what pin WHERE the block ran.
      expect(outcome?.code, `R29 ORDERING DEFECT: expected a structured ORDER_TERMINAL refusal for ${orderId}`).toBe("ORDER_TERMINAL");
      expect(
        outcome?.statusCode,
        "R29 ORDERING DEFECT: 409 comes only from the pre-split terminal throw — a non-409 result means the terminal guard was skipped in favour of a later, non-throwing path"
      ).toBe(409);

      // THE money assertion — this is what pins the ORDERING: nothing about
      // the split may have moved, because executeRouteSplit has no
      // short-circuit for an unresolved (`pending_retry`) split.
      const order = docs.get(`orders/${orderId}`)!.data;
      expect(order.routeTransferStatus, ORDERING_DEFECT).toBe("pending_retry");
      expect(order.routeTransferClaimedAt, ORDERING_DEFECT).toBeUndefined();
      expect(order["payment.routeTransfer"], ORDERING_DEFECT).toBeUndefined();
      expect(order.routeTransferError, ORDERING_DEFECT).toBe("Route transfer failed");

      // Terminal state itself untouched, no confirmation work of any kind.
      expect(order.status, ORDERING_DEFECT).toMatchObject({ code, terminal: true });
      expect(order.paymentStatus, ORDERING_DEFECT).toBe("pending");
      expect(park!.data).toMatchObject({
        reason: parkReason,
        status: "needs_review",
        orderId,
        razorpayPaymentId: paymentId,
        orderStatus: code,
      });
      expect(confirmAuditWrites(), ORDERING_DEFECT).toHaveLength(0);
      expect(confirmAudits(), ORDERING_DEFECT).toHaveLength(0);
      expect(keysWithPrefix("coin_transactions/"), ORDERING_DEFECT).toHaveLength(0);
    }
  );

  it("fails closed on an invalid signature (no order write, no audit)", async () => {
    control.seed("orders/order_sig_1", transferredOrder({ paymentStatus: "pending" }));

    const err: any = await verifyPayment({
      ...validParams("order_sig_1", "pay_sig_1"),
      razorpaySignature: "force_fail",
    }).then(
      (x) => x,
      (e) => e
    );
    expect(err?.code).toBe("INVALID_SIGNATURE");
    expect(err?.statusCode).toBe(401);
    expect(docs.get("orders/order_sig_1")!.data.paymentStatus).toBe("pending");
    expect(confirmAudits()).toHaveLength(0);
  });

  it("gates the order/OTP payload on caller ownership", async () => {
    control.seed(
      "orders/order_owner_1",
      transferredOrder({ paymentStatus: "pending", customerId: "cust_owner" })
    );
    control.seed(
      "orders/order_intruder_1",
      transferredOrder({ paymentStatus: "pending", customerId: "cust_owner" })
    );

    const owner: any = await verifyPayment(
      validParams("order_owner_1", "pay_owner_1"),
      { uid: "cust_owner" }
    );
    expect(owner.ok).toBe(true);
    expect(owner.order).toBeDefined();
    expect(owner.deliveryOtp).toBeDefined();

    const intruder: any = await verifyPayment(
      validParams("order_intruder_1", "pay_intruder_1"),
      { uid: "someone_else" }
    );
    expect(intruder.ok).toBe(true);
    expect(intruder.order).toBeUndefined();
    expect(intruder.deliveryOtp).toBeUndefined();
    // The server still confirmed the paid order; only the response was redacted.
    expect(docs.get("orders/order_intruder_1")!.data.paymentStatus).toBe("completed");
  });

  it("serializes concurrent verify + verify: one confirmation audit, one OTP, stable hash", async () => {
    control.seed(
      "orders/order_race_vv",
      transferredOrder({ paymentStatus: "pending", pricing: { grandTotal: 100, split: { branchTransferPaise: 9000 } } })
    );

    const [a, b]: any[] = await Promise.all([
      verifyPayment(validParams("order_race_vv", "pay_race_vv")),
      verifyPayment(validParams("order_race_vv", "pay_race_vv")),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    const order = docs.get("orders/order_race_vv")!.data;
    expect(order.paymentStatus).toBe("completed");
    expect(order.status).toMatchObject({ code: "CONFIRMED" });
    // Exactly one confirmation performed the work.
    // R29: on the collision-free clock BOTH counts are exact — a second
    // confirmation would be 2 writes and 2 documents, never one doc id shared
    // by two same-millisecond confirmations.
    expect(
      confirmAuditWrites(),
      "exactly ONE confirmation audit write across the two racing verifies (a duplicate cannot hide behind an id collision)"
    ).toHaveLength(1);
    expect(confirmAudits()).toHaveLength(1);
    const auditKey = confirmAudits()[0];
    const auditParts = /^payment_audits\/aud_(\d+)_pay_race_v$/.exec(auditKey);
    expect(auditParts, `unexpected confirmation audit id: ${auditKey}`).not.toBeNull();
    expect(
      nowIssued.has(Number(auditParts![1])),
      "audit id must be stamped by the deterministic clock — a wall-clock id reopens the same-millisecond collision window"
    ).toBe(true);
    expect([a, b].filter((r) => !!r.deliveryOtp)).toHaveLength(1);
    const hash = order.deliveryOtpHash;
    expect(hash).toBeDefined();
    // No coin debit on either path (no intent).
    expect(keysWithPrefix("coin_transactions/")).toHaveLength(0);

    // A follow-up verify neither regenerates the hash nor adds an audit.
    const third: any = await verifyPayment(validParams("order_race_vv", "pay_race_vv"));
    expect(third.deliveryOtp).toBeUndefined();
    expect(docs.get("orders/order_race_vv")!.data.deliveryOtpHash).toBe(hash);
    expect(confirmAudits()).toHaveLength(1);
    expect(confirmAuditWrites()).toHaveLength(1);
  });

  it("deterministic contention: a competing writer between read and commit forces a retry against the changed snapshot", async () => {
    control.seed(
      "orders/order_det_1",
      transferredOrder({ paymentStatus: "pending", pricing: { grandTotal: 100, split: { branchTransferPaise: 9000 } } })
    );

    // Competing writer commits CONFIRMED + a hash AFTER our transaction reads but
    // BEFORE it commits. The store MUST abort + retry the callback.
    control.injectCompetingCommit(() =>
      control.seed(
        "orders/order_det_1",
        {
          paymentStatus: "completed",
          "payment.status": "completed",
          "payment.razorpayPaymentId": "pay_det_1",
          status: { code: "CONFIRMED", label: "Order confirmed", kind: "upcoming", terminal: false },
          deliveryOtpHash: "COMPETITOR_HASH",
        },
        true
      )
    );

    const res: any = await verifyPayment(validParams("order_det_1", "pay_det_1"));

    // The injection fired: one contention, one retry (real abort → re-invoke).
    expect(commitStats.contentions).toBe(1);
    expect(commitStats.retries).toBe(1);
    // The retry observed the competitor's CONFIRMED + hash and did no work:
    // no hash regeneration, no OTP leak, no duplicate audit.
    const order = docs.get("orders/order_det_1")!.data;
    expect(order.deliveryOtpHash).toBe("COMPETITOR_HASH");
    expect(res.deliveryOtp).toBeUndefined();
    expect(res.success).toBe(true);
    expect(confirmAudits()).toHaveLength(0);
  });
});
