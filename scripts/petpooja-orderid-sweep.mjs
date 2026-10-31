#!/usr/bin/env node
/**
 * Which single field, if any, makes save_order return a non-empty orderID?
 *
 * Everything else has been pinned down: credentials are validated (bogus ones
 * get GN_105), the documented `orderinfo.OrderInfo.*.details` envelope is
 * required, `restID` is never checked, and only three routes exist on either
 * host (save_order, update_order_status, mapped_restaurant_menus). `orderID`
 * is the single field that never populates.
 *
 * So hold the envelope fixed and vary ONE thing at a time, watching `orderID`.
 * Anything that flips it is the answer; if nothing does, the order is not being
 * registered and no request shape can fix that.
 *
 * Usage: node scripts/petpooja-orderid-sweep.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const ORDER_URL =
  "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order";
const MENU_URL_SAVE = ORDER_URL; // menu host answers identically; order host is canonical

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
const APP_KEY = env.PETPOOJA_APP_KEY || "";
const APP_SECRET = env.PETPOOJA_APP_SECRET || "";
const ACCESS_TOKEN = env.PETPOOJA_ACCESS_TOKEN || "";
const REST_ID = env.PETPOOJA_SANDBOX_MAPPING_CODE || "31z58ciw0h";
const CALLBACK_URL =
  env.PETPOOJA_CALLBACK_URL ||
  "https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook";

if (!APP_KEY || !APP_SECRET || !ACCESS_TOKEN) {
  console.error("ABORT: credentials not all set in functions/.env");
  process.exit(2);
}

const money = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Outlet's verifiable values (item 30791, taxes 3928/3929 @2.5% each).
const ITEM = { id: "30791", name: "Tandoori Dahi Kebab", price: 350 };
const CGST = { id: "3928", rate: 2.5 };
const SGST = { id: "3929", rate: 2.5 };

function istNow(plusDays = 0) {
  const d = new Date(Date.now() + plusDays * 86400000);
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t) => f.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${g("year")}-${g("month")}-${g("day")}`,
    time: `${g("hour")}:${g("minute")}:${g("second")}`,
    stamp: `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`,
  };
}

function line() {
  const unit = ITEM.price;
  const half = r2(r2(unit * ((CGST.rate + SGST.rate) / 100)) / 2);
  return {
    id: ITEM.id, name: ITEM.name,
    price: money(unit), final_price: money(unit), quantity: "1",
    gst_liability: "restaurant", item_discount: "",
    item_tax: [
      { id: CGST.id, name: "CGST", tax_percentage: String(CGST.rate), amount: money(half) },
      { id: SGST.id, name: "SGST", tax_percentage: String(SGST.rate), amount: money(half) },
    ],
    variation_id: "", variation_name: "", AddonItem: { details: [] },
  };
}

function taxArr() {
  const total = r2(ITEM.price * ((CGST.rate + SGST.rate) / 100));
  return [
    { id: CGST.id, title: "CGST", type: "P", price: `${CGST.rate}%`, tax: money(r2(total / 2)), restaurant_liable_amt: money(r2(total / 2)) },
    { id: SGST.id, title: "SGST", type: "P", price: `${SGST.rate}%`, tax: money(r2(total / 2)), restaurant_liable_amt: money(r2(total / 2)) },
  ];
}

/**
 * Build the documented body. `opts` lets exactly one dimension change at a
 * time: `wrap` ('details'|'bare'), which Order keys to omit, and overrides for
 * Order details.
 */
function build(tag, opts = {}) {
  const t = istNow(opts.plusDays || 0);
  const taxTotal = r2(ITEM.price * ((CGST.rate + SGST.rate) / 100));
  const grand = r2(ITEM.price + taxTotal);
  const base = {
    orderID: `bgx_sweep_${tag}_${Date.now()}`,
    preorder_date: t.date,
    preorder_time: t.time,
    advanced_order: opts.advanced_order || "N",
    order_type: opts.order_type || "H",
    payment_type: opts.payment_type || "ONLINE",
    service_charge: String(opts.service_charge ?? 0),
    delivery_charges: String(opts.delivery_charges ?? 0),
    dc_tax_percentage: "0",
    packing_charges: String(opts.packing_charges ?? 0),
    pc_tax_percentage: "0",
    discount_total: "0",
    tax_total: money(taxTotal),
    total: money(r2(grand + (opts.delivery_charges || 0) + (opts.packing_charges || 0) + (opts.service_charge || 0))),
    description: `orderid sweep ${tag}`,
    created_on: t.stamp,
    enable_delivery: opts.enable_delivery || "0",
    min_prep_time: "0",
    callback_url: CALLBACK_URL,
    collect_cash: "0",
  };
  for (const k of opts.omitOrderKeys || []) delete base[k];
  if (opts.overrideOrderKeys) Object.assign(base, opts.overrideOrderKeys);
  if (opts.table_no) base.table_no = opts.table_no;
  if (opts.no_of_persons) base.no_of_persons = opts.no_of_persons;

  const wrap = opts.wrap || "details";
  const items = wrap === "bare" ? [line()] : { details: [line()] };
  const taxes = wrap === "bare" ? taxArr() : { details: taxArr() };

  const inner = {
    Restaurant: { details: { restID: REST_ID, res_name: "Burgonomics DEMO", address: "Ahmedabad", contact_information: "1234567890" } },
    Customer: { details: { email: "burgonomicsind@gmail.com", name: "OrderID Sweep", address: "Sandbox test order", phone: "9825000001" } },
    Order: { details: base },
    OrderItem: items,
  };
  if (!opts.omitTax) inner.Tax = taxes;
  if (!opts.omitDiscount) inner.Discount = wrap === "bare" ? [] : { details: [] };

  return {
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    access_token: ACCESS_TOKEN,
    ...(opts.udid ? { udid: opts.udid } : {}),
    ...(opts.device_type ? { device_type: opts.device_type } : {}),
    orderinfo: { OrderInfo: inner },
  };
}

const variants = [
  ["V0-control", "baseline: orderID set, H, ONLINE, details-wrapped", build("v0")],
  ["V1-no-orderID", "Order.orderID key omitted entirely", build("v1", { omitOrderKeys: ["orderID"] })],
  ["V2-empty-orderID", "Order.orderID = \"\" (let the POS assign one)", build("v2", { overrideOrderKeys: { orderID: "" } })],
  ["V3-udid", "udid + device_type present", build("v3", { udid: "burgonomics-sandbox", device_type: "1" })],
  ["V4-cod", "payment_type COD", build("v4", { payment_type: "COD" })],
  ["V5-dinein", "order_type D + table_no + no_of_persons", build("v5", { order_type: "D", table_no: "T1", no_of_persons: "2" })],
  ["V6-parcel", "order_type P", build("v6", { order_type: "P" })],
  ["V7-bare", "OrderItem/Tax/Discount as BARE ARRAYS (OpenAPI typing)", build("v7", { wrap: "bare" })],
  ["V8-no-discount", "Discount member omitted", build("v8", { omitDiscount: true })],
  ["V9-no-tax", "Tax member omitted", build("v9", { omitTax: true })],
  ["V10-advanced", "advanced_order Y + preorder tomorrow", build("v10", { advanced_order: "Y", plusDays: 1 })],
  ["V11-enabled-delivery", "enable_delivery 1", build("v11", { enable_delivery: "1" })],
  ["V12-charges", "delivery 40 + packing 20 + service 10", build("v12", { delivery_charges: 40, packing_charges: 20, service_charge: 10 })],
];

console.log("=== save_order orderID sweep ===");
console.log(`restID ${REST_ID} | item ${ITEM.id} @${ITEM.price} | taxes ${CGST.id}/${SGST.id}\n`);

const results = [];
let hit = null;
for (const [id, label, body] of variants) {
  let status = 0, text = "";
  try {
    const res = await fetch(ORDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    text = await res.text();
  } catch (err) { text = `FETCH_ERROR: ${err?.message || err}`; }
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  const orderId = parsed?.orderID ?? null;
  const flag = orderId ? "  <-- ORDER ID RETURNED" : "";
  console.log(`${id.padEnd(20)} HTTP ${status}  orderID=${JSON.stringify(orderId)}${flag}`);
  console.log(`   ${label}`);
  console.log(`   ${text.slice(0, 220)}`);
  if (orderId && !hit) hit = { id, label, orderId, response: parsed };
  results.push({ id, label, httpStatus: status, orderID: orderId, response: parsed ?? text });
  await sleep(400);
}

const ev = {
  generatedAt: new Date().toISOString(),
  endpoint: ORDER_URL,
  restID: REST_ID,
  results,
  hit,
  verdict: hit
    ? `orderID returned by ${hit.id}: ${hit.orderId}`
    : "no variant returned an orderID — the order is not being registered, and no request shape changes that",
};
const out = path.join(REPO_ROOT, "scripts", "petpooja-orderid-sweep-evidence.json");
fs.writeFileSync(out, JSON.stringify(ev, null, 2));
console.log(`\nEvidence: ${out}`);
console.log(`VERDICT: ${ev.verdict}`);
process.exit(hit ? 0 : 1);
