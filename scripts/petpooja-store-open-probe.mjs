#!/usr/bin/env node
/**
 * Is the DEMO outlet actually accepting orders?
 *
 * With the corrected `orderinfo.OrderInfo.*.details` envelope the API now reads
 * back our real restID and clientOrderID, but still returns orderID:"". One
 * remaining server-side reason: the store's online ordering may be OFF, in
 * which case orders are acked but not registered.
 *
 * Uses the documented Stores API (POST /V1/update_store_status) to turn it on,
 * then re-sends ONE spec-shaped order.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

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
const REST_ID = env.PETPOOJA_SANDBOX_MAPPING_CODE || "31z58ciw0h";
const CALLBACK_URL =
  env.PETPOOJA_CALLBACK_URL ||
  "https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook";
const MENU_HOST = "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1";
const ORDER_URL = "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order";

const MENU_PATH = path.join(process.env.TEMP || "/tmp", "petpooja-menu-push.json");
const menu = JSON.parse(fs.readFileSync(MENU_PATH, "utf8"));
const items = (menu.items || []).filter((i) => Number(i.price) > 0 && String(i.active) === "1");
const cgst = (menu.taxes || []).find((x) => /cgst/i.test(x.taxname || ""));
const sgst = (menu.taxes || []).find((x) => /sgst/i.test(x.taxname || ""));

const money = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const HEADER_AUTH = {
  "Content-Type": "application/json",
  "app-key": APP_KEY,
  "app-secret": APP_SECRET,
  "access-token": ACCESS_TOKEN,
};

async function post(url, body, headers) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: headers || HEADER_AUTH,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: `FETCH_ERROR: ${err?.message || err}` };
  }
}

function istNow() {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t) => f.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${g("year")}-${g("month")}-${g("day")}`,
    time: `${g("hour")}:${g("minute")}:${g("second")}`,
    stamp: `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`,
  };
}

function specOrder(tag) {
  const rate = (Number(cgst.tax) + Number(sgst.tax)) / 100;
  const lines = items.slice(0, 1).map((item) => {
    const unit = Number(item.price);
    const half = r2(r2(unit * rate) / 2);
    return {
      id: String(item.itemid), name: item.itemname,
      price: money(unit), final_price: money(unit), quantity: "1",
      gst_liability: "restaurant", item_discount: "",
      item_tax: [
        { id: String(cgst.taxid), name: "CGST", tax_percentage: String(cgst.tax), amount: money(half) },
        { id: String(sgst.taxid), name: "SGST", tax_percentage: String(sgst.tax), amount: money(half) },
      ],
      variation_id: "", variation_name: "", AddonItem: { details: [] },
    };
  });
  const itemTotal = r2(lines.reduce((s, l) => s + Number(l.price), 0));
  const taxTotal = r2(itemTotal * rate);
  const t = istNow();
  return {
    app_key: APP_KEY, app_secret: APP_SECRET, access_token: ACCESS_TOKEN,
    callback_url: CALLBACK_URL,
    orderinfo: {
      OrderInfo: {
        Restaurant: { details: { restID: REST_ID, res_name: "Burgonomics DEMO", address: "Ahmedabad", contact_information: "1234567890" } },
        Customer: { details: { email: "burgonomicsind@gmail.com", name: "Burgonomics Sandbox Test", address: "Sandbox test order", phone: "9825000001" } },
        Order: {
          details: {
            orderID: `bgx_store_${tag}_${Date.now()}`, preorder_date: t.date, preorder_time: t.time,
            advanced_order: "N", order_type: "H", payment_type: "ONLINE",
            service_charge: "0", delivery_charges: "0", dc_tax_percentage: "0",
            packing_charges: "0", pc_tax_percentage: "0", discount_total: "0",
            tax_total: money(taxTotal), total: money(itemTotal + taxTotal),
            description: "store-status probe", created_on: t.stamp,
            enable_delivery: "0", callback_url: CALLBACK_URL, collect_cash: "0",
          },
        },
        OrderItem: { details: lines },
        Tax: {
          details: [
            { id: String(cgst.taxid), title: "CGST", type: "P", price: `${cgst.tax}%`, tax: money(r2(taxTotal / 2)), restaurant_liable_amt: money(r2(taxTotal / 2)) },
            { id: String(sgst.taxid), title: "SGST", type: "P", price: `${sgst.tax}%`, tax: money(r2(taxTotal / 2)), restaurant_liable_amt: money(r2(taxTotal / 2)) },
          ],
        },
        Discount: { details: [] },
      },
    },
  };
}

console.log("=== BEFORE (store status untouched) ===");
let r = await post(ORDER_URL, specOrder("before"));
console.log(`  HTTP ${r.status} ${r.text}`);

console.log("\n=== update_store_status: turn ON ===");
r = await post(`${MENU_HOST}/update_store_status`, {
  restID: REST_ID, store_status: "1", turn_on_time: "",
});
console.log(`  HTTP ${r.status} ${r.text}`);

console.log("\n=== AFTER (store turned on) ===");
r = await post(ORDER_URL, specOrder("after"));
console.log(`  HTTP ${r.status} ${r.text}`);
let parsed = null;
try { parsed = JSON.parse(r.text); } catch { /* non-JSON */ }
console.log(
  `\n  orderID after enabling: ${JSON.stringify(parsed?.orderID ?? null)}` +
    (parsed?.orderID ? "  <-- REGISTERED" : "  (still empty)")
);
