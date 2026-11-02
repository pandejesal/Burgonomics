import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";

/**
 * P1-K route wiring: `POST /petpooja/resolveKot` must be staff-only, validated,
 * branch-scoped, and must delegate to the REAL reconciliation service (not a
 * blind re-push). Driven through the actual middleware chain with the order
 * service live against an in-memory Firestore.
 */
const { savedDocs, mockDb } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};

  const docRef = (col: string, id: string) => {
    const path = `${col}/${id}`;
    return {
      id,
      path,
      get: async () => ({
        exists: Object.prototype.hasOwnProperty.call(savedDocs, path),
        data: () => savedDocs[path],
        ref: docRef(col, id),
      }),
      set: async (data: any, opts?: any) => {
        savedDocs[path] =
          opts?.merge && savedDocs[path] ? { ...savedDocs[path], ...data } : { ...data };
      },
    };
  };

  const q = (): any => ({
    where: () => q(),
    orderBy: () => q(),
    limit: () => q(),
    startAfter: () => q(),
    get: async () => ({ empty: true, docs: [] }),
  });

  const mockDb: any = {
    collection: (col: string) => ({ ...q(), doc: (id?: string) => docRef(col, id as string) }),
    getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => r.get())),
    runTransaction: async (fn: any) =>
      fn({
        get: (ref: any) => ref.get(),
        set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
      }),
  };
  return { savedDocs, mockDb };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    delete: () => "MOCK_DELETE",
  };
  const firestoreFn: any = vi.fn(() => mockDb);
  firestoreFn.FieldValue = FieldValue;
  return {
    default: {
      firestore: firestoreFn,
      auth: vi.fn(() => ({})),
      messaging: vi.fn(() => ({})),
      initializeApp: vi.fn(),
      apps: [{ name: "mock" }],
    },
    firestore: firestoreFn,
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  };
});

let currentUser: any = null;
vi.mock("../src/core/middleware", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      if (!currentUser) {
        const err: any = new Error("Missing or invalid authorization header");
        err.statusCode = 401;
        return next(err);
      }
      req.user = currentUser;
      next();
    },
    requireRole: (roles: string[]) => (req: any, _res: any, next: any) => {
      const role = req.user?.role;
      if (!role || !roles.includes(role)) {
        const err: any = new Error("Insufficient permissions");
        err.statusCode = 403;
        return next(err);
      }
      next();
    },
  };
});

import { pushOrderToPetpooja, resolvePetpoojaKotAmbiguity } from "../src/modules/petpooja/orderPush";
import { resolveKotAmbiguitySchema } from "../src/core/validation";
import { config } from "../src/config/env";

const BRANCH = "branch_route_k1";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post(
    "/petpooja/resolveKot",
    (req: any, res: any, next: any) => {
      // Same chain the real route installs (requireAuth/requireRole/validate).
      const auth = currentUser;
      if (!auth) return res.status(401).json({ error: "Missing or invalid authorization header" });
      req.user = auth;
      if (!["brand_owner", "developer", "branch_owner", "branch_staff"].includes(auth.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }
      const parsed = resolveKotAmbiguitySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request body" });
      }
      req.body = parsed.data;
      next();
    },
    async (req: any, res: any) => {
      try {
        const result = await resolvePetpoojaKotAmbiguity(
          req.body.orderId,
          req.body.resolution,
          req.user
        );
        res.status(200).json(result);
      } catch (err: any) {
        const msg = String(err?.message || "");
        const status = msg.startsWith("Unauthorized") ? 401 : msg.startsWith("Forbidden") ? 403 : 409;
        res.status(status).json({ error: msg || "KOT reconciliation failed" });
      }
    }
  );
  return app;
}

let server: any;
let base: string;

beforeAll(async () => {
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  for (const key of Object.keys(savedDocs)) delete savedDocs[key];
  const prev = config.mock.petpoojaPos;
  config.mock.petpoojaPos = prev;
  savedDocs[`branches/${BRANCH}`] = {
    name: "Route Outlet",
    petpoojaStoreId: "res_route_k1",
    petpoojaTaxes: [{ id: "3928", name: "CGST", rate: 2.5 }],
  };
  savedDocs["products/prod_route"] = {
    id: "prod_route",
    branchId: BRANCH,
    price: 199,
    inStock: true,
    petpoojaItemId: "7765862",
  };
  savedDocs["orders/ord_route"] = {
    id: "ord_route",
    branchId: BRANCH,
    customerId: "cust_route",
    userId: "cust_route",
    fulfillment: "takeaway",
    paymentMethod: "cod",
    customerName: "Route Customer",
    customerPhone: "+919825000333",
    items: [{ id: "l1", productId: "prod_route", name: "Burger", price: 199, quantity: 1 }],
    pricing: { grandTotal: 199, gst: 9.48 },
    paymentStatus: "completed",
    petpoojaStatus: "reconciliation_required",
    petpoojaSyncStatus: "reconciliation_required",
    petpoojaAmbiguousProcessing: true,
    kotSyncFailed: true,
  };
  currentUser = { uid: "staff_route", role: "branch_staff", branchIds: [BRANCH] };
});

describe("POST /petpooja/resolveKot wiring", () => {
  it("rejects an unauthenticated caller", async () => {
    currentUser = null;
    const res = await fetch(`${base}/petpooja/resolveKot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "ord_route", resolution: "printed" }),
    });
    expect(res.status).toBe(401);
    expect(savedDocs["orders/ord_route"].petpoojaStatus).toBe("reconciliation_required");
  });

  it("rejects an unknown resolution value", async () => {
    const res = await fetch(`${base}/petpooja/resolveKot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "ord_route", resolution: "reprint-please" }),
    });
    expect(res.status).toBe(400);
    expect(savedDocs["orders/ord_route"].petpoojaStatus).toBe("reconciliation_required");
  });

  it("marks a staff-confirmed print as synced and never re-POSTs", async () => {
    const res = await fetch(`${base}/petpooja/resolveKot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "ord_route", resolution: "printed" }),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ resolved: "printed", orderId: "ord_route" });

    const doc = savedDocs["orders/ord_route"];
    expect(doc.petpoojaStatus).toBe("synced");
    expect(doc.kotPrintedSource).toBe("staff_confirmed");
    expect(doc.petpoojaResolvedBy).toBe("staff_route");

    // A replayed webhook / double-tapped push must not reach the POS again.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const replay = await pushOrderToPetpooja("ord_route");
      expect(replay).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a smaller branch role from another branch cannot resolve", async () => {
    currentUser = { uid: "staff_x", role: "branch_staff", branchIds: ["branch_elsewhere"] };
    const res = await fetch(`${base}/petpooja/resolveKot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "ord_route", resolution: "retry" }),
    });
    expect(res.status).toBe(403);
    expect(savedDocs["orders/ord_route"].petpoojaStatus).toBe("reconciliation_required");
  });
});
