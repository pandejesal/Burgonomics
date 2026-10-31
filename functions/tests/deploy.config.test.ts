import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function readFirebaseJson(): any {
  const candidates = [
    path.resolve(process.cwd(), "../firebase.json"),
    path.resolve(process.cwd(), "firebase.json"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  throw new Error("firebase.json not found from the functions test cwd");
}

describe("functions deploy ignore list (OPS-F)", () => {
  it("keeps agent/dev artifacts out of the functions bundle", () => {
    const functions = readFirebaseJson().functions[0];
    expect(functions.ignore).toEqual(
      expect.arrayContaining([".opencode", ".swarm", ".github", "tests", "*.out", "AGENTS.md"])
    );
  });

  it("never ignores the runtime sources, build output, scripts or secrets", () => {
    const ignore: string[] = readFirebaseJson().functions[0].ignore;
    for (const forbidden of ["src", "dist", "lib", "scripts", "package.json", ".env"]) {
      expect(ignore).not.toContain(forbidden);
    }
  });
});
