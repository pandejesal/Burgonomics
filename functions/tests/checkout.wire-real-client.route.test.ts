import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Composition proof for the Cycle 10 incident: the REAL Customer `HttpClient`
 * source, executed with the REAL `fetch` (undici), posting to the REAL Express
 * app from `src/index.ts` (real parser matcher, real `validateBody`, real route).
 *
 * Why this test exists: each half's unit tests passed while production failed.
 * The client test only inspected the object it handed to fetch, and the route
 * tests always sent a single canonical header. Neither composed the two, so
 * neither could see that a case-different merge produces
 * `application/json, application/json` and that the parser then skips the body.
 *
 * Enabled by `CHECKOUT_CUSTOMER_SRC` (path to the Customer `src` directory), so CI
 * that only checks out this repo skips it instead of failing. The capture-based
 * suite in `checkout.wire-content-type.route.test.ts` runs unconditionally.
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

const customerSrc = process.env.CHECKOUT_CUSTOMER_SRC;

interface HttpResult {
  status: number;
  data: unknown;
}

interface RealClient {
  post(url: string, body: unknown, init?: { headers?: Record<string, string> }): Promise<HttpResult>;
}

/**
 * Load the Customer's real `httpClient.ts` in-process.
 *
 * Only two module boundaries are supplied differently from the app: the config
 * module becomes a fixture (it reads VITE_* at import time) and Vite's
 * `import.meta.env` is defined. The transport module, the interceptor registry
 * and the error classes are the REAL Customer files, so the header merge, retry
 * policy and `dispatch`'s `fetch` call are all shipping code.
 *
 * The client refuses a cleartext base outside dev, so it is constructed with the
 * staging-shaped HTTPS sentinel below and every call passes an ABSOLUTE loopback
 * URL, which `resolveUrl` uses verbatim - no client code is altered and the
 * request still goes through Node's real fetch.
 */
const CLIENT_SENTINEL_BASE = "https://api.staging.invalid";

function loadRealCustomerClient(): RealClient {
  const srcRoot = customerSrc!;
  const cache = new Map<string, Record<string, unknown>>();

  const appConfigFixture = {
    api: {
      baseUrl: CLIENT_SENTINEL_BASE,
      timeoutMs: 5000,
      retry: { attempts: 1, backoffMs: 0 },
    },
  };

  /** Transpile and evaluate one Customer TypeScript module. */
  function loadTs(relativePath: string): Record<string, unknown> {
    const cached = cache.get(relativePath);
    if (cached) return cached;
    const file = join(srcRoot, relativePath);
    if (!existsSync(file)) throw new Error(`Customer module not found at ${file}`);
    const source = readFileSync(file, "utf8").replaceAll("import.meta.env", "__viteEnv");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: file,
    }).outputText;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(relativePath, module.exports);
    const require = (specifier: string) => resolve(specifier, relativePath);
    new Function("exports", "module", "require", "__viteEnv", transpiled)(
      module.exports,
      module,
      require,
      { DEV: false, PROD: true, MODE: "staging" },
    );
    return module.exports;
  }

  function resolve(specifier: string, fromRelative: string): unknown {
    if (specifier === "@/core/config" || specifier === "@/core/config/env") {
      return { appConfig: appConfigFixture };
    }
    if (specifier === "@/core/errors") {
      return {
        ...loadTs("core/errors/errorClasses.ts"),
        ...loadTs("core/errors/AppError.ts"),
      };
    }
    const alias = "@/";
    if (specifier.startsWith(alias)) return loadTs(`${specifier.slice(alias.length)}.ts`);
    if (specifier.startsWith(".")) {
      const fromDir = fromRelative.replace(/\/[^/]+$/, "");
      const parts = `${fromDir}/${specifier}`.split("/");
      const normalised: string[] = [];
      for (const part of parts) {
        if (part === "." || part === "") continue;
        if (part === "..") normalised.pop();
        else normalised.push(part);
      }
      return loadTs(`${normalised.join("/")}.ts`);
    }
    throw new Error(`Unexpected import from Customer HttpClient: ${specifier}`);
  }

  const exports = loadTs("core/network/httpClient.ts");
  const HttpClient = (exports as { HttpClient: new (options?: unknown) => RealClient }).HttpClient;
  return new HttpClient();
}

let server: Server;
let baseUrl: string;
/** Raw Content-Type header values the Express app actually received. */
let receivedContentTypes: string[] = [];
let receivedHeaderNames: string[] = [];

beforeAll(async () => {
  // A thin recorder in front of the REAL app: it observes the wire (including
  // duplicate header names) and then hands the request to Express untouched.
  server = createServer((req, res) => {
    receivedContentTypes = [];
    receivedHeaderNames = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === "content-type") {
        receivedHeaderNames.push(req.rawHeaders[i]);
        receivedContentTypes.push(req.rawHeaders[i + 1]);
      }
    }
    app(req, res);
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  verifyIdToken.mockReset();
});

const describeWithCustomer = customerSrc ? describe : describe.skip;

describeWithCustomer("Cycle 10: real Customer HttpClient -> real Express app", () => {
  it.each(["cash", "online"] as const)(
    "the %s lane's capital-cased override still reaches the route as parsed JSON",
    async (lane) => {
      verifyIdToken.mockResolvedValue({ uid: "cust_compose_c10", phone_number: "+910000000000" });
      const client = loadRealCustomerClient();
      const path = lane === "cash" ? "/orders/createCashOrder" : "/orders/createOnlineDraft";
      const body = {
        orderId: `ord_compose_${lane}_c10`,
        attemptId: `attempt_compose_${lane}_c10`,
        storeId: "str_fulfill",
        orderType: "takeaway",
        items: [{ productId: "burger_1", quantity: 1 }],
        ...(lane === "cash" ? { expectedTotalPaise: 10900 } : {}),
      };

      let status = 0;
      let payload: { code?: string; details?: string[] } = {};
      try {
        const response = await client.post(`${baseUrl}${path}`, body, {
          // Exactly what the checkout services add on top of the default.
          headers: { "Content-Type": "application/json", authorization: "Bearer wire-token" },
        });
        status = response.status;
        payload = (response.data ?? {}) as typeof payload;
      } catch (error) {
        const failure = error as { status?: number; response?: { data?: unknown } };
        status = failure.status ?? 0;
        payload = (failure.response?.data ?? {}) as typeof payload;
      }

      // The defect signature was a 400 with `details` naming missing fields,
      // because express.json() had skipped the body entirely.
      expect(payload.details, `status=${status} payload=${JSON.stringify(payload)}`).toBeUndefined();
      expect(status, `payload=${JSON.stringify(payload)}`).not.toBe(400);
      // A typed domain refusal (stubbed Firestore has no catalogue for the
      // store) or a created order both prove the JSON was parsed.
      expect(
        typeof payload.code === "string" || status === 201,
        `status=${status} payload=${JSON.stringify(payload)}`,
      ).toBe(true);
    },
  );

  it("records the deployed duplicate on the wire and one header after the fix", async () => {
    verifyIdToken.mockResolvedValue({ uid: "cust_compose_c10", phone_number: "+910000000000" });
    const client = loadRealCustomerClient();
    await client
      .post(
        `${baseUrl}/orders/createCashOrder`,
        {
          orderId: "ord_compose_wire_c10",
          storeId: "str_fulfill",
          orderType: "takeaway",
          items: [{ productId: "burger_1", quantity: 1 }],
          expectedTotalPaise: 10900,
        },
        { headers: { "Content-Type": "application/json", authorization: "Bearer wire-token" } },
      )
      .catch(() => undefined);

    // Exactly one Content-Type must reach the server. The deployed bundle sent
    // one header whose value was the joined pair, which type-is cannot match.
    expect(receivedContentTypes).toHaveLength(1);
    expect(receivedContentTypes[0]).toBe("application/json");
    expect(receivedContentTypes[0]).not.toContain(",");
    expect(receivedHeaderNames).toHaveLength(1);
  });

  it("never parses a body whose declared media type is not JSON", async () => {
    verifyIdToken.mockResolvedValue({ uid: "cust_compose_c10", phone_number: "+910000000000" });
    const client = loadRealCustomerClient();
    const status = await client
      .post(
        `${baseUrl}/orders/createCashOrder`,
        { orderId: "ord_compose_text_c10", orderType: "takeaway" },
        { headers: { "Content-Type": "text/plain", authorization: "Bearer wire-token" } },
      )
      .then(
        (response) => response.status,
        (error: { status?: number }) => error.status ?? 0,
      );
    // text/plain is not JSON: either the parser ignores it and validation sees an
    // empty body (400), or a conflicting list is refused (415). It must never
    // produce a parsed, accepted order.
    expect([400, 415]).toContain(status);
  });
});


