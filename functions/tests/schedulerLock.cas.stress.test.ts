import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * STRESS-TEST REPAIR RED/GREEN — `withSchedulerLock` mutual exclusion
 * (stress sweep 2026-10-24, scheduler finding M1).
 *
 * The lock was read-then-set: two Cloud Run instances (or a scheduler retry)
 * can both `get()` an absent lock doc inside the same instant, both pass the
 * freshness guard, and both `set()` their own lease — the second overwrites
 * the first, and BOTH run the whole tick (double KOT scan, double transfer
 * worker, double reminders). The fix: acquire inside a transaction so the
 * freshness check and the lease write commit atomically; the loser observes
 * the winner's stamp and skips.
 */

const { mockDb, docs, control } = vi.hoisted(() => {
  type Rec = { data: any; version: number };
  const docs = new Map<string, Rec>();
  const versionOf = (path: string): number => docs.get(path)?.version ?? -1;
  const dataOf = (path: string): any => docs.get(path)?.data;
  const applyWrite = (path: string, data: any, merge?: boolean) => {
    const existing = docs.get(path);
    const next = merge && existing ? { ...existing.data, ...data } : { ...data };
    docs.set(path, { data: next, version: (existing?.version ?? 0) + 1 });
  };

  const runTransaction = (fn: (tx: any) => any): Promise<any> => {
    const attempt = async (): Promise<any> => {
      for (let tries = 0; tries <= 8; tries++) {
        const readVersions = new Map<string, number>();
        const writes: Array<{ path: string; data: any; merge?: boolean }> = [];
        const tx = {
          get: async (ref: any) => {
            readVersions.set(ref.path, versionOf(ref.path));
            const data = dataOf(ref.path);
            return { exists: data !== undefined, data: () => data, ref };
          },
          set: (ref: any, data: any, opts?: any) => void writes.push({ path: ref.path, data, merge: !!opts?.merge }),
          update: (ref: any, data: any) => void writes.push({ path: ref.path, data, merge: true }),
        };
        const result = await fn(tx);
        const conflicted = () => [...readVersions.entries()].some(([path, v]) => versionOf(path) !== v);
        if (writes.length === 0) {
          if (conflicted()) continue;
          return result;
        }
        if (conflicted()) continue;
        for (const w of writes) applyWrite(w.path, w.data, w.merge);
        return result;
      }
      const err: any = new Error("SIMULATED_TRANSACTION_CONTENTION: retries exhausted");
      err.code = "ABORTED";
      throw err;
    };
    return attempt();
  };

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    const ref: any = {
      id,
      path,
      get: async () => {
        const data = dataOf(path);
        return { exists: data !== undefined, data: () => data, ref };
      },
      set: async (data: any, opts?: any) => applyWrite(path, data, !!opts?.merge),
    };
    return ref;
  };
  const collection = (col: string) => ({
    doc: (id: string) => docRef(col, id),
  });
  const mockDb: any = { collection, runTransaction };
  return { mockDb, docs, control: { reset: () => docs.clear() } };
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

import { withSchedulerLock } from "../src/core/schedulerLock";

describe("withSchedulerLock transactional acquire (stress sweep)", () => {
  beforeEach(() => {
    control.reset();
  });

  it("M1 RED: two simultaneous callers — exactly ONE runs the guarded function", async () => {
    const runs: string[] = [];
    const [a, b] = await Promise.all([
      withSchedulerLock("lock_m1", 60_000, async () => {
        runs.push("a");
        return "A";
      }),
      withSchedulerLock("lock_m1", 60_000, async () => {
        runs.push("b");
        return "B";
      }),
    ]);

    expect(runs).toHaveLength(1);
    const ranStates = [a.ran, b.ran].filter(Boolean);
    expect(ranStates).toHaveLength(1);
  });

  it("M1 side A: a fresh lock written by a previous tick still skips the next one", async () => {
    const [first, second] = await Promise.allSettled([
      withSchedulerLock("lock_m2", 60_000, async () => "once"),
      withSchedulerLock("lock_m2", 60_000, async () => "twice"),
    ]);
    // After the race the lock exists and is live: any further caller skips.
    const third = await withSchedulerLock("lock_m2", 60_000, async () => "third");
    expect(third.ran).toBe(false);
  });
});
