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

describe("hosting fonts + app-shell cache (OPS-J)", () => {
  const config = readFirebaseJson();

  /** Firebase Hosting glob subset used by this config ("**", "/x/**", exact). */
  function matchesSource(source: string, requestPath: string): boolean {
    if (source === "**") return true;
    if (source.endsWith("/**")) {
      return requestPath === source.slice(0, -3) || requestPath.startsWith(source.slice(0, -2));
    }
    return source === requestPath;
  }

  /** Last matching rule wins per header key (the ordering the config relies on). */
  function effectiveHeader(target: string, requestPath: string, key: string): string | null {
    const hosting = config.hosting.find((h: any) => h.target === target);
    expect(hosting, `hosting target ${target}`).toBeTruthy();
    let value: string | null = null;
    for (const rule of hosting.headers) {
      if (!matchesSource(rule.source, requestPath)) continue;
      const header = (rule.headers || []).find(
        (h: any) => String(h.key).toLowerCase() === key.toLowerCase()
      );
      if (header) value = header.value;
    }
    return value;
  }

  it("allows Google Fonts on burgonomics-app (stylesheet + font files)", () => {
    const csp = cspFor(config, "burgonomics-app");
    expect(cspDirective(csp, "style-src")).toBe(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"
    );
    expect(cspDirective(csp, "font-src")).toBe(
      "font-src 'self' data: https://fonts.gstatic.com"
    );
  });

  it("never caches the shell at / or on extensionless SPA routes", () => {
    for (const route of ["/", "/index.html", "/orders/ord_1/track", "/store/demo"]) {
      expect(effectiveHeader("burgonomics-app", route, "Cache-Control"), route).toBe("no-cache");
    }
  });

  it("keeps hashed assets immutable (the assets rule wins after the catch-all)", () => {
    expect(
      effectiveHeader("burgonomics-app", "/assets/index-a1b2c3.js", "Cache-Control")
    ).toBe("public, max-age=31536000, immutable");
  });

  it("keeps the .well-known JSON rules last and effective", () => {
    for (const file of ["/.well-known/apple-app-site-association", "/.well-known/assetlinks.json"]) {
      expect(effectiveHeader("burgonomics-app", file, "Content-Type"), file).toBe(
        "application/json"
      );
      expect(effectiveHeader("burgonomics-app", file, "Cache-Control"), file).toBe(
        "public, max-age=300"
      );
    }
  });

  it("leaves the partner hosting headers unchanged", () => {
    const partner = config.hosting.find((h: any) => h.target === "burgonomics-partner");
    const cacheRules = (partner.headers || [])
      .filter((r: any) =>
        (r.headers || []).some((h: any) => String(h.key).toLowerCase() === "cache-control")
      )
      .map((r: any) => [
        r.source,
        (r.headers as any[]).find((h: any) => String(h.key).toLowerCase() === "cache-control")!
          .value,
      ]);
    expect(cacheRules).toEqual([
      ["/assets/**", "public, max-age=31536000, immutable"],
      ["/index.html", "no-cache"],
      ["/.well-known/apple-app-site-association", "public, max-age=300"],
      ["/.well-known/assetlinks.json", "public, max-age=300"],
    ]);
  });

  it("adds no robots/noindex rule (staging headers would follow a production launch)", () => {
    const all = JSON.stringify(config.hosting);
    expect(all.toLowerCase()).not.toContain("x-robots-tag");
    expect(all.toLowerCase()).not.toContain("noindex");
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
