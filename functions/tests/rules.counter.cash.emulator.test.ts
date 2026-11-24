import { describe, expect, it, beforeAll } from "vitest";

/** counter-cash-c9: client writes to cash evidence must be denied on the emulator. */
function emulator() {
  const raw = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8085").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const i = raw.lastIndexOf(":");
  return i > 0 ? { host: raw.slice(0, i), port: Number(raw.slice(i + 1)) } : { host: raw, port: 8085 };
}
const { host, port } = emulator();
const PROJECT = "demo-burgonomics-cod-courier";
const BASE = `http://${host}:${port}/v1/projects/${PROJECT}/databases/(default)/documents`;
const STAFF = "uid_c9_cash_staff";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: STAFF, user_id: STAFF, auth_time: 0, iat: 0, exp: 9999999999 })}.`;
const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ integerValue: String(v) });
const map = (fields: Record<string, any>) => ({ mapValue: { fields } });

async function seed(path: string, fields: Record<string, any>) {
  const r = await fetch(`${BASE}/${path}`, { method: "PATCH", headers: { Authorization: "Bearer owner", "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`seed ${path}: ${r.status} ${await r.text()}`);
}
async function staffPatch(field: string, value: any) {
  const r = await fetch(`${BASE}/orders/ord_c9?updateMask.fieldPaths=${encodeURIComponent(field)}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields: { [field]: value } }),
  });
  return r.status;
}
beforeAll(async () => {
  await seed(`admins/${STAFF}`, { role: str("branch_owner"), branchId: str("b1"), active: { booleanValue: true } });
  await seed(`users/${STAFF}`, { active: { booleanValue: true } });
  await seed("orders/ord_c9", {
    branchId: str("b1"), customerId: str("cust_1"), status: map({ code: str("READY_FOR_PICKUP"), label: str("Ready"), kind: str("in_progress"), terminal: { booleanValue: false } }),
    paymentChannel: str("cash"), cashDuePaise: int(10900),
  });
}, 30_000);

describe("counter cash fields are server-only (emulator)", () => {
  it("allows an ordinary staff edit", async () => { expect(await staffPatch("notes", str("counter note"))).toBe(200); }, 30_000);
  it("denies a client cashCollectedPaise write", async () => { expect(await staffPatch("cashCollectedPaise", int(1))).toBe(403); }, 30_000);
  it("denies a client receiptEvidence write", async () => { expect(await staffPatch("receiptEvidence", map({ source: str("counter_handover"), paise: int(10900) }))).toBe(403); }, 30_000);
  it("denies a client paymentStatus write", async () => { expect(await staffPatch("paymentStatus", str("paid"))).toBe(403); }, 30_000);
});
