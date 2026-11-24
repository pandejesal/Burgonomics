import { describe, expect, it } from "vitest";

/** Client order birth is server-only. Run under firebase emulators:exec with JBR. */
function emulator() {
  const raw = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8085").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const i = raw.lastIndexOf(":");
  return i > 0 ? { host: raw.slice(0, i), port: Number(raw.slice(i + 1)) } : { host: raw, port: 8085 };
}
const { host, port } = emulator();
const PROJECT = "demo-burgonomics-cod-courier";
const BASE = `http://${host}:${port}/v1/projects/${PROJECT}/databases/(default)/documents`;
const UID = "uid_c9_customer";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: UID, user_id: UID, auth_time: 0, iat: 0, exp: 9999999999 })}.`;
const str = (value: string) => ({ stringValue: value });
const int = (value: number) => ({ integerValue: String(value) });
const bool = (value: boolean) => ({ booleanValue: value });
const map = (fields: Record<string, any>) => ({ mapValue: { fields } });
const list = (values: any[]) => ({ arrayValue: { values } });

function clientOrder(overrides: Record<string, any> = {}) {
  return {
    customerId: str(UID), userId: str(UID), orderId: str("ord_client"), orderType: str("takeaway"),
    branchId: str("branch_a"), total: int(1), paymentStatus: str("pending"),
    payment: map({ method: str("cod"), status: str("PAY_AT_STORE") }),
    status: map({ code: str("PLACED"), label: str("Placed"), kind: str("upcoming"), terminal: bool(false) }),
    ...overrides,
  };
}
async function clientCreate(id: string, fields: Record<string, any>) {
  const response = await fetch(`${BASE}/orders/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  return response.status;
}

describe("orders create is server-only (emulator)", () => {
  it("denies a signed-in customer's otherwise-valid pending order", async () => {
    expect(await clientCreate("ord_c9_client_pending", clientOrder())).toBe(403);
  }, 30_000);

  it.each([
    ["paid", clientOrder({ paymentStatus: str("paid"), payment: map({ method: str("online"), status: str("completed") }) })],
    ["evidence", clientOrder({ receiptEvidence: map({ kind: str("cash"), paise: int(1), by: str("server") }) })],
    ["cash", clientOrder({ paymentChannel: str("cash"), cashDuePaise: int(1) })],
    ["settlement", clientOrder({ settlementEffectiveAtMs: int(1), settlementCaptureState: str("confirmed") })],
    ["confirmed", clientOrder({ status: map({ code: str("CONFIRMED"), terminal: bool(false) }) })],
  ])("denies a client-created %s order", async (_name, fields) => {
    expect(await clientCreate(`ord_c9_client_${_name}`, fields)).toBe(403);
  }, 30_000);

  it("still permits the emulator Admin/owner bypass used by server routes", async () => {
    const id = "ord_c9_server_draft";
    const response = await fetch(`${BASE}/orders/${id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      body: JSON.stringify({ fields: {
        customerId: str(UID), userId: str(UID), orderId: str(id), branchId: str("branch_a"), orderType: str("takeaway"),
        status: map({ code: str("PLACED"), terminal: bool(false) }), paymentMethod: str("online"), paymentStatus: str("pending"),
        payment: map({ method: str("online"), status: str("pending") }),
        onlineDraft: map({ version: int(1), source: str("server_online_draft"), orderId: str(id), customerId: str(UID), attemptId: str("attempt_server") }),
      } }),
    });
    expect(response.status).toBe(200);
  }, 30_000);
});
