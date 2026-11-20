"use strict";

/**
 * Hermetic guard for the store-listing copy — the words a human pastes into
 * Google Play Console and App Store Connect.
 *
 * Why this exists: the 2026-10-17 draft promised features the app does not
 * ship (Grill Coins loyalty, "real-time availability", Porter dispatch as the
 * live path) and pointed both stores' privacy/terms fields at
 * `burgonomics.com`, whose legal paths 404. Copy that over-promises is a
 * rejection risk and, for the loyalty claim, a refund-fight waiting to happen.
 *
 * The owner's decisions of 2026-11-20 fix the allowed claims:
 *   offers/coupons YES · loyalty/coins/tiers/points NO · online + COD + counter
 *   cash YES · iPhone in scope · `burgonomics.com` OUT of scope (legal pages live
 *   on the Customer app's own hosting at /legal/<slug>).
 *
 * Scope: read-only. `BURG_STORE_DOC_ROOT` lets the same file run against a
 * different checkout (used to prove this guard fails on the old copy).
 *
 *   node --test scripts/store-listing-honesty.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = process.env.BURG_STORE_DOC_ROOT || path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const LISTINGS = "STORE_LISTINGS_DRAFT.md";
const GUIDE = "STORE_SUBMISSION_GUIDE.md";
const CHECKLIST = path.join("client-handover", "STORE_SUBMISSION_CHECKLIST.md");

const docs = () => [
  [LISTINGS, read(LISTINGS)],
  [GUIDE, read(GUIDE)],
  [CHECKLIST, read(CHECKLIST)],
];

/** The four public legal paths the Customer app actually publishes. */
const LEGAL_PATHS = ["/legal/privacy", "/legal/terms", "/legal/refund-policy", "/legal/grievance"];

test("the copy that gets pasted into a console never sells loyalty", () => {
  // The fenced blocks are the literal listing text a human pastes. Any loyalty
  // word inside one is an offer the app cannot honour (owner decision 2026-11-20).
  const listings = read(LISTINGS);
  const pasted = [...listings.matchAll(/```(?:markdown)?\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(pasted.length >= 2, "the listings must contain the paste-ready blocks");
  for (const block of pasted) {
    assert.ok(!/Grill[-\s]?Coins/i.test(block), "a paste block still offers Grill Coins");
    assert.ok(
      !/\b(earn|redeem)\b[\s\S]{0,40}\b(coins?|points?)\b/i.test(block),
      "a paste block still promises earning or redeeming coins/points",
    );
    assert.ok(!/\bloyalty\b/i.test(block), "a paste block still offers loyalty");
  }

  for (const [name, text] of docs().filter(([n]) => n !== LISTINGS)) {
    assert.ok(!/Grill[-\s]?Coins/i.test(text), `${name}: Grill Coins still present`);
    assert.ok(
      !/\bloyalty (coins|points|tiers?)\b/i.test(text),
      `${name}: loyalty still described as a feature`,
    );
  }
});

test("both console forms point at legal URLs the app publishes, never burgonomics.com", () => {
  const checklist = read(CHECKLIST);
  for (const legalPath of LEGAL_PATHS) {
    assert.ok(
      checklist.includes(legalPath),
      `${CHECKLIST}: missing published legal path ${legalPath}`,
    );
  }
  // A store form that points at the marketing domain is a dead link today.
  const consoleSections = checklist.split("## 📁 1. Release Files Directory")[1] ?? "";
  assert.ok(
    !/https:\/\/burgonomics\.com\//.test(consoleSections),
    `${CHECKLIST}: a console field still points at burgonomics.com`,
  );
});

test("the guide no longer advertises the removed claims", () => {
  const guide = read(GUIDE);
  for (const claim of [
    "live order tracking!",
    "Porter dispatch",
    "POS billing",
    "real-time kitchen tracking",
    "3-way fulfillment",
  ]) {
    assert.ok(!guide.includes(claim), `${GUIDE}: removed claim still present: ${claim}`);
  }
});

test("the launch scope the owner decided is stated, not implied", () => {
  const listings = read(LISTINGS);
  for (const required of [
    "cash on delivery",
    "/legal/refund-policy",
    "iPhone",
    "no loyalty",
  ]) {
    assert.ok(listings.toLowerCase().includes(required.toLowerCase()), `missing: ${required}`);
  }
});

test("every remaining claim is marked as verified or as needing a human", () => {
  const listings = read(LISTINGS);
  const needs = (listings.match(/\[NEEDS: /g) || []).length;
  assert.ok(needs > 0, "the listings must mark the facts a human still has to supply");
  // A blessing that reads as fact but cannot be checked must not survive.
  assert.ok(!/✅ (LIVE|WORKS|SHIPPED) on production/i.test(listings));
});

test("the checklist blocks submission while legal facts are missing", () => {
  const checklist = read(CHECKLIST);
  assert.ok(
    /Legal facts — BLOCKING/.test(checklist),
    `${CHECKLIST}: no blocking legal-facts section`,
  );
  assert.ok(
    /Do not submit either app|do not submit either app/i.test(checklist),
    `${CHECKLIST}: nothing stops a submission`,
  );
  for (const fact of [
    "FSSAI",
    "Grievance Officer",
    "CIN",
    "GSTIN",
    "Registered address",
  ]) {
    assert.ok(checklist.includes(fact), `${CHECKLIST}: missing blocking fact ${fact}`);
  }
});
