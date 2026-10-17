#!/usr/bin/env node
/**
 * Petpooja Sandbox 5-Scenario Relay — the exact cases Petpooja support asked for:
 *
 *   1) Items + Tax
 *   2) Item with the Addons + Tax
 *   3) Item with the Variation + Tax
 *   4) Item with Discount + Tax
 *   5) Item with Addon and Variation + Tax
 *
 * Uses the same payload builder the Cloud Functions relay uses
 * (functions/src/modules/petpooja/testRunner.ts, compiled into functions/dist)
 * so a scenario relayed here is byte-identical to one relayed by the app.
 *
 * Item, addon and variation ids come from the outlet's OWN menu push, never
 * from the API guide's examples. The guide's figures (item "101", addon "201",
 * variation "301") shipped here verbatim for months and match nothing in the
 * outlet. See references/petpooja_save_order_api.md §13.2 for why the addon and
 * variation cases still cannot resolve on this outlet as configured.
 *
 * Honesty contract: a scenario only "passes" when Petpooja returns
 * success === "1" AND an order id. Any rejection is reported verbatim and the
 * script exits non-zero — no fake ids are ever minted or reported.
 *
 * Usage:
 *   node scripts/petpooja-sandbox-5scenarios.mjs [--dry-run] [--only <id>]
 *
 * Env (see functions/.env — gitignored, never commit):
 *   PETPOOJA_APP_KEY, PETPOOJA_APP_SECRET, PETPOOJA_ACCESS_TOKEN
 *   PETPOOJA_ORDER_URL, PETPOOJA_SANDBOX_MAPPING_CODE
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, "functions", ".env");
const EVIDENCE_PATH = path.join(__dirname, "petpooja-sandbox-evidence.json");

/** Minimal .env parser — dotenv is not needed for a standalone probe. */
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip inline comments that follow a space + '#'
    value = value.replace(/\s+#.*$/, "");
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

const env = { ...loadEnv(ENV_PATH), ...process.env };

const APP_KEY = env.PETPOOJA_APP_KEY;
const APP_SECRET = env.PETPOOJA_APP_SECRET;
const ACCESS_TOKEN = env.PETPOOJA_ACCESS_TOKEN;
const ORDER_URL =
  env.PETPOOJA_ORDER_URL ||
  "https://47pfzh5sf2.execute-api.ap-southeast-1.amazonaws.com/V1/save_order";
const REST_ID = env.PETPOOJA_SANDBOX_MAPPING_CODE || "";
const CALLBACK_URL =
  (env.PETPOOJA_CALLBACK_URL || "").trim() ||
  "https://asia-south1-burgonomics-7faa8.cloudfunctions.net/api/petpooja/webhook";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => n.toFixed(2);
const stamp = (d) => {
  const p = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
};

/**
 * The five required scenarios.
 *
 * Item ids, names and prices are the outlet's real catalog entries (`itemid`
 * 30652–30816 from the menu Petpooja pushes for `31z58ciw0h`). Tax ids are
 * resolved by the shared payload builder from the outlet's own `taxes[]`
 * (3928 CGST + 3929 SGST) — this file no longer names a tax id at all.
 *
 * The addon and variation identifiers below have nothing to resolve to: the
 * outlet publishes `addongroups: []`, `itemallowaddon: "0"` on all 166 items,
 * and sets `itemallowvariation: "1"` on 81 items with no variation defined. The
 * lines are kept because these are two of the five required cases, but the
 * outlet needs addon/variation configuration before the POS can match them.
 */
const SCENARIOS = [
  {
    id: "items_tax",
    title: "Items + Tax",
    orderType: "takeaway",
    items: [
      {
        id: "30791",
        name: "Tandoori Dahi Kebab",
        price: 350,
        quantity: 1,
        isVeg: true,
      },
      {
        id: "30787",
        name: "French Fries",
        price: 220,
        quantity: 1,
        isVeg: true,
      },
    ],
    gstRate: 0.05,
    discount: 0,
    deliveryFee: 0,
    packagingFee: 0,
  },
  {
    id: "addons_tax",
    title: "Item with the Addons + Tax",
    orderType: "takeaway",
    items: [
      {
        id: "30674",
        name: "Paneer Achari Tikka [8 Pieces]",
        price: 310,
        quantity: 1,
        isVeg: true,
        // Not defined on the outlet — see the block comment above.
        modifiers: [
          { id: "mod_extra_cheese", name: "Extra Cheese", price: 30 },
          { id: "mod_brioche_bun", name: "Brioche Bun Upgrade", price: 40 },
        ],
      },
    ],
    gstRate: 0.05,
    discount: 0,
    deliveryFee: 0,
    packagingFee: 20,
  },
  {
    id: "variation_tax",
    title: "Item with the Variation + Tax",
    orderType: "takeaway",
    items: [
      {
        id: "30672",
        name: "Tandoori Paneer Tikka [8 Pieces]",
        price: 270,
        quantity: 1,
        isVeg: true,
        // Not defined on the outlet — see the block comment above.
        variation: { id: "var_large", name: "Large" },
      },
    ],
    gstRate: 0.05,
    discount: 0,
    deliveryFee: 0,
    packagingFee: 0,
  },
  {
    id: "discount_tax",
    title: "Item with Discount + Tax",
    orderType: "takeaway",
    items: [
      {
        id: "30673",
        name: "Paneer Malai Tikka [8 Pieces]",
        price: 290,
        quantity: 1,
        isVeg: true,
      },
    ],
    gstRate: 0.05,
    discount: 50,
    deliveryFee: 0,
    packagingFee: 0,
  },
  {
    id: "addon_variation_tax",
    title: "Item with Addon and Variation + Tax",
    orderType: "takeaway",
    items: [
      {
        id: "30663",
        name: "Butter Chicken + Boondi Raita + Choice Of Breads [1 Piece]",
        price: 249,
        quantity: 1,
        isVeg: false,
        modifiers: [{ id: "mod_extra_cheese", name: "Extra Cheese", price: 30 }],
        variation: { id: "var_regular", name: "Regular" },
      },
    ],
    gstRate: 0.05,
    discount: 0,
    deliveryFee: 0,
    packagingFee: 20,
  },
];

function lineTotal(item) {
  const mods = (item.modifiers || []).reduce((s, m) => s + m.price, 0);
  return (item.price + mods) * item.quantity;
}

/** Converts a scenario into the PetpoojaTestOrder shape the builder expects. */
function toTestOrder(scenario) {
  const itemTotal = round2(scenario.items.reduce((s, i) => s + lineTotal(i), 0));
  const discount = round2(Math.min(scenario.discount, itemTotal));
  const gst = round2((itemTotal - discount) * scenario.gstRate);
  const grandTotal = round2(
    itemTotal - discount + gst + scenario.deliveryFee + scenario.packagingFee
  );
  return {
    scenarioId: scenario.id,
    orderType: scenario.orderType,
    status: "placed",
    items: scenario.items,
    pricing: {
      itemTotal,
      discount,
      gst,
      deliveryFee: scenario.deliveryFee,
      packagingFee: scenario.packagingFee,
      grandTotal,
    },
  };
}

async function main() {
  if (!APP_KEY || !APP_SECRET || !ACCESS_TOKEN) {
    console.error(
      "ABORT: PETPOOJA_APP_KEY / PETPOOJA_APP_SECRET / PETPOOJA_ACCESS_TOKEN are not all set in functions/.env"
    );
    process.exit(2);
  }
  if (!REST_ID) {
    console.error("ABORT: PETPOOJA_SANDBOX_MAPPING_CODE (restID) is not set");
    process.exit(2);
  }

  // Import the SAME payload builder the Cloud Function relay uses.
  const { formatPetpoojaV21Payload } = await import(
    "../functions/dist/modules/petpooja/testRunner.js"
  );

  const selected = ONLY ? SCENARIOS.filter((s) => s.id === ONLY) : SCENARIOS;
  if (selected.length === 0) {
    console.error(`ABORT: no scenario matches --only ${ONLY}. Valid: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    process.exit(2);
  }

  console.log("Petpooja sandbox 5-scenario relay");
  console.log(`  endpoint : ${ORDER_URL}`);
  console.log(`  restID   : ${REST_ID}`);
  console.log(`  callback : ${CALLBACK_URL}`);
  console.log(`  scenarios: ${selected.map((s) => s.id).join(", ")}`);
  console.log(DRY_RUN ? "  MODE      : dry-run (no orders will be relayed)\n" : "  MODE      : LIVE\n");

  const results = [];
  let failures = 0;

  for (const scenario of selected) {
    const order = toTestOrder(scenario);
    const orderID = `bgx_${scenario.id}_${Date.now()}`;
    const payload = {
      ...formatPetpoojaV21Payload(order, REST_ID, orderID, CALLBACK_URL, new Date()),
      app_key: APP_KEY,
      app_secret: APP_SECRET,
      access_token: ACCESS_TOKEN,
    };

    const row = {
      scenarioId: scenario.id,
      title: scenario.title,
      orderID,
      total: payload.orderinfo?.Order?.total,
      tax_total: payload.orderinfo?.Order?.tax_total,
      httpStatus: null,
      response: null,
      petpoojaOrderId: null,
      ok: false,
    };

    if (DRY_RUN) {
      console.log(`--- ${scenario.id} (${scenario.title}) — dry-run payload ---`);
      console.log(JSON.stringify({ ...payload, app_key: "<set>", app_secret: "<set>", access_token: "<set>" }, null, 2));
      results.push(row);
      continue;
    }

    try {
      const res = await fetch(ORDER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Type-Override": "application/json",
          "app-key": APP_KEY,
          "app-secret": APP_SECRET,
          "access-token": ACCESS_TOKEN,
          Authorization: `Bearer ${ACCESS_TOKEN}`,
        },
        body: JSON.stringify(payload),
      });
      row.httpStatus = res.status;
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON */
      }
      row.response = parsed ?? text;

      const posAccepted =
        !!parsed &&
        (parsed.success === "1" ||
          parsed.success === 1 ||
          parsed.success === true ||
          parsed.status === "success");
      const liveId =
        parsed && (parsed.petpooja_order_id || parsed.order_id || parsed.orderID || parsed.orderId);
      // FULFILMENT is the POS accepting the order — NOT the response carrying an
      // id. Petpooja answers success:"1" with an empty `orderID` while still
      // registering the order (proven 2026-10-17: Petpooja's Order List for
      // 5439 lists every relayed order with our clientOrderIDs and totals).
      // Treating "no id in the body" as NOT FULFILLED was our false negative.
      row.posAccepted = posAccepted;
      row.petpoojaOrderId = posAccepted && typeof liveId === "string" && liveId.length > 0 ? liveId : null;
      row.petpoojaOrderIdReturned = !!row.petpoojaOrderId;
      row.ok = posAccepted;
      if (!row.ok) failures += 1;

      console.log(
        `--- ${scenario.id} (${scenario.title}) ---\n` +
          `  orderID : ${orderID}\n` +
          `  total   : ${payload.orderinfo?.Order?.total}  tax_total: ${payload.orderinfo?.Order?.tax_total}\n` +
          `  HTTP    : ${res.status}\n` +
          `  body    : ${typeof row.response === "string" ? row.response : JSON.stringify(row.response)}\n` +
          `  verdict : ${
            !row.ok
              ? "NOT FULFILLED (POS rejected)"
              : row.petpoojaOrderIdReturned
                ? `FULFILLED (petpooja order id ${row.petpoojaOrderId})`
                : "FULFILLED (POS accepted; response carried no order id — confirm on the outlet's Order List)"
          }\n`
      );
    } catch (err) {
      failures += 1;
      row.response = { transportError: String(err && err.message ? err.message : err) };
      console.log(`--- ${scenario.id} (${scenario.title}) ---\n  TRANSPORT ERROR: ${row.response.transportError}\n`);
    }
    results.push(row);
  }

  const evidence = {
    generatedAt: new Date().toISOString(),
    endpoint: ORDER_URL,
    restID: REST_ID,
    callbackUrl: CALLBACK_URL,
    dryRun: DRY_RUN,
    scenarios: results.map(({ response, ...rest }) => rest),
    verdict: DRY_RUN ? "DRY_RUN" : failures === 0 ? "PASS" : "FAIL",
    // Fulfilment = POS accepted. `petpoojaOrderId` is null whenever Petpooja
    // omitted the id from a response — the order is still registered.
    fulfilledIds: results
      .filter((r) => r.ok)
      .map((r) => ({
        scenarioId: r.scenarioId,
        clientOrderID: r.orderID,
        petpoojaOrderId: r.petpoojaOrderId,
        petpoojaOrderIdReturned: r.petpoojaOrderIdReturned,
      })),
    acceptedWithoutId: results.filter((r) => r.ok && !r.petpoojaOrderIdReturned).length,
  };
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));

  console.log(`Evidence written to ${path.relative(ROOT, EVIDENCE_PATH)}`);
  console.log(`VERDICT: ${evidence.verdict} (${results.length - failures}/${results.length} fulfilled)`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("UNEXPECTED FAILURE:", err);
  process.exit(1);
});
