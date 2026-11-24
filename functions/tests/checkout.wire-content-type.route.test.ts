import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Cycle 10 staging (2026-11-24, Customer 67371ec / backend 568f151): cash
 * checkout on /checkout and /payment, online draft creation and a valid ₹0
 * checkout all returned HTTP 400 BEFORE any order was written.
 *
 * Captured cause (tester trace, checkout-400-trace): the deployed bundle passed
 * fetch an init object with BOTH `content-type` (HttpClient default) and
 * `Content-Type` (payment services), and the browser serialised them into ONE
 * header: `application/json, application/json`. `type-is` does not match that,
 * so `express.json()` skipped the body and `validateBody` saw `{}` — the
 * field-level 400 the tester recorded.
 *
 * This suite drives the REAL Express app from src/index.ts (real parser matcher,
 * real error handler, real routes) with the exact captured header value and the
 * exact captured bodies. Only firebase-admin auth is stubbed; nothing here
 * parses the body on the test's behalf.
 */
vi.hoisted(() => {
  process.env.BURGONOMICS_ENV = "dev";
  process.env.APP_CHECK_ENFORCEMENT = "";
});

const { verifyIdToken } = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (value: unknown) => ({ union: value }),
    arrayRemove: (...values: unknown[]) => ({ remove: values }),
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => ({
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        get: async () => ({ exists: false, data: () => undefined }),
        set: async () => undefined,
      })),
      where: vi.fn(() => ({ limit: vi.fn(() => ({ get: async () => ({ empty: true, docs: [] }) })) })),
      get: async () => ({ empty: true, docs: [] }),
    })),
    runTransaction: async (fn: any) => fn({ get: async () => ({ exists: false }), set: () => undefined }),
  }));
  firestoreFn.FieldValue = FieldValue;
  const authFn: any = vi.fn(() => ({ verifyIdToken, getUser: vi.fn() }));
  return {
    default: {
      firestore: firestoreFn,
      auth: authFn,
      messaging: vi.fn(() => ({ send: vi.fn() })),
      appCheck: vi.fn(() => ({ verifyToken: vi.fn() })),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
      credential: { cert: vi.fn() },
    },
    firestore: firestoreFn,
    auth: authFn,
    messaging: vi.fn(() => ({ send: vi.fn() })),
    appCheck: vi.fn(() => ({ verifyToken: vi.fn() })),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
    credential: { cert: vi.fn() },
  };
});

import { app } from "../src/index";

const captured = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "checkout-wire-cycle10.json"), "utf8"),
) as {
  deployedContentType: string;
  canonicalContentType: string;
  lanes: Record<string, { path: string; body: Record<string, unknown> }>;
};

/**
 * Rebuild the deployed header from the two client shapes that produced it:
 * HttpClient's lowercase default plus the payment services' capital override,
 * spread into one object. Fetch then joins the two distinct keys with ", ".
 */
function deployedHeaderValue(): string {
  const merged = {
    ...{ "content-type": "application/json" },
    ...{ "Content-Type": "application/json" },
  };
  return new Headers(merged).get("content-type") ?? "";
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The staging tester was signed in, so auth passes and validation decides. */
function authenticate() {
  verifyIdToken.mockResolvedValue({ uid: "cust_wire_c10", phone_number: "+910000000000" });
}

function post(path: string, contentType: string, body: string, token = "wire-token") {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": contentType, authorization: `Bearer ${token}` },
    body,
  });
}

/**
 * Replay the EXACT init object the deployed app handed to `fetch`: two
 * case-different Content-Type keys (HttpClient default + service override) plus
 * the lowercase authorization the interceptor added. Node's real fetch (undici)
 * serialises that the same way the browser did, so this exercises the wire
 * itself rather than a pre-joined string.
 */
function postDuplicatedInitKeys(path: string, body: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Content-Type": "application/json",
      authorization: "Bearer wire-token",
    },
    body,
  });
}

describe("Cycle 10 checkout wire content type", () => {
  it("pins the captured header to the duplicated-key shape the deployed UI produced", () => {
    // Guards the fixture: if either client literal changes, the capture no
    // longer describes the deployed defect and these tests must be revisited.
    expect(deployedHeaderValue()).toBe(captured.deployedContentType);
    expect(captured.deployedContentType).toBe("application/json, application/json");
  });

  it.each(["cash", "online", "zero"] as const)(
    "parses the captured duplicate media type on the %s lane instead of failing the body as empty",
    async (lane) => {
      authenticate();
      const { path, body } = captured.lanes[lane];
      const res = await post(path, captured.deployedContentType, JSON.stringify(body));
      const payload = (await res.json()) as { code?: string; details?: string[] };
      // Before the fix these were 400 with `details` ("items: expected array,
      // received undefined") because the body was never parsed.
      expect(payload.details).toBeUndefined();
      expect(res.status).not.toBe(400);
      expect(typeof payload.code).toBe("string");
    },
  );

  it.each(["cash", "online", "zero"] as const)(
    "parses the same request when the client hands fetch two case-different Content-Type keys on the %s lane",
    async (lane) => {
      authenticate();
      const { path, body } = captured.lanes[lane];
      // This is the deployed shape at the source: the join is produced by the
      // HTTP stack, not by the test's string literal.
      const res = await postDuplicatedInitKeys(path, JSON.stringify(body));
      const payload = (await res.json()) as { code?: string; details?: string[] };
      expect(payload.details).toBeUndefined();
      expect(res.status).not.toBe(400);
      expect(typeof payload.code).toBe("string");
    },
  );

  it.each(["cash", "online", "zero"] as const)(
    "parses the same captured body on the %s lane with a canonical media type",
    async (lane) => {
      authenticate();
      const { path, body } = captured.lanes[lane];
      const res = await post(path, captured.canonicalContentType, JSON.stringify(body));
      const payload = (await res.json()) as { code?: string; details?: string[] };
      expect(payload.details).toBeUndefined();
      expect(res.status).not.toBe(400);
      expect(typeof payload.code).toBe("string");
    },
  );

  it("still accepts a charset parameter on the media type", async () => {
    authenticate();
    const { path, body } = captured.lanes.cash;
    const res = await post(path, "application/json; charset=utf-8", JSON.stringify(body));
    expect(((await res.json()) as { details?: string[] }).details).toBeUndefined();
    expect(res.status).not.toBe(400);
  });

  it("refuses a non-JSON body with a typed 415 instead of parsing it as JSON", async () => {
    authenticate();
    const { path, body } = captured.lanes.cash;
    const res = await post(path, "text/plain, application/json", JSON.stringify(body));
    expect(res.status).toBe(415);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "INVALID_CONTENT_TYPE" });
  });

  it("does not widen to a purely non-JSON type", async () => {
    authenticate();
    const { path, body } = captured.lanes.cash;
    const res = await post(path, "text/plain", JSON.stringify(body));
    // express.json() ignores a non-JSON type entirely: the body stays unparsed
    // and validation answers 400. It must never be read as JSON.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { details?: string[] }).details?.length).toBeGreaterThan(0);
  });

  it("keeps malformed JSON as INVALID_JSON", async () => {
    const { path } = captured.lanes.cash;
    const res = await post(path, captured.deployedContentType, '{"orderId":');
    expect(res.status).toBe(400);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "INVALID_JSON" });
  });
});
