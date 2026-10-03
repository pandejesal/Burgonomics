// Self-serve key verification (no deploy, no test suite coupling).
// Usage:  cd functions && node --env-file=.env scripts/verify-keys.mjs
// Proves the test credentials we obtained ourselves actually authenticate:
//   - Razorpay  GET /v1/payments?limit=1      (Basic auth, test keys)
//   - Borzo     GET /api/business/1.8/client  (X-DV-Auth-Token)
// Empty keys print SKIPPED and never fail the run; a rejected key exits 2.

const RAZORPAY = "https://api.razorpay.com/v1";
const BORZO_DEFAULT_BASE = "https://robot-in.borzodelivery.com";

const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  console.log(`[${status.padEnd(7)}] ${name}: ${detail}`);
};

async function checkRazorpay() {
  const keyId = (process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || "").trim();
  if (!keyId || !keySecret) {
    record("razorpay", "SKIPPED", "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET empty");
    return;
  }
  const prefix = keyId.startsWith("rzp_test_")
    ? "test"
    : keyId.startsWith("rzp_live_")
      ? "LIVE"
      : "unknown-mode";
  try {
    const res = await fetch(`${RAZORPAY}/payments`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(10000),
    });
    await res.arrayBuffer().catch(() => {});
    if (res.status === 200) {
      record(
        "razorpay",
        "OK",
        `auth accepted (${prefix} key); GET /payments returned 200`,
      );
    } else if (res.status === 401) {
      record("razorpay", "FAIL", `401 Unauthorized - key id/secret pair rejected`);
    } else {
      record("razorpay", "WARN", `HTTP ${res.status} (auth may still be valid)`);
    }
  } catch (err) {
    record("razorpay", "ERROR", String(err && err.message ? err.message : err));
  }
}

async function checkBorzo() {
  const token = (process.env.BORZO_API_KEY || "").trim();
  const base = (
    process.env.BORZO_BASE_URL || BORZO_DEFAULT_BASE
  ).replace(/\/+$/, "");
  if (!token) {
    record("borzo", "SKIPPED", "BORZO_API_KEY empty");
    return;
  }
  const envTag = base.includes("robotapitest")
    ? "test env"
    : base.includes("robot-in")
      ? "PRODUCTION env"
      : "custom base";
  try {
    const res = await fetch(`${base}/api/business/1.8/client`, {
      headers: { "X-DV-Auth-Token": token },
      signal: AbortSignal.timeout(10000),
    });
    await res.arrayBuffer().catch(() => {});
    if (res.status === 200) {
      record("borzo", "OK", `auth accepted (${envTag}); GET /client returned 200`);
    } else if (res.status === 401 || res.status === 403) {
      record("borzo", "FAIL", `HTTP ${res.status} - auth token rejected (${envTag})`);
    } else if (res.status === 404) {
      record("borzo", "FAIL", `404 at ${base}/api/business/1.8/client - check BORZO_BASE_URL`);
    } else {
      record("borzo", "WARN", `HTTP ${res.status} (${envTag}; auth may still be valid)`);
    }
  } catch (err) {
    record("borzo", "ERROR", String(err && err.message ? err.message : err));
  }
}

function reportDispatchReadiness() {
  const borzoLive = (process.env.BORZO_API_KEY || "").trim() !== "";
  const sfxLive =
    (process.env.SHADOWFAX_API_KEY || "").trim() !== "" &&
    (process.env.SHADOWFAX_CLIENT_CODE || "").trim() !== "";
  const mocks =
    ["MOCK_BORZO_DISPATCH", "MOCK_SHADOWFAX_DISPATCH", "MOCK_PORTER_DISPATCH"]
      .filter((k) => process.env[k] === "true");
  console.log("\nDispatch fan-out readiness:");
  console.log(`  borzo     : ${borzoLive ? "LIVE key set" : "no key (excluded from fan-out)"}`);
  console.log(`  shadowfax : ${sfxLive ? "LIVE key set" : "no key (excluded from fan-out)"}`);
  console.log(`  mocks on  : ${mocks.length ? mocks.join(", ") : "none (live mode)"}`);
}

async function main() {
  console.log("Verifying self-serve test keys...\n");
  await checkRazorpay();
  await checkBorzo();
  reportDispatchReadiness();

  const failed = results.filter((r) => r.status === "FAIL" || r.status === "ERROR");
  const checked = results.filter((r) => r.status !== "SKIPPED");
  console.log(
    `\n${checked.length} checked, ${failed.length} failed, ` +
      `${results.length - checked.length} skipped.`,
  );
  process.exitCode = failed.length ? 2 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
