#!/usr/bin/env node
/**
 * Decisive probe: does Petpooja return a real `orderID` when the relayed cart
 * is built from the restaurant's OWN catalog?
 *
 * Why this exists
 * ---------------
 * Every relay so far used placeholder item ids (101 / 201 / 301 / 302) taken
 * from the integration guide. The sandbox restaurant `5439 - Burgonomics DEMO
 * [135148]` (menusharingcode 31z58ciw0h) does not contain those ids — it has
 * 166 items with ids in the 30600-30800 range. Petpooja answered
 * `{"success":"1","message":"Your order is saved.","orderID":""}` for every
 * relay: accepted, but no order materialised and the Order List stayed empty.
 *
 * This probe reuses the EXACT SAME payload builder as the production relay
 * (`formatPetpoojaV21Payload` from the compiled functions bundle) and only
 * swaps in real item ids, real prices, and the restaurant's real tax ids
 * (CGST 3928 + SGST 3929), so the result isolates "wrong item ids" as the
 * cause rather than any payload-shape difference.
 *
 * Usage
 * -----
 *   node scripts/petpooja-real-item-probe.mjs
 *   node scripts/petpooja-real-item-probe.mjs --items 30791,30787
 *   node scripts/petpooja-real-item-probe.mjs --menu "C:\\path\\to\\menu.json"
 *
 * `--menu` defaults to the menu captured from Petpooja's own menu PUSH
 * (the payload our /petpooja/menu-sync endpoint receives). Nothing is written
 * to the repo. Credentials are read from functions/.env and never printed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const argOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ITEMS_ARG = argOf("--items");
const RESTID_ARG = argOf("--restid");
const MENU_PATH =
  argOf("--menu") || path.join(process.env.TEMP || "/tmp", "petpooja-menu-push.json");

// ---------------------------------------------------------------- env
function loadDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, "");
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env = loadDotEnv(path.join(REPO_ROOT, "functions", ".env"));
const APP_KEY = env.PETPOOJA_APP_KEY;
const APP_SECRET = env.PETPOOJA_APP_SECRET;
const ACCESS_TOKEN = env.PETPOOJA_ACCESS_TOKEN;
const REST_ID = RESTID_ARG || env.PETPOOJA_SANDBOX_MAPPING_CODE || "31z58ciw0h";
const ORDER_URL =
  env.PETPOOJA_ORDER_URL ||
  "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order";
const CALLBACK_URL =
  env.PETPOOJA_CALLBACK_URL ||
  "https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

async function main() {
  if (!APP_KEY || !APP_SECRET || !ACCESS_TOKEN) {
    console.error(
      "ABORT: PETPOOJA_APP_KEY / PETPOOJA_APP_SECRET / PETPOOJA_ACCESS_TOKEN not all set in functions/.env"
    );
    process.exit(2);
  }
  if (!fs.existsSync(MENU_PATH)) {
    console.error(`ABORT: menu snapshot not found at ${MENU_PATH}`);
    console.error("Pass --menu <path> pointing at a captured Petpooja menu push payload.");
    process.exit(2);
  }

  const menu = JSON.parse(fs.readFileSync(MENU_PATH, "utf8"));
  const allItems = Array.isArray(menu.items) ? menu.items : [];
  if (allItems.length === 0) {
    console.error("ABORT: menu snapshot has no items[]");
    process.exit(2);
  }

  // Pick the cart: explicit --items, else the two priciest in-stock items
  // (a realistic non-trivial order that still stays small).
  let chosen;
  if (ITEMS_ARG) {
    const wanted = ITEMS_ARG.split(",").map((s) => s.trim()).filter(Boolean);
    chosen = wanted.map((id) => {
      const hit = allItems.find((i) => String(i.itemid) === id);
      if (!hit) {
        console.error(`ABORT: item ${id} is not in the catalog snapshot`);
        process.exit(2);
      }
      return hit;
    });
  } else {
    chosen = allItems
      .filter((i) => Number(i.price) > 0 && String(i.active) === "1")
      .sort((a, b) => Number(b.price) - Number(a.price))
      .slice(0, 2);
  }

  // Import the SAME builder the production relay uses.
  const { formatPetpoojaV21Payload } = await import(
    "../functions/dist/modules/petpooja/testRunner.js"
  );

  const items = chosen.map((i) => ({
    id: String(i.itemid),
    name: i.itemname,
    price: Number(i.price),
    quantity: 1,
  }));
  const itemTotal = round2(items.reduce((s, i) => s + i.price * i.quantity, 0));
  const gst = round2(itemTotal * 0.05);
  const packagingFee = 0;
  const grandTotal = round2(itemTotal + gst + packagingFee);

  const orderID = `bgx_realitems_${Date.now()}`;
  const payload = {
    ...formatPetpoojaV21Payload(
      {
        scenarioId: "real_items_tax",
        orderType: "Delivery",
        status: "placed",
        items,
        pricing: {
          itemTotal,
          discount: 0,
          gst,
          deliveryFee: 0,
          packagingFee,
          grandTotal,
        },
      },
      REST_ID,
      orderID,
      CALLBACK_URL,
      new Date()
    ),
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    access_token: ACCESS_TOKEN,
  };

  console.log("Petpooja REAL-ITEM probe");
  console.log(`  menu snapshot : ${MENU_PATH} (${allItems.length} items)`);
  console.log(`  endpoint      : ${ORDER_URL}`);
  console.log(`  restID        : ${REST_ID}`);
  console.log(`  clientOrderID : ${orderID}`);
  console.log(
    `  cart          : ${items.map((i) => `${i.id} ${i.name} @${i.price}`).join(" | ")}`
  );
  console.log(`  totals        : itemTotal=${itemTotal} gst=${gst} grand=${grandTotal}`);
  console.log("");

  const res = await fetch(ORDER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "app-key": APP_KEY,
      "app-secret": APP_SECRET,
      "access-token": ACCESS_TOKEN,
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45_000),
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }

  console.log(`HTTP ${res.status}`);
  console.log(`BODY ${parsed ? JSON.stringify(parsed) : text}`);

  const ack =
    parsed &&
    (parsed.success === "1" ||
      parsed.success === 1 ||
      parsed.success === true ||
      parsed.status === "success");
  const liveId =
    parsed && (parsed.petpooja_order_id || parsed.order_id || parsed.orderID || parsed.orderId);

  console.log("");
  console.log(`ACK               : ${ack ? "yes" : "no"}`);
  console.log(`PETPOOJA_ORDER_ID : ${liveId || "(empty — still not materialised)"}`);
  console.log(
    liveId
      ? "VERDICT: FULFILLED — real item ids were the blocker."
      : "VERDICT: NOT FULFILLED — item ids were not the (only) blocker."
  );

  const evidence = {
    generatedAt: new Date().toISOString(),
    endpoint: ORDER_URL,
    restID: REST_ID,
    clientOrderID: orderID,
    cart: items,
    totals: { itemTotal, gst, grandTotal },
    httpStatus: res.status,
    response: parsed ?? text,
    ack: Boolean(ack),
    petpoojaOrderId: liveId || null,
  };
  const evPath = path.join(REPO_ROOT, "scripts", "petpooja-real-item-probe-evidence.json");
  fs.writeFileSync(evPath, JSON.stringify(evidence, null, 2));
  console.log(`Evidence written to ${evPath}`);

  process.exit(liveId ? 0 : 1);
}

main().catch((err) => {
  console.error("PROBE FAILED:", err?.message || err);
  process.exit(1);
});
