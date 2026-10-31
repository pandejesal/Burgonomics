import { describe, it, expect, vi, beforeEach } from "vitest";

// Atomic scheduler lock: two ticks that overlap must not BOTH run. The old
// read-then-write lock let both callers read an unclaimed lease before either
// wrote, so a slow tick and the next one double-processed the same queue.
const { mockDb, lockDocs, control, stats } = vi.hoisted(() => {
  const lockDocs: Record<string, any> = {};
  const control = { failReads: false, failWrites: false, transactions: 0 };
  const stats = { transactions: 0 };
  const refFor = (docId: string) => ({
    id: docId,
    path: `scheduler_locks/${docId}`,
    get: async () => {
      if (control.failReads) throw new Error("read unavailable");
      return {
        exists: Object.prototype.hasOwnProperty.call(lockDocs, docId),
        data: () => (lockDocs[docId] ? { ...lockDocs[docId] } : undefined),
      };
    },
    set: async (data: any, options?: any) => {
      if (control.failWrites) throw new Error("write unavailable");
      lockDocs[docId] =
        options?.merge && lockDocs[docId] ? { ...lockDocs[docId], ...data } : { ...data };
    },
  });
  // Firestore serializes transactions; mirror that so a transactional claim is
  // observably different from the old read-then-write pair.
  let chain: Promise<unknown> = Promise.resolve();
  const mockDb: any = {
    collection: (col: string) => ({ doc: (docId: string) => refFor(docId) }),
    runTransaction: (fn: any) => {
      stats.transactions++;
      const run = chain.then(async () => {
        // Firestore commits writes at the end of the transaction; mirror that
        // so a failed write rejects runTransaction (and the lock fails open).
        const writes: Array<Promise<unknown>> = [];
        const result = await fn({
          get: (ref: any) => ref.get(),
          set: (ref: any, data: any, options?: any) => {
            writes.push(Promise.resolve(ref.set(data, options)));
          },
        });
        await Promise.all(writes);
        return result;
      });
      // Keep the queue alive and attach a handler so a rejected transaction is
      // reported to its caller, not as an unhandled rejection here.
      run.catch(() => undefined);
      chain = run.catch(() => undefined);
      return run;
    },
  };
  void control.transactions;
  return { mockDb, lockDocs, control, stats };
});

vi.mock("../src/core/firebase", () => ({ db: mockDb }));

import { withSchedulerLock } from "../src/core/schedulerLock";

const TTL = 60_000;

describe("withSchedulerLock (POS-02)", () => {
  beforeEach(() => {
    for (const key of Object.keys(lockDocs)) delete lockDocs[key];
    control.failReads = false;
    control.failWrites = false;
    stats.transactions = 0;
  });

  it("lets exactly one of two concurrent callers run", async () => {
    const work = vi.fn(async () => "done");
    const [a, b] = await Promise.all([
      withSchedulerLock("overlap", TTL, work),
      withSchedulerLock("overlap", TTL, work),
    ]);
    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
    expect(work).toHaveBeenCalledTimes(1);
    expect(typeof lockDocs["overlap"].claimedAtMs).toBe("number");
  });

  it("skips while a live lease is held", async () => {
    lockDocs["live"] = { claimedAtMs: Date.now() - 1_000 };
    const work = vi.fn();
    await expect(withSchedulerLock("live", TTL, work)).resolves.toEqual({ ran: false });
    expect(work).not.toHaveBeenCalled();
  });

  it("takes over an expired lease", async () => {
    lockDocs["stale"] = { claimedAtMs: Date.now() - (TTL + 1_000) };
    const work = vi.fn(async () => 7);
    await expect(withSchedulerLock("stale", TTL, work)).resolves.toEqual({
      ran: true,
      result: 7,
    });
    expect(lockDocs["stale"].claimedAtMs).toBeGreaterThan(Date.now() - 5_000);
  });

  it("fails OPEN when the lease cannot be read", async () => {
    control.failReads = true;
    const work = vi.fn(async () => "ran");
    await expect(withSchedulerLock("unreadable", TTL, work)).resolves.toEqual({
      ran: true,
      result: "ran",
    });
  });

  it("fails OPEN when the lease cannot be written", async () => {
    control.failWrites = true;
    const work = vi.fn(async () => "ran");
    await expect(withSchedulerLock("unwritable", TTL, work)).resolves.toEqual({
      ran: true,
      result: "ran",
    });
  });

  it("claims through a transaction", async () => {
    await withSchedulerLock("tx", TTL, async () => undefined);
    expect(stats.transactions).toBe(1);
  });
});
