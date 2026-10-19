import { db } from "../../core/firebase";
import { config, assertLivePetpoojaContext } from "../../config/env";
import { captureErrorSnapshot } from "../../core/errors";
import { getPetpoojaConfig } from "./client";
import * as admin from "firebase-admin";
import { assertBranchAccess, type StaffCaller } from "../../core/middleware";

export interface PetpoojaMenuItem {
  itemid: string;
  itemname: string;
  // Both spellings are kept: the legacy `item_description` the mapper used to
  // read, and `itemdescription` — the name the real push actually sends
  // (non-empty on 110/166 captured items). Same alias-tolerance as orderPush.
  item_description?: string;
  itemdescription?: string;
  price: string | number;
  itemcategoryname: string;
  itemcategoryid: string;
  // The real push keys the item's category as `item_categoryid` and joins it to
  // the top-level `categories[].categoryid` for the NAME; `itemcategoryid` is
  // the legacy spelling that was all the mapper read. The vendor sends a string
  // today, but a number is tolerated and normalised with `String(...)` on write.
  item_categoryid?: string | number;
  in_stock: string | number | boolean;
  item_attributeid?: string; // 1 = Veg, 2 = NonVeg, 3 = Egg
  itemimageurl?: string;
  item_image_url?: string;
  image_url?: string;
  image?: string;
  addon_groups?: any[];
  itemallowvariation?: string | number | boolean;
  variation?: unknown[];
}

/**
 * Builds `categoryid -> categoryname` from the payload's top-level `categories`
 * array — the join the push's item-level `item_categoryid` needs to resolve a
 * human name. The vendor sends the id on the ITEM (`item_categoryid`, e.g.
 * "90750") and the name only in the top-level catalog
 * (`categories[].categoryid` / `categories[].categoryname`), so neither side
 * alone is enough.
 *
 * The whole shape is guarded: `categories` may be absent, not an array, or
 * carry entries that are not objects or miss either key. A malformed catalog
 * degrades to the item's own legacy `itemcategoryname` (then "Other") — it must
 * never throw, and it must never turn an id the payload DID carry into "Other".
 *
 * A repeated `categoryid` is FIRST-wins: the first catalogued name for an id is
 * the one that survives, and later duplicates are ignored (see below).
 */
function buildCategoryNameMap(categories: any): Map<string, string> {
  const names = new Map<string, string>();
  if (!Array.isArray(categories)) return names;
  for (const entry of categories) {
    if (!entry || typeof entry !== "object") continue;
    const id = entry.categoryid;
    const name = entry.categoryname;
    if (id === undefined || id === null || String(id).trim() === "") continue;
    // An entry with no usable name cannot name anything — skip it so the item
    // falls through to the legacy name rather than to an empty string.
    if (typeof name !== "string" || name.trim() === "") continue;
    // FIRST-wins, NOT last-wins: the map is a join against the vendor's own
    // catalog, so the first name catalogued for an id is the one that survives.
    // A payload that repeats a `categoryid` previously let the LAST duplicate
    // overwrite the earlier entries; the earliest entry now wins and later
    // duplicates are ignored. The check is `!names.has(...)` (not `set` alone)
    // so the choice is explicit rather than an overwrite side effect.
    if (!names.has(String(id))) names.set(String(id), name);
  }
  return names;
}

/**
 * Synchronizes menu from Petpooja endpoint into the canonical `products`
 * collection — the single menu source both apps read (Partner filters by
 * `branchId`, Delivery by `restId`). `petpoojaItemId` is the join key for
 * 86-ing in both directions. Legacy `petpooja_products` /
 * `petpooja_categories` / `menu/{branch}/…` collections are deprecated.
 */
export async function syncPetpoojaMenu(branchId: string, caller?: StaffCaller, incomingMenu?: any): Promise<{
  itemCount: number;
  categoriesCount: number;
}> {
  // Staff boundary: branch-A staff cannot sync Branch-B's menu.
  if (caller) assertBranchAccess(caller, branchId);
  // ZERO-MOCK runtime gate: the canned catalog below must never be written
  // into the live `products` collection a real app is ordering from.
  assertLivePetpoojaContext(`menu sync for branch ${branchId}`);
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

  if (incomingMenu && Array.isArray(incomingMenu.items)) {
    // A Petpooja menu PUSH already carries the catalog — ingest it directly.
    // Re-fetching would hit the Menu API's S3 lookup, which fails with
    // "unable to fetch Object from s3 bucket" whenever the outlet's menu file
    // has not been provisioned yet.
    //
    // A FAILED push arrives in this same shape ({"success":"0","items":[...]}),
    // so `Array.isArray(items)` alone is not enough to accept one — a failed
    // push then synced its items and wrote a green COMPLETED row plus a branch
    // stamp. This branch classifies ITS OWN input (throwIfVendorRefusal), rather
    // than leaning on the caller: syncPetpoojaMenu is exported and takes
    // `incomingMenu` as a parameter, so any other caller could otherwise hand it
    // a body the vendor reported as failed and have it ingested.
    //
    // The `Array.isArray(items)` precondition just above is why that single check
    // is the COMPLETE guard for the shapes that can reach here: a non-object or
    // empty-object body (the "malformed" kind) has no `.items` array and is
    // refused by the precondition itself, so only the vendor kind needs an
    // explicit check.
    //
    // That acceptance is still not a provenance guarantee: classification needs a
    // POSITIVE signal, so a body that omits `success` (rule 4) is accepted here —
    // its unexplained `message`, if any, is recorded in the sync log's `error`
    // field instead (undocumentedVendorMessage), not silently reported as clean.
    // See menuApiFailureReason.
    throwIfVendorRefusal(incomingMenu, restId);
    menuData = incomingMenu;
  } else if (config.mock.petpoojaPos) {
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
              // Loop: hung gateway held the function until platform timeout.
              signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          // Documented Menu-API auth (app-key/app-secret/access-token) PLUS
          // the legacy Content_key/Bearer pair this integration shipped with.
          // Dual-send until the sandbox probe pins one shape — a wrong guess
          // here silently stops ALL catalog ingestion from the source of truth.
          "Content_key": petpoojaConfig.appKey,
          "app-key": petpoojaConfig.appKey,
          "app-secret": petpoojaConfig.appSecret,
          "access-token": petpoojaConfig.accessToken,
          Authorization: `Bearer ${petpoojaConfig.accessToken}`,
        },
        // Published contract names the outlet key `restID` (required); our
        // legacy call used `rest_id`. Same verified value under both spellings.
        body: JSON.stringify({ rest_id: restId, restID: restId }),
      });

      if (!response.ok) {
        throw new Error(`Petpooja Menu API responded with HTTP ${response.status}`);
      }

      const parsed: any = await response.json();

      // A 200 whose body reports the vendor's OWN failure is still a failure.
      // See menuApiFailureReason/classifyMenuBody: unchecked, a failed lookup
      // synced zero items and then logged COMPLETED/error:null — an outage that
      // looked healthy.
      // This call is also the shape guard: rules 1-2 refuse a null / array /
      // empty-object body BEFORE anything reads `.items`, which used to throw an
      // unclassified TypeError outside any named failure. A malformed body is
      // marked `malformedMenuBody` (severity stays high); a vendor refusal is
      // marked `vendorRefusal` (severity medium). Both happen inside this try, so
      // they route through the captureErrorSnapshot below.
      throwIfUnusableMenuBody(parsed, restId);
      menuData = parsed;
    } catch (err: any) {
      await captureErrorSnapshot({
        source: "petpooja",
        // The vendor's own refusal (e.g. an outlet whose menu file is not
        // provisioned yet) is expected and usually self-healing. The menu
        // scheduler ticks HOURLY, so a 'high' severity paged on-call every hour
        // for one un-provisioned outlet. Genuinely unexpected failures (network
        // error, timeout, non-2xx HTTP, unparseable JSON, a malformed body)
        // stay 'high'. The marker property, not the message text, is what
        // distinguishes them — message string-matching would break on any vendor
        // copy change.
        severity: err?.vendorRefusal === true ? "medium" : "high",
        message: `Failed to fetch Petpooja menu for branch ${branchId}: ${err.message}`,
        errorStack: err.stack,
        branchId,
      });
      throw err;
    }
  }

  // Every path that reaches here hands us a plain object: the live branch
  // refuses a non-object body via throwIfUnusableMenuBody (inside its snapshot
  // try), the push branch classifies its own input via throwIfVendorRefusal and
  // its `Array.isArray(items)` precondition refuses the malformed shapes, and the
  // canned mock body is a literal. So this read can no longer throw an
  // unclassified TypeError for a null/array response.
  const items = (menuData.items || []) as PetpoojaMenuItem[];
  const categories = menuData.categories || [];

  // Resolve the item -> category NAME join ONCE, before the loop: the real push
  // carries the id on each item and the name only in the top-level catalog.
  const categoryNames = buildCategoryNameMap(menuData.categories);

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

  // OBSERVABILITY ONLY — nothing below influences a single product document.
  // A real push carried `"in_stock": "2"` on all 166 items; the whitelist maps
  // that to `inStock: false`, so the whole catalogue rendered Sold Out while the
  // run still wrote a green COMPLETED sync-log row and stamped the branch — a
  // 100% dark catalogue was indistinguishable from a healthy sync, and nothing
  // warned. Two additions, both additive: census the RAW `in_stock` values as
  // they arrive (recorded on the sync-log row), and warn once when EVERY item
  // came out not-in-stock. Whether "2" means available or unavailable is
  // UNRESOLVED — that is exactly why the raw values are counted: the next real
  // push answers it without a code change.
  const rawInStockValues: Record<string, number> = {};
  let inStockTrueCount = 0;
  let unpricedSkuCount = 0;
  let unpricedInStockCount = 0;
  let unpricedVariationFlaggedCount = 0;
  let unpricedInStockVariationMissingCount = 0;

  for (const item of items) {
    // Doc id is branch-scoped: the same Petpooja itemid exists in every
    // outlet, and a global prod_{itemid} lets the second synced branch
    // overwrite (and steal) the first branch's doc.
    const productId = `prod_${branchId}_${item.itemid}`;
    const productRef = db.collection("products").doc(productId);
    const inStock = item.in_stock === 1 || item.in_stock === "1" || item.in_stock === true;

    // Census bucket. Normalised ONLY for grouping (`String(value)`), so "2"
    // stays "2" and the numeric 1 / "1" / true collapse to one key. An absent or
    // null flag is its own bucket ("(absent)") rather than being folded into the
    // string "undefined". Optional chaining keeps a non-object entry (a bare
    // string / number in `items`) from throwing here — this read must never be
    // the thing that fails a sync.
    const rawInStock = (item as any)?.in_stock;
    const rawInStockKey =
      rawInStock === undefined || rawInStock === null ? "(absent)" : String(rawInStock);
    rawInStockValues[rawInStockKey] = (rawInStockValues[rawInStockKey] || 0) + 1;
    if (inStock) inStockTrueCount++;

    // Record-only: keep the existing price mapping and stock whitelist intact.
    if (!(Number(item.price) > 0)) {
      unpricedSkuCount++;
      if (inStock) unpricedInStockCount++;
      const variationFlagged =
        item.itemallowvariation === "1" || item.itemallowvariation === 1 || item.itemallowvariation === true;
      if (variationFlagged) {
        unpricedVariationFlaggedCount++;
        // Item-local `variation` ONLY. The vendor blueprint marks the top-level
        // `variations` object deprecated ("Do not consume this object") and makes
        // the item-local array authoritative, so a non-empty top-level array must
        // never be read as "this item has variations". Counting it here understated
        // the money hazard: an unpriced, in-stock, variation-flagged item whose
        // item-local array is empty is exactly what this counter exists to catch,
        // whatever the deprecated object happens to carry.
        if (inStock && !(Array.isArray(item.variation) && item.variation.length > 0)) {
          unpricedInStockVariationMissingCount++;
        }
      }
    }

    const isVeg =
      item.item_attributeid !== undefined && item.item_attributeid !== null
        ? String(item.item_attributeid).trim() === "1"
        : true;

    // Read the vendor's OWN spellings first, keep the legacy ones as fallback
    // (alias-tolerant read, matching orderPush.ts). The push sends
    // `item_categoryid` / `itemdescription` / `item_image_url`; the mapper used
    // to read only `itemcategoryid` / `item_description` and so wrote every one
    // of the 166 captured docs as "uncategorized" / "Other" / "".
    // `String(...)` wraps the WHOLE resolution so a numeric `item_categoryid`
    // (the vendor sends strings today, but a number would otherwise be written
    // into the doc as a number) can never land on the document as a number. A
    // string input is unchanged ("90750" stays "90750") and the "uncategorized"
    // fallback stays.
    const categoryId = String(item.item_categoryid || item.itemcategoryid || "uncategorized");
    // The NAME lives only in the top-level catalog, keyed by the id above. If
    // the id is absent from that map, fall back to the item's legacy name, then
    // "Other" — an id the catalog DID carry always resolves to its real name.
    // The lookup normalises with the same String(...) so it stays consistent
    // with the (now always string) id above.
    const categoryName =
      categoryNames.get(String(categoryId)) || item.itemcategoryname || "Other";

    const productPayload = {
      id: productId,
      petpoojaItemId: item.itemid,
      name: item.itemname,
      description: item.itemdescription || item.item_description || "",
      price: Number(item.price) || 0,
      categoryId,
      categoryName,
      imageUrl:
        item.itemimageurl || item.item_image_url || item.image_url || item.image || null,
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

  // "The catalogue came out unorderable" gets ONE definition, shared by the
  // operator warning and by the sync-log readiness fields, so the two can never
  // drift apart. An EMPTY feed is deliberately not an all-dark catalogue (an API
  // glitch must not look like a 100% 86-ing), and a partially dark catalogue is
  // normal 86-ing — only "items ingested AND none available" qualifies.
  const allDark = items.length > 0 && inStockTrueCount === 0;
  const catalogueReady = items.length > 0 && inStockTrueCount > 0;
  const availabilityWarning = allDark ? "NO_ITEMS_IN_STOCK" : null;

  // The warning that would have caught the 166-item Sold-Out incident. A warn
  // only: it never throws and does not change `status`, `error` or the returned
  // counts.
  if (allDark) {
    const census = Object.entries(rawInStockValues)
      .map(([value, count]) => `${value} x${count}`)
      .join(", ");
    console.warn(
      `[Petpooja Menu Sync] menu sync for outlet ${restId} ingested ${items.length} items and NONE are in stock (raw in_stock: ${census}) — the whole catalogue will render as Sold Out; verify the vendor's in_stock encoding`
    );
  }

  // PRICE OBSERVABILITY: fire only when this becomes a live money hazard,
  // not while out-of-stock items make it harmless or on a healthy outlet.
  if (unpricedInStockCount > 0) {
    console.warn(
      `[Petpooja Menu Sync] outlet ${restId} ingested ${items.length} items: ${unpricedSkuCount} unpriced, ${unpricedInStockCount} unpriced in stock; ${unpricedInStockVariationMissingCount} of those are variation-flagged without definitions — live money hazard`
    );
  }

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
      // Paginated by doc id: the old single limit(1000) pass left SKUs past
      // the window live/orderable forever on catalogs bigger than the page.
      const TOMBSTONE_PAGE = 500;
      let lastDoc: any = null;
      let retired = 0;
      for (;;) {
        let pageQuery: any = db
          .collection("products")
          .where("branchId", "==", branchId)
          .orderBy("__name__")
          .limit(TOMBSTONE_PAGE);
        if (lastDoc && typeof pageQuery.startAfter === "function") {
          pageQuery = pageQuery.startAfter(lastDoc);
        }
        const existingSnap = await pageQuery.get();
        const docs = existingSnap.docs || [];
        for (const d of docs) {
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
        if (docs.length < TOMBSTONE_PAGE) break;
        lastDoc = docs[docs.length - 1];
        if (!lastDoc || typeof pageQuery.startAfter !== "function") break;
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
  //
  // FINDING 4c: an accepted body that carries a prose `message` and NO truthy
  // `success` is a vendor failure in a shape we have not captured — it must not
  // be recorded as a clean `error: null`. Refusing it outright was rejected: an
  // undocumented SUCCESS body nesting its catalogue under `restaurants` would
  // then be discarded (a self-inflicted outage). It stays ingesting, and the
  // vendor's own words land in the existing `error` field instead.
  const unexplainedVendorMessage = undocumentedVendorMessage(menuData);
  if (unexplainedVendorMessage) {
    console.warn(
      `[Petpooja Menu Sync] outlet ${restId} (branch ${branchId}) returned a catalogue body with no success flag but the message: ${unexplainedVendorMessage}`
    );
  }
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
      // TRUTHFUL READINESS: `status` reports that the INGEST completed, which
      // stayed true for a 100%-dark catalogue — exactly how a fully Sold-Out
      // outlet produced a green row with `error: null`. These two fields carry
      // what an operator or health check actually needs: whether anything in the
      // catalogue is orderable, and why not. Additive; `status` and `error` keep
      // their existing meanings, so no existing consumer changes behaviour.
      catalogueReady,
      availabilityWarning,
      deleted: 0,
      conflicts: 0,
      // ADDITIVE observability: the RAW `in_stock` values seen this run, grouped
      // by String(value) — e.g. { "2": 166 }. Record-only; it never influences
      // the products written, and no existing field is renamed or repurposed.
      inStockValues: rawInStockValues,
      unpricedSkuCount,
      unpricedInStockCount,
      unpricedVariationFlaggedCount,
      unpricedInStockVariationMissingCount,
      error: unexplainedVendorMessage,
      simulated: config.mock.petpoojaPos,
      source: "menuSyncWebhook",
    });
  } catch (err) {
    console.warn("[Petpooja] sync log persist failed (non-blocking):", (err as any)?.message || err);
  }

  return {
    itemCount: items.length,
    categoriesCount: categories.length,
  };
}

/**
 * Extracts the Petpooja restID (menu sharing code) from a menu payload.
 *
 * The Menu API's fetch response puts the code in `restaurants[].details`.
 * A **menu PUSH webhook** uses exactly the same shape — the code lives in
 * `restaurants[0].details.menusharingcode`, NOT in a top-level `rest_id`.
 * Reading only `rest_id` made every push throw "Missing rest_id" and answer
 * HTTP 400 (observed live: dashboard reported
 * `{"error":"","http_code":400}` for a perfectly valid push).
 *
 * Order matters: an explicit top-level `rest_id` still wins when a payload
 * carries one (legacy callers / Update Order Status), then the push's
 * `menusharingcode`, then the numeric `restaurantid`.
 */
export function extractMenuRestId(payload: any): string | null {
  const p = payload || {};
  const explicit = p.rest_id || p.res_id || p.restID || p.restId;
  if (explicit) return String(explicit);

  const restaurants = Array.isArray(p.restaurants) ? p.restaurants : [];
  for (const r of restaurants) {
    const details = r?.details || {};
    const code =
      details.menusharingcode ||
      details.menu_sharing_code ||
      details.restID ||
      r?.menusharingcode ||
      r?.restID;
    if (code) return String(code);
  }
  // Last resort: the numeric Petpooja restaurant id (e.g. "5439"). It is a
  // weaker join key than the sharing code — and as wired it CANNOT resolve to a
  // branch: resolveBranchIdForRestId (item86ingSync.ts) matches
  // where("petpoojaStoreId", "==", restId) EXACTLY, and ops links outlets with
  // the alphanumeric sharing code (e.g. "31z58ciw0h"), so a numeric
  // restaurantid never matches. Kept (rather than dropped) so the caller can log
  // the unlinked outlet loudly and stage it, instead of the push vanishing.
  for (const r of restaurants) {
    if (r?.restaurantid) return String(r.restaurantid);
  }
  return null;
}

/**
 * Why a Menu API body cannot be used for a sync — and which KIND of failure it
 * is. The kind matters: the two are not interchangeable downstream.
 *
 *   - "vendor"    the vendor itself reporting its own failure (a falsy
 *                 `success` / `status`). Expected and usually self-healing, so
 *                 it is recorded at severity `medium` and the webhook route
 *                 answers 503 ("retry").
 *   - "malformed" the body is not a menu object at all (not a plain object, or
 *                 a plain object with zero own keys). Genuinely unexpected — a
 *                 bug or a broken caller — so severity stays `high` and the
 *                 route answers 400 ("your request was malformed").
 *
 * Classifying these together as one "refusal" was a real bug: a push body of
 * `{}` / `null` / `[]` answered 503 ("retry") where it had always answered 400.
 */
interface MenuBodyClassification {
  kind: "vendor" | "malformed";
  /**
   * Human-readable detail WITHOUT the "for outlet X" prefix, which the callers
   * below add because it differs per kind.
   */
  reason: string;
}

/**
 * Classifies a Menu API body that cannot be used, else null (accept).
 *
 * A failure must carry a POSITIVE signal — it is never inferred from the ABSENCE
 * of a key. (An earlier revision also refused any body with no `success` key, no
 * top-level `items` array, and a non-empty `message`; that discarded legitimate
 * success bodies — an outage of our own making. A shape like that is now merely
 * FLAGGED in the sync log, see undocumentedVendorMessage.) The rules:
 *   1. not a plain object (null / undefined / array / scalar)
 *                                                       -> malformed
 *      ("response was not a menu object")
 *   2. a plain object with ZERO own keys                -> malformed
 *      ("response was an empty object")
 *   3. `success` PRESENT and FALSY (false, 0, null,
 *      undefined, "", or a string that trims and
 *      lowercases to "0" / "false")                     -> vendor
 *   3b. `success` ABSENT and `status` present and falsy -> vendor
 *      (the module's own canned body and the repo's
 *      probe scripts use `status:"success"` as the
 *      success key, so `status` is a real alternate
 *      signal; `success` always wins when both exist)
 *   4. otherwise                                        -> null (accept)
 * Every captured vendor failure body (the S3 failure body, save_order,
 * update_order_status) carries `success:"0"`, so success-based detection covers
 * every observed failure shape.
 */
function classifyMenuBody(menuData: any): MenuBodyClassification | null {
  // Rule 1: only a plain object can be a menu body. A null / array / scalar
  // body previously reached `menuData.items` and threw an unclassified
  // TypeError instead of a named failure.
  if (menuData === null || menuData === undefined || typeof menuData !== "object" || Array.isArray(menuData)) {
    return { kind: "malformed", reason: "response was not a menu object" };
  }
  const body = menuData as Record<string, any>;

  // Rule 2: an object with no own keys carries neither a signal nor a catalog.
  if (Object.keys(body).length === 0) {
    return { kind: "malformed", reason: "response was an empty object" };
  }

  // Rule 3: an explicitly falsy `success` is the vendor reporting its OWN
  // failure. An absent key, or any truthy value (true, 1, "1", "true"), is NOT
  // a failure — see rule 4.
  const hasSuccess = Object.prototype.hasOwnProperty.call(body, "success");
  if (hasSuccess && isFalsySuccessFlag(body.success)) {
    return { kind: "vendor", reason: bodyMessage(body) || `success=${JSON.stringify(body.success)}` };
  }

  // Rule 3b: `status` is an alternate success signal in this integration, so a
  // falsy `status` (and only when `success` is absent — success always wins) is
  // the same failure. A non-falsy `status` (200, "success") never makes a body a
  // failure.
  if (!hasSuccess && Object.prototype.hasOwnProperty.call(body, "status") && isFalsySuccessFlag(body.status)) {
    return { kind: "vendor", reason: bodyMessage(body) || `status=${JSON.stringify(body.status)}` };
  }

  // Rule 4: accept — including a genuinely empty catalog ({"success":"1",
  // "items":[]}) and a body that simply omits `success`. Deliberate: an
  // explicit failure that nevertheless carries a catalogue
  // ({"success":"0","items":[...]}) is refused by rule 3 BEFORE it reaches here
  // — an explicit vendor failure is never acted on, even when it ships items.
  return null;
}

/** Non-empty `message` string from a body, else null (never inferred). */
function bodyMessage(body: Record<string, any>): string | null {
  return typeof body.message === "string" && body.message.length > 0 ? body.message : null;
}

/** Renders a classification as the operator-facing error message. */
function menuBodyFailureMessage(classification: MenuBodyClassification, restId: string): string {
  const prefix =
    classification.kind === "vendor"
      ? `Petpooja Menu API refused the catalog lookup for outlet ${restId}`
      : `Petpooja Menu API answered for outlet ${restId} with no menu object`;
  return `${prefix}: ${classification.reason}`;
}

/**
 * Returns a human-readable reason when a Menu API response body reports the
 * VENDOR'S OWN failure or is malformed, else null.
 *
 * The Menu API reports failures with HTTP 200 — e.g.
 * `{"success":"0","message":"unable to fetch Object from s3 bucket"}`. Because
 * the live fetch only checked `response.ok`, that body fell through to
 * `menuData.items || []`, so a failed lookup synced zero items and then wrote a
 * `petpooja_sync_logs` row reading `COMPLETED / error: null / created: 0`, and
 * stamped `lastPetpoojaSync` + `petpoojaItemCount: 0` on the branch. An outlet in
 * the middle of a vendor outage was therefore indistinguishable from one that
 * honestly has no menu (observed live 2026-10-17T10:30Z for outlet 31z58ciw0h).
 *
 * Scope note, so this is not mistaken for a data-loss guard: the empty-feed
 * tombstone pass is separately guarded by `items.length > 0`, so this case never
 * retired anything. The harm is purely that a failure was reported as a success.
 *
 * Delegates to classifyMenuBody, which draws the vendor/malformed split; this
 * wrapper keeps its original name and signature for existing callers.
 */
export function menuApiFailureReason(menuData: any, restId: string): string | null {
  const classification = classifyMenuBody(menuData);
  return classification ? menuBodyFailureMessage(classification, restId) : null;
}

/**
 * Falsy `success` flag: false, numeric 0, `null`, `undefined` (a JS-object
 * caller can produce it), "", or a string that trims and lowercases to "0" /
 * "false". Anything else (1, "1", "true", or an arbitrary non-empty string such
 * as "00" / "no" / "error") is NOT a failure signal — the normalisation is
 * deliberately narrow. An ABSENT key is not evaluated here at all.
 */
function isFalsySuccessFlag(success: any): boolean {
  if (success === false || success === 0 || success === "" || success === null || success === undefined) {
    return true;
  }
  if (typeof success === "string") {
    const normalized = success.trim().toLowerCase();
    return normalized === "0" || normalized === "false";
  }
  return false;
}

/**
 * HTTP status for a failed `/petpooja/menu-sync` call.
 *
 * A vendor-side lookup refusal (e.g. the outlet's menu file is not provisioned
 * yet) is transient: 400 would tell Petpooja "your request was malformed — do
 * not retry". Answer 503 so it retries. Genuine caller errors (missing rest_id)
 * keep their 400.
 *
 * A MALFORMED body — one that parses but is unusable ({}, null, [], a scalar) —
 * also stays 400, and that is DELIBERATE, not an oversight. It is a protocol
 * fault, not a transient outage, so its severity stays high (see the live
 * fetch's captureErrorSnapshot). The /petpooja/menu-sync route is
 * operator-triggered from Petpooja's own dashboard, so there is no automatic
 * retry for the status code to steer, and 400 reads as "this is broken" from
 * either direction. Only an EXPLICIT vendor refusal (a present-and-falsy
 * `success`/`status`) is marked retryable with 503.
 */
export function menuSyncFailureStatus(err: any): number {
  return err?.vendorRefusal === true ? 503 : 400;
}

/** Throws a marked error for a classified failure. Never message-matched. */
function throwMarkedMenuBodyFailure(classification: MenuBodyClassification, restId: string): never {
  const err = new Error(menuBodyFailureMessage(classification, restId)) as Error & {
    vendorRefusal?: true;
    malformedMenuBody?: true;
  };
  if (classification.kind === "vendor") err.vendorRefusal = true;
  else err.malformedMenuBody = true;
  throw err;
}

/**
 * Throws a vendor-refusal-MARKED error when a menu body reports the vendor's
 * own failure; returns void otherwise. A MALFORMED body is deliberately NOT
 * thrown here — this call runs before the `rest_id` requirement, and a body
 * that is not a usable object cannot carry a `rest_id` anyway, so it falls
 * through to the existing "Missing rest_id" 400.
 *
 * The marker property (`vendorRefusal`) — not the message text — is what the
 * live fetch's captureErrorSnapshot (down to `medium` so an hourly scheduler
 * does not page on-call) and the `/petpooja/menu-sync` route (503, "retry")
 * branch on. Message string-matching would break on any vendor copy change.
 */
function throwIfVendorRefusal(menuData: any, restId: string): void {
  const classification = classifyMenuBody(menuData);
  if (classification?.kind === "vendor") throwMarkedMenuBodyFailure(classification, restId);
}

/**
 * Throws a marked error when a body is unusable for ANY reason — vendor refusal
 * or malformed. Used where the body must be a usable catalogue (the live fetch),
 * so that a null / array / empty-object body becomes a NAMED failure (severity
 * `high`) instead of an unclassified TypeError outside any named failure.
 */
function throwIfUnusableMenuBody(menuData: any, restId: string): void {
  const classification = classifyMenuBody(menuData);
  if (classification) throwMarkedMenuBodyFailure(classification, restId);
}

/**
 * A non-empty `message` from a body that carries NO truthy `success` — i.e. a
 * vendor failure in a shape we have not captured, such as
 * `{"message":"unable to fetch Object from s3 bucket"}`.
 *
 * FINDING 4c: refusing this shape outright (as an earlier revision did) risks a
 * self-inflicted outage on an undocumented SUCCESS body that nests its catalogue
 * under `restaurants`. So the body is still ingested, but it must not read as a
 * clean success: the sync-log row's `error` field carries this message instead
 * of null. A genuinely empty catalogue ({"success":"1","items":[]}) keeps
 * `error: null`.
 */
function undocumentedVendorMessage(menuData: any): string | null {
  if (!menuData || typeof menuData !== "object" || Array.isArray(menuData)) return null;
  const body = menuData as Record<string, any>;
  // A truthy `success` — or the truthy `status` alternate this module's canned
  // body and the repo's probe scripts use (see classifyMenuBody rule 3b) —
  // vouches for the catalogue. Honouring ONLY `success` here would flag a body
  // the classifier had just accepted, recording a false `error` on a clean sync.
  if (body.success || body.status) return null;
  return bodyMessage(body);
}

/**
 * Webhook handler for external menu pushes from Petpooja desktop POS.
 */
export async function handlePetpoojaMenuWebhook(payload: any): Promise<{
  success: boolean;
  itemCount: number;
}> {
  const p = payload || {};
  const restId = extractMenuRestId(p);

  // A menu PUSH carries the vendor's OWN success flag, and a FAILED push arrives
  // in the SAME shape as a good one — {"success":"0","items":[]}. Accepting on
  // `Array.isArray(incomingMenu.items)` alone therefore reported
  // {"success":true,"itemCount":0} for a push the vendor had already told us
  // failed, and wrote a green COMPLETED / created:0 row plus
  // petpoojaItemCount: 0. Classify BEFORE the rest_id requirement, so a failed
  // push is named as a vendor refusal (and answered 503, "retry") rather than as
  // a malformed request.
  //
  // Only the VENDOR kind is thrown here; a malformed body ({}, null, [], a
  // scalar) deliberately falls through to the rest_id check below, so it keeps
  // its historic 400 ("Missing rest_id") instead of being answered 503 for a
  // body that carries no rest_id and never could.
  throwIfVendorRefusal(p, restId || "(unidentified outlet)");

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

  const result = await syncPetpoojaMenu(branchId, undefined, p);
  return {
    success: true,
    itemCount: result.itemCount,
  };
}
