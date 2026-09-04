import { db } from "../../core/firebase";
import { config } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getPetpoojaConfig } from "./client";
import * as admin from "firebase-admin";

export interface PetpoojaMenuItem {
  itemid: string;
  itemname: string;
  item_description?: string;
  price: string | number;
  itemcategoryname: string;
  itemcategoryid: string;
  in_stock: string | number | boolean;
  item_attributeid?: string; // 1 = Veg, 2 = NonVeg, 3 = Egg
  addon_groups?: any[];
}

/**
 * Synchronizes menu from Petpooja endpoint into the canonical `products`
 * collection — the single menu source both apps read (Partner filters by
 * `branchId`, Delivery by `restId`). `petpoojaItemId` is the join key for
 * 86-ing in both directions. Legacy `petpooja_products` /
 * `petpooja_categories` / `menu/{branch}/…` collections are deprecated.
 */
export async function syncPetpoojaMenu(branchId: string): Promise<{
  itemCount: number;
  categoriesCount: number;
}> {
  // Resolve the Petpooja restID for this branch (ops links outlets via
  // branches/{id}.petpoojaStoreId — Runbook §5). Falls back to branchId.
  let restId: string = branchId;
  try {
    const branchSnap = await db.collection("branches").doc(branchId).get();
    const b = branchSnap.data() as any;
    if (b?.petpoojaStoreId) restId = b.petpoojaStoreId;
  } catch {
    // branch lookup failure — proceed with branchId as restId
  }

  let menuData: any;

  if (config.mock.petpoojaPos) {
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
      const petpoojaConfig = getPetpoojaConfig();
      const response = await fetch(petpoojaConfig.menuUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Content_key: petpoojaConfig.appKey,
          Authorization: `Bearer ${petpoojaConfig.accessToken}`,
        },
        body: JSON.stringify({ rest_id: restId }),
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

  for (const item of items) {
    const productId = `prod_${item.itemid}`;
    const productRef = db.collection("products").doc(productId);
    const inStock = item.in_stock === 1 || item.in_stock === "1" || item.in_stock === true;

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
      imageUrl: item.itemimageurl || item.image_url || item.image || null,
      inStock,
      isVeg,
      branchId,
      // Delivery filters products by this restId (stores/{id}.petpoojaRestId
      // must equal the branch's restId once outlets are linked — Runbook §5).
      restId,
      lastPetpoojaSync: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    batch.set(productRef, productPayload, { merge: true });
  }

  await batch.commit();

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
 * Webhook handler for external menu pushes from Petpooja desktop POS.
 */
export async function handlePetpoojaMenuWebhook(payload: any): Promise<{
  success: boolean;
  itemCount: number;
}> {
  const restId = payload.rest_id || payload.res_id;
  if (!restId) {
    throw new Error("Missing rest_id in Petpooja menu webhook payload");
  }

  const result = await syncPetpoojaMenu(restId);
  return {
    success: true,
    itemCount: result.itemCount,
  };
}
