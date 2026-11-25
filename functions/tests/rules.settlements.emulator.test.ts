import { beforeAll, describe, expect, it } from "vitest";

/**
 * A1 (GPT-6.2 Sol 2026-11-22) — REAL Firestore emulator rules behaviour.
 *
 *   firebase emulators:exec --config ../firebase.json --only firestore \
 *     --project demo-burgonomics-settlement-rules \
 *     "npx vitest run tests/rules.settlements.emulator.test.ts"
 *
 * Excluded from the default `npm test` (no emulator there); enabled by
 * FIRESTORE_EMULATOR_HOST in vitest.config.ts. Nothing is mocked: the rules
 * file, the auth JWTs and the admins/users docs are all exercised for real.
 */
function emulator(): { host: string; port: number } {
  const raw = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8085")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const idx = raw.lastIndexOf(":");
  return idx > 0
    ? { host: raw.slice(0, idx), port: Number(raw.slice(idx + 1)) }
    : { host: raw, port: 8085 };
}
const { host, port } = emulator();
const PROJECT = process.env.FIRESTORE_RULES_PROJECT ?? "demo-burgonomics-settlement-rules";
const BASE = `http://${host}:${port}/v1/projects/${PROJECT}/databases/(default)/documents`;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenFor = (uid: string) =>
  `${b64({ alg: "none", typ: "JWT" })}.${b64({
    sub: uid,
    user_id: uid,
    auth_time: 0,
    iat: 0,
    exp: 9_999_999_999,
  })}.`;

const STAFF = "uid_settle_staff";
const OWNER = "uid_settle_owner";
const OTHER_OWNER = "uid_settle_other";
const BRAND = "uid_settle_brand";
const BRANCH = "branch_settle_a";
const OTHER = "branch_settle_b";
const STATEMENT = "branch_settle_a_2026-11_v001";

const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ integerValue: String(v) });
const bool = (v: boolean) => ({ booleanValue: v });

async function seed(path: string, fields: Record<string, any>): Promise<void> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`seed ${path} failed: ${res.status} ${await res.text()}`);
}

async function readAs(path: string, uid: string): Promise<number> {
  const res = await fetch(`${BASE}/${path}`, {
    headers: { Authorization: `Bearer ${tokenFor(uid)}` },
  });
  return res.status;
}

async function patchAs(path: string, uid: string, field: string, value: any): Promise<number> {
  const res = await fetch(`${BASE}/${path}?updateMask.fieldPaths=${encodeURIComponent(field)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tokenFor(uid)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [field]: value } }),
  });
  return res.status;
}

async function setup(): Promise<void> {
  // Parallel seeds: a cold emulator makes each HTTP round trip slow, and the
  // rules assertions — not setup latency — are what these tests must measure.
  await Promise.all([
    seed(`admins/${STAFF}`, { role: str("branch_staff"), branchId: str(BRANCH), active: bool(true) }),
    seed(`users/${STAFF}`, { active: bool(true) }),
    seed(`admins/${OWNER}`, { role: str("branch_owner"), branchId: str(BRANCH), active: bool(true) }),
    seed(`users/${OWNER}`, { active: bool(true) }),
    seed(`admins/${OTHER_OWNER}`, { role: str("branch_owner"), branchId: str(OTHER), active: bool(true) }),
    seed(`users/${OTHER_OWNER}`, { active: bool(true) }),
    seed(`admins/${BRAND}`, { role: str("brand_owner"), active: bool(true) }),
    seed(`users/${BRAND}`, { active: bool(true) }),
    seed(`branches/${BRANCH}`, { name: str("Surat"), monthlyFee: int(2500), settlementFee: int(2000) }),
    seed('orders/settlement-month-test', { branchId: str(BRANCH), customerId: str('settlement-customer'), status: { mapValue: { fields: { code: str('CONFIRMED'), terminal: bool(false) } } }, settlementEffectiveAtMs: int(1796063400000) }),
    seed(`branch_settlements/${STATEMENT}`, { branchId: str(BRANCH), monthKey: str("2026-11"), version: int(1) }),
  ]);
}

describe("A1 settlement rules — real emulator", () => {
  // Seed once: each assertion is a single emulator round trip, so a cold rules
  // compilation cannot eat the whole per-test budget before the assertion runs.
  beforeAll(setup);

  it('a branch owner may annotate the order but cannot change its capture month', async () => {
    expect(await patchAs('orders/settlement-month-test', OWNER, 'notes', str('received'))).toBe(200);
    expect(await patchAs('orders/settlement-month-test', OWNER, 'settlementEffectiveAtMs', int(1796063399999))).toBe(403);
  });

  it("branch staff cannot read an owner-only statement; only brand reads the raw document", async () => {
    const [staff, otherOwner, owner, brand] = await Promise.all([
      readAs(`branch_settlements/${STATEMENT}`, STAFF),
      readAs(`branch_settlements/${STATEMENT}`, OTHER_OWNER),
      readAs(`branch_settlements/${STATEMENT}`, OWNER),
      readAs(`branch_settlements/${STATEMENT}`, BRAND),
    ]);
    expect(staff).toBe(403); // same branch, but staff is not an owner
    expect(otherOwner).toBe(403); // owner of a DIFFERENT branch
    // Cycle 11 §8: the raw statement holds the brand operator's e-mail and
    // internal notes, so a branch owner now reads the projected API view
    // (tests/settlements-route-rbac.test.ts) rather than the document.
    expect(owner).toBe(403);
    expect(brand).toBe(200);
  });

  it("settlementFee is brand-only; an ordinary branch edit still succeeds", async () => {
    // These three patches all target the SAME field; run them in sequence so a
    // Firestore 409 write conflict cannot stand in for the rules verdict.
    const ownerFee = await patchAs(`branches/${BRANCH}`, OWNER, "settlementFee", int(1));
    const staffFee = await patchAs(`branches/${BRANCH}`, STAFF, "settlementFee", int(1));
    const brandFee = await patchAs(`branches/${BRANCH}`, BRAND, "settlementFee", int(1));
    const ownerName = await patchAs(`branches/${BRANCH}`, OWNER, "name", str("Surat 2"));
    expect(ownerFee).toBe(403);
    expect(staffFee).toBe(403); // same-branch staff denied the fee write too
    expect(brandFee).toBe(200);
    expect(ownerName).toBe(200); // ordinary branch edits still work
  });
});
