/**
 * FCM device-token ownership (Loop 120 / fresh-team owner fix; ratified
 * files: src/modules/notifications/unregisterToken.ts ONLY — lane4 owns the
 * registerToken rebind seam, hence its absence from these cases).
 *
 * Contract (main-ratified + DeepSeek-review resolved):
 *   1. own token     -> token doc deleted (atomically with the ownership
 *                       compare) + bounded fan-out scrub of profiles listing
 *                       the token, counted, capped at 20 with a warn when the
 *                       cap truncates.
 *   2. foreign uid   -> ZERO mutation, silent success (no existence oracle:
 *                       response body identical to the unknown-token path).
 *   3. missing uid   -> zero mutation.
 *   4. unknown token -> callers own profile scrubbed as self-service
 *                       (NOT counted), no holders query, constant response.
 *   5. ownerless legacy doc (userId absent/non-string) -> no delete by any
 *                       caller (fail-closed; warn makes the backlog visible),
 *                       own-profile self-scrub allowed, constant response.
 *   6. TOCTOU        -> the ownership compare and the delete are one
 *                       transaction; a concurrent re-registration that flips
 *                       the owner makes the call a no-op.
 *   7. resilience    -> a holders query failure after delete must not 500
 *                       the logout (warn + constant response). The scrub is a
 *                       SECOND transaction — the delete and the holder writes
 *                       are two commits — that re-reads the token doc: a
 *                       rebind landing after the delete, or a conflicting
 *                       holder mutation, is observed by that read set and the
 *                       scrub becomes a no-op / retries instead of writing
 *                       through a stale snapshot.
 *
 * No-network unit harness: core/firebase and firebase-admin FieldValue are
 * faked in-memory with argument capture (collection/where/limit fidelity).
 * The emulator rules suite is NOT exercised here (rules edits not granted).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock factories are hoisted: keep the fake fully self-contained.
const h = vi.hoisted(() => {
  type TokenDoc = { userId?: string; platform?: string; appVersion?: string | null };
  type UserDoc = { fcmTokens: string[]; updatedAt?: unknown };

  const store: {
    tokens: Map<string, TokenDoc>;
    users: Map<string, UserDoc>;
    userOps: string[];
    queries: Array<{ collection: string; field: string; op: string; val: string; limit?: number }>;
    txDeleteOps: string[];
    refDeletes: string[];
    concurrencyHook?: () => void;
    afterCommitHook?: () => void;
    queryFailCode?: string;
  } = { tokens: new Map(), users: new Map(), userOps: [], queries: [], txDeleteOps: [], refDeletes: [] };

  function tokenSnap(ident: string) {
    const doc = store.tokens.get(ident);
    if (!doc) return { exists: false, data: () => ({}) };
    const d = doc;
    return { exists: true, data: () => ({ ...d }) };
  }

  function applyRemove(id: string, patch: { fcmTokens: { __op: string; vals: string[] }; updatedAt?: unknown }) {
    const cur = store.users.get(id);
    if (!cur) {
      const err = new Error("NOT_FOUND") as Error & { code?: number };
      err.code = 5;
      throw err;
    }
    const next = patch.fcmTokens.__op === "arrayRemove"
      ? { fcmTokens: (cur.fcmTokens || []).filter(t => !patch.fcmTokens.vals.includes(t)), updatedAt: patch.updatedAt }
      : { ...cur, ...patch };
    store.users.set(id, next);
    store.userOps.push(`users/${id}`);
  }

  const fakeDb = {
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Buffered writes with commit-at-end (transaction fidelity): a fake that
      // applied writes mid-flight could not tell "scrubbed inside the
      // transaction" from "scrubbed after commit", which is exactly the
      // rebind-race distinction test 13 pins.
      const bufferedDeletes: string[] = [];
      const bufferedUpdates: Array<() => void> = [];
      const result = await fn({
        get: async (target: { __run?: () => Promise<unknown>; _docId: string }) => {
          if (typeof target.__run === "function") return target.__run();
          store.concurrencyHook?.();
          return tokenSnap(target._docId);
        },
        delete: (ref: { _docId: string }) => {
          bufferedDeletes.push(ref._docId);
        },
        update: (
          ref: { _docId: string },
          patch: { fcmTokens: { __op: string; vals: string[] }; updatedAt?: unknown },
        ) => {
          bufferedUpdates.push(() => applyRemove(ref._docId, patch));
        },
      });
      for (const id of bufferedDeletes) {
        store.tokens.delete(id);
        store.txDeleteOps.push(`device_tokens/${id}`);
      }
      for (const apply of bufferedUpdates) apply();
      store.afterCommitHook?.();
      return result as never;
    },
    collection(name: string) {
      if (name !== "device_tokens" && name !== "users") {
        throw new Error(`unexpected collection in test fake: ${name}`);
      }
      return {
        doc(id: string) {
          if (name === "device_tokens") {
            return {
              _docId: id,
              get: async () => tokenSnap(id),
              delete: async () => {
                // Ref-delete provenance (GLM advisory 1): a regression that
                // hops the delete OUT of the transaction closure would show
                // up here and fail the txDeleteOps assertions in tests 1/7.
                store.tokens.delete(id);
                store.refDeletes.push(`device_tokens/${id}`);
              },
            };
          }
          return {
            _docId: id,
            update: async (patch: { fcmTokens: { __op: string; vals: string[] }; updatedAt?: unknown }) =>
              applyRemove(id, patch),
          };
        },
        where(field: string, op: string, val: string) {
          const entry = { collection: name, field, op, val };
          const idx = store.queries.push(entry) - 1;
          const runGet = async () => {
            if (store.queryFailCode) {
              const err = new Error("QUERY_FAIL") as Error & { code?: string };
              err.code = store.queryFailCode;
              throw err;
            }
            const n = entry.limit ?? 100;
            const all = [...store.users.entries()]
              .filter(([, u]) => (u.fcmTokens || []).includes(val))
              .slice(0, n);
            const docs = all.map(([id]) => ({
              ref: {
                _docId: id,
                path: `users/${id}`,
                update: async (patch: { fcmTokens: { __op: string; vals: string[] }; updatedAt?: unknown }) =>
                  applyRemove(id, patch),
              },
            }));
            return {
              docs,
              size: docs.length,
              forEach: (cb: (d: (typeof docs)[number]) => void) => docs.forEach(cb),
            };
          };
          return {
            __run: runGet,
            limit(n: number) {
              entry.limit = n;
              return { get: runGet, __run: runGet };
            },
            get: runGet,
          };
        },
      };
    },
  };

  return { store, fakeDb };
});

vi.mock("../src/core/firebase", () => ({ db: h.fakeDb }));
vi.mock("firebase-admin", () => ({
  firestore: {
    FieldValue: {
      serverTimestamp: () => "SERVER_TS",
      arrayRemove: (...vals: string[]) => ({ __op: "arrayRemove", vals }),
    },
  },
}));

import { unregisterDeviceToken } from "../src/modules/notifications/unregisterToken";

const OWNER = "user_owner";
const ATTACKER = "user_attacker";
const TOKEN = "tkn_realregistrationtokenvictimstring";
const OWNER_SECOND = "tkn_ownersecondarytoken000";
const ATTACKER_OWN = "tkn_attackerowntokenffffffffff";

function seed(attackerAlsoListsVictimToken: boolean) {
  h.store.tokens.set(TOKEN, { userId: OWNER, platform: "android", appVersion: "1.0.0" });
  h.store.users.set(OWNER, { fcmTokens: [TOKEN, OWNER_SECOND] });
  h.store.users.set(ATTACKER, {
    fcmTokens: attackerAlsoListsVictimToken ? [TOKEN, ATTACKER_OWN] : [ATTACKER_OWN],
  });
}

let warns: string[];
beforeEach(() => {
  h.store.tokens.clear();
  h.store.users.clear();
  h.store.userOps.length = 0;
  h.store.txDeleteOps.length = 0;
  h.store.refDeletes.length = 0;
  h.store.queries.length = 0;
  h.store.concurrencyHook = undefined;
  h.store.afterCommitHook = undefined;
  h.store.queryFailCode = undefined;
  warns = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  });
});

describe("unregisterDeviceToken token ownership", () => {
  it("1. owner deletes the token doc and scrubs EVERY holder incl. other lists (counted, bounded query)", async () => {
    seed(true);
    const res = await unregisterDeviceToken({ token: TOKEN, uid: OWNER });

    expect(res).toEqual({ success: true, removedFromUsers: 2 });
    expect(h.store.tokens.has(TOKEN)).toBe(false);
    expect(h.store.users.get(OWNER)!.fcmTokens).not.toContain(TOKEN);
    expect(h.store.users.get(OWNER)!.fcmTokens).toContain(OWNER_SECOND);
    expect(h.store.users.get(ATTACKER)!.fcmTokens).not.toContain(TOKEN);
    expect(h.store.users.get(ATTACKER)!.fcmTokens).toContain(ATTACKER_OWN);
    // Exactly one query, with the ratified bounded shape.
    expect(h.store.queries).toEqual([
      { collection: "users", field: "fcmTokens", op: "array-contains", val: TOKEN, limit: 20 },
    ]);
    // Each profile updated exactly once (no double-scrub of the owner doc).
    expect(new Set(h.store.userOps)).toEqual(new Set([`users/${OWNER}`, `users/${ATTACKER}`]));
    // Provenance: the doc MUST have been deleted via the transaction, never
    // via a bare ref delete (GLM advisory 1 regression tripwire).
    expect(h.store.txDeleteOps).toEqual([`device_tokens/${TOKEN}`]);
    expect(h.store.refDeletes).toEqual([]);
  });

  it("2. foreign uid: zero mutation, holders query never runs, constant response", async () => {
    seed(false);
    const res = await unregisterDeviceToken({ token: TOKEN, uid: ATTACKER });

    expect(res).toEqual({ success: true, removedFromUsers: 0 });
    expect(h.store.tokens.has(TOKEN)).toBe(true);
    expect(h.store.tokens.get(TOKEN)!.userId).toBe(OWNER);
    expect(h.store.users.get(OWNER)!.fcmTokens).toContain(TOKEN);
    expect(h.store.users.get(ATTACKER)!.fcmTokens).toEqual([ATTACKER_OWN]);
    expect(h.store.userOps).toEqual([]);
    expect(h.store.queries).toEqual([]);
  });

  it("3. missing uid: zero mutation even against a registered token", async () => {
    seed(false);
    const res = await unregisterDeviceToken({ token: TOKEN, uid: undefined });

    expect(res).toEqual({ success: true, removedFromUsers: 0 });
    expect(h.store.tokens.has(TOKEN)).toBe(true);
    expect(h.store.users.get(OWNER)!.fcmTokens).toContain(TOKEN);
    expect(h.store.userOps).toEqual([]);
    expect(h.store.queries).toEqual([]);
  });

  it("4. unknown token + own uid listing it: self-scrub ONLY, not counted, no holders query", async () => {
    seed(true);
    h.store.tokens.delete(TOKEN);
    const res = await unregisterDeviceToken({ token: TOKEN, uid: OWNER });

    expect(res).toEqual({ success: true, removedFromUsers: 0 });
    expect(h.store.users.get(OWNER)!.fcmTokens).not.toContain(TOKEN);
    expect(h.store.users.get(ATTACKER)!.fcmTokens).toContain(TOKEN);
    expect(h.store.userOps).toEqual([`users/${OWNER}`]);
    expect(h.store.queries).toEqual([]);
  });

  it("5. unknown token + foreign uid listing it: own-entry self-scrub, owner untouched, constant response", async () => {
    seed(true);
    h.store.tokens.delete(TOKEN);
    const res = await unregisterDeviceToken({ token: TOKEN, uid: ATTACKER });

    expect(res).toEqual({ success: true, removedFromUsers: 0 });
    expect(h.store.users.get(ATTACKER)!.fcmTokens).not.toContain(TOKEN);
    expect(h.store.users.get(OWNER)!.fcmTokens).toContain(TOKEN);
    expect(h.store.userOps).toEqual([`users/${ATTACKER}`]);
    expect(h.store.queries).toEqual([]);
  });

  it("6. existence-oracle control: foreign-registered response is byte-identical to unknown-token response", async () => {
    seed(false);
    const foreignRes = await unregisterDeviceToken({ token: TOKEN, uid: ATTACKER });
    h.store.tokens.delete(TOKEN);
    const unknownRes = await unregisterDeviceToken({ token: TOKEN, uid: ATTACKER });

    expect(JSON.stringify(foreignRes)).toBe(JSON.stringify(unknownRes));
    expect(JSON.stringify(foreignRes)).toBe(JSON.stringify({ success: true, removedFromUsers: 0 }));
  });

  it("7. TOCTOU: concurrent re-register flipping the doc owner inside the transaction blocks delete+scrub", async () => {
    seed(true);
    h.store.concurrencyHook = () => {
      h.store.tokens.set(TOKEN, { userId: ATTACKER, platform: "android", appVersion: "1.0.0" });
    };
    const res = await unregisterDeviceToken({ token: TOKEN, uid: OWNER });

    expect(res).toEqual({ success: true, removedFromUsers: 0 });
    expect(h.store.tokens.has(TOKEN)).toBe(true);
    expect(h.store.tokens.get(TOKEN)!.userId).toBe(ATTACKER);
    expect(h.store.users.get(OWNER)!.fcmTokens).toContain(TOKEN);
    expect(h.store.queries).toEqual([]);
    // No provenance path at all: neither a tx delete nor a bare ref delete.
    expect(h.store.txDeleteOps).toEqual([]);
    expect(h.store.refDeletes).toEqual([]);
  });

  it("8. legacy ownerless doc: fail-closed (no delete by anyone), own list scrubbed, distinct warn", async () => {
    h.store.tokens.set(TOKEN, { platform: "android" }); // no userId at all
    h.store.users.set(OWNER, { fcmTokens: [TOKEN] });

    const res = await unregisterDeviceToken({ token: TOKEN, uid: OWNER });

    expect(res).toEqual({ success: true, removedFromUsers: 0 });
    expect(h.store.tokens.has(TOKEN)).toBe(true);
    expect(h.store.tokens.get(TOKEN)!.userId).toBeUndefined();
    expect(h.store.users.get(OWNER)!.fcmTokens).not.toContain(TOKEN);
    expect(h.store.userOps).toEqual([`users/${OWNER}`]);
    expect(warns.some(w => w.includes("no owner stored"))).toBe(true);
  });

  it("9. legacy doc with non-string userId: still fail-closed, own list scrubbed, constant response", async () => {
    h.store.tokens.set(TOKEN, { userId: 123 as unknown as string });
    h.store.users.set(OWNER, { fcmTokens: [TOKEN] });

    const res = await unregisterDeviceToken({ token: TOKEN, uid: OWNER });

    expect(res).toEqual({ success: true, removedFromUsers: 0 });
    expect(h.store.tokens.has(TOKEN)).toBe(true);
    expect(h.store.users.get(OWNER)!.fcmTokens).not.toContain(TOKEN);
  });

  it("10. holders cap (20 hit by 25 holders): truncates at 20 and warns about the remainder", async () => {
    h.store.tokens.set(TOKEN, { userId: OWNER, platform: "android" });
    for (let i = 0; i < 25; i++) {
      h.store.users.set(`holder_${i}`, { fcmTokens: [TOKEN] });
    }
    h.store.users.set(OWNER, { fcmTokens: [TOKEN] });

    const res = await unregisterDeviceToken({ token: TOKEN, uid: OWNER });

    // 20 docs patched (the first 20 holders in seed order — the owner doc is
    // seeded last and falls outside the slice); 6 remain.
    expect(h.store.userOps.length).toBe(20);
    const remaining = [...h.store.users.entries()].filter(([, u]) => u.fcmTokens.includes(TOKEN));
    expect(remaining.length).toBe(6);
    expect(warns.some(w => w.includes("cap"))).toBe(true);
    expect(h.store.tokens.has(TOKEN)).toBe(false);
  });

  it("11. holders query failure AFTER the token delete: logout still succeeds (warn, constant response)", async () => {
    seed(true);
    h.store.queryFailCode = "TRANSIENT";
    const res = await unregisterDeviceToken({ token: TOKEN, uid: OWNER });

    expect(res).toEqual({ success: true, removedFromUsers: 0 });
    expect(h.store.tokens.has(TOKEN)).toBe(false);
    expect(warns.some(w => w.includes("holders scrub failed after token delete"))).toBe(true);
  });

  it("12. caller without any users profile + unknown token: silent idempotent success (NOT_FOUND tolerated)", async () => {
    h.store.tokens.clear(); // no token doc, no profile docs at all
    const res = await unregisterDeviceToken({ token: TOKEN, uid: ATTACKER });

    expect(res).toEqual({ success: true, removedFromUsers: 0 });
    expect(warns.some(w => w.includes("self-service scrub skipped"))).toBe(true);
  });

  it("13. rebind race: a scrub outside the delete transaction would erase the NEW owner's fresh membership", async () => {
    seed(false);
    // Race window as it exists pre-fix: the delete transaction commits, and
    // BEFORE the holders scrub reads, another account registers this same
    // device token (rebind): new device_tokens owner + arrayUnion on its list.
    h.store.afterCommitHook = () => {
      h.store.tokens.set(TOKEN, { userId: ATTACKER, platform: "android" });
      h.store.users.get(ATTACKER)!.fcmTokens = [TOKEN, ATTACKER_OWN];
    };

    const res = await unregisterDeviceToken({ token: TOKEN, uid: OWNER });

    // The rebind owns the token now; the detach must not touch its list.
    expect(h.store.tokens.get(TOKEN)!.userId).toBe(ATTACKER);
    expect(h.store.users.get(ATTACKER)!.fcmTokens).toContain(TOKEN);
    // A rebind landed between the delete and the holders read, so the scrub
    // must skip wholesale — the skip protects the new owner's fresh membership;
    // stale lists stay until that owner's later refresh prunes them.
    expect(res).toEqual({ success: true, removedFromUsers: 0 });
    expect(h.store.userOps).toEqual([]);
    expect(warns.some(w => w.includes("re-registered during detach"))).toBe(true);
  });
});
