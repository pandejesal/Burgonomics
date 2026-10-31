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

function cspFor(config: any, target: string): string {
  const hosting = config.hosting.find((h: any) => h.target === target);
  expect(hosting, `hosting target ${target}`).toBeTruthy();
  const allHeaders = hosting.headers.find((h: any) => h.source === "**")?.headers || [];
  const csp = allHeaders.find((h: any) => h.key === "Content-Security-Policy");
  expect(csp, `${target} CSP header`).toBeTruthy();
  return csp.value as string;
}

function cspDirective(csp: string, name: string): string {
  return (
    csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `)) || ""
  );
}

const PARTNER_CSP_UNCHANGED =
  "default-src 'self'; script-src 'self' https://checkout.razorpay.com https://*.razorpay.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.razorpay.com https://*.razorpay.com https://*.googleapis.com https://*.gstatic.com https://*.firebaseio.com wss://*.firebaseio.com https://*.cloudfunctions.net; frame-src https://checkout.razorpay.com https://*.razorpay.com https://api.razorpay.com; frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

describe("hosting CSP allows phone sign-in (OPS-I)", () => {
  const config = readFirebaseJson();

  it("allows reCAPTCHA and the geocoder on burgonomics-app only", () => {
    const csp = cspFor(config, "burgonomics-app");
    const script = cspDirective(csp, "script-src");
    for (const host of [
      "https://www.google.com",
      "https://www.gstatic.com",
      "https://apis.google.com",
    ]) {
      expect(script).toContain(host);
    }
    const frame = cspDirective(csp, "frame-src");
    expect(frame).toContain("https://www.google.com");
    expect(frame).toContain("https://*.firebaseapp.com");
    const connect = cspDirective(csp, "connect-src");
    expect(connect).toContain("https://www.google.com");
    expect(connect).toContain("https://nominatim.openstreetmap.org");
  });

  it("does not relax script-src with unsafe-inline or unsafe-eval", () => {
    const script = cspDirective(cspFor(config, "burgonomics-app"), "script-src");
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toContain("unsafe-eval");
    // No bare wildcard token was added (the pre-existing *.razorpay.com stays).
    expect(script.split(/\s+/)).not.toContain("*");
  });

  it("leaves the partner site CSP unchanged (email sign-in)", () => {
    expect(cspFor(config, "burgonomics-partner")).toBe(PARTNER_CSP_UNCHANGED);
  });
});

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
