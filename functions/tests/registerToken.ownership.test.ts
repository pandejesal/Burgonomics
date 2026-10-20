/**
 * FCM device-token REGISTER ownership (lane 04 running the ratified standing
 * claim, sibling of tests/notifications.token-ownership.test.ts which covers
 * the lane-07-owned unregisterToken.ts ONLY).
 *
 * Defect under test (index.ts:1231-1237 before this fix): the register handler
 * merged device_tokens/{token} with an unconditional `userId: uid`, so
 *   - a foreign caller silently REBOUND a token owned by another account,
 *   - concurrent registers raced (no transaction, last write wins),
 *   - ownerless legacy docs were claimable by anyone.
 *
 * Contract (lane-04 brief + unregisterToken contract mirrored):
 *   1. unknown token + uid      -> claim: doc set (token, userId, platform,
 *                                  appVersion, updatedAt) + caller list
 *                                  arrayUnion, in ONE transaction.
 *   2. foreign-owned token      -> refuse: ZERO mutation, no prune scan.
 *   3. ownerless doc (userId
 *      absent / non-string)     -> refuse (fail-closed) + distinct warn.
 *   4. own token re-register    -> idempotent refresh: metadata stamped,
 *                                  ownership unchanged.
 *   5. stale holders (other
 *      users' lists naming the
 *      token)                   -> bounded (20) best-effort arrayRemove prune
 *                                  from every holder EXCEPT the caller.
 *   6. missing uid              -> throws (route 401s first; depth defense).
 *   7. resilience               -> prune query failure / per-holder scrub
 *                                  failure never fails the registration.
 *
 * No-network unit harness: core/firebase + firebase-admin FieldValue faked
 * in-memory with argument capture (mirrors the sibling file's harness).
 *
 * Honest coverage note (DS review): the fake has no snapshot isolation or
 * retry loop, so a true interleaving (owner flips BETWEEN read and commit,
 * forcing re-execution) is not representable here — real Firestore transaction
 * semantics provide that only in the emulator/deployed runtime. What the
 * unit suite DOES pin: refusals at read time leave zero mutation, and every
 * write rides tx.set (txSetOps provenance), never a bare ref write.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock factories are hoisted: keep the fake fully self-contained.
const h = vi.hoisted(() => {
  type TokenDoc = {
    token?: string;
    userId?: unknown;
    platform?: string;
    appVersion?: string | null;
    updatedAt?: unknown;
  };
  type UserDoc = { fcmTokens: string[]; updatedAt?: unknown };

  const store: {
    tokens: Map<string, TokenDoc>;
    users: Map<string, UserDoc>;
    txSetOps: string[];
    txSetData: Array<Record<string, unknown>>;
    refSetOps: string[];
    userOps: string[];
    queries: Array<{ collection: string; field: string; op: string; val: string; limit?: number }>;
    scrubFailIds?: string[];
    concurrencyHook?: () => void;
    queryFailCode?: string;
    failRunTransaction?: boolean;
  } = {
    tokens: new Map(),
    users: new Map(),
    txSetOps: [],
    txSetData: [],
    refSetOps: [],
    userOps: [],
    queries: [],
  };

  function applyArraySentinel(doc: UserDoc, sent: { __op: string; vals: string[] }) {
    const cur = doc.fcmTokens || [];
    doc.fcmTokens =
      sent.__op === "arrayUnion"
        ? Array.from(new Set([...cur, ...sent.vals]))
        : cur.filter((t) => !sent.vals.includes(t));
  }

  function applyMerge(target: Record<string, unknown>, patch: Record<string, unknown>) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === "fcmTokens" && v && (v as { __op?: string }).__op) {
        applyArraySentinel(target as unknown as UserDoc, v as { __op: string; vals: string[] });
      } else {
        target[k] = v;
      }
    }
  }

  const fakeDb = {
    async runTransaction(fn: (tx: unknown) => Promise<unknown>) {
      if (store.failRunTransaction) throw new Error("FIRESTORE_UNAVAILABLE");
      const writes: Array<{ path: string; patch: Record<string, unknown> }> = [];
      const gate = await fn({
        get: async (ref: { _docId: string }) => {
          store.concurrencyHook?.();
          const doc = store.tokens.get(ref._docId);
          return doc
            ? { exists: true, data: () => ({ ...doc }) }
            : { exists: false, data: () => ({}) };
        },
        set: (ref: { _docId: string; _mount?: string }, patch: Record<string, unknown>) => {
          writes.push({ path: `${ref._mount}/${ref._docId}`, patch });
        },
      });
      // Commit only after the closure resolved (fake atomicity).
      for (const w of writes) {
        store.txSetOps.push(w.path);
        store.txSetData.push(w.patch);
        const [mount, id] = w.path.split("/");
        if (mount === "device_tokens") {
          const cur = (store.tokens.get(id) || {}) as Record<string, unknown>;
          applyMerge(cur, w.patch);
          store.tokens.set(id, cur as TokenDoc);
        } else {
          const cur: Record<string, unknown> = {
            ...(store.users.get(id) as unknown as Record<string, unknown>),
          };
          applyMerge(cur, w.patch);
          store.users.set(id, cur as UserDoc);
        }
      }
      return gate as never;
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
              _mount: "device_tokens",
              get: async () => {
                const doc = store.tokens.get(id);
                return doc
                  ? { exists: true, data: () => ({ ...doc }) }
                  : { exists: false, data: () => ({}) };
              },
              set: async (_patch: Record<string, unknown>) => {
                // Provenance tripwire: the claim must ride the TRANSACTION
                // closure, never a bare ref set.
                store.refSetOps.push(`device_tokens/${id}`);
                throw new Error("bare ref set outside a transaction is a bug");
              },
            };
          }
          return {
            _docId: id,
            _mount: "users",
            update: async (patch: Record<string, unknown>) => {
              if (store.scrubFailIds?.includes(id)) throw new Error("SCRUB_FAIL");
              const cur = store.users.get(id);
              if (!cur) {
                // Real Firestore throws on a missing doc (NOT_FOUND, code 5) —
                // aligned with the sibling harness so silent-no-op drift
                // cannot inflate prunedStaleHolders in the fake.
                const err = new Error("NOT_FOUND") as Error & { code?: number };
                err.code = 5;
                throw err;
              }
              applyMerge(cur as unknown as Record<string, unknown>, patch);
              store.userOps.push(`users/${id}`);
            },
          };
        },
        where(field: string, op: string, val: string) {
          const entry = { collection: name, field, op, val };
          store.queries.push(entry);
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
              id,
              ref: {
                path: `users/${id}`,
                update: async (patch: Record<string, unknown>) => {
                  if (store.scrubFailIds?.includes(id)) throw new Error("SCRUB_FAIL");
                  const cur = store.users.get(id);
                  if (cur) {
                    applyMerge(cur as unknown as Record<string, unknown>, patch);
                    store.userOps.push(`users/${id}`);
                  }
                },
              },
            }));
            return {
              docs,
              size: docs.length,
              forEach: (cb: (d: (typeof docs)[number]) => void) => docs.forEach(cb),
            };
          };
          return {
            limit(n: number) {
              entry.limit = n;
              return { get: runGet };
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
      arrayUnion: (...vals: string[]) => ({ __op: "arrayUnion", vals }),
      arrayRemove: (...vals: string[]) => ({ __op: "arrayRemove", vals }),
    },
  },
}));

import { registerDeviceToken, httpResponseFor } from "../src/core/deviceTokenRegister";

const OWNER = "user_owner";
const ATTACKER = "user_attacker";
const TOKEN = "tkn_realregistrationtokenvictimstring";
const TOKEN_SHORT = "tkn_second";

function txSetsFor(mount: string): Array<Record<string, unknown>> {
  return h.store.txSetData.filter((_, i) => h.store.txSetOps[i].startsWith(`${mount}/`));
}

function txSetPathsFor(mount: string): string[] {
  return h.store.txSetOps.filter((p) => p.startsWith(`${mount}/`));
}

describe("registerDeviceToken ownership seam", () => {
  beforeEach(() => {
    h.store.tokens.clear();
    h.store.users.clear();
    h.store.txSetOps.length = 0;
    h.store.txSetData.length = 0;
    h.store.refSetOps.length = 0;
    h.store.userOps.length = 0;
    h.store.queries.length = 0;
    h.store.scrubFailIds = undefined;
    h.store.concurrencyHook = undefined;
    h.store.queryFailCode = undefined;
    h.store.failRunTransaction = false;
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("1. unknown token: claims doc with stamped metadata + callers arrayUnion in ONE transaction", async () => {
    const res = await registerDeviceToken({
      token: TOKEN,
      uid: OWNER,
      platform: "android",
      appVersion: "1.2.3",
    });

    expect(res).toEqual({ success: true, outcome: "claimed", prunedStaleHolders: 0 });
    // Ownership claim + caller list union both rode the transaction.
    expect(txSetPathsFor("device_tokens")).toEqual([`device_tokens/${TOKEN}`]);
    expect(txSetsFor("device_tokens")[0]).toEqual({
      token: TOKEN,
      userId: OWNER,
      platform: "android",
      appVersion: "1.2.3",
      updatedAt: "SERVER_TS",
    });
    expect(txSetPathsFor("users")).toEqual([`users/${OWNER}`]);
    expect(h.store.users.get(OWNER)!.fcmTokens).toEqual([TOKEN]);
    // A fresh claim is self-granted ownership: it may secure the CALLER's own
    // list (inside the transaction above) but must NEVER scan or purge other
    // accounts' lists (ratified sibling rule: an unowned string, once
    // unclaimed, purges nothing — DS review finding 1).
    expect(h.store.queries).toEqual([]);
    expect(h.store.userOps).toEqual([]); // pruning is transaction-write-only for the claim
    expect(h.store.txSetOps.length).toBe(2); // claim stayed inside the transaction
  });

  it("2. unknown token with defaults: platform 'unknown', appVersion null", async () => {
    const res = await registerDeviceToken({ token: TOKEN, uid: OWNER });

    expect(res.outcome).toBe("claimed");
    expect(txSetsFor("device_tokens")[0]).toMatchObject({
      token: TOKEN,
      userId: OWNER,
      platform: "unknown",
      appVersion: null,
    });
  });

  it("3. foreign-owned token: ZERO mutation — owner doc AND caller's own list untouched, no prune scan, refused_foreign", async () => {
    h.store.tokens.set(TOKEN, { token: TOKEN, userId: OWNER, platform: "android" });
    h.store.users.set(OWNER, { fcmTokens: [TOKEN] });
    h.store.users.set(ATTACKER, { fcmTokens: [] });

    const res = await registerDeviceToken({ token: TOKEN, uid: ATTACKER, platform: "ios" });

    expect(res).toEqual({ success: false, outcome: "refused_foreign", prunedStaleHolders: 0 });
    // The owner's stored binding is untouched — no silent rebind.
    expect(h.store.tokens.get(TOKEN)!.userId).toBe(OWNER);
    expect(h.store.users.get(OWNER)!.fcmTokens).toEqual([TOKEN]);
    // ...and the CALLER's own list gained nothing either (the seam header's
    // zero-mutation promise; DS review finding 3).
    expect(h.store.users.get(ATTACKER)!.fcmTokens).toEqual([]);
    expect(h.store.userOps).toEqual([]);
    expect(h.store.queries).toEqual([]); // no scan on refusal
    expect(h.store.txSetOps).toEqual([]); // no writes at all
  });

  it("4. ownerless legacy doc (userId absent): refused_ownerless + distinct warn, zero mutation", async () => {
    h.store.tokens.set(TOKEN, { platform: "android" }); // no userId
    h.store.users.set(OWNER, { fcmTokens: [] });
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) =>
      warns.push(a.map(String).join(" "))
    );

    const res = await registerDeviceToken({ token: TOKEN, uid: OWNER });

    expect(res).toEqual({ success: false, outcome: "refused_ownerless", prunedStaleHolders: 0 });
    expect(h.store.tokens.get(TOKEN)!.userId).toBeUndefined();
    expect(h.store.txSetOps).toEqual([]);
    expect(warns.some((w) => w.includes("no owner stored"))).toBe(true);
    // The stripPrefix contract: no warn may ever carry the full token (GLM
    // verify NIT — pinned so a future edit cannot leak the credential).
    expect(warns.every((w) => !w.includes(TOKEN))).toBe(true);
  });

  it("5. ownerless legacy doc (non-string userId): refused_ownerless, caller's own list untouched, zero mutation", async () => {
    h.store.tokens.set(TOKEN, { userId: 123 as unknown as string });
    h.store.users.set(OWNER, { fcmTokens: [] });

    const res = await registerDeviceToken({ token: TOKEN, uid: OWNER });

    expect(res.outcome).toBe("refused_ownerless");
    expect(h.store.tokens.get(TOKEN)!.userId).toBe(123);
    expect(h.store.users.get(OWNER)!.fcmTokens).toEqual([]); // caller's own doc also untouched
    expect(h.store.userOps).toEqual([]);
    expect(h.store.txSetOps).toEqual([]);
  });

  it("6. owner re-register: idempotent refresh — metadata stamped, ownership NOT flipped, stale holder pruned", async () => {
    h.store.tokens.set(TOKEN, {
      token: TOKEN,
      userId: OWNER,
      platform: "android",
      appVersion: "1.0.0",
    });
    h.store.users.set(OWNER, { fcmTokens: [TOKEN, TOKEN_SHORT] });
    // Legacy damage from the pre-fix rebind bug: another account still lists
    // the token; the refresh prune removes it so the owner reclaims alone.
    h.store.users.set(ATTACKER, { fcmTokens: [TOKEN] });

    const res = await registerDeviceToken({
      token: TOKEN,
      uid: OWNER,
      platform: "web",
      appVersion: "2.0.0",
    });

    expect(res).toEqual({ success: true, outcome: "refreshed", prunedStaleHolders: 1 });
    expect(txSetsFor("device_tokens")[0]).toEqual({
      token: TOKEN,
      userId: OWNER,
      platform: "web",
      appVersion: "2.0.0",
      updatedAt: "SERVER_TS",
    });
    expect(h.store.users.get(OWNER)!.fcmTokens).toEqual([TOKEN, TOKEN_SHORT]); // own list preserved, union idempotent
    expect(h.store.users.get(ATTACKER)!.fcmTokens).toEqual([]);
    expect(h.store.userOps).toEqual([`users/${ATTACKER}`]); // owner's own doc not scrubbed
  });

  it("7. prune is bounded at 20 holders and warns about the truncation", async () => {
    h.store.tokens.set(TOKEN, { token: TOKEN, userId: OWNER });
    for (let i = 0; i < 25; i++) h.store.users.set(`holder_${i}`, { fcmTokens: [TOKEN] });
    h.store.users.set(OWNER, { fcmTokens: [TOKEN] });
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) =>
      warns.push(a.map(String).join(" "))
    );

    const res = await registerDeviceToken({ token: TOKEN, uid: OWNER, platform: "ios" });

    expect(res.success).toBe(true);
    expect(res.outcome).toBe("refreshed");
    // Firestore returns array-contains hits in unspecified order, so a page
    // of 20 may include the caller (→ 19 pruned) or not (→ 20). Ordering is
    // not contract — the cap and the warn are (DS review finding).
    expect(res.prunedStaleHolders).toBeGreaterThanOrEqual(19);
    expect(res.prunedStaleHolders).toBeLessThanOrEqual(20);
    expect(warns.some((w) => w.includes("cap"))).toBe(true);
    // At least 5 holder profiles remain past the cap, and the OWNER's list is
    // always excluded from the prune.
    const remaining = [...h.store.users.entries()].filter(([, u]) => u.fcmTokens.includes(TOKEN));
    expect(remaining.length).toBeGreaterThanOrEqual(5);
    expect(h.store.users.get(OWNER)!.fcmTokens).toContain(TOKEN);
  });

  it("8. prune query failure: registration still succeeds (warn, count 0)", async () => {
    h.store.tokens.set(TOKEN, { token: TOKEN, userId: OWNER });
    h.store.users.set(OWNER, { fcmTokens: [TOKEN] });
    h.store.queryFailCode = "TRANSIENT";
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) =>
      warns.push(a.map(String).join(" "))
    );

    const res = await registerDeviceToken({ token: TOKEN, uid: OWNER, platform: "ios" });

    expect(res).toEqual({ success: true, outcome: "refreshed", prunedStaleHolders: 0 });
    expect(h.store.tokens.get(TOKEN)!.platform).toBe("ios");
    expect(warns.some((w) => w.includes("holders query failed"))).toBe(true);
  });

  it("9. per-holder scrub failure: warns, keeps counting the successes, registration succeeds", async () => {
    h.store.tokens.set(TOKEN, { token: TOKEN, userId: OWNER });
    h.store.users.set(OWNER, { fcmTokens: [TOKEN] });
    h.store.users.set("holder_a", { fcmTokens: [TOKEN] });
    h.store.users.set("holder_b", { fcmTokens: [TOKEN] });
    h.store.scrubFailIds = ["holder_a"];

    const res = await registerDeviceToken({ token: TOKEN, uid: OWNER, platform: "ios" });

    expect(res).toEqual({ success: true, outcome: "refreshed", prunedStaleHolders: 1 });
    expect(h.store.users.get("holder_b")!.fcmTokens).toEqual([]);
    expect(h.store.users.get("holder_a")!.fcmTokens).toContain(TOKEN);
  });

  it("10. foreign doc observed at read time (post-race) refuses with ZERO mutation — full read/commit interleaving is emulator-only coverage", async () => {
    h.store.tokens.set(TOKEN, { token: TOKEN, userId: OWNER, platform: "android" });
    h.store.users.set(OWNER, { fcmTokens: [TOKEN] });
    h.store.concurrencyHook = () => {
      // Simulates a concurrent register by ATTACKER that committed before this
      // transaction's snapshot was taken. The fake has no snapshot isolation,
      // so this models "the doc was already foreign at read time" (DS review
      // reclassified this case); a true abort-and-retry is covered by real
      // Firestore transaction semantics, not by this fake.
      h.store.tokens.set(TOKEN, {
        token: TOKEN,
        userId: ATTACKER,
        platform: "android",
        appVersion: null,
      });
    };

    const res = await registerDeviceToken({ token: TOKEN, uid: OWNER, platform: "ios" });

    expect(res).toEqual({ success: false, outcome: "refused_foreign", prunedStaleHolders: 0 });
    expect(h.store.tokens.get(TOKEN)!.userId).toBe(ATTACKER); // winner of the race kept
    expect(h.store.txSetOps).toEqual([]); // THIS caller mutated nothing
    expect(h.store.users.get(OWNER)!.fcmTokens).toEqual([TOKEN]); // own list untouched
    expect(h.store.queries).toEqual([]);
  });

  it("11. transaction infra failure: rethrows, nothing partially committed", async () => {
    h.store.failRunTransaction = true;
    h.store.tokens.set(TOKEN, { token: TOKEN, userId: OWNER });

    await expect(
      registerDeviceToken({ token: TOKEN, uid: OWNER, platform: "ios" })
    ).rejects.toThrow("FIRESTORE_UNAVAILABLE");
    expect(h.store.tokens.get(TOKEN)!.platform).toBeUndefined(); // no partial claim
  });

  it("12. missing uid: throws (route 401s first; depth defense here)", async () => {
    await expect(
      registerDeviceToken({ token: TOKEN, uid: undefined as unknown as string })
    ).rejects.toThrow(/uid/);
    expect(h.store.txSetOps).toEqual([]);
  });

  it("13. second token of the same owner claims independently — and never scans other lists", async () => {
    h.store.tokens.set(TOKEN, { token: TOKEN, userId: OWNER, platform: "android" });
    h.store.users.set(OWNER, { fcmTokens: [TOKEN] });

    const res = await registerDeviceToken({
      token: TOKEN_SHORT,
      uid: OWNER,
      platform: "android",
    });

    expect(res).toEqual({ success: true, outcome: "claimed", prunedStaleHolders: 0 });
    expect(txSetPathsFor("device_tokens")).toEqual([`device_tokens/${TOKEN_SHORT}`]);
    expect(h.store.users.get(OWNER)!.fcmTokens).toEqual([TOKEN, TOKEN_SHORT]);
    expect(h.store.queries).toEqual([]); // claim path: no prune scan
  });

  it("14. fresh claim with legacy residue in OTHER accounts' lists: residue is NOT purged (proven-ownership-only prune)", async () => {
    // Pre-seed legacy damage: the token was never registered in
    // device_tokens but strange accounts still list it in their fan-out.
    h.store.users.set(OWNER, { fcmTokens: [TOKEN] });
    h.store.users.set("legacy_holder", { fcmTokens: [TOKEN] });

    const res = await registerDeviceToken({ token: TOKEN, uid: OWNER, platform: "web" });

    expect(res).toEqual({ success: true, outcome: "claimed", prunedStaleHolders: 0 });
    // The caller's list keeps the token; the OTHER list is untouched — a
    // self-granted claim may not strip another account's push channel.
    expect(h.store.users.get("legacy_holder")!.fcmTokens).toEqual([TOKEN]);
    expect(h.store.queries).toEqual([]);
    expect(h.store.userOps).toEqual([]);
  });

  describe("httpResponseFor wire contract", () => {
    it("15. success paths: 200 with EXACT body {success:true} (no prunedStaleHolders oracle)", async () => {
      for (const outcome of ["claimed", "refreshed"] as const) {
        // prunedStaleHolders must never reach the wire even when non-zero.
        const http = httpResponseFor({ success: true, outcome, prunedStaleHolders: 17 });
        expect(http.status).toBe(200);
        expect(http.body).toEqual({ success: true });
      }
    });

    it("16. refusals: 409 with ONE generic body for both outcomes (no live-vs-legacy state oracle)", async () => {
      const foreign = httpResponseFor({ success: false, outcome: "refused_foreign", prunedStaleHolders: 0 });
      const ownerless = httpResponseFor({ success: false, outcome: "refused_ownerless", prunedStaleHolders: 0 });
      for (const http of [foreign, ownerless]) {
        expect(http.status).toBe(409);
        expect(http.body).toEqual({ error: "device token cannot be registered by this account" });
      }
    });
  });
});
