import { beforeAll, describe, expect, it } from "vitest";

/**
 * Capture recovery rules against a real local Firestore emulator.
 *
 *   firebase emulators:exec --config ../firebase.json --only firestore \
 *     --project demo-burgonomics-settlement-rules \
 *     "npx vitest run tests/capture.recovery.rules.emulator.test.ts"
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
const BRAND = "uid_settle_brand";
const BRANCH = "branch_settle_a";

const str = (v: string) => ({ stringValue: v });
const bool = (v: boolean) => ({ booleanValue: v });

async function seed(fixtures: Record<string, Record<string, unknown>>): Promise<void> {
  const writes = Object.entries(fixtures).map(([path, fields]) => ({
    update: { name: `projects/${PROJECT}/databases/(default)/documents/${path}`, fields },
  }));
  const res = await fetch(`${BASE}:commit`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) throw new Error(`emulator fixture commit failed: ${res.status} ${await res.text()}`);
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

describe("capture recovery rules (real emulator)", () => {
  beforeAll(async () => {
    await seed({
      [`admins/${STAFF}`]: { role: str("branch_staff"), branchId: str(BRANCH), active: bool(true) },
      [`users/${STAFF}`]: { active: bool(true) },
      [`admins/${OWNER}`]: { role: str("branch_owner"), branchId: str(BRANCH), active: bool(true) },
      [`users/${OWNER}`]: { active: bool(true) },
      [`admins/${BRAND}`]: { role: str("brand_owner"), active: bool(true) },
      [`users/${BRAND}`]: { active: bool(true) },
      "settlement_capture_issues/o1": { orderId: str("o1"), status: str("open"), paymentId: str("pay_1") },
      "settlement_capture_issues/o2": { orderId: str("o2"), status: str("conflict") },
      "settlement_capture_resolutions/o1_v1": { orderId: str("o1"), immutable: bool(true) },
      "settlement_capture_regeneration/branch_2026-11": { branchId: str("branch"), monthKey: str("2026-11") },
      "orders/recovery-order": { branchId: str(BRANCH), status: { mapValue: { fields: { code: str("CONFIRMED") } } } },
    });
  });

  it("brand reads issues and resolutions; staff and branch owner are denied", async () => {
    expect(await readAs("settlement_capture_issues/o1", BRAND)).toBe(200);
    expect(await readAs("settlement_capture_issues/o2", BRAND)).toBe(200);
    expect(await readAs("settlement_capture_resolutions/o1_v1", BRAND)).toBe(200);
    expect(await readAs("settlement_capture_issues/o1", STAFF)).toBe(403);
    expect(await readAs("settlement_capture_issues/o1", OWNER)).toBe(403);
    expect(await readAs("settlement_capture_resolutions/o1_v1", STAFF)).toBe(403);
  });

  it("clients can never write issue or resolution documents", async () => {
    expect(await patchAs("settlement_capture_issues/o1", BRAND, "status", str("resolved"))).toBe(403);
    expect(await patchAs("settlement_capture_resolutions/o1_v1", BRAND, "reason", str("x"))).toBe(403);
    expect(await patchAs("settlement_capture_issues/o1", STAFF, "status", str("conflict"))).toBe(403);
    expect(await patchAs("settlement_capture_issues/o2", BRAND, "status", str("resolved"))).toBe(403);
    expect(await readAs("settlement_capture_regeneration/branch_2026-11", BRAND)).toBe(403);
    expect(await patchAs("settlement_capture_regeneration/branch_2026-11", BRAND, "monthKey", str("2026-12"))).toBe(403);
  });

  it("does not allow brand or branch clients to manufacture the server capture state", async () => {
    expect(await patchAs("orders/recovery-order", BRAND, "settlementCaptureState", str("confirmed_manual"))).toBe(403);
    expect(await patchAs("orders/recovery-order", OWNER, "settlementCaptureState", str("confirmed_manual"))).toBe(403);
  });
});
