#!/usr/bin/env node
/**
 * Does the API validate `restID`?
 *
 * With the documented `orderinfo.OrderInfo.*.details` shape the API now echoes
 * our real `restID` and `clientOrderID` (it echoed nothing before). `orderID`
 * is still empty. To tell whether that is (a) the outlet not accepting orders or
 * (b) something still wrong in our order body, vary ONLY `restID`:
 *
 *   real   -> 31z58ciw0h     (the outlet's menusharingcode)
 *   bogus  -> THIS_RES_ID_DOES_NOT_EXIST_999
 *   numeric-> 5439            (the outlet's numeric restaurantid)
 *
 * If the bogus id is echoed back as-is, the API performs no restaurant lookup,
 * and an empty `orderID` cannot be caused by our body. If the bogus id is
 * dropped (or rejected), the API DOES look the restaurant up — so the real id
 * passing means our remaining order fields are what is failing.
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
const CALLBACK_URL =
  env.PETPOOJA_CALLBACK_URL ||
  "https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook";
const URL_ORDER =
  "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order";

const MENU_PATH = path.join(process.env.TEMP || "/tmp", "petpooja-menu-push.json");
const menu = JSON.parse(fs.readFileSync(MENU_PATH, "utf8"));
const items = (menu.items || []).filter((i) => Number(i.price) > 0 && String(i.active) === "1");
const cgst = (menu.taxes || []).find((x) => /cgst/i.test(x.taxname || ""));
const sgst = (menu.taxes || []).find((x) => /sgst/i.test(x.taxname || ""));
const restName = menu.restaurants?.[0]?.details?.restname || "Burgonomics DEMO";

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

function buildBody(restID, tag) {
  const rate = (Number(cgst.tax) + Number(sgst.tax)) / 100;
  const lines = items.slice(0, 2).map((item) => {
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
  const taxTotal = r2(lines.reduce((s, l) => s + Number(l.item_tax[0].amount) * 2, 0));
  const t = istNow();
  return {
    app_key: APP_KEY, app_secret: APP_SECRET, access_token: ACCESS_TOKEN,
    callback_url: CALLBACK_URL,
    orderinfo: {
      OrderInfo: {
        Restaurant: { details: { res_name: restName, address: "Ahmedabad", contact_information: "1234567890", restID } },
        Customer: { details: { email: "burgonomicsind@gmail.com", name: "Burgonomics Sandbox Test", address: "Sandbox test order", phone: "9825000001" } },
        Order: {
          details: {
            orderID: `bgx_rid_${tag}_${Date.now()}`, preorder_date: t.date, preorder_time: t.time,
            advanced_order: "N", order_type: "H", payment_type: "ONLINE",
            service_charge: "0", delivery_charges: "0", dc_tax_percentage: "0",
            packing_charges: "0", pc_tax_percentage: "0", discount_total: "0",
            tax_total: money(taxTotal), total: money(r2(itemTotal + taxTotal)),
            description: "restID validation probe", created_on: t.stamp,
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

const cases = [
  ["real", "31z58ciw0h"],
  ["bogus", "THIS_RES_ID_DOES_NOT_EXIST_999"],
  ["numeric", "5439"],
];

const results = [];
for (const [tag, restID] of cases) {
  const sent = buildBody(restID, tag);
  let status = 0, text = "";
  try {
    const res = await fetch(URL_ORDER, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sent), signal: AbortSignal.timeout(45_000),
    });
    status = res.status;
    text = await res.text();
  } catch (err) { text = `FETCH_ERROR: ${err?.message || err}`; }
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  const echoed = parsed?.restID;
  console.log(`-- ${tag}: sent restID=${restID}`);
  console.log(`   HTTP ${status} ${text}`);
  console.log(
    `   echoed restID=${JSON.stringify(echoed)}  ${
      echoed === restID ? "ECHOED AS SENT" : echoed ? "DIFFERENT" : "DROPPED/EMPTY"
    }`
  );
  results.push({ tag, sentRestID: restID, httpStatus: status, response: parsed ?? text, echoedRestID: echoed ?? null });
}

const ev = { generatedAt: new Date().toISOString(), endpoint: URL_ORDER, results };
fs.writeFileSync(
  path.join(REPO_ROOT, "scripts", "petpooja-restid-validation-evidence.json"),
  JSON.stringify(ev, null, 2)
);
console.log("\nEvidence: scripts/petpooja-restid-validation-evidence.json");
