import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Regression: the ops reconciliation query filters `payment_discrepancies` by
//   where("status","==","needs_review")
//   where("createdAt",">=",Date)  where("createdAt","<=",Date)
// partner/src/admin/dashboard/services/dashboardService.ts:797-803
// An equality plus a RANGE on a DIFFERENT field needs a composite index. The
// manifest carried no `payment_discrepancies` entry at all, so the query raised
// FAILED_PRECONDITION on every call and the page's catch downgraded it to
// "unavailable" - permanently, even with rows waiting for review.
//
// This suite is a manifest contract test: it fails if the index disappears,
// if it is declared for the wrong collection scope, or if the field order stops
// matching what Firestore requires (equality first, then the range field).

const manifestPath = resolve(__dirname, "../../firestore.indexes.json");

interface IndexField {
  fieldPath: string;
  order: string;
}
interface IndexDef {
  collectionGroup: string;
  queryScope: string;
  fields: IndexField[];
}

const loadManifest = (): { indexes: IndexDef[] } =>
  JSON.parse(readFileSync(manifestPath, "utf8"));

describe("firestore.indexes.json - payment_discrepancies reconciliation query", () => {
  it("declares a composite for (status, createdAt) that serves the ops query", () => {
    const { indexes } = loadManifest();
    const candidates = indexes.filter(
      (idx) => idx.collectionGroup === "payment_discrepancies"
    );
    expect(candidates.length).toBeGreaterThan(0);

    const serving = candidates.find(
      (idx) =>
        idx.queryScope === "COLLECTION" &&
        idx.fields.length === 2 &&
        idx.fields[0].fieldPath === "status" &&
        // Equality filter first - Firestore requires this ordering for a
        // subsequent range on a different field.
        idx.fields[1].fieldPath === "createdAt"
    );
    expect(serving).toBeDefined();
    // The range is `>=` and `<=` in one query: ASCENDING covers both bounds.
    expect(serving!.fields[1].order).toBe("ASCENDING");
    // Neither field is a map/array: both are plain scalars on the writer side.
    expect(serving!.fields.every((f) => f.order === "ASCENDING")).toBe(true);
  });

  it("uses the COLLECTION scope the client actually queries", () => {
    // dashboardService reads the ROOT collection (`collection(db, ...)`), not a
    // collection group. A COLLECTION_GROUP index would not serve it.
    const { indexes } = loadManifest();
    const scopes = indexes
      .filter((idx) => idx.collectionGroup === "payment_discrepancies")
      .map((idx) => idx.queryScope);
    expect(scopes).toContain("COLLECTION");
  });

  it("every index entry names a real collection and at least one field", () => {
    // Cheap structural sanity across the whole manifest: a malformed entry is
    // silently ignored by the deploy and looks identical to a missing index.
    const { indexes } = loadManifest();
    for (const idx of indexes) {
      expect(typeof idx.collectionGroup).toBe("string");
      expect(idx.collectionGroup.length).toBeGreaterThan(0);
      expect(["COLLECTION", "COLLECTION_GROUP"]).toContain(idx.queryScope);
      expect(Array.isArray(idx.fields)).toBe(true);
      expect(idx.fields.length).toBeGreaterThan(0);
      for (const field of idx.fields) {
        expect(typeof field.fieldPath).toBe("string");
        expect(field.fieldPath.length).toBeGreaterThan(0);
        expect(["ASCENDING", "DESCENDING", "ARRAY_CONTAINS"]).toContain(field.order);
      }
    }
  });

  it("keeps the manifest parseable with an empty field override list", () => {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(Array.isArray(raw.fieldOverrides)).toBe(true);
  });
});
