import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SEC-11 migration (A3 finding 1): the one-off, staging-only move of the
 * branch POS/payment identifiers into the brand-only `branch_secrets`.
 *
 * These tests pin the three things a reviewer must be able to trust:
 *  - PLAN never writes (it must be safe to run against staging first);
 *  - APPLY moves the three POS fields and DROPS the retired Route account id,
 *    writing a receipt that carries the removed VALUES;
 *  - ROLLBACK restores exactly what the receipt recorded.
 */
const { savedDocs, deleteSentinel, writes, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const writes: Array<{ path: string; data: any }> = [];
  const deleteSentinel = "FIELD_DELETED";

  const FieldValue = {
    serverTimestamp: () => "TS",
    delete: () => deleteSentinel,
  };

  const docRef = (col: string, id: string): any => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({ exists: path in savedDocs, data: () => savedDocs[path] }),
      set: async (data: any, opts?: any) => {
        writes.push({ path, data });
        const base = opts?.merge && savedDocs[path] ? { ...savedDocs[path] } : {};
        for (const [k, v] of Object.entries(data || {})) {
          if (v === deleteSentinel) delete base[k];
          else base[k] = v;
        }
        savedDocs[path] = base;
      },
      update: async (data: any) => {
        writes.push({ path, data });
        const base = { ...(savedDocs[path] || {}) };
        for (const [k, v] of Object.entries(data || {})) {
          if (v === deleteSentinel) delete base[k];
          else base[k] = v;
        }
        savedDocs[path] = base;
      },
    };
  };

  const collection = (col: string): any => {
    const build = (): any => ({
      doc: (id: string) => docRef(col, id),
      orderBy: () => build(),
      startAfter: () => build(),
      limit: () => build(),
      get: async () => ({
        docs: Object.keys(savedDocs)
          .filter((p) => p.startsWith(`${col}/`) && !p.slice(col.length + 1).includes("/"))
          .map((p) => ({ id: p.slice(col.length + 1), data: () => savedDocs[p], ref: docRef(col, p.slice(col.length + 1)) })),
      }),
    });
    return build();
  };

  const mockDb: any = { collection };
  return { savedDocs, deleteSentinel, writes, mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = { serverTimestamp: () => "TS", delete: () => deleteSentinel };
  const FieldPath = { documentId: () => "__name__" };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.FieldPath = FieldPath;
  return {
    default: { firestore: firestoreFn, FieldValue, FieldPath },
    firestore: firestoreFn,
    FieldValue,
    FieldPath,
  };
});

// The mirror trigger's module reads `db` from here; point it at the same fake so
// the rollback test can run the REAL trigger logic against the REAL rollback.
vi.mock("../src/core/firebase", () => ({
  db: mockDb,
  auth: { revokeRefreshTokens: vi.fn(async () => {}) },
  messaging: { send: vi.fn(async () => "m") },
}));

import {
  planBranchMigration,
  planBranchSecretsMigration,
  applyBranchSecretsMigration,
  rollbackBranchSecretsMigration,
} from "../../scripts/backfill/branchSecretsMigration";
import { mirrorAndStripBranchSecrets } from "../src/modules/branches/branchSecrets";

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  writes.length = 0;
});

function seedBranching(): void {
  savedDocs["branches/b_linked"] = {
    name: "Surat Adajan",
    city: "Surat",
    petpoojaStoreId: "PP_SURAT_01",
    petpooja: { appKey: "k", appSecret: "s", accessToken: "t" },
    restIDs: ["PP_SURAT_01"],
    razorpayAccountId: "acc_retired_1",
  };
  savedDocs["branches/b_unlinked"] = { name: "Vadodara", city: "Vadodara" };
  savedDocs["branches/b_empty_binding"] = { name: "Nadiad", petpoojaStoreId: "" };
}

describe("planBranchMigration (pure)", () => {
  beforeEach(seedBranching);

  it("moves the three POS fields and drops the retired Route account id", () => {
    const plan = planBranchMigration("b_linked", savedDocs["branches/b_linked"]);
    expect(plan.action).toBe("move");
    expect(plan.secret).toEqual({
      branchId: "b_linked",
      petpoojaStoreId: "PP_SURAT_01",
      petpooja: { appKey: "k", appSecret: "s", accessToken: "t" },
      restIDs: ["PP_SURAT_01"],
    });
    expect(plan.secret.razorpayAccountId).toBeUndefined();
    expect(plan.removedFields.sort()).toEqual([
      "petpooja",
      "petpoojaStoreId",
      "razorpayAccountId",
      "restIDs",
    ]);
    expect(plan.droppedFields).toEqual(["razorpayAccountId"]);
  });

  it("skips a branch that carries none of the keys", () => {
    const plan = planBranchMigration("b_unlinked", savedDocs["branches/b_unlinked"]);
    expect(plan).toMatchObject({ action: "skip", removedFields: [], droppedFields: [] });
  });

  it("still drops the retired key when it is the only thing present", () => {
    const plan = planBranchMigration("b_route_only", { name: "x", razorpayAccountId: "acc_1" });
    expect(plan.action).toBe("move");
    expect(plan.secret).toEqual({});
    expect(plan.removedFields).toEqual(["razorpayAccountId"]);
  });
});

describe("PLAN mode is read-only", () => {
  it("reports what would change and writes nothing", async () => {
    seedBranching();
    const result = await planBranchSecretsMigration(mockDb);
    expect(result.mode).toBe("plan");
    expect(result.scanned).toBe(3);
    expect(result.planned).toBe(2);
    expect(result.written).toBe(0);
    expect(writes).toHaveLength(0);
    expect(savedDocs["branch_secrets/b_linked"]).toBeUndefined();
    expect(savedDocs["branches/b_linked"].petpoojaStoreId).toBe("PP_SURAT_01");
  });
});

describe("APPLY mode", () => {
  it("writes the secret, strips the branch and records the removed VALUES", async () => {
    seedBranching();
    const planned = await planBranchSecretsMigration(mockDb);
    const applied = await applyBranchSecretsMigration(mockDb, planned.entries);
    expect(applied.written).toBe(2);

    const secret = savedDocs["branch_secrets/b_linked"];
    expect(secret.petpoojaStoreId).toBe("PP_SURAT_01");
    expect(secret.razorpayAccountId).toBeUndefined();

    const branch = savedDocs["branches/b_linked"];
    expect(branch.petpoojaStoreId).toBeUndefined();
    expect(branch.petpooja).toBeUndefined();
    expect(branch.restIDs).toBeUndefined();
    expect(branch.razorpayAccountId).toBeUndefined();
    expect(branch.name).toBe("Surat Adajan");
    expect(branch.city).toBe("Surat");

    const receipt = applied.receipt.find((r) => r.branchId === "b_linked")!;
    expect(receipt.removed.petpoojaStoreId).toBe("PP_SURAT_01");
    expect(receipt.removed.razorpayAccountId).toBe("acc_retired_1");
  });

  it("is idempotent: a second plan finds nothing left to move", async () => {
    seedBranching();
    const first = await planBranchSecretsMigration(mockDb);
    await applyBranchSecretsMigration(mockDb, first.entries);
    const second = await planBranchSecretsMigration(mockDb);
    expect(second.planned).toBe(0);
  });
});

describe("ROLLBACK mode", () => {
  /**
   * Runs the REAL mirror trigger (`onBranchWrittenSecretsMirror` ->
   * `mirrorAndStripBranchSecrets`) the way the platform would after a write to
   * `branches/{id}`: it sees the document as it now stands and does its
   * mirror+strip. Used to prove the rollback survives the safety net.
   */
  async function fireBranchWriteTrigger(branchId: string) {
    const current = savedDocs[`branches/${branchId}`];
    return mirrorAndStripBranchSecrets(branchId, null, current ? { ...current } : null);
  }

  it("restores the receipt values into branch_secrets and leaves the branch stripped", async () => {
    seedBranching();
    const planned = await planBranchSecretsMigration(mockDb);
    const applied = await applyBranchSecretsMigration(mockDb, planned.entries);

    // Between APPLY and the rollback the outlet rotated its token in the
    // canonical doc — the state a rollback has to reason about, because the
    // receipt's values are the OLD ones.
    savedDocs["branch_secrets/b_linked"] = {
      ...savedDocs["branch_secrets/b_linked"],
      petpooja: { appKey: "k", appSecret: "s", accessToken: "ROTATED" },
    };

    const reverted = await rollbackBranchSecretsMigration(mockDb, applied);
    expect(reverted).toBe(2);

    // The moved fields are back where the backend reads them, exactly as the
    // receipt recorded them.
    const secret = savedDocs["branch_secrets/b_linked"];
    expect(secret.petpoojaStoreId).toBe("PP_SURAT_01");
    expect(secret.restIDs).toEqual(["PP_SURAT_01"]);
    expect(secret.petpooja).toEqual({ appKey: "k", appSecret: "s", accessToken: "t" });

    // ...and the world-readable branch document stays stripped. This is the
    // whole point of SEC-11: no identifier may reappear under `isStaff()`.
    const branch = savedDocs["branches/b_linked"];
    for (const key of ["petpooja", "petpoojaStoreId", "restIDs", "razorpayAccountId"]) {
      expect(branch[key]).toBeUndefined();
    }
    expect(branch.name).toBe("Surat Adajan");
  });

  it("never writes the secrets onto the branch document", async () => {
    seedBranching();
    const planned = await planBranchSecretsMigration(mockDb);
    const applied = await applyBranchSecretsMigration(mockDb, planned.entries);
    writes.length = 0;

    await rollbackBranchSecretsMigration(mockDb, applied);

    // Only `branch_secrets` writes: a `branches` write would hand the values to
    // the mirror trigger, which re-strips them — the rollback would report
    // success while exposing the identifiers for one hop and mutating the
    // canonical copy from a stale receipt.
    expect(writes.map((w) => w.path)).toEqual([
      "branch_secrets/b_linked",
      "branch_secrets/b_empty_binding",
    ]);
  });

  it("survives the mirror trigger firing after the rollback", async () => {
    seedBranching();
    const planned = await planBranchSecretsMigration(mockDb);
    const applied = await applyBranchSecretsMigration(mockDb, planned.entries);
    await rollbackBranchSecretsMigration(mockDb, applied);

    const result = await fireBranchWriteTrigger("b_linked");

    // Nothing to mirror (the branch carries no secret keys) and nothing to
    // strip, so the restored canonical values are untouched.
    expect(result.mirrored).toEqual([]);
    expect(result.stripped).toEqual([]);
    expect(savedDocs["branch_secrets/b_linked"].petpooja).toEqual({
      appKey: "k",
      appSecret: "s",
      accessToken: "t",
    });
    expect(savedDocs["branches/b_linked"].petpoojaStoreId).toBeUndefined();
  });

  it("keeps the canonical doc as the single source after the trigger pass", async () => {
    seedBranching();
    const planned = await planBranchSecretsMigration(mockDb);
    const applied = await applyBranchSecretsMigration(mockDb, planned.entries);
    await rollbackBranchSecretsMigration(mockDb, applied);

    // A second rollback (a re-run after a partial failure) is idempotent and
    // still leaves the branch clean.
    const again = await rollbackBranchSecretsMigration(mockDb, applied);
    expect(again).toBe(2);
    await fireBranchWriteTrigger("b_linked");
    expect(savedDocs["branch_secrets/b_linked"].petpoojaStoreId).toBe("PP_SURAT_01");
    expect(savedDocs["branches/b_linked"].petpoojaStoreId).toBeUndefined();
  });
});
