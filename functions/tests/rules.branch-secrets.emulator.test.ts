import { beforeAll, describe, expect, it } from "vitest";

/**
 * SEC-11 (A3 finding 1) — REAL Firestore emulator, no mocks.
 *
 *   firebase emulators:exec --config ../firebase.json --only firestore \
 *     --project demo-burgonomics-branch-secrets \
 *     "npx vitest run tests/rules.branch-secrets.emulator.test.ts"
 *
 * Both halves of the finding are exercised:
 *  - ALLOWED: an operator still reads the branch DIRECTORY (the Partner outlet
 *    picker, city-scoped tickets/analytics and the dispatch pickup pin all query
 *    the collection), because the sensitive keys are no longer on it.
 *  - DENIED: the POS/payment identifiers are unreachable to every non-brand
 *    role through `branch_secrets`, and no client may write them back onto a
 *    branch document.
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
const PROJECT = process.env.FIRESTORE_RULES_PROJECT ?? "demo-burgonomics-branch-secrets";
const BASE = `http://${host}:${port}/v1/projects/${PROJECT}/databases/(default)/documents`;

const OWN_STAFF = "uid_sec11_staff";
const OWN_OWNER = "uid_sec11_branch_owner";
const BRAND = "uid_sec11_brand";
const OTHER_STAFF = "uid_sec11_other_staff";
const REGIONAL = "uid_sec11_regional";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenFor = (uid: string) =>
  `${b64({ alg: "none", typ: "JWT" })}.${b64({
    sub: uid,
    user_id: uid,
    auth_time: 0,
    iat: 0,
    exp: 9_999_999_999,
  })}.`;

const TOKENS = {
  ownStaff: tokenFor(OWN_STAFF),
  ownOwner: tokenFor(OWN_OWNER),
  brand: tokenFor(BRAND),
  otherStaff: tokenFor(OTHER_STAFF),
  regional: tokenFor(REGIONAL),
};

const str = (v: string) => ({ stringValue: v });
const bool = (v: boolean) => ({ booleanValue: v });
const map = (fields: Record<string, any>) => ({ mapValue: { fields } });
const arr = (values: any[]) => ({ arrayValue: { values } });

async function seed(path: string, fields: Record<string, any>): Promise<void> {
  const res = await fetch(`${BASE}/${path}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`seed ${path} failed: ${res.status} ${await res.text()}`);
}

async function read(path: string, token: string): Promise<number> {
  const res = await fetch(`${BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.status;
}

async function clientPatch(path: string, field: string, value: any, token: string): Promise<number> {
  const res = await fetch(`${BASE}/${path}?updateMask.fieldPaths=${encodeURIComponent(field)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [field]: value } }),
  });
  return res.status;
}

async function staffProfile(uid: string, role: string, branchId: string): Promise<void> {
  await Promise.all([
    seed(`admins/${uid}`, { role: str(role), branchId: str(branchId), active: bool(true) }),
    seed(`users/${uid}`, { active: bool(true) }),
  ]);
}

beforeAll(async () => {
  await Promise.all([
    staffProfile(OWN_STAFF, "branch_staff", "branch_one"),
    staffProfile(OWN_OWNER, "branch_owner", "branch_one"),
    staffProfile(OTHER_STAFF, "branch_staff", "branch_two"),
    staffProfile(BRAND, "brand_owner", "branch_one"),
    seed(`admins/${REGIONAL}`, {
      role: str("regional_manager"),
      branchIds: arr([str("branch_one"), str("branch_two")]),
      active: bool(true),
    }),
    seed(`users/${REGIONAL}`, { active: bool(true) }),
    // The discovery document: everything an operator legitimately renders.
    seed("branches/branch_one", {
      name: str("Surat Adajan"),
      city: str("Surat"),
      address: str("Prime Arcade"),
      phone: str("+912612345678"),
      coordinates: map({ lat: { doubleValue: 21.19 }, lng: { doubleValue: 72.79 } }),
      active: bool(true),
      acceptingOrdersStatus: str("open"),
    }),
    // The brand-only half: POS binding, vendor credentials, legacy restID list.
    seed("branch_secrets/branch_one", {
      branchId: str("branch_one"),
      petpoojaStoreId: str("PP_SURAT_01"),
      petpooja: map({ appKey: str("k"), accessToken: str("t") }),
      restIDs: arr([str("PP_SURAT_01")]),
    }),
  ]);
}, 30_000);

describe("branches stay readable; the identifiers do not", () => {
  it("allows an own-branch staff member to read the branch directory", async () => {
    expect(await read("branches/branch_one", TOKENS.ownStaff)).toBe(200);
  });

  it("allows a branch STAFF member to read another outlet's directory document", async () => {
    // The Partner outlet picker / city-scoped views query the collection; the
    // document no longer carries anything sensitive.
    expect(await read("branches/branch_one", TOKENS.otherStaff)).toBe(200);
  });

  it("allows a branch owner and a regional manager to read the directory", async () => {
    expect(await read("branches/branch_one", TOKENS.ownOwner)).toBe(200);
    expect(await read("branches/branch_one", TOKENS.regional)).toBe(200);
  });

  it("denies the branch's OWN staff the secrets document", async () => {
    expect(await read("branch_secrets/branch_one", TOKENS.ownStaff)).toBe(403);
  });

  it("denies the branch's own OWNER and a regional manager too", async () => {
    expect(await read("branch_secrets/branch_one", TOKENS.ownOwner)).toBe(403);
    expect(await read("branch_secrets/branch_one", TOKENS.regional)).toBe(403);
  });

  it("denies a member of another outlet", async () => {
    expect(await read("branch_secrets/branch_one", TOKENS.otherStaff)).toBe(403);
  });

  it("allows the brand owner (the only role that manages outlet linking)", async () => {
    expect(await read("branch_secrets/branch_one", TOKENS.brand)).toBe(200);
  });
});

describe("no client may write the identifiers onto a branch", () => {
  it("denies a branch owner planting petpoojaStoreId on its own branch", async () => {
    expect(
      await clientPatch("branches/branch_one", "petpoojaStoreId", str("PP_HIJACK"), TOKENS.ownOwner)
    ).toBe(403);
  });

  it("denies a branch owner planting the vendor credential map or the restID list", async () => {
    expect(
      await clientPatch("branches/branch_one", "petpooja", map({ appKey: str("stolen") }), TOKENS.ownOwner)
    ).toBe(403);
    expect(
      await clientPatch("branches/branch_one", "restIDs", arr([str("PP_OTHER")]), TOKENS.ownOwner)
    ).toBe(403);
  });

  it("denies re-planting the retired Route account id", async () => {
    expect(
      await clientPatch("branches/branch_one", "razorpayAccountId", str("acc_retired_1"), TOKENS.ownOwner)
    ).toBe(403);
  });

  it("denies a branch staff member writing the secrets document", async () => {
    expect(
      await clientPatch("branch_secrets/branch_one", "petpoojaStoreId", str("PP_HIJACK"), TOKENS.ownStaff)
    ).toBe(403);
  });

  it("still allows an ordinary branch field the app really edits (positive control)", async () => {
    expect(
      await clientPatch("branches/branch_one", "acceptingOrdersStatus", str("closed"), TOKENS.ownOwner)
    ).toBe(200);
  });
});
