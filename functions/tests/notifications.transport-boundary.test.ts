/**
 * M1 transport boundary (contract §2): `messaging.send` and
 * `messaging.sendEachForMulticast` may only be called from fcmClient.ts.
 *
 * This is the enforcement mechanism the contract assumes in place of an
 * ESLint rule (functions/ has no lint config). It is a source test, not a
 * runtime mock: any new direct transport call fails the suite.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("FCM transport boundary", () => {
  it("no src file outside notifications/fcmClient.ts calls messaging.send*", () => {
    const files = walk(SRC_ROOT);
    const directCall = /messaging\.(send|sendEachForMulticast)\s*\(/;
    const offenders = files
      .filter((file) => path.basename(file) !== "fcmClient.ts")
      .filter((file) => directCall.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });

  it("fcmClient.ts is where the transport calls actually live", () => {
    const file = path.join(SRC_ROOT, "modules", "notifications", "fcmClient.ts");
    const source = fs.readFileSync(file, "utf8");
    expect(source).toMatch(/messaging\.send\s*\(/);
    expect(source).toMatch(/messaging\.sendEachForMulticast\s*\(/);
  });
});
