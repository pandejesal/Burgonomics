import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rules = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");
const functionBody = (name: string) =>
  rules.split(`function ${name}()`)[1]?.split("\n    }")[0] ?? "";

describe("courier COD fields are server-owned in Firestore rules (source contract)", () => {
  it("protects the order's cash due and readiness snapshot", () => {
    const body = functionBody("orderServerOwnedKeys");
    expect(body).toContain("'cashDuePaise'");
    expect(body).toContain("'cashOnDelivery'");
  });

  it("lets only brand owners or the server change branch courier readiness", () => {
    expect(rules).toContain("function courierCodSnapshot(data)");
    const branchUpdate = rules.split("match /branches/{branchId}")[1]?.split("allow delete")[0] ?? "";
    expect(branchUpdate).toContain(
      "courierCodSnapshot(request.resource.data) == courierCodSnapshot(resource.data)"
    );
  });
});
