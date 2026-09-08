import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockDb, savedDocs } = vi.hoisted(() => {
  const savedDocs: Record<string, any> = {};
  const mockDb = {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        id: docId,
        set: vi.fn(async (data: any) => {
          savedDocs[`${colName}/${docId}`] = {
            ...(savedDocs[`${colName}/${docId}`] || {}),
            ...data,
          };
        }),
        get: vi.fn(async () => ({
          exists: true,
          data: () =>
            savedDocs[`${colName}/${docId}`] || {
              branchId: "branch_ahmedabad_1",
              branchName: "Burgonomics CG Road",
              branchCoordinates: { lat: 23.0131, lng: 72.5085 },
              deliveryAddress: {
                full: "102, Shivalik Highstreet, Vastrapur",
                lat: 23.0338,
                lng: 72.5262,
              },
              customerPhone: "+91 99999 88888",
              customerName: "Aarav Shah",
              status: "ready",
            },
          ref: {
            set: vi.fn(async (data: any) => {
              savedDocs[`${colName}/${docId}`] = {
                ...(savedDocs[`${colName}/${docId}`] || {}),
                ...data,
              };
            }),
          },
        })),
      }),
      where: (field: string, op: string, val: any) => ({
        limit: (n: number) => ({
          get: async () => ({
            empty: false,
            docs: [
              {
                ref: {
                  set: vi.fn(async (data: any) => {
                    savedDocs[`${colName}/matched_order`] = {
                      ...(savedDocs[`${colName}/matched_order`] || {}),
                      ...data,
                    };
                  }),
                },
                data: () => ({ status: "ready" }),
              },
            ],
          }),
        }),
      }),
    }),
  };
  return { mockDb, savedDocs };
});

vi.mock("firebase-admin", () => {
  const FieldValue = {
    serverTimestamp: () => "MOCK_TIMESTAMP",
    increment: (n: number) => n,
    arrayUnion: (item: any) => [item],
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

import {
  getDeliveryQuote,
  normalizePorterEvent,
  bookPorterRider,
  handlePorterWebhook,
  generateDeliveryOtp,
  verifyDeliveryOtp,
  manualBranchDispatch,
  pollActivePorterOrdersWorker,
} from "../src/modules/porter/porter.service";
import { checkBranchDeliveryServiceability } from "../src/core/utils/geo.utils";
import { computeHmacSha256 } from "../src/core/security";
import { config } from "../src/config/env";

// Fail-closed test rig (H-M2/H-M3): sandbox paths engage ONLY via explicit
// opt-in flags — never auto-mock. Webhook + OTP secrets are test-only values.
const TEST_PORTER_WEBHOOK_SECRET = "test_porter_whsec_vitest_only";
const TEST_OTP_SECRET = "test_otp_hmac_vitest_only";

let prevMockPorter = false;
let prevPorterSecret = "";
let prevOtpSecret: string | undefined;

beforeEach(() => {
  prevMockPorter = config.mock.porterDispatch;
  config.mock.porterDispatch = true;
  prevPorterSecret = config.porter.webhookSecret;
  config.porter.webhookSecret = TEST_PORTER_WEBHOOK_SECRET;
  prevOtpSecret = process.env.OTP_HMAC_SECRET;
  process.env.OTP_HMAC_SECRET = TEST_OTP_SECRET;
});

afterEach(() => {
  config.mock.porterDispatch = prevMockPorter;
  config.porter.webhookSecret = prevPorterSecret;
  if (prevOtpSecret === undefined) delete process.env.OTP_HMAC_SECRET;
  else process.env.OTP_HMAC_SECRET = prevOtpSecret;
});

const porterSig = (rawBody: string) =>
  computeHmacSha256(rawBody, TEST_PORTER_WEBHOOK_SECRET);

describe("Porter Logistics Service", () => {
  describe("getDeliveryQuote", () => {
    it("calculates live fare quote based on pickup and drop distance", async () => {
      const quote = await getDeliveryQuote({
        pickupLat: 23.0131,
        pickupLng: 72.5085,
        dropLat: 23.0338,
        dropLng: 72.5262,
      });

      expect(quote).toBeDefined();
      expect(quote.estimatedDistanceKm).toBeGreaterThan(0);
      expect(quote.estimatedFare).toBeGreaterThanOrEqual(40);
      expect(quote.vehicleType).toContain("2-Wheeler");
      expect(quote.validForSeconds).toBe(600);
      expect(quote.expiresAt).toBeGreaterThan(Date.now());
    });

    it("applies base minimum fare of ₹40 for short trips under 2km", async () => {
      const quote = await getDeliveryQuote({
        pickupLat: 23.0131,
        pickupLng: 72.5085,
        dropLat: 23.0141, // very close (~150m)
        dropLng: 72.509,
      });

      expect(quote.estimatedFare).toBe(40);
    });
  });

  describe("normalizePorterEvent", () => {
    it("reconciles Porter standard events with platform events", () => {
      expect(normalizePorterEvent("ASSIGNED")).toBe("DRIVER_ALLOCATED");
      expect(normalizePorterEvent("DRIVER_ALLOCATED")).toBe("DRIVER_ALLOCATED");
      expect(normalizePorterEvent("ARRIVED_AT_PICKUP")).toBe("ARRIVED_AT_PICKUP");
      expect(normalizePorterEvent("IN_TRANSIT")).toBe("STARTED_DELIVERY");
      expect(normalizePorterEvent("STARTED_DELIVERY")).toBe("STARTED_DELIVERY");
      expect(normalizePorterEvent("DELIVERED")).toBe("DELIVERED");
      expect(normalizePorterEvent("CANCELLED")).toBe("RIDER_CANCELLED");
      expect(normalizePorterEvent("RIDER_CANCELLED")).toBe("RIDER_CANCELLED");
    });
  });

  describe("bookPorterRider & handlePorterWebhook", () => {
    it("books Porter rider and stores dispatch metadata", async () => {
      const result = await bookPorterRider("order_prt_101", "Store Manager");
      expect(result).toBeDefined();
      expect(result.porterOrderId).toMatch(/^PRTR-ORD-/);
      expect(result.riderName).toBeDefined();
      expect(result.status).toBe("dispatched");
      expect(savedDocs["orders/order_prt_101"]?.deliveryStatus).toBe("dispatched");
      // Geo provenance is the contract: live_gps or fallback_default, never absent.
      expect(result.geoSource).toBeDefined();
      expect(savedDocs["orders/order_prt_101"]?.dispatchGeoSource).toBeDefined();
    });

    it("processes Porter webhook transit and delivery events", async () => {
      // 1. In Transit (valid HMAC — the enforced live path, no mock bypass)
      await handlePorterWebhook("raw_body", porterSig("raw_body"), {
        event: "IN_TRANSIT",
        request_id: "REQ-order_prt_101",
        order_id: "PRTR-ORD-12345",
      });
      expect(savedDocs["orders/order_prt_101"]?.status).toMatchObject({
        code: "OUT_FOR_DELIVERY",
        kind: "in_progress",
      });
      expect(savedDocs["orders/order_prt_101"]?.deliveryStatus).toBe("in_transit");

      // 2. Delivered
      await handlePorterWebhook("raw_body", porterSig("raw_body"), {
        event: "DELIVERED",
        request_id: "REQ-order_prt_101",
        order_id: "PRTR-ORD-12345",
      });
      expect(savedDocs["orders/order_prt_101"]?.status).toMatchObject({
        code: "DELIVERED",
        kind: "completed",
        terminal: true,
      });
      expect(savedDocs["orders/order_prt_101"]?.deliveryStatus).toBe("delivered");
    });

    it("rejects a forged Porter webhook with 401 semantics and zero writes", async () => {
      const before = Object.keys(savedDocs).length;
      const err: any = await handlePorterWebhook("raw_body", "forged_signature", {
        event: "DELIVERED",
        request_id: "REQ-order_prt_forged",
        order_id: "PRTR-ORD-99999",
      }).then(
        () => null,
        (e) => e
      );
      expect(err?.message).toMatch(/Invalid Porter webhook signature/);
      expect(err?.statusCode).toBe(401);
      // Fail-closed: no order flip, no parked doc, no writes at all.
      expect(Object.keys(savedDocs).length).toBe(before);
      expect(savedDocs["orders/order_prt_forged"]).toBeUndefined();
    });
  });

  describe("Delivery OTP Verification & Manual Dispatch", () => {
    it("generates a 4-digit numeric OTP", () => {
      const otp = generateDeliveryOtp();
      expect(otp).toMatch(/^\d{4}$/);
    });

    it("verifies valid customer OTP and marks order delivered", async () => {
      savedDocs["orders/order_otp_101"] = {
        id: "order_otp_101",
        deliveryOtpHash: computeHmacSha256("4589", TEST_OTP_SECRET),
        status: "out_for_delivery",
      };

      const res = await verifyDeliveryOtp({
        orderId: "order_otp_101",
        otp: "4589",
        staffName: "Karan Cashier",
      });

      expect(res.success).toBe(true);
      expect(savedDocs["orders/order_otp_101"]?.status).toMatchObject({
        code: "DELIVERED",
        kind: "completed",
        terminal: true,
      });
      expect(savedDocs["orders/order_otp_101"]?.deliveryVerifiedBy).toBe("customer_otp");
    });

    it("rejects invalid delivery OTP with descriptive error", async () => {
      savedDocs["orders/order_otp_102"] = {
        id: "order_otp_102",
        deliveryOtpHash: computeHmacSha256("8899", TEST_OTP_SECRET),
        status: "out_for_delivery",
      };

      await expect(
        verifyDeliveryOtp({
          orderId: "order_otp_102",
          otp: "1234",
        })
      ).rejects.toThrow(/Invalid Delivery OTP/);
    });

    it("locks out after 3 wrong attempts and recovers on expiry", async () => {
      savedDocs["orders/order_otp_109"] = {
        id: "order_otp_109",
        deliveryOtpHash: computeHmacSha256("7777", TEST_OTP_SECRET),
        status: "out_for_delivery",
      };

      await expect(verifyDeliveryOtp({ orderId: "order_otp_109", otp: "0000" })).rejects.toThrow(
        /Invalid Delivery OTP/
      );
      await expect(verifyDeliveryOtp({ orderId: "order_otp_109", otp: "0001" })).rejects.toThrow(
        /Invalid Delivery OTP/
      );
      await expect(verifyDeliveryOtp({ orderId: "order_otp_109", otp: "0002" })).rejects.toThrow(
        /Too many wrong attempts/
      );
      // Locked: even the right code is rejected until expiry
      await expect(verifyDeliveryOtp({ orderId: "order_otp_109", otp: "7777" })).rejects.toThrow(
        /Too many wrong attempts/
      );
      expect(savedDocs["orders/order_otp_109"]?.deliveryOtpAttempts).toBe(3);

      // After expiry the right code succeeds and clears the counter
      savedDocs["orders/order_otp_109"].deliveryOtpLockedUntil = Date.now() - 1000;
      const res = await verifyDeliveryOtp({ orderId: "order_otp_109", otp: "7777" });
      expect(res.success).toBe(true);
      expect(savedDocs["orders/order_otp_109"]?.deliveryOtpAttempts).toBe(0);
    });

    it("falls back to legacy plaintext OTP when no hash is stored", async () => {
      savedDocs["orders/order_otp_103"] = {
        id: "order_otp_103",
        deliveryOtp: "4589",
        status: "out_for_delivery",
      };

      const res = await verifyDeliveryOtp({
        orderId: "order_otp_103",
        otp: "4589",
        staffName: "Karan Cashier",
      });

      expect(res.success).toBe(true);
      expect(savedDocs["orders/order_otp_103"]?.status).toMatchObject({
        code: "DELIVERED",
        kind: "completed",
        terminal: true,
      });
      expect(savedDocs["orders/order_otp_103"]?.deliveryVerifiedBy).toBe("customer_otp");
    });

    it("denies OTP verification and dispatch for staff outside the order branch", async () => {
      savedDocs["orders/order_branch_a"] = {
        id: "order_branch_a",
        branchId: "branch_surat_01",
        deliveryOtpHash: computeHmacSha256("1111", TEST_OTP_SECRET),
        status: "out_for_delivery",
      };
      const outsider = { uid: "staff_b", role: "branch_staff", branchIds: ["branch_ahmedabad_01"] };

      await expect(
        verifyDeliveryOtp({ orderId: "order_branch_a", otp: "1111", caller: outsider })
      ).rejects.toThrow(/outside your assigned branches/);
      await expect(
        manualBranchDispatch({
          orderId: "order_branch_a",
          riderName: "Rider X",
          riderPhone: "+91 90000 00000",
          caller: outsider,
        })
      ).rejects.toThrow(/outside your assigned branches/);
      // Failed auth must not burn OTP attempts
      expect(savedDocs["orders/order_branch_a"]?.deliveryOtpAttempts || 0).toBe(0);
    });

    it("allows OTP verification for staff holding the order branch", async () => {
      savedDocs["orders/order_branch_b"] = {
        id: "order_branch_b",
        branchId: "branch_surat_01",
        deliveryOtpHash: computeHmacSha256("2222", TEST_OTP_SECRET),
        status: "out_for_delivery",
      };
      const insider = { uid: "staff_a", role: "branch_staff", branchIds: ["branch_surat_01"] };

      const res = await verifyDeliveryOtp({
        orderId: "order_branch_b",
        otp: "2222",
        caller: insider,
      });
      expect(res.success).toBe(true);
    });

    it("dispatches order manually via Branch POS Terminal fallback", async () => {
      savedDocs["orders/order_manual_103"] = {
        id: "order_manual_103",
        status: "ready",
      };

      const result = await manualBranchDispatch({
        orderId: "order_manual_103",
        riderName: "Vikram Local Rider",
        riderPhone: "+91 98980 12345",
        staffName: "Branch Manager",
      });

      expect(result.success).toBe(true);
      expect(savedDocs["orders/order_manual_103"]?.dispatchType).toBe("manual_branch_terminal");
      expect(savedDocs["orders/order_manual_103"]?.riderName).toBe("Vikram Local Rider");
      expect(savedDocs["orders/order_manual_103"]?.deliveryStatus).toBe("dispatched");
    });

    it("runs 5-minute polling fallback worker safely", async () => {
      const result = await pollActivePorterOrdersWorker();
      expect(result).toBeDefined();
      expect(typeof result.polledCount).toBe("number");
      expect(typeof result.updatedCount).toBe("number");
    });

    it("accurately evaluates branch delivery serviceability within and outside radius", () => {
      const branchLat = 21.1518;
      const branchLng = 72.7758;

      // Drop ~2km away (serviced)
      const nearResult = checkBranchDeliveryServiceability(branchLat, branchLng, 21.1650, 72.7850, 8.0);
      expect(nearResult.isServiced).toBe(true);
      expect(nearResult.distanceKm).toBeLessThanOrEqual(8.0);

      // Drop ~15km away (not serviced)
      const farResult = checkBranchDeliveryServiceability(branchLat, branchLng, 21.2800, 72.8800, 8.0);
      expect(farResult.isServiced).toBe(false);
      expect(farResult.distanceKm).toBeGreaterThan(8.0);
      expect(farResult.reason).toContain("exceeds the 8km branch delivery zone");
    });
  });
});
