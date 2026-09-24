import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const verifyTokenMock = vi.fn();

vi.mock("firebase-admin", () => ({
  default: {
    appCheck: () => ({ verifyToken: verifyTokenMock }),
    firestore: vi.fn(() => ({})),
    auth: vi.fn(() => ({})),
    messaging: vi.fn(() => ({})),
    initializeApp: vi.fn(),
    apps: [{ name: "mock" }],
  },
  appCheck: () => ({ verifyToken: verifyTokenMock }),
  firestore: vi.fn(() => ({})),
  auth: vi.fn(() => ({})),
  messaging: vi.fn(() => ({})),
  initializeApp: vi.fn(),
  apps: [{ name: "mock" }],
}));

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((b: any) => {
    res.body = b;
    return res;
  });
  return res;
}

async function loadMiddlewareWithEnforcement(on: boolean) {
  vi.resetModules();
  process.env.APP_CHECK_ENFORCEMENT = on ? "true" : "false";
  return import("../src/core/middleware");
}

describe("requireAppCheck enforcement gate", () => {
  const prev = process.env.APP_CHECK_ENFORCEMENT;

  beforeEach(() => {
    verifyTokenMock.mockReset();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.APP_CHECK_ENFORCEMENT;
    else process.env.APP_CHECK_ENFORCEMENT = prev;
    vi.resetModules();
  });

  it("monitor mode: missing token passes through (never breaks clients)", async () => {
    const { requireAppCheck } = await loadMiddlewareWithEnforcement(false);
    const next = vi.fn();
    const res = mockRes();
    await requireAppCheck({ headers: {} } as any, res as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("monitor mode: invalid token is logged, never rejected", async () => {
    const { requireAppCheck } = await loadMiddlewareWithEnforcement(false);
    verifyTokenMock.mockRejectedValueOnce(new Error("bad token"));
    const next = vi.fn();
    const res = mockRes();
    await requireAppCheck({ headers: { "x-firebase-appcheck": "bogus" } } as any, res as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("enforcement: missing token is 403", async () => {
    const { requireAppCheck } = await loadMiddlewareWithEnforcement(true);
    const next = vi.fn();
    const res = mockRes();
    await requireAppCheck({ headers: {} } as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("enforcement: valid token passes", async () => {
    const { requireAppCheck } = await loadMiddlewareWithEnforcement(true);
    verifyTokenMock.mockResolvedValueOnce({ appId: "app_1" });
    const next = vi.fn();
    const res = mockRes();
    await requireAppCheck({ headers: { "x-firebase-appcheck": "good" } } as any, res as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("enforcement: forged token is 403", async () => {
    const { requireAppCheck } = await loadMiddlewareWithEnforcement(true);
    verifyTokenMock.mockRejectedValueOnce(new Error("forged"));
    const next = vi.fn();
    const res = mockRes();
    await requireAppCheck({ headers: { "x-firebase-appcheck": "forged" } } as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
