import { describe, expect, it } from "vitest";

/**
 * Firestore rules, real emulator, no new dependencies.
 *
 * Run in the rules lane:
 *   firebase emulators:exec --config ../firebase.json --only firestore \
 *     --project demo-burgonomics-cod-courier \
 *     "npx vitest run tests/rules.cod-courier.emulator.test.ts"
 *
 * The unsigned JWT has the same shape the rules-unit-testing SDK mints, so
 * request.auth.uid and the admins/users documents are exercised for real.
 */
function emulator(): { host: string; port: number } {
  const raw = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8085")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const idx = raw.lastIndexOf(":");
  if (idx > 0) return { host: raw.slice(0, idx), port: Number(raw.slice(idx + 1)) };
  return { host: raw, port: 8085 };
}

const { host, port } = emulator();
const PROJECT = process.env.FIRESTORE_RULES_PROJECT ?? "demo-burgonomics-cod-courier";
const BASE = `http://${host}:${port}/v1/projects/${PROJECT}/databases/(default)/documents`;
const BRANCH_STAFF = "uid_branch_staff_cod";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const staffToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({
  sub: BRANCH_STAFF,
  user_id: BRANCH_STAFF,
  auth_time: 0,
  iat: 0,
  exp: 9_999_999_999,
})}.`;

const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ integerValue: String(v) });
const bool = (v: boolean) => ({ booleanValue: v });
const map = (fields: Record<string, any>) => ({ mapValue: { fields } });

async function seed(path: string, fields: Record<string, any>): Promise<void> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`seed ${path} failed: ${res.status} ${await res.text()}`);
}

async function staffPatch(path: string, field: string, value: any): Promise<number> {
  const res = await fetch(`${BASE}/${path}?updateMask.fieldPaths=${encodeURIComponent(field)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${staffToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [field]: value } }),
  });
  return res.status;
}

const READY = map({
  enabled: bool(true),
  providers: map({ borzo: bool(true), shadowfax: bool(false) }),
});

async function setup(): Promise<void> {
  await seed(`admins/${BRANCH_STAFF}`, {
    role: str("branch_owner"),
    branchId: str("branch_cod"),
    active: bool(true),
  });
  await seed(`users/${BRANCH_STAFF}`, { active: bool(true) });
  await seed("branches/branch_cod", {
    name: str("COD Branch"),
    cashOnDelivery: map({
      enabled: bool(true),
      maxOrderValuePaise: int(500000),
      courierCod: READY,
    }),
  });
  await seed("orders/ord_cod_rules", {
    branchId: str("branch_cod"),
    customerId: str("cust_cod_rules"),
    // A REAL status map: rules read status.code in directDeliveredBypass(), so
    // a status-less fixture would deny even a legitimate staff edit.
    status: map({
      code: str("CONFIRMED"),
      label: str("Order confirmed"),
      kind: str("upcoming"),
      terminal: bool(false),
    }),
    paymentChannel: str("cash"),
    cashDuePaise: int(12345),
    cashOnDelivery: map({ maxOrderValuePaise: int(500000), courierCod: READY }),
  });
}

describe("branch staff cannot rewrite courier COD money or readiness (emulator)", () => {
  it("allows a staff order edit that is not server-owned", async () => {
    await setup();
    // Same staff identity, valid status: a normal order edit still succeeds.
    expect(await staffPatch("orders/ord_cod_rules", "notes", str("staff note"))).toBe(200);
  });

  it("denies an order cashDuePaise rewrite", async () => {
    await setup();
    expect(await staffPatch("orders/ord_cod_rules", "cashDuePaise", int(1))).toBe(403);
  });

  it("denies an order readiness-snapshot rewrite", async () => {
    await setup();
    expect(await staffPatch("orders/ord_cod_rules", "cashOnDelivery", READY)).toBe(403);
  });

  it("denies enabling branch courier readiness, but allows other cash config", async () => {
    await setup();
    const enabled = map({
      enabled: bool(true),
      providers: map({ borzo: bool(true), shadowfax: bool(true) }),
    });
    expect(await staffPatch("branches/branch_cod", "cashOnDelivery", enabled)).toBe(403);
    // Positive control: the same staff identity CAN edit a branch field the
    // rules do not reserve for the owner (packagingFee is owner-only).
    expect(await staffPatch("branches/branch_cod", "name", str("Renamed COD Branch"))).toBe(200);
  });
});
