import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { autoRefund } from "../payments/razorpay.service";
import * as admin from "firebase-admin";

export interface PetpoojaMenuItem {
  itemid: string;
  itemname: string;
  item_description?: string;
  price: string | number;
  itemcategoryname: string;
  itemcategoryid: string;
  in_stock: string | number | boolean;
  item_attributeid?: string; // 1 = Veg, 2 = NonVeg
  addon_groups?: any[];
}

/**
 * Synchronizes menu from Petpooja V1 endpoint into Firestore branches/{branchId}/menu and products collection.
 */
export async function syncPetpoojaMenu(branchId: string): Promise<{
  itemCount: number;
  categoriesCount: number;
}> {
  let menuData: any;

  if (config.mock.petpoojaPos) {
    // Realistic sandbox mock menu
    menuData = {
      status: "success",
      categories: [
        { categoryid: "cat_burgers", categoryname: "Signature Burgers" },
        { categoryid: "cat_sides", categoryname: "Crispy Fries & Sides" },
        { categoryid: "cat_beverages", categoryname: "Beverages & Shakes" },
      ],
      items: [
        {
          itemid: "pp_b1",
          itemname: "Classic Smash Cheese Burger",
          item_description: "Crispy smashed veg patty, double cheddar, secret house sauce",
          price: 199,
          itemcategoryname: "Signature Burgers",
          itemcategoryid: "cat_burgers",
          in_stock: 1,
          item_attributeid: "1",
        },
        {
          itemid: "pp_b2",
          itemname: "Fiery Peri Peri Crunch Burger",
          item_description: "Spicy crisp patty dusted in peri peri spice with jalapeno mayo",
          price: 229,
          itemcategoryname: "Signature Burgers",
          itemcategoryid: "cat_burgers",
          in_stock: 1,
          item_attributeid: "1",
        },
        {
          itemid: "pp_s1",
          itemname: "Cajun Seasoned Fries",
          item_description: "Golden crispy fries tossed in zesty cajun herb blend",
          price: 99,
          itemcategoryname: "Crispy Fries & Sides",
          itemcategoryid: "cat_sides",
          in_stock: 1,
          item_attributeid: "1",
        },
        {
          itemid: "pp_d1",
          itemname: "Belgian Chocolate Milkshake",
          item_description: "Thick hand-spun shake made with rich Belgian dark cocoa",
          price: 149,
          itemcategoryname: "Beverages & Shakes",
          itemcategoryid: "cat_beverages",
          in_stock: 1,
          item_attributeid: "1",
        },
      ],
    };
  } else {
    try {
      const response = await fetch(config.petpooja.menuUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Content_key: config.petpooja.appKey,
          Authorization: `Bearer ${config.petpooja.accessToken}`,
        },
        body: JSON.stringify({ rest_id: branchId }),
      });

      if (!response.ok) {
        throw new Error(`Petpooja Menu API responded with HTTP ${response.status}`);
      }

      menuData = await response.json();
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "petpooja",
        severity: "high",
        message: `Failed to fetch Petpooja menu for branch ${branchId}: ${err.message}`,
        errorStack: err.stack,
        branchId,
      });
      throw err;
    }
  }

  const items = (menuData.items || []) as PetpoojaMenuItem[];
  const categories = menuData.categories || [];

  const batch = db.batch();

  // Save to products collection & branch menu
  for (const item of items) {
    const productId = `prod_${item.itemid}`;
    const productRef = db.collection("products").doc(productId);
    const inStock = item.in_stock === 1 || item.in_stock === "1" || item.in_stock === true;
    
    // Petpooja item_attributeid: "1" = Veg, "2" = NonVeg, "3" = Egg
    const isVeg =
      item.item_attributeid !== undefined && item.item_attributeid !== null
        ? String(item.item_attributeid).trim() === "1"
        : true;

    const productPayload = {
      id: productId,
      petpoojaItemId: item.itemid,
      name: item.itemname,
      description: item.item_description || "",
      price: Number(item.price) || 0,
      categoryId: item.itemcategoryid,
      categoryName: item.itemcategoryname,
      inStock,
      isVeg,
      branchId,
      lastPetpoojaSync: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    batch.set(productRef, productPayload, { merge: true });
  }

  await batch.commit();

  // Update branch metadata
  await db.collection("branches").doc(branchId).set(
    {
      lastPetpoojaSync: admin.firestore.FieldValue.serverTimestamp(),
      petpoojaItemCount: items.length,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return {
    itemCount: items.length,
    categoriesCount: categories.length,
  };
}

/**
 * Instant stock-out (86ing) webhook from Petpooja kitchen.
 */
export async function handlePetpoojaStockWebhook(payload: any): Promise<void> {
  const { rest_id, item_id, in_stock } = payload;
  const inStockBool = in_stock === 1 || in_stock === "1" || in_stock === true;

  if (item_id) {
    const productId = `prod_${item_id}`;
    await db.collection("products").doc(productId).set(
      {
        inStock: inStockBool,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  console.log(`[Petpooja 86ing] Item ${item_id} at branch ${rest_id} set inStock=${inStockBool}`);
}

/**
 * Pushes order KOT to Petpooja POS API upon payment confirmation.
 */
export async function pushOrderToPetpooja(orderId: string): Promise<boolean> {
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) {
    throw new Error(`Order ${orderId} does not exist`);
  }

  const order = orderDoc.data()!;
  const branchId = order.branchId;

  if (config.mock.petpoojaPos) {
    const mockPetpoojaOrderId = `pp_kot_${Date.now()}`;
    await orderDoc.ref.set(
      {
        petpoojaOrderId: mockPetpoojaOrderId,
        petpoojaStatus: "synced",
        petpoojaSyncStatus: "synced",
        kotPrinted: true,
        kotPrintedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  }

  try {
    let appKey = config.petpooja.appKey;
    let appSecret = config.petpooja.appSecret;
    let accessToken = config.petpooja.accessToken;

    if (branchId) {
      try {
        const branchSnap = await db.collection("branches").doc(branchId).get();
        const branchData = branchSnap.data();
        if (branchData?.petpooja) {
          appKey = branchData.petpooja.appKey || appKey;
          appSecret = branchData.petpooja.appSecret || appSecret;
          accessToken = branchData.petpooja.accessToken || accessToken;
        }
      } catch {
        // Fallback to global config
      }
    }

    const orderItems = (order.items || []).map((it: any) => ({
      item_id: it.petpoojaItemId || it.itemId || it.id,
      item_name: it.name,
      price: it.price,
      quantity: it.quantity,
      final_price: (it.price || 0) * (it.quantity || 1),
      addon_items: it.selectedAddons || [],
      item_attribute: it.isVeg !== false ? "1" : "2",
    }));

    const payload = {
      app_key: appKey,
      app_secret: appSecret,
      access_token: accessToken,
      rest_id: branchId,
      order_id: orderId,
      customer_name: order.customerName || "Customer",
      customer_phone: order.customerPhone || "9999999999",
      order_type: order.orderType || "delivery",
      order_items: orderItems,
      items: orderItems,
      tax_details: [
        {
          tax_name: "GST 5%",
          tax_percent: 5,
          tax_amount: order.pricing?.gst || order.tax || 0,
        },
      ],
      delivery_charges: order.pricing?.deliveryFee || order.deliveryFee || 0,
      packing_charges: order.pricing?.packagingFee || 0,
      discount_amount: order.pricing?.discount || 0,
      total_amount: order.pricing?.grandTotal || order.total || 0,
      total: order.pricing?.grandTotal || order.total || 0,
      payment_type: order.paymentMethod || "razorpay",
    };

    const response = await fetch(config.petpooja.orderUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Content_key: appKey,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (result.status === "success") {
      await orderDoc.ref.set(
        {
          petpoojaOrderId: result.petpooja_order_id || result.order_id,
          petpoojaStatus: "synced",
          petpoojaSyncStatus: "synced",
          kotPrinted: true,
          kotPrintedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return true;
    } else {
      throw new Error(result.message || "Petpooja KOT push rejected");
    }
  } catch (err: any) {
    console.warn(`[Petpooja KOT Push Error] Order ${orderId}: ${err.message}`);
    await orderDoc.ref.set(
      {
        petpoojaStatus: "pending_retry",
        petpoojaSyncStatus: "failed",
        petpoojaRetryCount: admin.firestore.FieldValue.increment(1),
        lastPetpoojaError: err.message,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await captureErrorSnapshot({
      source: "petpooja",
      severity: "medium",
      message: `Failed to push order KOT to Petpooja for order ${orderId}: ${err.message}`,
      orderId,
      branchId,
    });

    return false;
  }
}

/**
 * Normalizes Petpooja webhook order status from numeric or string values into standard Burgonomics status.
 * -1 = Cancelled / Void
 * 1, 2, 3 = Accepted / In Preparation
 * 4 = Dispatch / In Transit
 * 5 = Food Ready
 * 10 = Delivered / Completed
 */
export function normalizePetpoojaStatus(
  status: string | number | undefined | null
): "accepted" | "ready" | "out_for_delivery" | "delivered" | "cancelled" | "unknown" {
  if (status === undefined || status === null) return "unknown";
  const s = String(status).trim().toUpperCase();

  if (s === "-1" || s === "CANCELLED" || s === "REJECTED" || s === "VOID") {
    return "cancelled";
  }
  if (
    [
      "1",
      "2",
      "3",
      "ACCEPTED",
      "KITCHEN_ACCEPTED",
      "IN_PREPARATION",
      "PREPARING",
      "PREPARED",
    ].includes(s)
  ) {
    return "accepted";
  }
  if (["5", "FOOD_READY", "READY"].includes(s)) {
    return "ready";
  }
  if (["4", "DISPATCH", "DISPATCHED", "OUT_FOR_DELIVERY", "IN_TRANSIT"].includes(s)) {
    return "out_for_delivery";
  }
  if (["10", "DELIVERED", "COMPLETED", "CLOSED"].includes(s)) {
    return "delivered";
  }
  return "unknown";
}

/**
 * Handles kitchen state transitions & post-checkout item rejections from Petpooja.
 */
export async function handlePetpoojaWebhook(payload: any): Promise<void> {
  const { order_id, status, rejected_items } = payload;
  if (!order_id) return;

  const orderDoc = await db.collection("orders").doc(order_id).get();
  if (!orderDoc.exists) return;

  const order = orderDoc.data()!;

  // 1. Kitchen item rejection & auto-refund
  if (Array.isArray(rejected_items) && rejected_items.length > 0) {
    let refundAmount = 0;
    for (const item of rejected_items) {
      const price = Number(item.price) || 0;
      const qty = Number(item.quantity) || 1;
      const itemTotal = price * qty;
      const gst = itemTotal * 0.05; // 5% GST
      refundAmount += itemTotal + gst;
    }

    if (refundAmount > 0 && order.payment?.razorpayPaymentId) {
      await autoRefund({
        orderId: order_id,
        razorpayPaymentId: order.payment.razorpayPaymentId,
        amountRupees: Math.round(refundAmount),
        reason: `Kitchen 86ed items post-checkout: ${rejected_items
          .map((i: any) => i.name || i.item_name || i.item_id)
          .join(", ")}`,
      });
    }
  }

  // 2. Kitchen Status Transition with bidirectional normalization
  const normalizedStatus = normalizePetpoojaStatus(status);
  const updateData: Record<string, any> = {
    petpoojaKitchenStatus: status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (normalizedStatus !== "unknown") {
    updateData.status = normalizedStatus;
    updateData["status.kind"] = normalizedStatus;
  }

  await orderDoc.ref.set(updateData, { merge: true });
}
