import { describe, it, expect, vi } from "vitest";

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
        get: vi.fn(async () => {
          const docPath = `${colName}/${docId}`;
          if (savedDocs[docPath]) {
            return { exists: true, data: () => savedDocs[docPath], ref: { set: vi.fn(async (d: any) => { savedDocs[docPath] = { ...savedDocs[docPath], ...d }; }) } };
          }
          if (colName === "branches") {
            return {
              exists: true,
              data: () => ({
                id: docId,
                name: "Burgonomics CG Road",
                razorpayAccountId: "acc_branch_ahmedabad_1",
                active: true,
                branchCoordinates: { lat: 23.0131, lng: 72.5085 },
              }),
            };
          }
          return {
            exists: true,
            data: () => savedDocs[docPath] || {},
            ref: {
              set: vi.fn(async (d: any) => {
                savedDocs[docPath] = { ...(savedDocs[docPath] || {}), ...d };
              }),
            },
          };
        }),
      }),
      where: (field: string, op: string, val: any) => {
        const query = {
          where: (f2: string, o2: string, v2: any) => query,
          limit: (n: number) => ({
            get: async () => ({
              empty: false,
              docs: [
                {
                  ref: {
                    set: vi.fn(async (data: any) => {
                      savedDocs[`${colName}/matched_doc`] = {
                        ...(savedDocs[`${colName}/matched_doc`] || {}),
                        ...data,
                      };
                    }),
                  },
                  data: () => ({ status: "ready" }),
                },
              ],
            }),
          }),
        };
        return query;
      },
    }),
    batch: () => ({
      set: vi.fn((ref: any, data: any) => {
        savedDocs[ref.id || "batch_doc"] = data;
      }),
      commit: async () => {},
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

import { calculateOrderPricing } from "../src/modules/payments/pricing.engine";
import {
  createPaymentOrder,
  verifyPayment,
  autoRefund,
  retryPendingRouteTransfersWorker,
} from "../src/modules/payments/razorpay.service";
import {
  pushOrderToPetpooja,
  handlePetpoojaWebhook,
} from "../src/modules/petpooja/petpooja.service";
import {
  getDeliveryQuote,
  bookPorterRider,
  handlePorterWebhook,
  verifyDeliveryOtp,
} from "../src/modules/porter/porter.service";

describe("End-to-End Platform Integration Flow", () => {
  const orderId = "ord_e2e_live_flow_001";
  const branchId = "branch_ahmedabad_cg_road";

  it("executes complete lifecycle: Price → Razorpay Route → Petpooja KOT → Porter 3PL Delivery", async () => {
    // 1. Calculate Authoritative Server Pricing & Route Split
    const pricing = await calculateOrderPricing({
      items: [
        { id: "pp_b1", name: "Classic Smash Cheese Burger", price: 199, quantity: 2, isVeg: true },
        { id: "pp_s1", name: "Cajun Seasoned Fries", price: 99, quantity: 1, isVeg: true },
      ],
      branchId,
      orderType: "delivery",
      deliveryFee: 40,
      packagingFee: 15,
    });

    expect(pricing.foodSubtotal).toBe(497); // 199*2 + 99
    expect(pricing.gst).toBe(24.85);
    expect(pricing.deliveryFee).toBe(40);
    expect(pricing.packagingFee).toBe(15);
    expect(pricing.grandTotal).toBe(577);

    // Route split: default 7% brand royalty, rest branch settlement
    expect(pricing.split.brandRoyaltyAmount).toBe(34.79);
    expect(pricing.split.branchTransferAmount).toBe(542.06);
    expect(pricing.split.brandRoyaltyPaise + pricing.split.branchTransferPaise).toBe(
      Math.round((497 + 15 + 40 + 24.85) * 100)
    );

    // Initialize mock order in Firestore
    savedDocs[`orders/${orderId}`] = {
      id: orderId,
      branchId,
      customerId: "cust_aarav_99",
      customerName: "Aarav Shah",
      customerPhone: "+91 98250 12345",
      orderType: "delivery",
      items: [
        { id: "pp_b1", name: "Classic Smash Cheese Burger", price: 199, quantity: 2, isVeg: true },
        { id: "pp_s1", name: "Cajun Seasoned Fries", price: 99, quantity: 1, isVeg: true },
      ],
      pricing,
      status: "pending_payment",
      branchCoordinates: { lat: 23.0131, lng: 72.5085 },
      deliveryAddress: {
        full: "102, Shivalik Highstreet, Vastrapur, Ahmedabad",
        lat: 23.0338,
        lng: 72.5262,
      },
    };

    // 2. Create Razorpay Payment Order with Route Notes
    const rzpOrder = await createPaymentOrder({
      orderId,
      items: savedDocs[`orders/${orderId}`].items,
      branchId,
      orderType: "delivery",
      deliveryFee: 40,
      packagingFee: 15,
      customerId: "cust_aarav_99",
    });

    expect(rzpOrder.razorpayOrderId).toBeDefined();
    expect(rzpOrder.amountPaise).toBe(Math.round(pricing.grandTotal * 100));

    // 3. Verify Payment & Execute Route Split Transfer
    const paymentVerification = await verifyPayment({
      orderId,
      razorpayOrderId: rzpOrder.razorpayOrderId,
      razorpayPaymentId: "pay_rzp_mock_98765",
      razorpaySignature: "mock_signature_valid",
    });

    expect(paymentVerification.success).toBe(true);
    expect(savedDocs[`orders/${orderId}`].status).toBe("accepted");
    expect(savedDocs[`orders/${orderId}`].paymentStatus).toBe("completed");
    expect(
      paymentVerification.transfer ||
        savedDocs[`orders/${orderId}`]["payment.routeTransfer"]
    ).toBeDefined();

    // 4. Push Order KOT to Petpooja POS
    const kotPushed = await pushOrderToPetpooja(orderId);
    expect(kotPushed).toBe(true);
    expect(savedDocs[`orders/${orderId}`].petpoojaStatus).toBe("synced");
    expect(savedDocs[`orders/${orderId}`].kotPrinted).toBe(true);

    // 5. Petpooja Webhook: Kitchen status transitions to FOOD_READY (Code 5)
    await handlePetpoojaWebhook({
      order_id: orderId,
      status: 5,
    });
    expect(savedDocs[`orders/${orderId}`].status).toBe("ready");

    // 6. Delivery Quote Calculation with 10-min Fee Lock TTL
    const quote = await getDeliveryQuote({
      pickupLat: 23.0131,
      pickupLng: 72.5085,
      dropLat: 23.0338,
      dropLng: 72.5262,
    });

    expect(quote.estimatedFare).toBeGreaterThanOrEqual(40);
    expect(quote.validForSeconds).toBe(600);
    expect(quote.expiresAt).toBeGreaterThan(Date.now());

    // 7. Book Porter 3PL Rider from Partner POS
    const dispatchResult = await bookPorterRider(orderId, "Store Manager");
    expect(dispatchResult.porterOrderId).toBeDefined();
    expect(dispatchResult.status).toBe("dispatched");
    expect(savedDocs[`orders/${orderId}`].deliveryStatus).toBe("dispatched");

    // 8. Porter Webhook: IN_TRANSIT
    await handlePorterWebhook("raw", "sig", {
      event: "IN_TRANSIT",
      request_id: `REQ-${orderId}`,
      order_id: dispatchResult.porterOrderId,
    });
    expect(savedDocs[`orders/${orderId}`].status).toBe("out_for_delivery");

    // 9. Customer Delivery OTP Verification on Handover
    const customerOtp =
      paymentVerification.deliveryOtp || savedDocs[`orders/${orderId}`].deliveryOtp;
    expect(customerOtp).toBeDefined();
    expect(customerOtp).toMatch(/^\d{4}$/);

    const otpVerification = await verifyDeliveryOtp({
      orderId,
      otp: customerOtp,
      staffName: "Courier Driver",
    });
    expect(otpVerification.success).toBe(true);
    expect(savedDocs[`orders/${orderId}`].status).toBe("delivered");
    expect(savedDocs[`orders/${orderId}`].deliveryStatus).toBe("delivered");
    expect(savedDocs[`orders/${orderId}`].deliveryVerifiedBy).toBe("customer_otp");

    // 10. Post-Checkout Auto-Refund Verification (Item 86ed during cooking)
    const refundResult = await autoRefund({
      orderId,
      razorpayPaymentId: "pay_rzp_mock_98765",
      amountRupees: 104, // 99 + 5% GST
      reason: "Kitchen 86ed Cajun Seasoned Fries",
    });

    expect(refundResult.id).toBeDefined();
    expect(savedDocs[`orders/${orderId}`].refundStatus).toBe("refunded");
    expect(savedDocs[`orders/${orderId}`].refundAmount).toBe(104);
  });

  it("drains pending_retry route transfers without throwing (mock-safe worker)", async () => {
    // The shared mock `where` returns a single order doc lacking branch/pricing/payment
    // linkage, so the worker must mark it failed (missing data) rather than throw.
    const result = await retryPendingRouteTransfersWorker();

    expect(result).toBeDefined();
    expect(typeof result.retriedCount).toBe("number");
    // Missing linkage is handled gracefully and never crashes the batch.
    expect(savedDocs["orders/matched_doc"]?.routeTransferStatus).toBe("failed");
  });
});
