#!/usr/bin/env node
/**
 * DECISIVE PROBE — a corrected payload built by hand.
 *
 * Why this exists
 * ---------------
 * Every relay we have ever sent contained identifiers that cannot exist in the
 * outlet, because the payload builder copied the *examples* out of the API
 * guide instead of the outlet's real data:
 *
 *   API guide example          Our payload              Outlet's real value
 *   ---------------------------------------------------------------------
 *   item id "101"              "101"                    30791, 30674, ...
 *   addon id "201"             "201"                    (none configured)
 *   item tax "11213"/"20375"   "11213"/"20375"          3928 CGST, 3929 SGST
 *   tax_details "301"/"302"    "301"/"302"              3928, 3929
 *
 * Those guide numbers are illustrative. The outlet shares 3928/3929 on every
 * item and no item carries id 101. So the earlier "the endpoint is a stub"
 * conclusion was drawn from a payload that was itself wrong, and proves far
 * less than it claimed.
 *
 * This probe rebuilds the body from the outlet's OWN catalog and deliberately
 * does NOT use `formatPetpoojaV21Payload`, so the builder's hard-coded example
 * ids cannot contaminate the result. It tries BOTH documented contracts,
 * because the "flat body is rejected" finding was also produced with example
 * ids and may simply have been an invalid-item/tax rejection:
 *
 *   A) envelope — lower-case `orderinfo` wrapper (the shape observed accepted)
 *   B) flat     — every field top-level, per the official PDF sections 2-8
 *
 * Usage
 *   node scripts/petpooja-corrected-payload-probe.mjs
 *   node scripts/petpooja-corrected-payload-probe.mjs --items 30791,30787
 *   node scripts/petpooja-corrected-payload-probe.mjs --only A
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

const ITEMS_ARG = argOf("--items");
const ONLY = (argOf("--only") || "AB").toUpperCase();
const MENU_PATH =
  argOf("--menu") || path.join(process.env.TEMP || "/tmp", "petpooja-menu-push.json");

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
const ORDER_URL =
  env.PETPOOJA_ORDER_URL ||
  "https://qle1yy2ydc.execute-api.ap-southeast-1.amazonaws.com/V1/save_order";
const CALLBACK_URL =
  env.PETPOOJA_CALLBACK_URL ||
  "https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook";

const money = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isTrue = (v) => v === true || v === "1" || v === 1 || v === "true";

/** The outlet's real taxes, read from the menu snapshot — never hard-coded. */
function readTaxes(menu) {
  const t = Array.isArray(menu.taxes) ? menu.taxes : [];
  const cgst = t.find((x) => /cgst/i.test(x.taxname || ""));
  const sgst = t.find((x) => /sgst/i.test(x.taxname || ""));
  return {
    cgst: { id: String(cgst?.taxid ?? ""), rate: Number(cgst?.tax ?? 2.5) },
    sgst: { id: String(sgst?.taxid ?? ""), rate: Number(sgst?.tax ?? 2.5) },
  };
}

/** Petpooja wants IST wall-clock, not the runner's local zone. */
function istParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t) => f.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${g("year")}-${g("month")}-${g("day")}`,
    time: `${g("hour")}:${g("minute")}:${g("second")}`,
    stamp: `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`,
  };
}

/** Build one line from a REAL catalog item. Nothing invented. */
function buildLine(item, taxes) {
  const unit = Number(item.price);
  const inclusive = isTrue(item.tax_inclusive);
  const rate = (taxes.cgst.rate + taxes.sgst.rate) / 100;
  const taxAmount = inclusive ? r2(unit - unit / (1 + rate)) : r2(unit * rate);
  const half = r2(taxAmount / 2);
  return {
    id: String(item.itemid),
    name: item.itemname,
    price: money(unit),
    final_price: money(unit),
    quantity: "1",
    gst_liability: "restaurant",
    tax_inclusive: inclusive,
    tax_percentage: String(taxes.cgst.rate + taxes.sgst.rate),
    item_discount: "",
    item_tax: [
      { id: taxes.cgst.id, name: "CGST", tax_percentage: String(taxes.cgst.rate), amount: money(half) },
      { id: taxes.sgst.id, name: "SGST", tax_percentage: String(taxes.sgst.rate), amount: money(half) },
    ],
    variation_id: "",
    variation_name: "",
    addon_items: [],
    _lineTotal: r2(unit),
    _taxAmount: taxAmount,
    _inclusive: inclusive,
  };
}

async function main() {
  if (!APP_KEY || !APP_SECRET || !ACCESS_TOKEN) {
    console.error("ABORT: Petpooja credentials not all set in functions/.env");
    process.exit(2);
  }
  if (!fs.existsSync(MENU_PATH)) {
    console.error(`ABORT: no menu snapshot at ${MENU_PATH} (pass --menu <path>)`);
    process.exit(2);
  }

  const menu = JSON.parse(fs.readFileSync(MENU_PATH, "utf8"));
  const all = Array.isArray(menu.items) ? menu.items : [];
  const priced = all.filter((i) => Number(i.price) > 0 && String(i.active) === "1");
  if (priced.length === 0) {
    console.error("ABORT: snapshot has no active, priced items");
    process.exit(2);
  }

  let chosen;
  if (ITEMS_ARG) {
    chosen = ITEMS_ARG.split(",").map((s) => {
      const id = s.trim();
      const hit = all.find((i) => String(i.itemid) === id);
      if (!hit) {
        console.error(`ABORT: item ${id} not in the catalog snapshot`);
        process.exit(2);
      }
      return hit;
    });
  } else {
    chosen = priced.sort((a, b) => Number(b.price) - Number(a.price)).slice(0, 2);
  }

  const taxes = readTaxes(menu);
  if (!taxes.cgst.id || !taxes.sgst.id) {
    console.error("ABORT: snapshot has no CGST/SGST tax ids to use");
    process.exit(2);
  }

  const lines = chosen.map((i) => buildLine(i, taxes));
  const itemTotal = r2(lines.reduce((s, l) => s + l._lineTotal, 0));
  const taxTotal = r2(lines.reduce((s, l) => s + l._taxAmount, 0));
  const grandTotal = r2(
    lines.reduce((s, l) => s + (l._inclusive ? l._lineTotal : l._lineTotal + l._taxAmount), 0)
  );
  const t = istParts();
  const clientOrderID = `bgx_corrected_${Date.now()}`;

  const customer = {
    name: "Burgonomics Sandbox Test",
    phone: "9825000001",
    address: "Sandbox test order - Burgonomics DEMO outlet",
    email: "burgonomicsind@gmail.com",
  };

  const orderFields = {
    orderID: clientOrderID,
    preorder_date: t.date,
    preorder_time: t.time,
    advanced_order: "N",
    order_type: "H",
    created_on: t.stamp,
    total: money(grandTotal),
    tax_total: money(taxTotal),
    dc_tax_percentage: "0",
    pc_tax_percentage: "0",
    payment_type: "ONLINE",
    enable_delivery: "0",
    delivery_charges: "0",
    packing_charges: "0",
    service_charge: "0",
    discount_type: "F",
    discount_total: "0",
    callback_url: CALLBACK_URL,
    description: "Corrected-payload probe",
    resID: REST_ID,
    restID: REST_ID,
    restaurant_id: String(menu.restaurants?.[0]?.restaurantid ?? ""),
  };

  const strip = (l) => {
    const { _lineTotal, _taxAmount, _inclusive, ...rest } = l;
    return rest;
  };
  const orderItems = lines.map(strip);
  const taxLines = [
    {
      id: taxes.cgst.id,
      title: "CGST",
      type: "P",
      price: `${taxes.cgst.rate}%`,
      tax: money(r2(taxTotal / 2)),
      restaurant_liable_amt: "0.00",
    },
    {
      id: taxes.sgst.id,
      title: "SGST",
      type: "P",
      price: `${taxes.sgst.rate}%`,
      tax: money(r2(taxTotal / 2)),
      restaurant_liable_amt: "0.00",
    },
  ];

  const envelope = {
    orderinfo: {
      Customer: customer,
      Order: { ...orderFields },
      OrderItem: orderItems,
      Tax: taxLines,
      tax_details: taxLines,
    },
    restID: REST_ID,
    callback_url: CALLBACK_URL,
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    access_token: ACCESS_TOKEN,
  };

  const flat = {
    restID: REST_ID,
    res_name: menu.restaurants?.[0]?.details?.restname ?? "Burgonomics DEMO [135148]",
    address: "Ahmedabad",
    contact_information: "1234567890",
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    customer_address: customer.address,
    ...orderFields,
    order_items: orderItems,
    tax_details: taxLines,
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    access_token: ACCESS_TOKEN,
  };

  console.log("=== CORRECTED-PAYLOAD PROBE ===");
  console.log(`endpoint    : ${ORDER_URL}`);
  console.log(`restID      : ${REST_ID}`);
  console.log(
    `tax ids used: CGST ${taxes.cgst.id} @${taxes.cgst.rate}% / SGST ${taxes.sgst.id} @${taxes.sgst.rate}%`
  );
  console.log(`cart        : ${orderItems.map((i) => `${i.id} ${i.name} @${i.price}`).join(" | ")}`);
  console.log(
    `totals      : itemTotal=${money(itemTotal)} taxTotal=${money(taxTotal)} grand=${money(grandTotal)}`
  );
  console.log("");

  const redact = (o) =>
    JSON.parse(
      JSON.stringify(o, (k, v) =>
        k === "app_key" || k === "app_secret" || k === "access_token" ? `<${k}:redacted>` : v
      )
    );

  const variants = [
    ["A", "envelope orderinfo (corrected content)", envelope],
    ["B", "flat body per official PDF (corrected content)", flat],
  ].filter(([id]) => ONLY.includes(id));

  const results = [];
  for (const [id, label, body] of variants) {
    console.log(`----- VARIANT ${id}: ${label} -----`);
    console.log("REQUEST BODY:");
    console.log(JSON.stringify(redact(body), null, 2));
    let status = 0;
    let text = "";
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
        signal: AbortSignal.timeout(45_000),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      text = `FETCH_ERROR: ${err?.message || err}`;
    }
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    const live =
      parsed && (parsed.orderID || parsed.order_id || parsed.petpooja_order_id || parsed.orderId);
    console.log(`RESPONSE HTTP ${status}: ${text}`);
    console.log(`  -> PETPOOJA ORDER ID: ${live || "(empty)"}`);
    console.log("");
    results.push({
      variant: id,
      label,
      httpStatus: status,
      response: parsed ?? text,
      petpoojaOrderId: live || null,
      request: redact(body),
    });
    if (live) {
      console.log(`*** FULFILLED by variant ${id} — the payload content WAS the blocker ***`);
      break;
    }
  }

  const ev = {
    generatedAt: new Date().toISOString(),
    endpoint: ORDER_URL,
    restID: REST_ID,
    taxIds: taxes,
    cart: orderItems.map((i) => ({ id: i.id, name: i.name, price: i.price })),
    totals: { itemTotal, taxTotal, grandTotal },
    results,
    anyFulfilled: results.some((r) => r.petpoojaOrderId),
  };
  const p = path.join(REPO_ROOT, "scripts", "petpooja-corrected-payload-evidence.json");
  fs.writeFileSync(p, JSON.stringify(ev, null, 2));
  console.log(`Evidence: ${p}`);
  console.log(
    ev.anyFulfilled
      ? "VERDICT: the relay is NOT a stub — our payload content was wrong."
      : "VERDICT: still no order id even with fully corrected real identifiers."
  );
  process.exit(ev.anyFulfilled ? 0 : 1);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e?.message || e);
  process.exit(1);
});
