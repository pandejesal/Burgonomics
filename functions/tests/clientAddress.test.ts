import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { resolveClientAddress } from "../src/core/clientAddress";

describe("rate-limit client identity behind Cloud Run (OPS-H)", () => {
  it("separates two clients by the RIGHTMOST forwarded address", () => {
    const a = resolveClientAddress("198.51.100.7, 203.0.113.5", "10.0.0.1");
    const b = resolveClientAddress("198.51.100.7, 203.0.113.6", "10.0.0.1");
    expect(a).toBe("203.0.113.5");
    expect(b).toBe("203.0.113.6");
    expect(a).not.toBe(b);
  });

  it("ignores a client-spoofed LEFTmost entry", () => {
    const spoofed = resolveClientAddress("9.9.9.9, 203.0.113.5", "10.0.0.1");
    const honest = resolveClientAddress("203.0.113.5", "10.0.0.1");
    expect(spoofed).toBe(honest);
    expect(spoofed).toBe("203.0.113.5");
  });

  it("falls back to the socket address when no forwarded header exists", () => {
    expect(resolveClientAddress(undefined, "192.0.2.10")).toBe("192.0.2.10");
    expect(resolveClientAddress("", "192.0.2.10")).toBe("192.0.2.10");
  });

  it("handles the header arriving as an array", () => {
    expect(resolveClientAddress(["198.51.100.7", "203.0.113.5"], "10.0.0.1")).toBe(
      "203.0.113.5"
    );
  });

  it("wires one trusted hop and silences the Forwarded-header warning", () => {
    const candidates = [
      path.resolve(process.cwd(), "src/index.ts"),
      path.resolve(process.cwd(), "../src/index.ts"),
    ];
    const file = candidates.find((c) => fs.existsSync(c));
    expect(file).toBeTruthy();
    const source = fs.readFileSync(file as string, "utf8");
    expect(source).toContain('app.set("trust proxy", 1)');
    expect(source).not.toContain('app.set("trust proxy", true)');
    expect(source).toContain("forwardedHeader: false");
  });
});
