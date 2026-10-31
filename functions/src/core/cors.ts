/**
 * CORS origin policy for the Cloud Functions API.
 *
 * Kept out of index.ts (which boots the Express app at import) so the origin
 * decision is unit-testable. Every entry is an EXACT origin — no wildcard, no
 * regex, no plain-http dev origin in production.
 */

/** Native shells (Capacitor) and the deployed web origins the apps use. */
export const APP_ALLOWED_ORIGINS: readonly string[] = [
  "https://burgonomics.com",
  "https://partner.burgonomics.com",
  "https://burgonomics.netlify.app",
  "capacitor://localhost",
  // Capacitor Android serves the bundled web app from https://localhost.
  "https://localhost",
  "https://burgonomics-7faa8.web.app",
  "https://burgonomics-7faa8.firebaseapp.com",
  "https://burgonomics-partner.web.app",
  "https://burgonomics-partner.firebaseapp.com",
];

/**
 * Plain-http dev origins must never be credentialed in production: auth is
 * Bearer-based (no cookies to steal), but there is no reason to widen the
 * surface. Preview deploys use an exact host, not a wildcard.
 */
export function devAllowedOrigins(nodeEnv: string | undefined): string[] {
  return nodeEnv === "production"
    ? []
    : ["http://localhost:8080", "http://localhost:5173", "http://localhost:3000"];
}

/** A missing Origin is a non-browser agent (mobile client, server call). */
export function isCorsOriginAllowed(
  origin: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV
): boolean {
  if (!origin) return true;
  if (APP_ALLOWED_ORIGINS.includes(origin)) return true;
  return devAllowedOrigins(nodeEnv).includes(origin);
}

/**
 * The Error handed to the `cors` callback for a rejected origin. `status` and
 * `statusCode` both carry 403 so Express answers 403, not the 500 a nameless
 * rejection used to produce.
 */
export function corsOriginError(
  origin: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV
): (Error & { status: number; statusCode: number }) | null {
  if (isCorsOriginAllowed(origin, nodeEnv)) return null;
  const err = new Error("CORS origin not allowed by Burgonomics security policy") as Error & {
    status: number;
    statusCode: number;
  };
  err.status = 403;
  err.statusCode = 403;
  return err;
}
