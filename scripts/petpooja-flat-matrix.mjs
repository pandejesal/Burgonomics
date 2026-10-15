#!/usr/bin/env node
/**
 * Flat-contract matrix — the official PDF documents a FLAT payload, but every
 * complete flat attempt returns "Invalid order relay payload", while an
 * `orderinfo`-wrapped payload succeeds. This binary-searches the boundary to
 * find exactly what makes a flat body acceptable.
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
const REST_ID = env.PETPOOJA_SANDBOX_MAPPING_CODE || "";
const CALLBACK_URL = env.PETPOOJA_CALLBACK_URL || "https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook";
const ENDPOINTS = [
  "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order",
  "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order",
];

const now = new Date();
const p = (v) => String(v).padStart(2, "0");
const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
const time = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
const stamp = `${date} ${time}`;

let counter = 0;
const oid = () => `mx_${Date.now()}_${counter++}`;

const ITEM = (id, qty = "1", extra = {}) => ({
  id,
  name: "Veg Smash Burger",
  tax_inclusive: true,
  item_discount: "",
  price: "199.00",
  final_price: "199.00",
  quantity: qty,
  gst_liability: "restaurant",
  tax_percentage: "5",
  item_tax: [
    { id: "11213", name: "CGST", tax_percentage: "2.5", amount: "4.97" },
    { id: "20375", name: "SGST", tax_percentage: "2.5", amount: "4.97" },
  ],
  variation_name: "",
  variation_id: "",
  addon_items: [],
  ...extra,
});

const TAX = [
  { id: "301", title: "CGST", type: "P", price: "2.5%", tax: "4.97", restaurant_liable_amt: "4.97" },
  { id: "302", title: "SGST", type: "P", price: "2.5%", tax: "4.97", restaurant_liable_amt: "4.97" },
];

/** A complete flat body per the PDF's required-field tables. */
function flatBody(extra = {}, itemExtra = {}) {
  return {
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    access_token: ACCESS_TOKEN,
    res_name: "Burgonomics",
    address: "Burgonomics, Ahmedabad",
    contact_information: "",
    restID: REST_ID,
    name: "Petpooja Sandbox Tester",
    phone: "",
    email: "",
    latitude: "",
    longitude: "",
    orderID: oid(),
    preorder_date: date,
    preorder_time: time,
    advanced_order: "N",
    order_type: "P",
    total: "208.95",
    tax_total: "9.95",
    created_on: stamp,
    dc_tax_percentage: "5",
    pc_tax_percentage: "5",
    description: "flat matrix",
    payment_type: "COD",
    delivery_charges: "0.00",
    urgent_order: false,
    enable_delivery: "1",
    callback_url: CALLBACK_URL,
    packing_charges: "0.00",
    order_items: [ITEM("101", "1", itemExtra)],
    tax_details: TAX,
    discount_type: "F",
    discount_total: "0.00",
    ...extra,
  };
}

const VARIANTS = {
  "flat (baseline)": {},
  "flat + customer address": { address: "Sandbox Test Address, Ahmedabad" },
  "flat + udid/device_type": { udid: "burgonomics-sandbox", device_type: "Web" },
  "flat + numeric prices": {
    total: 208.95,
    tax_total: 9.95,
    order_items: [{ ...ITEM("101"), price: 199, final_price: 199 }],
  },
  "flat + item_discount 0": { order_items: [ITEM("101", "1", { item_discount: 0 })] },
  "flat + orderinfo wrapper removed but keys flat": {},
  "flat + no addon_items key": { order_items: [ITEM("101")] },
};

async function post(url, body) {
  const res = await fetch(url, {
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
  return (await res.text()).trim();
}

for (const endpoint of ENDPOINTS) {
  console.log(`\n===== ${endpoint} =====`);
  for (const [name, extra] of Object.entries(VARIANTS)) {
    if (name === "flat + no addon_items key") {
      const b = flatBody(extra);
      delete b.order_items[0].addon_items;
      console.log(`${name.padEnd(42)} → ${await post(endpoint, b)}`);
      continue;
    }
    console.log(`${name.padEnd(42)} → ${await post(endpoint, flatBody(extra))}`);
  }
}
