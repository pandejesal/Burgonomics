#!/usr/bin/env node
/**
 * Contract probe — finds which save_order payload shape the Petpooja sandbox
 * actually accepts. The repo carries two conflicting descriptions:
 *   - flat V2.1.0 (references/petpooja_save_order_api.md, from the official PDFs)
 *   - nested orderinfo/OrderInfo (references/petpooja_pos.md P1)
 * This posts a minimal-but-complete payload in each shape and prints the raw
 * POS response so the accepted contract can be read straight off the server.
 *
 * Only the FIRST variant that returns success:"1" should be treated as real;
 * every other response is evidence about validation, not a relayed order.
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
const ORDER_URL =
  env.PETPOOJA_ORDER_URL ||
  "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order";
const REST_ID = env.PETPOOJA_SANDBOX_MAPPING_CODE || "";
const CALLBACK_URL =
  env.PETPOOJA_CALLBACK_URL ||
  "https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook";

const now = new Date();
const p = (v) => String(v).padStart(2, "0");
const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
const time = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
const stamp = `${date} ${time}`;
const tag = Date.now();
const oid = (name) => `probe_${name}_${tag}`;

const auth = { app_key: APP_KEY, app_secret: APP_SECRET, access_token: ACCESS_TOKEN };

const ITEMS = [
  {
    id: "101",
    name: "Veg Smash Burger",
    price: "199.00",
    final_price: "199.00",
    quantity: "1",
    gst_liability: "restaurant",
    tax_inclusive: true,
    item_discount: "0.00",
    tax_percentage: "5",
    item_tax: [
      { id: "11213", name: "CGST", tax_percentage: "2.5", amount: "4.97" },
      { id: "20375", name: "SGST", tax_percentage: "2.5", amount: "4.97" },
    ],
    variation_id: "",
    variation_name: "",
    addon_items: [],
  },
];

const TAX_DETAILS = [
  { id: "301", title: "CGST", type: "P", price: "5%", tax: "4.97", restaurant_liable_amt: "4.97" },
  { id: "302", title: "SGST", type: "P", price: "5%", tax: "4.97", restaurant_liable_amt: "4.97" },
];

/** Each variant is one candidate contract. */
const variants = {
  "flat-restID": {
    ...auth,
    restID: REST_ID,
    orderID: oid("flatrestid"),
    preorder_date: date,
    preorder_time: time,
    advanced_order: "N",
    order_type: "P",
    total: "208.95",
    tax_total: "9.95",
    created_on: stamp,
    dc_tax_percentage: "5",
    pc_tax_percentage: "5",
    payment_type: "COD",
    enable_delivery: "1",
    callback_url: CALLBACK_URL,
    order_items: ITEMS,
    tax_details: TAX_DETAILS,
  },
  "flat-rest_id": {
    ...auth,
    rest_id: REST_ID,
    orderID: oid("flatrestid_us"),
    preorder_date: date,
    preorder_time: time,
    advanced_order: "N",
    order_type: "P",
    total: "208.95",
    tax_total: "9.95",
    created_on: stamp,
    dc_tax_percentage: "5",
    pc_tax_percentage: "5",
    payment_type: "COD",
    enable_delivery: "1",
    callback_url: CALLBACK_URL,
    order_items: ITEMS,
    tax_details: TAX_DETAILS,
  },
  "flat-res_id": {
    ...auth,
    res_id: REST_ID,
    orderID: oid("flatresid"),
    preorder_date: date,
    preorder_time: time,
    advanced_order: "N",
    order_type: "P",
    total: "208.95",
    tax_total: "9.95",
    created_on: stamp,
    dc_tax_percentage: "5",
    pc_tax_percentage: "5",
    payment_type: "COD",
    enable_delivery: "1",
    callback_url: CALLBACK_URL,
    order_items: ITEMS,
    tax_details: TAX_DETAILS,
  },
  "top-restID+orderinfo": {
    ...auth,
    restID: REST_ID,
    orderinfo: {
      orderID: oid("toprestid"),
      customer_name: "Petpooja Sandbox Tester",
      payment_type: "COD",
      total: "208.95",
      tax: "9.95",
      order_type: "P",
      callback_url: CALLBACK_URL,
      tax_details: [
        { tax_name: "CGST", tax_percent: 2.5, tax_amount: 4.97 },
        { tax_name: "SGST", tax_percent: 2.5, tax_amount: 4.97 },
      ],
      order_items: [
        {
          item_id: "101",
          item_name: "Veg Smash Burger",
          price: 199,
          quantity: 1,
          final_price: 199,
          addons: [],
          item_attribute: "1",
        },
      ],
    },
    udid: "burgonomics-sandbox",
    device_type: "web",
  },
  "top-restID+OrderInfo": {
    ...auth,
    restID: REST_ID,
    orderinfo: {
      OrderInfo: {
        Restaurant: { restID: REST_ID, res_name: "Burgonomics" },
        Customer: { name: "Petpooja Sandbox Tester", phone: "", address: "" },
        Order: {
          orderID: oid("toporderinfo"),
          preorder_date: date,
          preorder_time: time,
          advanced_order: "N",
          order_type: "P",
          total: "208.95",
          tax_total: "9.95",
          created_on: stamp,
          dc_tax_percentage: "5",
          pc_tax_percentage: "5",
          payment_type: "COD",
          enable_delivery: "1",
          callback_url: CALLBACK_URL,
        },
        OrderItem: [
          {
            id: "101",
            name: "Veg Smash Burger",
            price: "199.00",
            final_price: "199.00",
            quantity: "1",
            gst_liability: "restaurant",
            tax_inclusive: true,
            item_tax: [
              { id: "11213", name: "CGST", tax_percentage: "2.5", amount: "4.97" },
              { id: "20375", name: "SGST", tax_percentage: "2.5", amount: "4.97" },
            ],
            addon_items: [],
          },
        ],
      },
    },
    udid: "burgonomics-sandbox",
    device_type: "web",
  },
  "nested-restID": {
    ...auth,
    orderinfo: {
      restID: REST_ID,
      orderID: oid("nestedrestid"),
      customer_name: "Petpooja Sandbox Tester",
      payment_type: "COD",
      total: "208.95",
      tax: "9.95",
      order_type: "P",
      callback_url: CALLBACK_URL,
      tax_details: [
        { tax_name: "CGST", tax_percent: 2.5, tax_amount: 4.97 },
        { tax_name: "SGST", tax_percent: 2.5, tax_amount: 4.97 },
      ],
      order_items: [
        {
          item_id: "101",
          item_name: "Veg Smash Burger",
          price: 199,
          quantity: 1,
          final_price: 199,
          addons: [],
          item_attribute: "1",
        },
      ],
    },
    udid: "burgonomics-sandbox",
    device_type: "web",
  },
  "nested-orderinfo": {
    ...auth,
    orderinfo: {
      orderID: oid("nested"),
      rest_id: REST_ID,
      customer_name: "Petpooja Sandbox Tester",
      customer_phone: "",
      customer_address: "",
      payment_type: "COD",
      total: "208.95",
      tax: "9.95",
      discount: "0.00",
      delivery_charges: "0.00",
      packing_charges: "0.00",
      order_type: "P",
      callback_url: CALLBACK_URL,
      tax_details: [
        { tax_name: "CGST", tax_percent: 2.5, tax_amount: 4.97 },
        { tax_name: "SGST", tax_percent: 2.5, tax_amount: 4.97 },
      ],
      order_items: [
        {
          item_id: "101",
          item_name: "Veg Smash Burger",
          price: 199,
          quantity: 1,
          final_price: 199,
          addons: [],
          item_attribute: "1",
        },
      ],
    },
    udid: "burgonomics-sandbox",
    device_type: "web",
  },
  "nested-OrderInfo": {
    ...auth,
    orderinfo: {
      OrderInfo: {
        Restaurant: { restID: REST_ID, res_name: "Burgonomics" },
        Customer: {
          name: "Petpooja Sandbox Tester",
          phone: "",
          address: "",
          email: "",
          latitude: "",
          longitude: "",
        },
        Order: {
          orderID: oid("nestedorderinfo"),
          preorder_date: date,
          preorder_time: time,
          advanced_order: "N",
          order_type: "P",
          total: "208.95",
          tax_total: "9.95",
          created_on: stamp,
          dc_tax_percentage: "5",
          pc_tax_percentage: "5",
          payment_type: "COD",
          enable_delivery: "1",
          delivery_charges: "0.00",
          packing_charges: "0.00",
          description: "contract probe",
          callback_url: CALLBACK_URL,
          discount_type: "F",
          discount_total: "0.00",
        },
        OrderItem: [
          {
            id: "101",
            name: "Veg Smash Burger",
            price: "199.00",
            final_price: "199.00",
            quantity: "1",
            gst_liability: "restaurant",
            tax_inclusive: true,
            tax_percentage: "5",
            item_discount: "0.00",
            variation_id: "",
            variation_name: "",
            item_tax: [
              { id: "11213", name: "CGST", tax_percentage: "2.5", amount: "4.97" },
              { id: "20375", name: "SGST", tax_percentage: "2.5", amount: "4.97" },
            ],
            addon_items: [],
          },
        ],
        Tax: [
          { id: "301", title: "CGST", type: "P", price: "5%", tax: "4.97", restaurant_liable_amt: "4.97" },
          { id: "302", title: "SGST", type: "P", price: "5%", tax: "4.97", restaurant_liable_amt: "4.97" },
        ],
        Discount: { discount_type: "F", discount_total: "0.00" },
      },
    },
    udid: "burgonomics-sandbox",
    device_type: "web",
  },
};

async function main() {
  if (!APP_KEY || !APP_SECRET || !ACCESS_TOKEN) {
    console.error("ABORT: Petpooja credentials not set in functions/.env");
    process.exit(2);
  }
  console.log(`endpoint: ${ORDER_URL}\nrestID: ${REST_ID}\n`);
  for (const [name, body] of Object.entries(variants)) {
    try {
      const res = await fetch(ORDER_URL, {
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
      console.log(`--- ${name} --- HTTP ${res.status}\n${text}\n`);
    } catch (err) {
      console.log(`--- ${name} --- TRANSPORT ERROR ${err.message}\n`);
    }
  }
}

main();
