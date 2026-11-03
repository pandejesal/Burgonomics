import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rules = readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8");
const functionBody = (name: string) => rules.split(`function ${name}()`)[1]?.split("\n    }")[0] ?? "";

describe("delivery OTP metadata is server only (canonical source contract)", () => {
  it.each(["deliveryOtpVersion", "deliveryOtpConsumedAt"])("protects %s at create and update", (field) => {
    expect(functionBody("orderCreateForbiddenKeys")).toContain(`'${field}'`);
    expect(functionBody("orderCreateAllowedKeys")).not.toContain(`'${field}'`);
    expect(functionBody("orderServerOwnedKeys")).toContain(`'${field}'`);
  });

  it("retains both brand and branch update guards", () => {
    expect(rules.match(/affectedKeys\(\)\.hasAny\(orderServerOwnedKeys\(\)\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
