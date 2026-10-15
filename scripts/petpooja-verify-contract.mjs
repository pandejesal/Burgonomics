#!/usr/bin/env node
/**
 * The winning combination: the sandbox dashboard confirms
 *   save_order = https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order
 * so the endpoint was right all along. The live API requires an `orderinfo`
 * envelope, while the official PDF documents the FIELDS. This posts the PDF's
 * documented fields INSIDE the `orderinfo` envelope.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let v = line.slice(eq + 1).trim().replace(/\s+#.*$/, "");
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}
const env = { ...loadEnv(path.join(ROOT, "functions", ".env")), ...process.env };

const APP_KEY = env.PETPOOJA_APP_KEY;
const APP_SECRET = env.PETPOOJA_APP_SECRET;
const ACCESS_TOKEN = env.PETPOOJA_ACCESS_TOKEN;
const ENDPOINT =
  env.PETPOOJA_ORDER_URL || "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order";
const REST_ID = env.PETPOOJA_SANDBOX_MAPPING_CODE || "";
const CALLBACK_URL = env.PETPOOJA_CALLBACK_URL || "https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook";

const now = new Date();
const p = (v) => String(v).padStart(2, "0");
const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
const time = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
const stamp = `${date} ${time}`;
const orderID = `bgx_oi_${Date.now()}`;

/** The PDF's documented order_items[] entry, verbatim field names. */
function item(id, name, price, qty = "1", extra = {}) {
  const linePrice = Number(price) * Number(qty);
  const tax = Math.round(linePrice * 0.05 * 100) / 100;
  const half = Math.round((tax / 2) * 100) / 100;
  return {
    id,
    name,
    tax_inclusive: true,
    item_discount: "",
    price: price.toFixed(2),
    final_price: linePrice.toFixed(2),
    quantity: qty,
    gst_liability: "restaurant",
    tax_percentage: "5",
    item_tax: [
      { id: "11213", name: "CGST", tax_percentage: "2.5", amount: half.toFixed(2) },
      { id: "20375", name: "SGST", tax_percentage: "2.5", amount: half.toFixed(2) },
    ],
    variation_name: "",
    variation_id: "",
    addon_items: [],
    ...extra,
  };
}

const items = [item("101", "Veg Smash Burger", 199)];
const itemTotal = 199;
const gst = Math.round(itemTotal * 0.05 * 100) / 100;
const halfGst = Math.round((gst / 2) * 100) / 100;
const total = itemTotal + gst;

const taxDetails = [
  { id: "301", title: "CGST", type: "P", price: "2.5%", tax: halfGst.toFixed(2), restaurant_liable_amt: halfGst.toFixed(2) },
  { id: "302", title: "SGST", type: "P", price: "2.5%", tax: halfGst.toFixed(2), restaurant_liable_amt: halfGst.toFixed(2) },
];

/** PDF fields, wrapped in the `orderinfo` envelope the live API requires. */
const body = {
  app_key: APP_KEY,
  app_secret: APP_SECRET,
  access_token: ACCESS_TOKEN,
  restID: REST_ID,
  orderinfo: {
    // §2 Restaurant
    res_name: "Burgonomics",
    address: "Burgonomics, Ahmedabad",
    contact_information: "",
    restID: REST_ID,
    // §3 Customer — `name` and `address` both REQUIRED
    name: "Petpooja Sandbox Tester",
    phone: "",
    email: "",
    address_customer: "", // `address` above is the restaurant address per §2
    latitude: "",
    longitude: "",
    // §4 Order
    orderID,
    preorder_date: date,
    preorder_time: time,
    advanced_order: "N",
    order_type: "P",
    total: total.toFixed(2),
    tax_total: gst.toFixed(2),
    created_on: stamp,
    dc_tax_percentage: "5",
    pc_tax_percentage: "5",
    description: "orderinfo + PDF-documented fields",
    // §5 Payment & delivery
    payment_type: "COD",
    delivery_charges: "0.00",
    urgent_order: false,
    enable_delivery: "1",
    // §6 Callbacks & charges
    callback_url: CALLBACK_URL,
    packing_charges: "0.00",
    // §7 Order items
    order_items: items,
    // §8 Tax & discount
    tax_details: taxDetails,
    discount_type: "F",
    discount_total: "0.00",
  },
  udid: "burgonomics-sandbox",
  device_type: "Web",
};

console.log(`endpoint : ${ENDPOINT}`);
console.log(`restID   : ${REST_ID}`);
console.log(`orderID  : ${orderID}\n`);

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "app-key": APP_KEY,
    "app-secret": APP_SECRET,
    "access-token": ACCESS_TOKEN,
    Authorization: `Bearer ${ACCESS_TOKEN}`,
  },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(`BODY ${text}`);

let parsed = null;
try { parsed = JSON.parse(text); } catch { /* ignore */ }
const ok = parsed && (parsed.success === "1" || parsed.success === 1 || parsed.success === true);
const hasIds = parsed && parsed.restID && parsed.orderID;
console.log(
  `\nVERDICT: ${ok ? "ACCEPTED" : "REJECTED"}` +
    (ok && hasIds ? ` with ids (restID=${parsed.restID}, orderID=${parsed.orderID})` : ok ? " but NO ids returned" : "")
);
process.exit(ok && hasIds ? 0 : 1);
