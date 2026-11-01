import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Support-ticket photo evidence — Firebase Storage rules.
 *
 * Source of truth: ../storage.rules (deployed by the root firebase.json
 * `storage.rules` key). The customer app uploads through
 * src/features/support/services/supportService.ts uploadEvidence()
 * (lines 298-319) to support-evidence/{uid}/{ticketRef}/{ts}_{name} with
 * `contentType: file.type || "image/jpeg"`, and CreateTicketForm.tsx:70 caps
 * each file at 5 MB with a 3-file limit.
 *
 * Runs against the Storage emulator. Start it with:
 *   firebase emulators:exec --only storage "npx vitest run tests/storage.rules.test.ts"
 * (JAVA_HOME must be a JDK 21+ runtime; the repo runner uses the Android
 * Studio JBR on Windows.)
 *
 * The emulator is driven over its REST surface rather than through the Storage
 * SDK so this suite needs no new dependency in functions/ (the worktree has
 * neither @firebase/rules-unit-testing nor firebase). The mock bearer token is
 * the same unsigned JWT the rules-unit-testing SDK produces, so
 * request.auth.uid is exercised for real.
 */

// firebase-tools exports STORAGE_EMULATOR_HOST as "host:port" (sometimes with a
// scheme) when it launches the suite via `firebase emulators:exec`. Parse it
// instead of assuming the bare default host.
function resolveEmulator(): { host: string; port: number } {
  const raw = process.env.STORAGE_EMULATOR_HOST;
  if (raw && raw.trim()) {
    const cleaned = raw.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const idx = cleaned.lastIndexOf(":");
    if (idx > 0) {
      const port = Number(cleaned.slice(idx + 1));
      if (Number.isFinite(port) && port > 0) {
        return { host: cleaned.slice(0, idx), port };
      }
    }
    return { host: cleaned, port: 9199 };
  }
  return {
    host: "127.0.0.1",
    port: Number(process.env.STORAGE_EMULATOR_PORT ?? 9199),
  };
}

const { host: EMULATOR_HOST, port: EMULATOR_PORT } = resolveEmulator();
// Demo project id keeps the emulator from touching live infrastructure.
const PROJECT_ID = process.env.STORAGE_RULES_PROJECT ?? "demo-burgonomics-storage-rules";
const BUCKET = `${PROJECT_ID}.firebasestorage.app`;

const BASE = `http://${EMULATOR_HOST}:${EMULATOR_PORT}/v0/b/${BUCKET}/o`;
const MAX_BYTES = 5 * 1024 * 1024;

const OWNER = "uid_owner_ticket_1";
const STRANGER = "uid_stranger_ticket_1";

/** Unsigned mock JWT, same shape the Firebase rules-unit-testing SDK mints. */
function mockToken(uid: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    sub: uid,
    user_id: uid,
    auth_time: 0,
    iat: 0,
    exp: 9_999_999_999,
  })}.`;
}

interface UploadResult {
  status: number;
  body: string;
}

function authHeader(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function upload(
  path: string,
  token: string | null,
  opts: { contentType?: string; bytes?: Buffer } = {},
): Promise<UploadResult> {
  const res = await fetch(`${BASE}?name=${encodeURIComponent(path)}&uploadType=media`, {
    method: "POST",
    headers: {
      "Content-Type": opts.contentType ?? "image/png",
      ...authHeader(token),
    },
    body: opts.bytes ?? Buffer.from("tiny-png-bytes"),
  });
  return { status: res.status, body: (await res.text()).slice(0, 400) };
}

async function download(path: string, token: string | null): Promise<UploadResult> {
  const res = await fetch(`${BASE}/${encodeURIComponent(path)}`, {
    headers: authHeader(token),
  });
  return { status: res.status, body: (await res.text()).slice(0, 400) };
}

async function remove(path: string, token: string | null): Promise<UploadResult> {
  const res = await fetch(`${BASE}/${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: authHeader(token),
  });
  return { status: res.status, body: (await res.text()).slice(0, 400) };
}

/** A unique ticket ref per test so `resource == null` is genuinely exercised. */
let seq = 0;
function evidencePath(uid: string, name = "1_photo.png"): string {
  seq += 1;
  return `support-evidence/${uid}/tkt_test_${Date.now()}_${seq}/${name}`;
}

let emulatorUp = false;

beforeAll(async () => {
  // Probe a real bucket endpoint: the emulator's root path does not answer with
  // a 2xx, so a root fetch would report a false negative.
  try {
    const res = await fetch(`${BASE}/does-not-exist-probe`, {
      signal: AbortSignal.timeout(5000),
    });
    // 404 (missing object) or 403 (rules) both prove the emulator answered.
    emulatorUp = res.status === 404 || res.status === 403 || res.status === 200;
  } catch {
    emulatorUp = false;
  }
  if (!emulatorUp) {
    throw new Error(
      `Storage emulator not reachable on ${EMULATOR_HOST}:${EMULATOR_PORT}. ` +
        "Run: firebase emulators:exec --only storage \"npx vitest run tests/storage.rules.test.ts\" " +
        "(JAVA_HOME needs JDK 21+).",
    );
  }
});

afterAll(() => {
  // Nothing to tear down: the emulator is per-run and disposable.
});

describe("storage.rules source is wired to firebase.json", () => {
  it("declares the storage rules target the deployed config uses", () => {
    const firebaseJson = JSON.parse(
      readFileSync(resolve(__dirname, "../../firebase.json"), "utf8"),
    );
    expect(firebaseJson.storage?.rules).toBe("storage.rules");
  });

  it("keeps a default-deny match block", () => {
    const rules = readFileSync(resolve(__dirname, "../../storage.rules"), "utf8");
    expect(rules).toContain("allow read, write: if false;");
    expect(rules).toMatch(/match \/support-evidence\/\{uid\}\/\{ticketRef\}\/\{file\}/);
    expect(rules).toContain("request.auth.uid == uid");
    // Evidence is immutable: overwrite/delete must stay closed to clients.
    expect(rules).toContain("allow update, delete: if false;");
    // An upload to an existing path must not satisfy `create`.
    expect(rules).toContain("resource == null");
    // SVG is an executable document; it must not pass the image arm.
    expect(rules).toContain("!request.resource.contentType.matches('image/svg.*')");
  });
});

describe("support-evidence uploads", () => {
  it("1. allows the owner to create an image in their own folder", async () => {
    const path = evidencePath(OWNER);
    const res = await upload(path, mockToken(OWNER), { contentType: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body).toContain(path);
  });

  it("2. allows a jpeg and an image/webp from the owner", async () => {
    expect((await upload(evidencePath(OWNER, "2_a.jpg"), mockToken(OWNER), { contentType: "image/jpeg" })).status).toBe(200);
    expect((await upload(evidencePath(OWNER, "3_a.webp"), mockToken(OWNER), { contentType: "image/webp" })).status).toBe(200);
  });

  it("3. denies writing into another customer's folder", async () => {
    const path = evidencePath(STRANGER);
    const res = await upload(path, mockToken(OWNER), { contentType: "image/png" });
    expect(res.status).toBe(403);
  });

  it("4. allows a stranger to write their OWN folder (rule is per-uid, not 'owner only')", async () => {
    const path = evidencePath(STRANGER);
    const res = await upload(path, mockToken(STRANGER), { contentType: "image/png" });
    expect(res.status).toBe(200);
  });

  it("5. denies an unauthenticated upload", async () => {
    const res = await upload(evidencePath(OWNER), null, { contentType: "image/png" });
    expect(res.status).toBe(403);
  });

  it("6. denies a non-image content type", async () => {
    const cases = ["text/plain", "application/pdf", "image/svg+xml", "application/octet-stream"];
    for (const contentType of cases) {
      const res = await upload(evidencePath(OWNER), mockToken(OWNER), { contentType });
      expect(res.status, `contentType ${contentType} must be refused`).toBe(403);
    }
  });

  it("7. denies a file at or over the 5 MB client limit", async () => {
    const over = await upload(evidencePath(OWNER, "big.png"), mockToken(OWNER), {
      contentType: "image/png",
      bytes: Buffer.alloc(MAX_BYTES + 1),
    });
    expect(over.status).toBe(403);

    const exact = await upload(evidencePath(OWNER, "exact.png"), mockToken(OWNER), {
      contentType: "image/png",
      bytes: Buffer.alloc(MAX_BYTES),
    });
    expect(exact.status).toBe(403);
  });

  it("8. allows just under the limit", async () => {
    const res = await upload(evidencePath(OWNER, "edge.png"), mockToken(OWNER), {
      contentType: "image/png",
      bytes: Buffer.alloc(MAX_BYTES - 1),
    });
    expect(res.status).toBe(200);
  });

  it("9. denies overwriting an existing evidence object", async () => {
    const path = evidencePath(OWNER, "immutable.png");
    expect((await upload(path, mockToken(OWNER), { contentType: "image/png" })).status).toBe(200);
    const overwrite = await upload(path, mockToken(OWNER), {
      contentType: "image/png",
      bytes: Buffer.from("replacement-bytes"),
    });
    expect(overwrite.status).toBe(403);
  });

  it("10. denies deleting evidence", async () => {
    const path = evidencePath(OWNER, "keep.png");
    expect((await upload(path, mockToken(OWNER), { contentType: "image/png" })).status).toBe(200);
    const res = await remove(path, mockToken(OWNER));
    expect(res.status).toBe(403);
  });
});

describe("support-evidence reads", () => {
  it("11. allows the owner to read their own evidence", async () => {
    const path = evidencePath(OWNER, "readable.png");
    expect((await upload(path, mockToken(OWNER), { contentType: "image/png" })).status).toBe(200);
    const res = await download(path, mockToken(OWNER));
    expect(res.status).toBe(200);
  });

  it("12. denies another authenticated customer reading it", async () => {
    const path = evidencePath(OWNER, "private.png");
    expect((await upload(path, mockToken(OWNER), { contentType: "image/png" })).status).toBe(200);
    const res = await download(path, mockToken(STRANGER));
    expect(res.status).toBe(403);
  });

  it("13. denies an anonymous read", async () => {
    const path = evidencePath(OWNER, "private2.png");
    expect((await upload(path, mockToken(OWNER), { contentType: "image/png" })).status).toBe(200);
    const res = await download(path, null);
    expect(res.status).toBe(403);
  });
});

describe("paths outside support-evidence", () => {
  it("14. denies uploads anywhere else in the bucket", async () => {
    const paths = [
      `scratch/${OWNER}/x.png`,
      `support-evidence/${OWNER}.png`,
      `support-evidence/${OWNER}/x.png`,
      `avatars/${OWNER}/x.png`,
    ];
    for (const path of paths) {
      const res = await upload(path, mockToken(OWNER), { contentType: "image/png" });
      expect(res.status, `path ${path} must be refused`).toBe(403);
    }
  });
});
