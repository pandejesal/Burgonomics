import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Firestore required composite indexes", () => {
  it("includes support_tickets (customerId ASC, createdAt DESC) composite index for assertTicketSpamGuards", () => {
    const indexPath = path.resolve(__dirname, "../../firestore.indexes.json");
    expect(fs.existsSync(indexPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const indexes: any[] = content.indexes || [];

    const found = indexes.some(
      (idx) =>
        idx.collectionGroup === "support_tickets" &&
        idx.queryScope === "COLLECTION" &&
        Array.isArray(idx.fields) &&
        idx.fields.length === 2 &&
        idx.fields[0].fieldPath === "customerId" &&
        idx.fields[0].order === "ASCENDING" &&
        idx.fields[1].fieldPath === "createdAt" &&
        idx.fields[1].order === "DESCENDING"
    );

    expect(found).toBe(true);
  });
});
