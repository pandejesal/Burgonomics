import { describe, it, expect } from "vitest";
import {
  APP_ALLOWED_ORIGINS,
  corsOriginError,
  isCorsOriginAllowed,
} from "../src/core/cors";

describe("CORS origin policy (OPS-01)", () => {
  const prod = "production";

  it.each([
    "https://localhost",
    "https://burgonomics-7faa8.web.app",
    "https://burgonomics-7faa8.firebaseapp.com",
    "https://burgonomics-partner.web.app",
    "https://burgonomics-partner.firebaseapp.com",
    "capacitor://localhost",
    "https://burgonomics.com",
    "https://partner.burgonomics.com",
    "https://burgonomics.netlify.app",
  ])("allows %s", (origin) => {
    expect(isCorsOriginAllowed(origin, prod)).toBe(true);
    expect(corsOriginError(origin, prod)).toBeNull();
  });

  it("allows a request with no Origin header", () => {
    expect(isCorsOriginAllowed(undefined, prod)).toBe(true);
    expect(corsOriginError(undefined, prod)).toBeNull();
  });

  it("rejects an unknown origin with a 403 error", () => {
    const err = corsOriginError("https://evil.example", prod);
    expect(err).not.toBeNull();
    expect(err?.status).toBe(403);
    expect(err?.statusCode).toBe(403);
  });

  it("rejects a look-alike origin instead of suffix-matching localhost", () => {
    expect(isCorsOriginAllowed("https://localhost.evil.example", prod)).toBe(false);
    expect(corsOriginError("https://localhost.evil.example", prod)?.status).toBe(403);
  });

  it("keeps every existing production entry and adds no wildcard/http localhost", () => {
    expect(APP_ALLOWED_ORIGINS).toEqual(
      expect.arrayContaining([
        "https://burgonomics.com",
        "https://partner.burgonomics.com",
        "https://burgonomics.netlify.app",
        "capacitor://localhost",
      ])
    );
    expect(APP_ALLOWED_ORIGINS).not.toContain("*");
    expect(APP_ALLOWED_ORIGINS.some((o) => o.startsWith("http://"))).toBe(false);
    expect(isCorsOriginAllowed("http://localhost", prod)).toBe(false);
  });

  it("keeps plain-http dev origins out of production and available elsewhere", () => {
    expect(isCorsOriginAllowed("http://localhost:5173", prod)).toBe(false);
    expect(isCorsOriginAllowed("http://localhost:5173", "development")).toBe(true);
  });
});
