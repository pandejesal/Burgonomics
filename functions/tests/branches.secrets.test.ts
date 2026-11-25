import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * SEC-11 (A3 finding 1): a branch's POS/payment identifiers live in the
 * brand-only `branch_secrets/{branchId}`, not on the document every operator
 * role can read.
 *
 * Covered here, through the real module:
 *  - canonical read wins over the legacy copy still on `branches`;
 *  - legacy fallback keeps an unmigrated outlet working (KOT, cancel, sync);
 *  - a missing secret is an empty answer, never a guess (callers fail closed);
 *  - the reverse restID lookup finds migrated AND legacy outlets;
 *  - the mirror/strip helper moves the fields and drops the retired
 *    `razorpayAccountId` instead of copying it.
 */
const { store, writes, db } = vi.hoisted(() => {
  const store = new Map<string, any>();
  const writes: Array<{ path: string; data: any }> = [];

  const docRef = (path: string) => ({
    path,
    id: path.split("/").pop(),
    get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
    set: async (data: any, options?: any) => {
      writes.push({ path, data });
      const next = options?.merge && store.get(path) ? { ...store.get(path) } : {};
      for (const [k, v] of Object.entries(data)) {
        if (v === "DELETE") delete next[k];
        else next[k] = v;
      }
      store.set(path, next);
    },
    update: async (data: any) => {
      writes.push({ path, data });
      const next = { ...(store.get(path) || {}) };
      for (const [k, v] of Object.entries(data)) {
        if (v === "DELETE") delete next[k];
        else next[k] = v;
      }
      store.set(path, next);
    },
    delete: async () => {
      writes.push({ path, data: null });
      store.delete(path);
    },
  });

  const db: any = {
    collection: (name: string) => {
      const build = (filters: Array<[string, string, any]>): any => {
        const api: any = {
          doc: (id: string) => docRef(`${name}/${id}`),
          limit: () => api,
          orderBy: () => api,
          startAfter: () => api,
          where: (field: string, op: string, value: any) =>
            build([...filters, [field, op, value]]),
          get: async () => {
            const docs = [...store.keys()]
              .filter((p) => p.startsWith(`${name}/`) && !p.slice(name.length + 1).includes("/"))
              .filter((p) => filters.every(([f, , v]) => store.get(p)?.[f] === v))
              .map((p) => ({ ...docRef(p) }));
            return { docs, empty: docs.length === 0 };
          },
        };
        return api;
      };
      return build([]);
    },
  };
  return { store, writes, db };
});

vi.mock("../src/core/firebase", () => ({ db }));
vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "TS",
    delete: () => "DELETE",
  };
  const firestoreFn: any = vi.fn(() => db);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: { firestore: firestoreFn },
    firestore: firestoreFn,
    FieldValue,
  };
});

import {
  loadBranchSecrets,
  loadPetpoojaStoreId,
  findBranchIdByPetpoojaStoreId,
  extractBranchSecrets,
  branchSecretStripPatch,
  mirrorAndStripBranchSecrets,
  BRANCH_SECRET_FIELDS,
  BRANCH_SECRETS,
} from "../src/modules/branches/branchSecrets";

beforeEach(() => {
  store.clear();
  writes.length = 0;
});

describe("loadBranchSecrets", () => {
  it("prefers the canonical branch_secrets document", async () => {
    store.set("branch_secrets/b1", { petpoojaStoreId: "pp_new", restIDs: ["pp_new"] });
    store.set("branches/b1", { petpoojaStoreId: "pp_legacy" });
    const secrets = await loadBranchSecrets("b1");
    expect(secrets.petpoojaStoreId).toBe("pp_new");
    expect(secrets.source).toBe("branch_secrets");
  });

  it("falls back to the legacy branch copy so an unmigrated outlet still prints KOTs", async () => {
    store.set("branches/b1", {
      petpoojaStoreId: "pp_legacy",
      petpooja: { appKey: "k", accessToken: "t" },
      razorpayAccountId: "acc_legacy_1",
    });
    const secrets = await loadBranchSecrets("b1");
    expect(secrets.petpoojaStoreId).toBe("pp_legacy");
    expect(secrets.petpooja).toEqual({ appKey: "k", accessToken: "t" });
    expect(secrets.source).toBe("branches_legacy");
  });

  it("returns an empty answer (never a guess) when neither document has a binding", async () => {
    store.set("branches/b1", { name: "Surat" });
    expect(await loadBranchSecrets("b1")).toEqual({
      petpoojaStoreId: "",
      petpooja: null,
      restIDs: null,
      source: "none",
    });
    expect(await loadPetpoojaStoreId("b_missing")).toBe("");
  });

  it("does not treat a half-written canonical doc as an unlinked outlet", async () => {
    store.set("branch_secrets/b1", { restIDs: ["pp_1"] });
    store.set("branches/b1", { petpoojaStoreId: "pp_1" });
    expect((await loadBranchSecrets("b1")).petpoojaStoreId).toBe("pp_1");
  });
});

describe("findBranchIdByPetpoojaStoreId", () => {
  it("resolves a migrated outlet from branch_secrets", async () => {
    store.set("branch_secrets/b_migrated", { petpoojaStoreId: "pp_migrated" });
    expect(await findBranchIdByPetpoojaStoreId("pp_migrated")).toBe("b_migrated");
  });

  it("resolves a legacy outlet from the branch document", async () => {
    store.set("branches/b_legacy", { petpoojaStoreId: "pp_legacy" });
    expect(await findBranchIdByPetpoojaStoreId("pp_legacy")).toBe("b_legacy");
  });

  it("returns null for an unknown outlet", async () => {
    store.set("branches/b1", { petpoojaStoreId: "pp_1" });
    expect(await findBranchIdByPetpoojaStoreId("pp_unknown")).toBeNull();
    expect(await findBranchIdByPetpoojaStoreId("")).toBeNull();
  });
});

describe("mirror and strip", () => {
  it("names every key a branch document must never carry", () => {
    expect([...BRANCH_SECRET_FIELDS]).toEqual([
      "petpooja",
      "petpoojaStoreId",
      "restIDs",
      "razorpayAccountId",
    ]);
  });

  it("moves the POS fields and DROPS the retired Route account id", async () => {
    const after = {
      name: "Surat",
      petpoojaStoreId: "pp_1",
      petpooja: { appKey: "k" },
      restIDs: ["pp_1"],
      razorpayAccountId: "acc_retired_1",
    };
    const result = await mirrorAndStripBranchSecrets("b1", null, after);
    expect(result.mirrored.sort()).toEqual(["petpooja", "petpoojaStoreId", "restIDs"]);
    const secret = store.get(`${BRANCH_SECRETS}/b1`);
    expect(secret.petpoojaStoreId).toBe("pp_1");
    expect(secret.petpooja).toEqual({ appKey: "k" });
    // Retired with Route: it must not be carried over, and never re-planted.
    expect(secret.razorpayAccountId).toBeUndefined();
    expect(store.get("branches/b1").razorpayAccountId).toBeUndefined();
  });

  it("strips the secrets from the branch document and keeps the discovery fields", async () => {
    store.set("branches/b1", { name: "Surat", city: "Surat", petpoojaStoreId: "pp_1" });
    await mirrorAndStripBranchSecrets("b1", null, store.get("branches/b1"));
    const branch = store.get("branches/b1");
    expect(branch.petpoojaStoreId).toBeUndefined();
    expect(branch.name).toBe("Surat");
    expect(branch.city).toBe("Surat");
  });

  it("is a no-op on a clean branch document (the trigger settles in one pass)", async () => {
    store.set("branches/b1", { name: "Surat" });
    const result = await mirrorAndStripBranchSecrets("b1", null, store.get("branches/b1"));
    expect(result).toEqual({ mirrored: [], stripped: [] });
    expect(writes).toHaveLength(0);
  });

  it("retires the secrets document when the branch is deleted", async () => {
    store.set("branch_secrets/b1", { petpoojaStoreId: "pp_1" });
    await mirrorAndStripBranchSecrets("b1", { name: "Surat" }, null);
    expect(store.has("branch_secrets/b1")).toBe(false);
  });
});

describe("extract / strip helpers", () => {
  it("extract takes only the moved keys", () => {
    expect(
      extractBranchSecrets({ name: "x", petpoojaStoreId: "pp", restIDs: ["a"], petpooja: {}, razorpayAccountId: "acc_1" })
    ).toEqual({ petpoojaStoreId: "pp", restIDs: ["a"], petpooja: {} });
  });

  it("strip covers every secret key that is present, including the retired one", () => {
    const patch = branchSecretStripPatch({
      name: "x",
      petpooja: {},
      petpoojaStoreId: "pp",
      restIDs: [],
      razorpayAccountId: "acc_1",
    });
    expect(Object.keys(patch).sort()).toEqual([
      "petpooja",
      "petpoojaStoreId",
      "razorpayAccountId",
      "restIDs",
    ]);
    expect(patch.name).toBeUndefined();
  });
});
