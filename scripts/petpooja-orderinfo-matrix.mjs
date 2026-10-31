#!/usr/bin/env node
/**
 * OrderInfo collection-wrapping matrix.
 *
 * The published Orders API has two conflicting descriptions of how the
 * collection members are carried:
 *
 *   OpenAPI (component OrderInfo)
 *     Restaurant/Customer/Order : object with `details`
 *     OrderItem / Tax / Discount : BARE ARRAYS
 *
 *   Postman example body
 *     every member wrapped: OrderItem: { details: [...] }, Tax: { details: [] }
 *
 * A probe using the Postman wrapping was ACCEPTED and echoed our real
 * `restID` and `clientOrderID` (previously always empty), but `orderID` stayed
 * empty — consistent with the order being read but its ITEMS not being parsed.
 * This script varies only that wrapping, so a non-empty `orderID` points at the
 * cause.
 *
 * Usage: node scripts/petpooja-orderinfo-matrix.mjs [--host order|menu|both]
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
const HOSTS = argOf("--host", "both");
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

async function main() {
  const menu = JSON.parse(fs.readFileSync(MENU_PATH, "utf8"));
  const items = (menu.items || []).filter((i) => Number(i.price) > 0 && String(i.active) === "1");
  const t0 = (menu.taxes || []).find((x) => /cgst/i.test(x.taxname || ""));
  const s0 = (menu.taxes || []).find((x) => /sgst/i.test(x.taxname || ""));
  const cgst = { id: String(t0.taxid), rate: Number(t0.tax) };
  const sgst = { id: String(s0.taxid), rate: Number(s0.tax) };
  const restName = menu.restaurants?.[0]?.details?.restname || "Burgonomics DEMO [135148]";
  const rate = (cgst.rate + sgst.rate) / 100;

  const chosen = items.slice(0, 2);
  const lines = chosen.map((item) => {
    const unit = Number(item.price);
    const taxAmount = r2(unit * rate);
    const half = r2(taxAmount / 2);
    return {
      body: {
        id: String(item.itemid), name: item.itemname,
        price: money(unit), final_price: money(unit), quantity: "1",
        gst_liability: "restaurant", item_discount: "", description: "",
        item_tax: [
          { id: cgst.id, name: "CGST", tax_percentage: String(cgst.rate), amount: money(half) },
          { id: sgst.id, name: "SGST", tax_percentage: String(sgst.rate), amount: money(half) },
        ],
        variation_id: "", variation_name: "",
        AddonItem: { details: [] },
      },
      unit, taxAmount,
    };
  });
  const itemTotal = r2(lines.reduce((s, l) => s + l.unit, 0));
  const taxTotal = r2(lines.reduce((s, l) => s + l.taxAmount, 0));
  const grandTotal = r2(itemTotal + taxTotal);
  const t = istNow();
  const clientOrderID = `bgx_mx_${Date.now()}`;

  const orderDetails = {
    orderID: clientOrderID, preorder_date: t.date, preorder_time: t.time,
    advanced_order: "N", order_type: "H", payment_type: "ONLINE",
    table_no: "", no_of_persons: "", service_charge: "0",
    delivery_charges: "0", dc_tax_percentage: "0", dc_tax_amount: "0",
    packing_charges: "0", pc_tax_percentage: "0", pc_tax_amount: "0",
    discount_total: "0", tax_total: money(taxTotal), total: money(grandTotal),
    description: "orderinfo matrix probe", created_on: t.stamp,
    enable_delivery: "0", min_prep_time: "0", callback_url: CALLBACK_URL,
    collect_cash: "0", otp: "", urgent_order: false, urgent_time: 0,
  };
  const customerDetails = {
    email: "burgonomicsind@gmail.com", name: "Burgonomics Sandbox Test",
    address: "Sandbox test order - Burgonomics DEMO outlet", phone: "9825000001",
    latitude: "", longitude: "",
  };
  const restaurantDetails = {
    res_name: restName, address: "Ahmedabad",
    contact_information: "1234567890", restID: REST_ID,
  };
  const taxDetails = [
    { id: cgst.id, title: "CGST", type: "P", price: `${cgst.rate}%`, tax: money(r2(taxTotal / 2)), restaurant_liable_amt: money(r2(taxTotal / 2)) },
    { id: sgst.id, title: "SGST", type: "P", price: `${sgst.rate}%`, tax: money(r2(taxTotal / 2)), restaurant_liable_amt: money(r2(taxTotal / 2)) },
  ];
  const lineBodies = lines.map((l) => l.body);

  // `wrap` controls ONLY how the three collection members are carried.
  const build = (wrap, extra = {}) => ({
    app_key: APP_KEY, app_secret: APP_SECRET, access_token: ACCESS_TOKEN,
    callback_url: CALLBACK_URL,
    ...extra,
    orderinfo: {
      OrderInfo: {
        Restaurant: { details: restaurantDetails },
        Customer: { details: customerDetails },
        Order: { details: orderDetails },
        OrderItem: wrap === "bare" ? lineBodies : { details: lineBodies },
        Tax: wrap === "bare" ? taxDetails : { details: taxDetails },
        Discount: wrap === "bare" ? [] : { details: [] },
      },
    },
  });

  const variants = [
    ["bare", "collections as BARE ARRAYS (OpenAPI)", build("bare")],
    ["details", "collections wrapped in details (Postman)", build("details")],
    ["bare+cod", "bare arrays + payment_type COD", build("bare", { udid: "bgx-probe", device_type: "3" })],
  ];

  const redact = (o) =>
    JSON.parse(JSON.stringify(o, (k, v) =>
      k === "app_key" || k === "app_secret" || k === "access_token" ? `<${k}:redacted>` : v));

  console.log("=== ORDERINFO WRAPPING MATRIX ===");
  console.log(`restID: ${REST_ID}   cart: ${lineBodies.map((i) => `${i.id}@${i.price}`).join(" | ")}`);
  console.log(`totals: item=${money(itemTotal)} tax=${money(taxTotal)} grand=${money(grandTotal)}\n`);

  const results = [];
  let anyFulfilled = false;

  for (const [hostKey, url] of ORDER_HOSTS) {
    for (const [id, label, body] of variants) {
      let status = 0, text = "";
      try {
        const res = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
        });
        status = res.status;
        text = await res.text();
      } catch (err) { text = `FETCH_ERROR: ${err?.message || err}`; }
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      const live = parsed && (parsed.orderID || parsed.order_id || parsed.petpooja_order_id || parsed.orderId);
      console.log(`-- ${hostKey} / ${id}: ${label}`);
      console.log(`   HTTP ${status} ${text}`);
      console.log(`   restID=${JSON.stringify(parsed?.restID)} clientOrderID=${JSON.stringify(parsed?.clientOrderID)} orderID=${JSON.stringify(live || "")}`);
      if (live) anyFulfilled = true;
      results.push({ host: hostKey, variant: id, label, httpStatus: status, response: parsed ?? text, orderId: live || null, request: redact(body) });
    }
  }

  const ev = { generatedAt: new Date().toISOString(), restID: REST_ID, results, anyFulfilled };
  const p = path.join(REPO_ROOT, "scripts", "petpooja-orderinfo-matrix-evidence.json");
  fs.writeFileSync(p, JSON.stringify(ev, null, 2));
  console.log(`\nEvidence: ${p}`);
  console.log(anyFulfilled ? "VERDICT: FULFILLED — orderID returned." : "VERDICT: no orderID on any wrapping.");
  process.exit(anyFulfilled ? 0 : 1);
}

main().catch((e) => { console.error("PROBE FAILED:", e?.message || e); process.exit(1); });
