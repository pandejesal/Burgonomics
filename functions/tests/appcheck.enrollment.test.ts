import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SEC-11 (A3 finding 4): the App Check enrollment list must never contain a
 * route whose shipped client does not send `X-Firebase-AppCheck`.
 *
 * Background: `requireAppCheck` is monitor-mode by default and rejects ONLY
 * when `APP_CHECK_ENFORCEMENT=true`. Enrolling a route early is therefore
 * invisible until ops flips that flag — and then the route 403s every real
 * request. The customer app's notification calls were enrolled while sending
 * only `Authorization`, exactly that failure.
 *
 * What is pinned here:
 *  1. the three customer notification routes stay de-enrolled until their
 *     client sends the header;
 *  2. the two Partner notification routes stay enrolled (its apiRequest helper
 *     always attaches the header);
 *  3. the source of truth: every enrolled path has a documented client that
 *     sends the header — checked by reading the app sources at their pinned
 *     heads, not by trusting a comment.
 */

const ROOT = resolve(__dirname, "../..");
const indexSrc = readFileSync(resolve(ROOT, "functions/src/index.ts"), "utf8");

/**
 * The two app repos sit next to the backend repo root. Resolve them by walking
 * up from this worktree, so the check works in a canonical checkout and in a
 * `.swarm-worktrees/.../backend` worktree alike (a fixed relative path is wrong
 * in one of the two).
 */
function siblingRepo(name: string): string {
  let dir = ROOT;
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, name);
    try {
      if (readFileSync(resolve(candidate, "package.json"), "utf8")) return candidate;
    } catch {
      // keep walking
    }
    dir = resolve(dir, "..");
  }
  throw new Error(`could not locate ${name} above ${ROOT}`);
}

const customerRoot = siblingRepo("burgonomics-foundation-core");
const partnerRoot = siblingRepo("burgonomics-partner");

/** The literal array passed to the App Check `app.use([...], requireAppCheck)`. */
function enrolledPaths(): string[] {
  const start = indexSrc.indexOf("app.use(\n  [");
  expect(start).toBeGreaterThan(-1);
  const end = indexSrc.indexOf("requireAppCheck", start);
  const block = indexSrc.slice(start, end);
  return [...block.matchAll(/"(\/[^"]+)"/g)].map((m) => m[1]);
}

/** Deliberately excluded routes, with the reason the file must state. */
const DE_ENROLLED = [
  "/notifications/registerToken",
  "/notifications/unregisterToken",
  "/notifications/preferences",
  "/orders/customerCancel",
];

describe("App Check enrollment matches what the clients actually send", () => {
  it("keeps every route whose customer client sends no attestation header OUT of the list", () => {
    const list = enrolledPaths();
    for (const path of DE_ENROLLED) {
      expect(list).not.toContain(path);
    }
  });

  it("still enrolls the Partner notification routes (partnerFunctionsApi sends the header)", () => {
    const list = enrolledPaths();
    expect(list).toContain("/notifications/subscribe");
    expect(list).toContain("/notifications/unsubscribe");
    expect(list).toContain("/notifications/dispatch");
  });

  it("documents each deliberate exclusion next to the list", () => {
    const start = indexSrc.indexOf("// App Check attestation on app-originated routes only");
    const end = indexSrc.indexOf("app.use(", start);
    const comment = indexSrc.slice(start, end);
    expect(comment).toMatch(/SEC-11/);
    expect(comment).toContain("/orders/customerCancel");
    expect(comment).toMatch(/registerToken/);
    expect(comment).toMatch(/preferences/);
  });

  it("the customer notifications client still sends only Authorization (the premise of the exclusion)", () => {
    const src = readFileSync(
      resolve(customerRoot, "src/features/notifications/services/notificationsService.ts"),
      "utf8"
    );
    // enroll them again only together with this client change.
    expect(src).not.toContain("X-Firebase-AppCheck");
    expect(src).toContain("/notifications/registerToken");
    expect(src).toContain("/notifications/unregisterToken");
    expect(src).toContain("/notifications/preferences");
  });

  it("the Partner api helper does attach the header, so its routes stay safe", () => {
    const src = readFileSync(
      resolve(partnerRoot, "src/services/partnerFunctionsApi.ts"),
      "utf8"
    );
    expect(src).toContain("X-Firebase-AppCheck");
    expect(src).toContain("'/notifications/subscribe'");
    expect(src).toContain("'/notifications/unsubscribe'");
  });

  it("the customer support client (an enrolled route) does attach the header", () => {
    const src = readFileSync(
      resolve(customerRoot, "src/features/support/services/supportService.ts"),
      "utf8"
    );
    expect(src).toContain("X-Firebase-AppCheck");
  });
});
