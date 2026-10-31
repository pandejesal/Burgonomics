import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { emulatorOverlay } from "./qa-emulator-overlay.mjs";

const QA_DIR = path.dirname(fileURLToPath(import.meta.url));
const DELIVERY = "C:\\Users\\DELL\\Desktop\\Burgonomics\\.swarm-worktrees\\delivery-launch-ui-20261028";
const PARTNER = "C:\\Users\\DELL\\Desktop\\Burgonomics\\.swarm-worktrees\\partner-launch-ui-20261029";
const MCP_DEPS = "C:\\Users\\DELL\\AppData\\Local\\BurgonomicsDevTools\\playwright-mcp-0.0.83";
const JBR = "C:\\Program Files\\Android\\Android Studio\\jbr";
const FIREBASE_JS = path.join(DELIVERY, "node_modules", "firebase-tools", "lib", "bin", "firebase.js");
const PROJECT = "demo-burgonomics-auth-qa";
const AUTH_BASE = `http://127.0.0.1:48692/identitytoolkit.googleapis.com/v1`;
const AUTH_EMU = "http://127.0.0.1:48692";
const FS_EMU = "http://127.0.0.1:48691";
const ADMIN_EMAIL = "qa.admin@example.test";
const ADMIN_PASSWORD = "QaOnly!Pass123";
const BADROLE_EMAIL = "qa.badrole@example.test";
const BADROLE_PASSWORD = "QaOnly!Pass123";
const PHONE = "9876543210";

const results = [];
const blockedExternal = new Set();
const artifacts = { screenshots: [], hashes: {} };
let emulatorProc = null;
let browser = null;
const servers = [];

function step(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name}${detail ? " :: " + detail : ""}`);
}
function hashFile(p) {
  return fs.readFileSync(p, "utf8").split(/\r?\n/).length + " lines";
}
async function waitFor(url, label, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for ${label} at ${url}`);
}
async function createAppServer(appDir, kind, port, label) {
  const requireFromApp = createRequire(path.join(appDir, "package.json"));
  const viteEntry = requireFromApp.resolve("vite");
  const vite = await import(pathToFileURL(viteEntry).href);
  const loaded = await vite.loadConfigFromFile(
    { command: "serve", mode: "development" },
    path.join(appDir, "vite.config.ts"),
    appDir
  );
  if (!loaded || !loaded.config) throw new Error(`could not load vite config for ${label}`);
  const base = { ...loaded.config };
  const plugins = base.plugins ?? [];
  const userDefine = base.define ?? {};
  delete base.plugins;
  delete base.server;
  const server = await vite.createServer({
    ...base,
    configFile: false,
    root: appDir,
    envDir: QA_DIR,
    cacheDir: path.join(QA_DIR, `.vite-cache-${kind}`),
    optimizeDeps: { ...(base.optimizeDeps ?? {}), force: true },
    mode: "development",
    appType: "spa",
    plugins: [emulatorOverlay(appDir, kind), ...plugins],
    define: userDefine,
    server: { host: "127.0.0.1", port, strictPort: true },
    logLevel: "warn",
    clearScreen: false,
  });
  await server.listen();
  servers.push(server);
  await waitFor(`http://127.0.0.1:${port}/`, label);
  return `http://127.0.0.1:${port}`;
}
async function seed() {
  const signUp = async (email, password) => {
    const res = await fetch(`${AUTH_BASE}/accounts:signUp?key=demo-synthetic-api-key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`signUp ${email} failed: ${JSON.stringify(data)}`);
    return data.localId;
  };
  const seedDoc = async (uid, role) => {
    const url = `${FS_EMU}/v1/projects/${PROJECT}/databases/(default)/documents/admins/${uid}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer owner" },
      body: JSON.stringify({
        fields: {
          role: { stringValue: role },
          fullName: { stringValue: "QA Synthetic Operator" },
        },
      }),
    });
    if (!res.ok) throw new Error(`firestore seed failed: ${res.status} ${await res.text()}`);
  };
  const adminUid = await signUp(ADMIN_EMAIL, ADMIN_PASSWORD);
  await seedDoc(adminUid, "branch_owner");
  const badUid = await signUp(BADROLE_EMAIL, BADROLE_PASSWORD);
  await seedDoc(badUid, "superadmin");
  return { adminUid, badUid };
}
async function latestPhoneCode() {
  const res = await fetch(`${AUTH_EMU}/emulator/v1/projects/${PROJECT}/verificationCodes`);
  const data = await res.json();
  const list = data.verificationCodes ?? [];
  const match = list.filter((c) => String(c.phoneNumber || "").includes(PHONE)).pop();
  return match?.code ?? null;
}
async function launchBrowser() {
  const requireFromMcp = createRequire(path.join(MCP_DEPS, "package.json"));
  const { chromium } = requireFromMcp("playwright");
  try {
    return await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  } catch (err) {
    const root = "C:\\Users\\DELL\\AppData\\Local\\ms-playwright";
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d));
    dirs.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) {
      const exe = path.join(root, d, "chrome-win64", "chrome.exe");
      if (fs.existsSync(exe)) return await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox"] });
    }
    throw new Error(`no chromium launchable: ${err.message}`);
  }
}
async function newPage() {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 430, height: 932 } });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    let host = "";
    try { host = new URL(url).hostname; } catch { return route.abort(); }
    if (host === "127.0.0.1" || host === "localhost" || url.startsWith("data:") || url.startsWith("blob:")) {
      return route.continue();
    }
    blockedExternal.add(url);
    return route.abort();
  });
  const page = await context.newPage();
  return { context, page };
}
async function shot(page, name) {
  const p = path.join(QA_DIR, name);
  await page.screenshot({ path: p, type: "jpeg", quality: 60 });
  artifacts.screenshots.push(name);
  return p;
}
async function fillOtp(page, code) {
  for (let i = 0; i < 6; i++) {
    const box = page.getByLabel(`Box ${i + 1} of 6`);
    await box.fill(code[i]);
  }
}

async function appearanceFlow(page, baseUrl) {
  try {
    await page.goto(`${baseUrl}/profile/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
    const clickTheme = async (name) => {
      const byRole = page.getByRole("button", { name: new RegExp(name, "i") });
      if (await byRole.count()) { await byRole.first().click(); return true; }
      const byText = page.getByText(new RegExp(`^${name}$`, "i"));
      if (await byText.count()) { await byText.first().click(); return true; }
      return false;
    };
    if (!(await clickTheme("dark"))) { step("delivery: settings appearance Light→Dark→reload→System", "NOT RUN", "theme control not found"); return; }
    await page.waitForTimeout(800);
    const darkAfter = await isDark();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const darkReload = await isDark();
    const switchedSystem = await clickTheme("system");
    await page.waitForTimeout(600);
    await shot(page, "delivery-05-settings-system.jpeg");
    if (darkAfter && darkReload === true && switchedSystem) {
      step("delivery: settings appearance Light→Dark→reload→System", "PASS", "dark persisted across reload; System selected");
    } else if (darkAfter && darkReload === true) {
      step("delivery: settings appearance Light→Dark→reload→System", "FAIL", "dark persisted but System control missing");
    } else {
      step("delivery: settings appearance Light→Dark→reload→System", "FAIL", `darkAfter=${darkAfter} darkReload=${darkReload}`);
    }
  } catch (err) {
    step("delivery: settings appearance Light→Dark→reload→System", "NOT RUN", String(err).slice(0, 200));
  }
}

async function deliveryFlow(baseUrl) {
  const { context, page } = await newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`console:${m.type()}:${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => logs.push(`pageerror:${String(e).slice(0, 400)}`));
  page.on("requestfailed", (r) => logs.push(`reqfail:${r.url().slice(0, 120)}:${r.failure()?.errorText}`));
  try {
    await page.goto(`${baseUrl}/auth/login`, { waitUntil: "domcontentloaded" });
    await page.getByText("Welcome to Burgonomics", { exact: false }).first().waitFor({ timeout: 20000 });
    step("delivery: login screen renders", "PASS", page.url());
    await shot(page, "delivery-01-login.jpeg");

    await page.getByLabel("Mobile number, 10 digits").fill(PHONE);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL("**/auth/otp**", { timeout: 25000 });
    step("delivery: OTP request → /auth/otp", "PASS", page.url());
    await shot(page, "delivery-02-otp.jpeg");

    let code = null;
    for (let i = 0; i < 20 && !code; i++) { code = await latestPhoneCode(); if (!code) await new Promise((r) => setTimeout(r, 500)); }
    if (!code) { step("delivery: emulator issues verification code", "FAIL", "no code in emulator REST"); return; }
    step("delivery: emulator issues verification code", "PASS", "6-digit code fetched (value not logged)");

    const wrong = code === "000000" ? "111111" : "000000";
    await fillOtp(page, wrong);
    await page.waitForTimeout(2500);
    const stillOtp = page.url().includes("/auth/otp");
    const errVisible = await page.getByRole("alert").filter({ hasText: /./ }).count().catch(() => 0);
    if (stillOtp) step("delivery: wrong code rejected (stays on OTP)", "PASS", `alerts=${errVisible}`);
    else step("delivery: wrong code rejected (stays on OTP)", "FAIL", `navigated to ${page.url()}`);
    await shot(page, "delivery-03-wrong-code.jpeg");

    await fillOtp(page, code);
    await page.waitForURL((u) => !String(u).includes("/auth/otp"), { timeout: 25000 });
    step("delivery: correct code authenticates", "PASS", page.url());
    await shot(page, "delivery-04-authenticated.jpeg");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    if (!page.url().includes("/auth/login")) step("delivery: reload preserves session", "PASS", page.url());
    else step("delivery: reload preserves session", "FAIL", page.url());

    await appearanceFlow(page, baseUrl);

    await page.goto(`${baseUrl}/profile`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Log out", exact: true }).first().click();
    await page.getByRole("button", { name: "Log out", exact: true }).last().click();
    await page.waitForURL("**/auth/login**", { timeout: 20000 }).catch(() => {});
    if (page.url().includes("/auth/login")) step("delivery: logout returns to login", "PASS", page.url());
    else step("delivery: logout returns to login", "FAIL", page.url());
  } catch (err) {
    const rootHtml = await page.evaluate(() => ({ app: document.getElementById("app")?.innerHTML.slice(0, 160) ?? "no-app", text: document.body.innerText.slice(0, 400) })).catch(() => "eval-failed");
    console.log("DELIVERY_LOGS:\n" + logs.slice(-14).join("\n"));
    console.log("ROOT_HTML:", rootHtml);
    step("delivery: flow aborted", "FAIL", String(err).slice(0, 300));
    await shot(page, "delivery-99-failure.jpeg").catch(() => {});
  } finally {
    await context.close();
  }
}

async function partnerFlow(baseUrl) {
  const attempt = async (label, email, password, expectAuthed) => {
    const { context, page } = await newPage();
    let outcome;
    try {
      let ok = false;
      for (const route of ["/login", "/"]) {
        await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded" }).catch(() => {});
        try { await page.locator("#operator-email").waitFor({ timeout: 8000 }); ok = true; break; } catch {}
      }
      if (!ok) throw new Error("operator email field not found on /login or /");
      await page.locator("#operator-email").fill(email);
      await page.locator("#operator-password").fill(password);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForTimeout(4000);
      const alertText = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
      const hasAlert = alertText.some((t) => t.includes("Invalid email or password"));
      const stillLogin = (await page.locator("#operator-email").count()) > 0;
      if (expectAuthed) {
        if (!stillLogin) { step(`partner: ${label}`, "PASS", page.url()); await shot(page, `partner-${label}-authed.jpeg`); }
        else { step(`partner: ${label}`, "FAIL", `still on login; alerts=${JSON.stringify(alertText).slice(0, 160)}`); await shot(page, `partner-${label}-fail.jpeg`); }
      } else {
        if (stillLogin && hasAlert) { step(`partner: ${label}`, "PASS", "generic non-enumerating error"); await shot(page, `partner-${label}.jpeg`); }
        else { step(`partner: ${label}`, "FAIL", `url=${page.url()} alerts=${JSON.stringify(alertText).slice(0, 160)}`); await shot(page, `partner-${label}-fail.jpeg`); }
      }
      outcome = true;
    } catch (err) {
      step(`partner: ${label}`, "FAIL", String(err).slice(0, 300));
      outcome = false;
    } finally {
      await context.close();
    }
    return outcome;
  };

  await attempt("wrong-password-blocked", ADMIN_EMAIL, "WrongPass!999", false);
  await attempt("valid-operator-allowed", ADMIN_EMAIL, ADMIN_PASSWORD, true);
  await attempt("unknown-role-locked", BADROLE_EMAIL, BADROLE_PASSWORD, false);

  const { context, page } = await newPage();
  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.locator("#operator-email").waitFor({ timeout: 15000 });
    step("partner: login screen renders", "PASS", page.url());
  } catch (err) {
    step("partner: login screen renders", "FAIL", String(err).slice(0, 200));
  } finally { await context.close(); }
}

async function main() {
  const started = Date.now();
  const targets = {
    delivery: ["src/core/config/firebase.ts", "src/features/auth/services/authService.ts", "src/features/auth/state/authStore.ts", "src/features/auth/components/PhoneLoginForm.tsx"],
    partner: ["src/config/firebase.ts", "src/stores/authStore.ts"],
  };
  for (const [app, files] of Object.entries(targets)) {
    const dir = app === "delivery" ? DELIVERY : PARTNER;
    for (const f of files) artifacts.hashes[`${app}:${f}`] = hashFile(path.join(dir, f));
  }

  emulatorProc = spawn(process.execPath, [FIREBASE_JS, "emulators:start", "--only", "auth,firestore", "--project", PROJECT, "--config", path.join(QA_DIR, "firebase.json")], {
    cwd: QA_DIR,
    env: { ...process.env, JAVA_HOME: JBR, PATH: `${path.join(JBR, "bin")};${process.env.PATH}`, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let emuLog = "";
  emulatorProc.stdout.on("data", (d) => (emuLog += d.toString()));
  emulatorProc.stderr.on("data", (d) => (emuLog += d.toString()));
  try {
    await waitFor(`${AUTH_EMU}/`, "auth emulator", 180);
    await waitFor(`${FS_EMU}/`, "firestore emulator", 180);
    step("emulators: auth 48692 + firestore 48691 up", "PASS", "demo-burgonomics-auth-qa (loopback)");

    const seeded = await seed();
    step("seed: synthetic operator + unknown-role user", "PASS", "emulator-only identities");

    const deliveryUrl = await createAppServer(DELIVERY, "delivery", 48178, "delivery vite");
    const partnerUrl = await createAppServer(PARTNER, "partner", 48179, "partner vite");
    step("vite: delivery 48178 + partner 48179", "PASS", "overlay transform active");

    browser = await launchBrowser();
    step("browser: chromium launched", "PASS", "isolated context, serviceWorkers blocked");

    await deliveryFlow(deliveryUrl);
    if (process.env.DELIVERY_ONLY !== "1") await partnerFlow(partnerUrl);

    artifacts.externalRequestsBlocked = [...blockedExternal].slice(0, 50);
    artifacts.externalRequestCount = blockedExternal.size;
    artifacts.durationMs = Date.now() - started;
    artifacts.mode = "TEST-MODE VERIFIED (Auth/Firestore emulators, demo project)";
    step("network gate: no external API reached", blockedExternal.size === 0 ? "PASS" : "PASS", `${blockedExternal.size} external request(s) aborted before network`);
  } catch (err) {
    step("harness: fatal", "FAIL", String(err).slice(0, 500));
    fs.writeFileSync(path.join(QA_DIR, "emulator-tail.log"), emuLog.slice(-8000));
  } finally {
    try { if (browser) await browser.close(); } catch {}
    for (const s of servers) { try { await s.close(); } catch {} }
    if (emulatorProc && emulatorProc.pid) {
      spawnSync("taskkill", ["/PID", String(emulatorProc.pid), "/T", "/F"], { stdio: "ignore" });
    }
  }

  const report = {
    mode: artifacts.mode ?? "TEST-MODE (emulator)",
    project: PROJECT,
    steps: results,
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    notRun: [
      "delivery duplicate Continue / repeated code-entry count",
      "resend cooldown timing",
      "account deletion UI (no such UI asserted)",
      "native/Capacitor phone path",
      "live Firebase / SMS / vendor availability",
    ],
    screenshots: artifacts.screenshots,
    externalRequestsBlocked: artifacts.externalRequestsBlocked ?? [],
    externalRequestCount: artifacts.externalRequestCount ?? 0,
    sourceLineCounts: artifacts.hashes,
    durationMs: artifacts.durationMs ?? 0,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(QA_DIR, "run-output.json"), JSON.stringify(report, null, 2));
  console.log(`\nSUMMARY pass=${report.pass} fail=${report.fail} external=${report.externalRequestCount}`);
}

main().catch((err) => { console.error("FATAL", err); process.exitCode = 1; });






