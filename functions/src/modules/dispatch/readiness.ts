/**
 * Dispatch test-window readiness preflight.
 *
 * Round-3 decisions N1(a)/N2 with the controller's C06/C11/C13: the staging run
 * exists to produce REAL provider test-API evidence, but nothing in the platform
 * refuses a mock dispatch outside production (`assertLiveDispatchContext` is a
 * no-op when BURGONOMICS_ENV !== production), and a disabled/unkeyed provider can
 * still win the cheapest bid from a local rate card and divert the walk into a
 * manual lane.
 *
 * This preflight is the explicit gate for that window. It reports which providers
 * are eligible, which one is mocking, and which host each would call — and refuses
 * the run when any of those would yield fake evidence or a live-dispatch risk.
 *
 * It carries names, booleans and hostnames ONLY: no secret value is ever included
 * in the report or in the thrown message. It is opt-in via
 * `config.dispatch.requireLive` (DISPATCH_REQUIRE_LIVE=true), so dev and
 * production behaviour is unchanged.
 */
import { config } from "../../config/env";
import { borzoAdapter } from "./providers/borzo.adapter";
import { shadowfaxAdapter } from "./providers/shadowfax.adapter";
import { porterAdapter } from "./providers/porter.adapter";

/** Documented vendor hosts (env.ts comments + the Borzo Business API 1.8 doc). */
export const BORZO_TEST_HOST = "robotapitest-in.borzodelivery.com";
export const BORZO_PRODUCTION_HOST = "robot-in.borzodelivery.com";
/** Shadowfax's own staging base, per the env.ts comment. */
export const SHADOWFAX_TEST_HOST = "hlbackend.staging.shadowfax.in";

export type ReadinessProviderId = "borzo" | "shadowfax" | "porter";

export interface DispatchProviderReadiness {
  provider: ReadinessProviderId;
  enabled: boolean;
  mock: boolean;
  eligible: boolean;
  keyPresent: boolean;
  host: string;
  testHost: boolean;
}

export interface DispatchReadinessReport {
  providers: DispatchProviderReadiness[];
  violations: string[];
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "";
  }
}

export function dispatchReadinessReport(): DispatchReadinessReport {
  const entries: Array<{
    provider: ReadinessProviderId;
    enabled: boolean;
    mock: boolean;
    eligible: boolean;
    keyPresent: boolean;
    baseUrl: string;
    testHostName: string;
  }> = [
    {
      provider: "borzo",
      enabled: config.borzo.enabled,
      mock: config.mock.borzoDispatch,
      eligible: borzoAdapter.isEligible(),
      keyPresent: !!config.borzo.apiKey,
      baseUrl: config.borzo.baseUrl,
      testHostName: BORZO_TEST_HOST,
    },
    {
      provider: "shadowfax",
      enabled: config.shadowfax.enabled,
      mock: config.mock.shadowfaxDispatch,
      eligible: shadowfaxAdapter.isEligible(),
      keyPresent: !!config.shadowfax.apiKey && !!config.shadowfax.clientCode,
      baseUrl: config.shadowfax.baseUrl,
      testHostName: SHADOWFAX_TEST_HOST,
    },
    {
      provider: "porter",
      enabled: config.porter.enabled,
      mock: config.mock.porterDispatch,
      eligible: porterAdapter.isEligible(),
      keyPresent:
        !!config.porter.apiKey &&
        !!config.porter.customerId &&
        !!config.porter.webhookSecret,
      baseUrl: config.porter.baseUrl,
      testHostName: "",
    },
  ];

  const providers: DispatchProviderReadiness[] = entries.map((e) => ({
    provider: e.provider,
    enabled: e.enabled,
    mock: e.mock,
    eligible: e.eligible,
    keyPresent: e.keyPresent,
    host: hostOf(e.baseUrl),
    testHost: e.testHostName !== "" && hostOf(e.baseUrl) === e.testHostName,
  }));
  const byId = (id: ReadinessProviderId) =>
    providers.find((p) => p.provider === id)!;

  const violations: string[] = [];

  // (1) No dispatch mock may be active: a mock rider/fare is not provider evidence.
  for (const p of providers) {
    if (p.mock) {
      violations.push(
        `${p.provider}: MOCK dispatch is ON (a mock result is not provider test evidence)`
      );
    }
  }

  // (2) The agreed automated test courier must be genuinely callable, on its TEST host.
  const borzo = byId("borzo");
  if (!borzo.enabled) {
    violations.push(
      "borzo: disabled — it is the only agreed automated test courier"
    );
  }
  if (borzo.enabled && !borzo.keyPresent) {
    violations.push(
      "borzo: enabled without an API key — nothing can be quoted or booked"
    );
  }
  if (borzo.eligible && !borzo.testHost) {
    violations.push(
      `borzo: host '${borzo.host}' is not the TEST host '${BORZO_TEST_HOST}' — refusing to send test traffic to a live host`
    );
  }

  // (3) Providers that must NOT be called during this run.
  const shadowfax = byId("shadowfax");
  if (shadowfax.eligible) {
    violations.push(
      "shadowfax: eligible while its contract and credentials are unverified — it must stay excluded (C06/C13)"
    );
  }
  const porter = byId("porter");
  if (porter.eligible) {
    violations.push(
      "porter: eligible while disabled for this run — an unkeyed local-rate-card quote can win the bid and divert to the manual lane (N2)"
    );
  }

  return { providers, violations };
}

export function assertDispatchTestReadiness(): DispatchReadinessReport {
  const report = dispatchReadinessReport();
  if (report.violations.length > 0) {
    const err: any = new Error(
      `Dispatch test readiness FAILED: ${report.violations.join("; ")}`
    );
    err.statusCode = 503;
    err.code = "DISPATCH_READINESS_FAILED";
    throw err;
  }
  return report;
}

/**
 * The gate the quote/book entry points call. Returns null when the run is not
 * opted in, so the default (dev, production) path is byte-for-byte unchanged.
 */
export function assertDispatchReadinessIfRequired(): DispatchReadinessReport | null {
  if (!config.dispatch.requireLive) return null;
  return assertDispatchTestReadiness();
}

/**
 * Booking-only gate for the TEST window. Quoting is safe (read-only), but a
 * create-order can dispatch a REAL rider. Until someone records a
 * real-rider-exclusion confirmation for the test account, booking stays blocked;
 * the opt-in is an EXACT "true" and is inert unless DISPATCH_REQUIRE_LIVE is on,
 * so dev and production bookings are unchanged.
 */
export function assertDispatchBookingReadinessIfRequired(): void {
  if (!config.dispatch.requireLive) return;
  if (config.dispatch.allowTestBooking) return;
  const err: any = new Error(
    "Booking is blocked in the TEST window until a real-rider-exclusion confirmation is recorded. " +
      "Set DISPATCH_ALLOW_TEST_BOOKING=true only after that confirmation; quoting is unaffected."
  );
  err.statusCode = 503;
  err.code = "DISPATCH_TEST_BOOKING_BLOCKED";
  throw err;
}
