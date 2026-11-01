import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * POST /support/feedback — customer service feedback.
 *
 * The customer app's Help screen has a feedback form. Until now the client
 * posted to /v1/support/feedback, which never existed, so feedback was silently
 * dropped (the old client even fabricated an id). This route records it.
 *
 * Pinned here:
 *  - the Zod schema shape (rating int 1..5; comment trimmed/optional/max 2000;
 *    optional orderId max 128)
 *  - the route exists, is requireAuth, and is registered inside the App Check
 *    list alongside /tickets/create
 *  - customerId comes from the VERIFIED token, never the request body
 *  - the response is 201 with the created id
 *  - firestore.rules still default-denies client access to support_feedback
 */

const root = path.resolve(__dirname, "../..");
const indexSrc = fs.readFileSync(path.join(root, "functions/src/index.ts"), "utf8");
const validationSrc = fs.readFileSync(path.join(root, "functions/src/core/validation.ts"), "utf8");
const rulesSrc = fs.readFileSync(path.join(root, "firestore.rules"), "utf8");

/**
 * Index of the route REGISTRATION (app.post), not the App Check allowlist entry
 * — "/support/feedback" appears in both, and the allowlist comes first.
 */
function routeStart(): number {
  const re = /app\.post\(\s*["']\/support\/feedback["']/;
  const m = re.exec(indexSrc);
  return m ? m.index : -1;
}

describe("support feedback schema", () => {
  it("is exported from core/validation.ts", () => {
    expect(validationSrc).toMatch(/export const supportFeedbackSchema\s*=/);
  });

  it("pins rating 1..5 as an integer, comment optional/trimmed/max 2000, orderId optional/max 128", () => {
    const block = validationSrc.slice(
      validationSrc.indexOf("export const supportFeedbackSchema"),
    );
    const schema = block.slice(0, block.indexOf("});") + 3);
    // rating: integer 1..5
    expect(schema).toMatch(/rating:\s*z\.number\(\)/);
    expect(schema).toMatch(/\.int\(\)/);
    expect(schema).toMatch(/\.min\(1\)/);
    expect(schema).toMatch(/\.max\(5\)/);
    // comment: trimmed, optional, max 2000
    expect(schema).toMatch(/comment:[\s\S]{0,160}?\.trim\(\)/);
    expect(schema).toMatch(/comment:[\s\S]{0,200}?\.max\(2000\)/);
    expect(schema).toMatch(/comment:[\s\S]{0,240}?\.optional\(\)/);
    // orderId: optional, max 128
    expect(schema).toMatch(/orderId:[\s\S]{0,120}?\.max\(128\)/);
    expect(schema).toMatch(/orderId:[\s\S]{0,160}?\.optional\(\)/);
  });

  it("does not accept a client-supplied customerId (identity comes from the token)", () => {
    const block = validationSrc.slice(
      validationSrc.indexOf("export const supportFeedbackSchema"),
    );
    const schema = block.slice(0, block.indexOf("});") + 3);
    expect(schema).not.toMatch(/customerId/);
  });
});

describe("POST /support/feedback route wiring", () => {
  it("is registered with requireAuth and the feedback schema", () => {
    expect(indexSrc).toMatch(/app\.post\(\s*["']\/support\/feedback["']/);
    const at = routeStart();
    expect(at).toBeGreaterThan(-1);
    const route = indexSrc.slice(at, at + 700);
    expect(route).toMatch(/requireAuth/);
    expect(route).toMatch(/validateBody\(\s*supportFeedbackSchema\s*\)/);
  });

  it("is listed in the App Check route allowlist next to /tickets/create", () => {
    const listStart = indexSrc.indexOf('"/tickets/create"');
    expect(listStart).toBeGreaterThan(-1);
    const listSlice = indexSrc.slice(listStart - 400, listStart + 1600);
    expect(listSlice).toContain('"/support/feedback"');
  });

  it("writes customerId from the verified token, not req.body", () => {
    const at = routeStart();
    expect(at).toBeGreaterThan(-1);
    const route = indexSrc.slice(at, at + 1200);
    // The uid must come from req.user.
    expect(route).toMatch(/req\.user\?\.uid/);
    // It must never read customerId out of the body for the write.
    expect(route).not.toMatch(/req\.body\.customerId/);
  });

  it("responds 201 with the created id", () => {
    const at = routeStart();
    expect(at).toBeGreaterThan(-1);
    const route = indexSrc.slice(at, at + 1200);
    expect(route).toMatch(/status\(201\)/);
    expect(route).toMatch(/\bid\b/);
  });

  it("collects into support_feedback through the Admin SDK", () => {
    const at = routeStart();
    expect(at).toBeGreaterThan(-1);
    const route = indexSrc.slice(at, at + 1200);
    expect(route).toMatch(/support_feedback/);
    expect(route).toMatch(/createdAt/);
  });
});

describe("support_feedback is not client-writable", () => {
  it("firestore.rules keeps the default deny (no support_feedback match block)", () => {
    // The rules end with a catch-all deny; adding a collection match for
    // support_feedback would be the only way a client could reach it.
    expect(rulesSrc).not.toMatch(/match\s*\/support_feedback/);
    expect(rulesSrc).toMatch(/allow read,\s*write:\s*if false/);
  });
});
