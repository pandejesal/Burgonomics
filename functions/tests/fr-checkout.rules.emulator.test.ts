import { beforeAll, describe, expect, it } from "vitest";

/**
 * fr-checkout r2 — A2, real Firestore emulator.
 *
 * Run in the rules lane (JBR JDK 21 as JAVA_HOME for THIS command only):
 *   $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
 *   firebase emulators:exec --config ../firebase.json --only firestore \
 *     --project demo-burgonomics-fr-checkout \
 *     "npx vitest run tests/fr-checkout.rules.emulator.test.ts"
 *
 * The rules must protect the server-issued cash receipt and cash marker from
 * staff writes; kitchen admission must agree with that rule: a client-writable
 * `method: cod` alone is refused, the server `paymentChannel: cash` is admitted.
 */
function emulator(): { host: string; port: number } {
  const raw = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8085")
    .trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const idx = raw.lastIndexOf(":");
  if (idx > 0) return { host: raw.slice(0, idx), port: Number(raw.slice(idx + 1)) };
  return { host: raw, port: 8085 };
}
const { host, port } = emulator();
const PROJECT = process.env.FIRESTORE_RULES_PROJECT ?? "demo-burgonomics-cod-courier";
const BASE = `http://${host}:${port}/v1/projects/${PROJECT}/databases/(default)/documents`;
const STAFF = "uid_fr_cash_staff";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({
  sub: STAFF, user_id: STAFF, auth_time: 0, iat: 0, exp: 9_999_999_999,
})}.`;
const str = (v: string) => ({ stringValue: v });
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
async function patch(path: string, field: string, value: any): Promise<number> {
  const res = await fetch(`${BASE}/${path}?updateMask.fieldPaths=${encodeURIComponent(field)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [field]: value } }),
  });
  return res.status;
}

async function setup(): Promise<void> {
  await seed(`admins/${STAFF}`, { role: str("branch_owner"), branchId: str("branch_fr"), active: bool(true) });
  await seed(`users/${STAFF}`, { active: bool(true) });
  await seed("orders/ord_fr_cash", {
    branchId: str("branch_fr"),
    customerId: str("cust_fr"),
    status: map({ code: str("CONFIRMED"), label: str("Order confirmed"), kind: str("upcoming"), terminal: bool(false) }),
    paymentChannel: str("cash"),
    cashDuePaise: ({ integerValue: "11500" } as any),
    cashReceipt: map({ orderId: str("ord_fr_cash"), cashDuePaise: ({ integerValue: "11500" } as any) }),
  });
}

describe("A2 rules + kitchen admission agree on the server cash marker", () => {
  // Seed once: the Firestore emulator's first write on a cold start can take
  // longer than a test's default 5s. This only changes setup cost — every
  // assertion below is unchanged and still a real emulator evaluation.
  beforeAll(async () => { await setup(); }, 30_000);

  it("allows the same operator to edit ordinary notes", async () => {
    expect(await patch("orders/ord_fr_cash", "notes", str("Counter note"))).toBe(200);
  });

  it.each(["cashRequestHash", "couponIntentId"])("protects %s against a staff write", async (field) => {
    expect(await patch("orders/ord_fr_cash", field, str("staff edit"))).toBe(403);
  });

  it("branch staff cannot plant or edit a cashReceipt", async () => {
    expect(await patch("orders/ord_fr_cash", "cashReceipt", map({ orderId: str("forged") }))).toBe(403);
  }, 30_000);

  it("branch staff cannot edit the server cash marker", async () => {
    expect(await patch("orders/ord_fr_cash", "paymentChannel", str("razorpay"))).toBe(403);
  }, 30_000);

  it("kitchen admission refuses a bare label and admits the server marker", async () => {
    const { requiresServerCaptureForKitchen } = await import("../src/modules/orders/paymentGate");
    expect(requiresServerCaptureForKitchen({ paymentMethod: "cod", payment: { method: "cod" } })).toBe(true);
    expect(requiresServerCaptureForKitchen({ paymentMethod: "cod", paymentChannel: "cash" })).toBe(false);
  });
});
