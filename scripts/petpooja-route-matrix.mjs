#!/usr/bin/env node
/**
 * Route + auth matrix for the deployed Petpooja gateway.
 *
 * Two questions:
 *   A) Does /save_order authenticate anything at all?
 *      (If a bogus or absent credential still returns success:"1", the endpoint
 *      enforces nothing, and an empty orderID cannot be an auth problem.)
 *   B) Is ANY route other than save_order deployed on either host — in
 *      particular an order-status / cancel / fetch route, which is the only way
 *      we could ever pull a POS order id? The vendor sandbox guide advertises a
 *      testable "Update Order Status API (cancel)" and a "Rider Info Webhook"
 *      that no probe in this repo has ever tried.
 *
 * AWS API Gateway answers an unrouted path with
 *   403 {"message":"Missing Authentication Token"}
 * and a routed-but-missing resource with 404. Anything else means the route
 * exists.
 *
 * Usage: node scripts/petpooja-route-matrix.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const ORDER_HOST = "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1";
const MENU_HOST = "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1";
const HOSTS = [["order", ORDER_HOST], ["menu", MENU_HOST]];

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
  console.error("ABORT: Petpooja credentials not all set in functions/.env");
  process.exit(2);
}

const AUTH_HEADERS = {
  "Content-Type": "application/json",
  "app-key": APP_KEY,
  "app-secret": APP_SECRET,
  "access-token": ACCESS_TOKEN,
};

const money = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MENU_PATH =
  process.env.PETPOOJA_MENU_SNAPSHOT ||
  path.join(process.env.TEMP || "/tmp", "petpooja-menu-push.json");
// The outlet's menu-push snapshot is a temp file and does get cleaned up. Fall
// back to the values this outlet verifiably exposes (captured from the Petpooja
// menu push for 31z58ciw0h) so the probe never depends on a temp file
// surviving — one real item and the two real tax rows are all it needs.
const OUTLET_FIXTURE = {
  restaurants: [{ details: { restname: "Burgonomics DEMO [135148]" } }],
  taxes: [
    { taxid: "3928", taxname: "CGST", tax: "2.5" },
    { taxid: "3929", taxname: "SGST", tax: "2.5" },
  ],
  items: [
    { itemid: "30791", itemname: "Tandoori Dahi Kebab", price: "350.00", active: "1" },
  ],
};
let menu;
try {
  menu = JSON.parse(fs.readFileSync(MENU_PATH, "utf8"));
} catch {
  console.warn(`(no menu snapshot at ${MENU_PATH} — using built-in outlet fixture)`);
  menu = OUTLET_FIXTURE;
}
const priced = (menu.items || []).filter(
  (i) => Number(i.price) > 0 && String(i.active) === "1"
);
const cgst = (menu.taxes || []).find((x) => /cgst/i.test(x.taxname || ""));
const sgst = (menu.taxes || []).find((x) => /sgst/i.test(x.taxname || ""));

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

/** Minimal documented save_order body (orderinfo.OrderInfo.*.details). */
function saveOrderBody(creds, tag) {
  const rate = (Number(cgst.tax) + Number(sgst.tax)) / 100;
  const lines = priced.slice(0, 1).map((item) => {
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
    ...creds,
    callback_url: CALLBACK_URL,
    orderinfo: {
      OrderInfo: {
        Restaurant: { details: { restID: REST_ID, res_name: "Burgonomics DEMO", address: "Ahmedabad", contact_information: "1234567890" } },
        Customer: { details: { email: "burgonomicsind@gmail.com", name: "Route Matrix Probe", address: "Sandbox test order", phone: "9825000001" } },
        Order: {
          details: {
            orderID: `bgx_route_${tag}_${Date.now()}`, preorder_date: t.date, preorder_time: t.time,
            advanced_order: "N", order_type: "H", payment_type: "ONLINE",
            service_charge: "0", delivery_charges: "0", dc_tax_percentage: "0",
            packing_charges: "0", pc_tax_percentage: "0", discount_total: "0",
            tax_total: money(taxTotal), total: money(r2(itemTotal + taxTotal)),
            description: "route matrix probe", created_on: t.stamp,
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

async function hit(url, { method = "POST", body, headers } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: headers || AUTH_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    return { status: res.status, text: text.slice(0, 400) };
  } catch (err) {
    return { status: 0, text: `FETCH_ERROR: ${err?.message || err}` };
  }
}

function classify(r) {
  if (r.status === 0) return "FETCH_ERROR";
  if (r.status === 403 && /Missing Authentication Token/i.test(r.text)) return "NO_ROUTE";
  if (r.status === 404) return "404";
  return "EXISTS";
}

const results = [];

// ---------------------------------------------------------------- A) auth
console.log("=== A) AUTH ENFORCEMENT on POST /V1/save_order (order host) ===\n");
const authCases = [
  ["correct body creds", { app_key: APP_KEY, app_secret: APP_SECRET, access_token: ACCESS_TOKEN }, AUTH_HEADERS],
  ["bogus body creds", { app_key: "bogus_key_xxx", app_secret: "bogus_secret_xxx", access_token: "bogus_token_xxx" }, { "Content-Type": "application/json" }],
  ["no creds anywhere", {}, { "Content-Type": "application/json" }],
  ["header-only creds", {}, AUTH_HEADERS],
];
for (const [label, creds, headers] of authCases) {
  const body = saveOrderBody(creds, label.replace(/\W+/g, "_"));
  const r = await hit(`${ORDER_HOST}/save_order`, { body, headers });
  const id = (() => { try { return JSON.parse(r.text).orderID; } catch { return undefined; } })();
  console.log(`  ${label.padEnd(22)} HTTP ${r.status}  orderID=${JSON.stringify(id)}`);
  console.log(`    ${r.text}`);
  results.push({ kind: "auth", label, status: r.status, body: r.text });
  await sleep(400);
}

// ------------------------------------------------------------- B) routes
console.log("\n=== B) ROUTE EXISTENCE MATRIX ===\n");
const postPaths = [
  "update_order_status", "cancel_order", "order_status", "get_order",
  "order_details", "order_list", "get_orders", "acknowledge_order",
  "save_order_status", "update_store_status", "get_store_status",
  "update_item_stock", "mapped_restaurant_menus",
  // Wider sweep: the vendor marks the store/stock paths "unreconciled", so the
  // deployed spelling may differ from the documented one. Any hit here is a
  // route we could actually use.
  "store_status", "updateStoreStatus", "update_store", "storeStatus",
  "update_store_availability", "set_store_status", "store",
  "update_order", "order_update_status", "order_status_update", "cancel",
  "order_cancel", "orders",
  "push_menu", "menu_push", "get_menu", "get_menu_items", "menu",
  "rider_info", "rider", "rider_info_webhook",
  "health", "ping",
];
const getPaths = [
  "order_status", "get_order", "order_details", "order_list",
  "get_orders", "get_store_status", "store_status", "get_menu", "menu",
];

const rows = [];
for (const [hostName, host] of HOSTS) {
  for (const p of postPaths) {
    // Send creds in BOTH places so a header-auth route still authenticates.
    const body = { app_key: APP_KEY, app_secret: APP_SECRET, access_token: ACCESS_TOKEN, restID: REST_ID, rest_id: REST_ID };
    const r = await hit(`${host}/${p}`, { body, headers: AUTH_HEADERS });
    const c = classify(r);
    rows.push({ host: hostName, method: "POST", path: p, status: r.status, cls: c, body: r.text });
    console.log(`  ${hostName.padEnd(5)} POST /${p.padEnd(24)} ${String(r.status).padEnd(4)} ${c.padEnd(10)} ${r.text.slice(0, 120)}`);
    await sleep(400);
  }
  for (const p of getPaths) {
    const r = await hit(`${host}/${p}?restID=${REST_ID}`, { method: "GET" });
    const c = classify(r);
    rows.push({ host: hostName, method: "GET", path: p, status: r.status, cls: c, body: r.text });
    console.log(`  ${hostName.padEnd(5)} GET  /${p.padEnd(24)} ${String(r.status).padEnd(4)} ${c.padEnd(10)} ${r.text.slice(0, 120)}`);
    await sleep(400);
  }
}

const existing = rows.filter((r) => r.cls === "EXISTS");
console.log("\n=== C) EXISTING (routed) paths ===\n");
if (!existing.length) {
  console.log("  (none)");
} else {
  for (const r of existing) {
    console.log(`  ${r.host} ${r.method} /${r.path} -> HTTP ${r.status}`);
    console.log(`    ${r.body}`);
  }
}

const ev = {
  generatedAt: new Date().toISOString(),
  hosts: HOSTS,
  auth: results,
  routeRows: rows,
  existing,
  verdict: existing.length
    ? `routed paths beyond save_order: ${existing.map((r) => `${r.host} ${r.method} /${r.path}`).join(", ")}`
    : "no routed path other than save_order on either host",
};
const out = path.join(REPO_ROOT, "scripts", "petpooja-route-matrix-evidence.json");
fs.writeFileSync(out, JSON.stringify(ev, null, 2));
console.log(`\nEvidence: ${out}`);
console.log(`VERDICT: ${ev.verdict}`);
