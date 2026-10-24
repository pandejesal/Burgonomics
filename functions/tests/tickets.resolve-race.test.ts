/**
 * resolveTicket concurrency (lane 04, session ses_ea5c89e34ffeE5jJ0PRSjVSH2k).
 *
 * Defect: the double-resolution guard (`status !== resolved/closed`) is read
 * from a snapshot at the top of resolveTicket and the resolution UPDATE lands
 * at the very end, after provider side effects. Two concurrent resolutions
 * therefore BOTH pass the guard; the later write overwrites the earlier
 * `resolution` payload (the audit trail loses the action that actually ran)
 * and — for refund actions — both enter autoRefund (money safety there rides
 * ONLY on the payments lane's own lease).
 *
 * Contract under test:
 *   1. A concurrent UNRELATED-status resolve (explanation) finishing while the
 *      first is mid-flight: exactly ONE resolve may win; the loser must get
 *      409 TICKET_RESOLUTION_IN_PROGRESS; the stored resolution must be the
 *      winner's, and the timeline must carry exactly ONE ticket_resolved event.
 *   2. A STALE claim (crashed resolver, older than the lease TTL) must NOT
 *      wedge the ticket — a later resolve proceeds.
 *
 * Harness mirrors tests/tickets.service.test.ts (savedDocs + serializing
 * runTransaction); the interleave is forced with a one-shot update gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, savedDocs, gate, barrier } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const gate: {
    path: string | null;
    parked: null | (() => void);
    release: null | (() => void);
  } = { path: null, parked: null, release: null };

  // Versioned transaction model (DS review M-3): per-doc versions + buffered
  // writes + re-execution on read/commit conflict — models the real Firestore
  // retry the lease relies on, unlike a passthrough shim.
  const versions: Record<string, number> = {};
  const barrier: { needed: number; arrived: number; release: null | (() => void) } = {
    needed: 0,
    arrived: 0,
    release: null,
  };
  const bump = (path: string) => {
    versions[path] = (versions[path] || 0) + 1;
  };

  const docRef = (colName: string, docId: string) => ({
    id: docId,
    path: `${colName}/${docId}`,
    get: vi.fn(async () => {
      const key = `${colName}/${docId}`;
      const out = savedDocs[key] ? { ...savedDocs[key] } : undefined;
      return { exists: !!out, data: () => out || {} };
    }),
    set: vi.fn(async (data: any, options?: any) => {
      const key = `${colName}/${docId}`;
      // One-shot interleave gate: park the FIRST FINAL resolution commit
      // (status:"resolved") on the chosen path until the racing resolve has
      // committed. The claim write does NOT park (it must land first).
      if (gate.path === key && data?.status === "resolved" && gate.parked === null) {
        await new Promise<void>((resolve) => {
          gate.parked = resolve;
        });
      }
      savedDocs[key] =
        options?.merge && savedDocs[key] ? { ...savedDocs[key], ...data } : { ...data };
      bump(key);
    }),
    update: vi.fn(async (data: any) => {
      const key = `${colName}/${docId}`;
      savedDocs[key] = { ...(savedDocs[key] || {}), ...data };
      bump(key);
    }),
  });
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId?: string) =>
        docRef(colName, docId || `mock_${Math.random().toString(36).slice(2, 8)}`),
    }),
    runTransaction: vi.fn(async (fn: any) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const readVersions: Record<string, number> = {};
        const writes: Array<{ ref: any; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            // First-get barrier: models two transactions whose reads both
            // observe the pre-claim snapshot before either commits.
            if (barrier.needed > 0) {
              barrier.arrived += 1;
              if (barrier.arrived >= barrier.needed) {
                barrier.needed = 0;
                barrier.release?.();
              } else {
                await new Promise<void>((resolve) => {
                  barrier.release = resolve;
                });
              }
            }
            const snap = await ref.get();
            if (!(ref.path in readVersions)) readVersions[ref.path] = versions[ref.path] || 0;
            return snap;
          },
          set: (ref: any, data: any, opts?: any) => {
            writes.push({ ref, data, merge: opts?.merge });
          },
        };
        const result = await fn(tx);
        const contended = Object.entries(readVersions).some(
          ([p, v]) => (versions[p] || 0) !== v
        );
        if (contended) continue; // Firestore re-runs the closure on conflict
        for (const w of writes) {
          await w.ref.set(w.data, w.merge ? { merge: true } : undefined);
        }
        return result;
      }
      const aborted: any = new Error("ABORTED");
      aborted.code = 10;
      throw aborted;
    }),
  };
  return { mockDb, savedDocs, gate, barrier };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_SERVER_TIMESTAMP",
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

vi.mock("../src/modules/payments/razorpay.service", () => ({
  autoRefund: vi.fn(async () => ({ success: true, id: "rfnd_mock_1" })),
}));

import { resolveTicket } from "../src/modules/tickets/tickets.service";
import { autoRefund } from "../src/modules/payments/razorpay.service";

const TICKET = "tkt_race";
const staffA = { uid: "staff_a", role: "brand_owner" };
const staffB = { uid: "staff_b", role: "brand_owner" };

function seedTicket(extra: Record<string, any> = {}) {
  savedDocs[`support_tickets/${TICKET}`] = {
    ticketNumber: "TKT-RACE-1",
    status: "open",
    branchId: "branch_1",
    customerId: "cust_1",
    timeline: [],
    ...extra,
  };
}

describe("resolveTicket concurrency", () => {
  beforeEach(() => {
    for (const k of Object.keys(savedDocs)) delete savedDocs[k];
    gate.path = null;
    gate.parked = null;
    gate.release = null;
    barrier.needed = 0;
    barrier.arrived = 0;
    barrier.release = null;
    vi.mocked(autoRefund).mockClear();
    mockDb.runTransaction.mockClear();
    seedTicket();
  });

  /** Waits for the one-shot final-commit park, bounded and diagnostic. */
  async function awaitParked(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (gate.parked === null) {
      if (Date.now() > deadline) throw new Error("first resolve never parked on its final commit");
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it("1. concurrent resolves (sequential arrival): exactly one wins, the loser 409s, ONE resolve event", async () => {
    gate.path = `support_tickets/${TICKET}`;
    const first = resolveTicket({
      ticketId: TICKET,
      resolvedBy: "staff_a",
      resolvedByName: "Staff A",
      action: "explanation",
      notes: "A wins",
      caller: staffA,
    } as any).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }));
    try {
      await awaitParked();

      const second = await resolveTicket({
        ticketId: TICKET,
        resolvedBy: "staff_b",
        resolvedByName: "Staff B",
        action: "discount_coupon",
        couponCode: "WELCOME50",
        notes: "B also",
        caller: staffB,
      } as any).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }));

      // Release the parked final commit; it must NOT be overwritten.
      (gate.parked as () => void)();
      const firstSettled = await first;

      // Exactly one resolve may succeed. Pre-lease BOTH succeeded (the guard
      // was read before either write) — this is the RED differentiator. The
      // loser must be the typed 409 lease refusal.
      expect([firstSettled.ok, second.ok].filter(Boolean).length).toBe(1);
      const loser = firstSettled.ok ? second : firstSettled;
      expect(loser.ok).toBe(false);
      expect((loser as any).e).toMatchObject({
        statusCode: 409,
        code: "TICKET_RESOLUTION_IN_PROGRESS",
      });

      // The stored resolution is the winner's, not a last-write-wins blend.
      const doc = savedDocs[`support_tickets/${TICKET}`];
      expect(doc.status).toBe("resolved");
      expect(doc.resolution.action).toBe(second.ok ? "discount_coupon" : "explanation");
      // Exactly one ticket_resolved timeline event survives.
      const resolves = (doc.timeline || []).filter((e: any) => e.action === "ticket_resolved");
      expect(resolves.length).toBe(1);
      // The lease was consumed by the resolution (never left behind).
      expect(doc.resolutionClaim).toBe("MOCK_DELETE");
    } finally {
      (gate.parked as null | (() => void))?.();
    }
  });

  it("2. NEGATIVE — a STALE resolution claim (crashed resolver) must not wedge the ticket", async () => {
    seedTicket({
      status: "open",
      // Older than the 2.5-minute lease: the crashed resolver never finished.
      resolutionClaim: { actorUid: "staff_x", claimedAt: Date.now() - 60 * 60 * 1000 },
    });

    const res = await resolveTicket({
      ticketId: TICKET,
      resolvedBy: "staff_b",
      resolvedByName: "Staff B",
      action: "explanation",
      notes: "retry after crash",
      caller: staffB,
    } as any);

    expect(res.success).toBe(true);
    const doc = savedDocs[`support_tickets/${TICKET}`];
    expect(doc.status).toBe("resolved");
    expect(doc.resolutionClaim).toBe("MOCK_DELETE");
  });

  it("3. TRUE CONCURRENCY — both claim transactions read before either commits; the loser re-runs and 409s", async () => {
    // Barrier parks BOTH first claim reads until both arrived: the exact
    // interleaving a passthrough shim cannot model, and the one the lease's
    // retry-and-re-read property depends on (DS review M-3).
    barrier.needed = 2;
    const a = resolveTicket({
      ticketId: TICKET,
      resolvedBy: "staff_a",
      resolvedByName: "Staff A",
      action: "explanation",
      notes: "A",
      caller: staffA,
    } as any).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }));
    const b = resolveTicket({
      ticketId: TICKET,
      resolvedBy: "staff_b",
      resolvedByName: "Staff B",
      action: "explanation",
      notes: "B",
      caller: staffB,
    } as any).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }));

    const [ra, rb] = await Promise.all([a, b]);

    expect([ra.ok, rb.ok].filter(Boolean).length).toBe(1);
    const loser = ra.ok ? rb : ra;
    expect(loser.ok).toBe(false);
    // The loser lost the race INSIDE the transaction: its re-run saw the
    // committed claim and refused with the typed lease code.
    expect((loser as any).e).toMatchObject({
      statusCode: 409,
      code: "TICKET_RESOLUTION_IN_PROGRESS",
    });
    const doc = savedDocs[`support_tickets/${TICKET}`];
    expect(doc.status).toBe("resolved");
    expect((doc.timeline || []).filter((e: any) => e.action === "ticket_resolved").length).toBe(1);
  });

  it("4. MONEY — two refund resolutions race: autoRefund is called EXACTLY once", async () => {
    savedDocs[`support_tickets/${TICKET}`] = {
      ticketNumber: "TKT-RACE-1",
      status: "open",
      branchId: "branch_1",
      customerId: "cust_1",
      orderId: "ord_paid_1",
      timeline: [],
    };
    savedDocs["orders/ord_paid_1"] = {
      payment: { razorpayPaymentId: "pay_mock_1" },
    };
    gate.path = `support_tickets/${TICKET}`;

    const first = resolveTicket({
      ticketId: TICKET,
      resolvedBy: "staff_a",
      resolvedByName: "Staff A",
      action: "full_refund",
      notes: "A refunds",
      caller: staffA,
    } as any).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }));
    try {
      await awaitParked();
      const second = await resolveTicket({
        ticketId: TICKET,
        resolvedBy: "staff_b",
        resolvedByName: "Staff B",
        action: "full_refund",
        notes: "B refunds too",
        caller: staffB,
      } as any).then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e }));

      (gate.parked as () => void)();
      const firstSettled = await first;

      expect([firstSettled.ok, second.ok].filter(Boolean).length).toBe(1);
      // The loser was refused BEFORE any side effect: one refund, not two.
      expect(vi.mocked(autoRefund)).toHaveBeenCalledTimes(1);
      const resolves = (savedDocs[`support_tickets/${TICKET}`].timeline || []).filter(
        (e: any) => e.action === "ticket_resolved"
      );
      expect(resolves.length).toBe(1);
    } finally {
      (gate.parked as null | (() => void))?.();
    }
  });

  it("5. deterministic ticket refund identity prevents collisions across punctuation or long prefixes", async () => {
    savedDocs["orders/ord_punc_1"] = { payment: { razorpayPaymentId: "pay_1" } };
    savedDocs["orders/ord_punc_2"] = { payment: { razorpayPaymentId: "pay_2" } };

    savedDocs["support_tickets/tkt_sample:item/1"] = {
      ticketNumber: "TKT-P1",
      status: "open",
      branchId: "branch_1",
      orderId: "ord_punc_1",
    };
    savedDocs["support_tickets/tkt_sample_item_1"] = {
      ticketNumber: "TKT-P2",
      status: "open",
      branchId: "branch_1",
      orderId: "ord_punc_2",
    };

    await resolveTicket({
      ticketId: "tkt_sample:item/1",
      resolvedBy: "staff_a",
      resolvedByName: "Staff A",
      action: "full_refund",
      notes: "punc 1",
      caller: staffA,
    } as any);

    await resolveTicket({
      ticketId: "tkt_sample_item_1",
      resolvedBy: "staff_a",
      resolvedByName: "Staff A",
      action: "full_refund",
      notes: "punc 2",
      caller: staffA,
    } as any);

    const calls = vi.mocked(autoRefund).mock.calls;
    const key1 = (calls[calls.length - 2][0] as any).refundRequestId;
    const key2 = (calls[calls.length - 1][0] as any).refundRequestId;

    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    expect(key1).not.toBe(key2);
  });
});
