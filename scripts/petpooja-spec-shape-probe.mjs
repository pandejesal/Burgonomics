#!/usr/bin/env node
/**
 * DECISIVE PROBE — the documented `orderinfo.OrderInfo.*.details` shape.
 *
 * Why this exists
 * ---------------
 * The accepted-shaped payload we have sent for weeks is:
 *
 *   { app_key, app_secret, access_token,
 *     orderinfo: { Customer: {...}, Order: {...}, OrderItem: [...], Tax: [...] } }
 *
 * The published OpenAPI for the Orders API (petpooja-orders-api-openapi.yml,
 * component `OrderInfo`) and that spec's Postman collection both describe:
 *
 *   { app_key, app_secret, access_token,
 *     orderinfo: { OrderInfo: {
 *       Restaurant: { details: { restID, res_name, address, contact_information } },
 *       Customer:   { details: { name, phone, address, email, latitude, longitude } },
 *       Order:      { details: { orderID, payment_type, total, ... } },
 *       OrderItem:  { details: [ {...} ] },
 *       Tax:        { details: [ {...} ] },
 *       Discount:   { details: [ {...} ] } } } }
 *
 * Two differences, both material:
 *   1. an inner `OrderInfo` level — we have never sent it;
 *   2. every section is wrapped in `details`, and `OrderItem` / `Tax` /
 *      `Discount` are OBJECTS holding a `details` ARRAY, not bare arrays.
 *   3. `restID` lives at `OrderInfo.Restaurant.details.restID`; there is no
 *      top-level `restID` in this contract at all.
 *
 * The validator only checks that `orderinfo` is present, so our body passes it,
 * and then the parser finds no `OrderInfo` to read — the order is empty, nothing
 * is saved, and the ack echoes empty ids. That, not a stub, is the likeliest
 * reason every relay returned orderID:"".
 *
 * Usage
 *   node scripts/petpooja-spec-shape-probe.mjs
 *   node scripts/petpooja-spec-shape-probe.mjs --only SPEC
 *   node scripts/petpooja-spec-shape-probe.mjs --host both
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const argOf = (f, d = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const ONLY = (argOf("--only") || "SPEC,CURRENT").toUpperCase();
const HOSTS = argOf("--host", "order");
const MENU_PATH =
  argOf("--menu") || path.join(process.env.TEMP || "/tmp", "petpooja-menu-push.json");

const ORDER_HOSTS = [
  ["order", "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order"],
  ["menu", "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order"],
].filter(([k]) => HOSTS === "both" || k === HOSTS);

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

const money = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function readTaxes(menu) {
  const t = Array.isArray(menu.taxes) ? menu.taxes : [];
  const cgst = t.find((x) => /cgst/i.test(x.taxname || ""));
  const sgst = t.find((x) => /sgst/i.test(x.taxname || ""));
  return {
    cgst: { id: String(cgst?.taxid ?? ""), rate: Number(cgst?.tax ?? 2.5) },
    sgst: { id: String(sgst?.taxid ?? ""), rate: Number(sgst?.tax ?? 2.5) },
  };
}

function istNow() {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t) => f.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${g("year")}-${g("month")}-${g("day")}`,
    time: `${g("hour")}:${g("minute")}:${g("second")}`,
    stamp: `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`,
  };
}

async function main() {
  if (!APP_KEY || !APP_SECRET || !ACCESS_TOKEN) {
    console.error("ABORT: Petpooja credentials not all set in functions/.env");
    process.exit(2);
  }
  if (!fs.existsSync(MENU_PATH)) {
    console.error(`ABORT: no menu snapshot at ${MENU_PATH}`);
    process.exit(2);
  }

  const menu = JSON.parse(fs.readFileSync(MENU_PATH, "utf8"));
  const items = (Array.isArray(menu.items) ? menu.items : []).filter(
    (i) => Number(i.price) > 0 && String(i.active) === "1"
  );
  if (!items.length) {
    console.error("ABORT: snapshot has no active, priced items");
    process.exit(2);
  }
  const taxes = readTaxes(menu);
  if (!taxes.cgst.id || !taxes.sgst.id) {
    console.error("ABORT: snapshot has no CGST/SGST tax ids");
    process.exit(2);
  }

  const restaurant = (menu.restaurants || [])[0] || {};
  const restName = restaurant?.details?.restname || restaurant?.name || "Burgonomics DEMO [135148]";

  // One real item, priced exclusive, tax added on top — the outlet declares
  // tax_inclusive:false on every item.
  const chosen = items.slice(0, 2);
  const rate = (taxes.cgst.rate + taxes.sgst.rate) / 100;

  const lines = chosen.map((item) => {
    const unit = Number(item.price);
    const taxAmount = r2(unit * rate);
    const half = r2(taxAmount / 2);
    return {
      line: {
        id: String(item.itemid),
        name: item.itemname,
        price: money(unit),
        final_price: money(unit),
        quantity: "1",
        gst_liability: "restaurant",
        item_discount: "",
        item_tax: [
          { id: taxes.cgst.id, name: "CGST", tax_percentage: String(taxes.cgst.rate), amount: money(half) },
          { id: taxes.sgst.id, name: "SGST", tax_percentage: String(taxes.sgst.rate), amount: money(half) },
        ],
        variation_id: "",
        variation_name: "",
        AddonItem: { details: [] },
      },
      unit,
      taxAmount,
    };
  });

  const itemTotal = r2(lines.reduce((s, l) => s + l.unit, 0));
  const taxTotal = r2(lines.reduce((s, l) => s + l.taxAmount, 0));
  const grandTotal = r2(itemTotal + taxTotal);
  const t = istNow();
  const clientOrderID = `bgx_spec_${Date.now()}`;

  const orderDetails = {
        orderID: clientOrderID,
        preorder_date: t.date,
        preorder_time: t.time,
        advanced_order: "N",
        order_type: "H",
        payment_type: "ONLINE",
        table_no: "",
        no_of_persons: "",
        service_charge: "0",
        delivery_charges: "0",
        dc_tax_percentage: "0",
        dc_tax_amount: "0",
        packing_charges: "0",
        pc_tax_percentage: "0",
        pc_tax_amount: "0",
        discount_total: "0",
        tax_total: money(taxTotal),
        total: money(grandTotal),
        description: "spec-shape probe",
        created_on: t.stamp,
        enable_delivery: "0",
        min_prep_time: "0",
        callback_url: CALLBACK_URL,
        collect_cash: "0",
        otp: "",
        urgent_order: false,
        urgent_time: 0,
  };

  const customerDetails = {
    email: "burgonomicsind@gmail.com",
    name: "Burgonomics Sandbox Test",
    address: "Sandbox test order - Burgonomics DEMO outlet",
    phone: "9825000001",
    latitude: "",
    longitude: "",
  };

  const restaurantDetails = {
    res_name: restName,
    address: "Ahmedabad",
    contact_information: "1234567890",
    restID: REST_ID,
  };

  const taxDetails = [
    { id: taxes.cgst.id, title: "CGST", type: "P", price: `${taxes.cgst.rate}%`, tax: money(r2(taxTotal / 2)), restaurant_liable_amt: money(r2(taxTotal / 2)) },
    { id: taxes.sgst.id, title: "SGST", type: "P", price: `${taxes.sgst.rate}%`, tax: money(r2(taxTotal / 2)), restaurant_liable_amt: money(r2(taxTotal / 2)) },
  ];

  const lineBodies = lines.map((l) => l.line);

  // ---- VARIANT SPEC: exactly the documented `orderinfo.OrderInfo.*.details` ----
  const specBody = {
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    access_token: ACCESS_TOKEN,
    callback_url: CALLBACK_URL,
    orderinfo: {
      OrderInfo: {
        Restaurant: { details: restaurantDetails },
        Customer: { details: customerDetails },
        Order: { details: orderDetails },
        OrderItem: { details: lineBodies },
        Tax: { details: taxDetails },
        Discount: { details: [] },
      },
    },
  };

  // ---- VARIANT CURRENT: what the builder sends today (control) ----
  const currentBody = {
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    access_token: ACCESS_TOKEN,
    restID: REST_ID,
    callback_url: CALLBACK_URL,
    orderinfo: {
      Customer: customerDetails,
      Order: { ...orderDetails, restID: REST_ID, resID: REST_ID },
      OrderItem: lineBodies,
      Tax: taxDetails,
      tax_details: taxDetails,
    },
  };

  const variants = [
    ["SPEC", "documented orderinfo.OrderInfo.*.details shape", specBody],
    ["CURRENT", "what our builder sends today (control)", currentBody],
  ].filter(([id]) => ONLY.includes(id));

  const redact = (o) =>
    JSON.parse(
      JSON.stringify(o, (k, v) =>
        k === "app_key" || k === "app_secret" || k === "access_token" ? `<${k}:redacted>` : v
      )
    );

  console.log("=== SPEC-SHAPE PROBE ===");
  console.log(`restID     : ${REST_ID}`);
  console.log(`cart       : ${lineBodies.map((i) => `${i.id} ${i.name} @${i.price}`).join(" | ")}`);
  console.log(`totals     : item=${money(itemTotal)} tax=${money(taxTotal)} grand=${money(grandTotal)}`);
  console.log("");

  const results = [];
  let anyFulfilled = false;

  for (const [hostKey, url] of ORDER_HOSTS) {
    for (const [id, label, body] of variants) {
      console.log(`----- ${hostKey} / VARIANT ${id}: ${label} -----`);
      let status = 0;
      let text = "";
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
        });
        status = res.status;
        text = await res.text();
      } catch (err) {
        text = `FETCH_ERROR: ${err?.message || err}`;
      }
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      const live = parsed && (parsed.orderID || parsed.order_id || parsed.petpooja_order_id || parsed.orderId);
      console.log(`RESPONSE HTTP ${status}: ${text}`);
      console.log(`  -> ORDER ID: ${live || "(empty)"}`);
      console.log("");
      if (live) anyFulfilled = true;
      results.push({
        host: hostKey, url, variant: id, label, httpStatus: status,
        response: parsed ?? text, orderId: live || null, request: redact(body),
      });
    }
  }

  const ev = {
    generatedAt: new Date().toISOString(),
    restID: REST_ID, taxIds: taxes,
    cart: lineBodies.map((i) => ({ id: i.id, name: i.name, price: i.price })),
    totals: { itemTotal, taxTotal, grandTotal },
    results, anyFulfilled,
  };
  const p = path.join(REPO_ROOT, "scripts", "petpooja-spec-shape-evidence.json");
  fs.writeFileSync(p, JSON.stringify(ev, null, 2));
  console.log(`Evidence: ${p}`);
  console.log(
    anyFulfilled
      ? "VERDICT: FULFILLED — the missing inner `OrderInfo` + `details` wrappers were our bug."
      : "VERDICT: still empty on both shapes."
  );
  process.exit(anyFulfilled ? 0 : 1);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e?.message || e);
  process.exit(1);
});
