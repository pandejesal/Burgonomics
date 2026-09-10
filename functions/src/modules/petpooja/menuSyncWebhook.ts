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
  itemimageurl?: string;
  image_url?: string;
  image?: string;
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
  // branches/{id}.petpoojaStoreId — Runbook §5). Loop 6: FAIL CLOSED on
  // unlinked branches or failed lookups — the old fallback sent our internal
  // branchId as rest_id and wrote the WRONG outlet's menu into this branch's
  // prod_<branch>_* docs. The scheduler (allSettled) and the route (500)
  // both tolerate the throw; unlinked branches sync nothing until ops links
  // them.
  let restId: string;
  if (config.mock.petpoojaPos) {
    // Mock mode serves canned menu data (no outlet queried) — the strict
    // outlet binding below applies to live mode only.
    try {
      const branchSnap = await db.collection("branches").doc(branchId).get();
      restId = (branchSnap.data() as any)?.petpoojaStoreId || branchId;
    } catch {
      restId = branchId;
    }
  } else
  try {
    const branchSnap = await db.collection("branches").doc(branchId).get();
    const b = branchSnap.data() as any;
    if (!b?.petpoojaStoreId) {
      throw new Error(
        `Branch ${branchId} has no linked Petpooja outlet (petpoojaStoreId) — refusing menu sync (ops must link it per Runbook §5)`
      );
    }
    restId = b.petpoojaStoreId;
  } catch (err: any) {
    if (err?.message?.includes("no linked Petpooja outlet")) throw err;
    throw new Error(
      `Branch lookup failed for menu sync of ${branchId} — refusing to sync with an untrusted rest_id: ${err?.message || err}`
    );
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

  // Firestore batches cap at 500 writes — a >500-SKU catalog in one batch
  // silently drops the tail (H10/M30). Commit in ≤500-item chunks.
  const MENU_SYNC_BATCH_LIMIT = 500;
  let batch = db.batch();
  let writesInBatch = 0;
  const commitChunk = async () => {
    if (writesInBatch > 0) {
      await batch.commit();
      batch = db.batch();
      writesInBatch = 0;
    }
  };

  for (const item of items) {
    // Doc id is branch-scoped: the same Petpooja itemid exists in every
    // outlet, and a global prod_{itemid} lets the second synced branch
    // overwrite (and steal) the first branch's doc.
    const productId = `prod_${branchId}_${item.itemid}`;
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
      categoryId: item.itemcategoryid || "uncategorized",
      categoryName: item.itemcategoryname || "Other",
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
    writesInBatch++;
    if (writesInBatch >= MENU_SYNC_BATCH_LIMIT) {
      await commitChunk();
    }
  }

  await commitChunk();

  // Loop 6: tombstone pass — SKUs absent from the POS feed otherwise stay
  // live/orderable forever (ghost catalog → kitchen can't fulfill → refunds).
  // Live mode only (mock feeds are canned subsets; retiring around them would
  // wipe test catalogs). Never DELETE: flip inStock:false + ghostRetired so a
  // bad feed is recoverable. Local-only docs (combos / no petpoojaItemId) are
  // never touched. Skipped entirely on an empty feed (API glitch must not
  // retire the whole catalog).
  if (!config.mock.petpoojaPos && items.length > 0) {
    try {
      const feedIds = new Set(items.map((i) => String((i as PetpoojaMenuItem).itemid)));
      const existingSnap = await db
        .collection("products")
        .where("branchId", "==", branchId)
        .limit(1000)
        .get();
      let retired = 0;
      for (const d of existingSnap.docs || []) {
        const dd = (d.data() as any) || {};
        if (dd.isCombo) continue;
        const pid = dd.petpoojaItemId ? String(dd.petpoojaItemId) : null;
        if (!pid) continue;
        if (!feedIds.has(pid) && dd.inStock !== false) {
          await d.ref.set(
            {
              inStock: false,
              ghostRetired: true,
              ghostRetiredAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          retired++;
        }
      }
      if (retired > 0) {
        const { captureErrorSnapshot } = await import("../../core/errors");
        await captureErrorSnapshot({
          source: "petpooja",
          severity: "medium",
          message: `Menu sync retired ${retired} ghost SKU(s) for branch ${branchId} (absent from POS feed, flipped out-of-stock — not deleted)`,
          branchId,
        });
      }
    } catch (err: any) {
      console.warn(`[Petpooja Menu Sync] Ghost-SKU tombstone pass failed for ${branchId}:`, err?.message || err);
    }
  }

  await db.collection("branches").doc(branchId).set(
    {
      lastPetpoojaSync: admin.firestore.FieldValue.serverTimestamp(),
      petpoojaItemCount: items.length,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Server-side sync audit trail (clients cannot write here by rules).
  // doc().set (not .add) for wider datastore-shim compatibility.
  try {
    await db.collection("petpooja_sync_logs").doc().set({
      storeId: branchId,
      storeName: branchId,
      scope: "FULL",
      status: "COMPLETED",
      version: "live",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      duration: "live",
      created: items.length,
      updated: 0,
      deleted: 0,
      conflicts: 0,
      error: null,
      simulated: config.mock.petpoojaPos,
      source: "menuSyncWebhook",
    });
  } catch (err) {
    console.warn("[Petpooja] sync log persist failed (non-blocking):", err);
  }

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

  // rest_id is Petpooja's id, NOT our branchId — passing it through writes
  // products no branch-scoped view can find. Resolve first; skip loudly if
  // the outlet isn't linked yet (Runbook §5). Mock mode has no Petpooja, so
  // rest_id doubles as the test branch id (existing behavior preserved).
  const { config } = await import("../../config/env");
  let branchId: string | null = null;
  if (config.mock.petpoojaPos) {
    branchId = restId;
  } else {
    const { resolveBranchIdForRestId } = await import("./item86ingSync");
    branchId = await resolveBranchIdForRestId(restId);
  }
  if (!branchId) {
    console.warn(`[Petpooja Webhook] rest_id ${restId} has no linked branch — menu push skipped`);
    return { success: false, itemCount: 0 };
  }

  const result = await syncPetpoojaMenu(branchId);
  return {
    success: true,
    itemCount: result.itemCount,
  };
}
