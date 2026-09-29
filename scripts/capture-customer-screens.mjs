// Customer app screens — viewport shots (true phone screens, no fullPage
// sticky-bar artifacts), privacy dismissed, store selected via real UI flow
// so Home/Menu/Product show real content instead of redirect duplicates.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = 5193;
const OUT = path.join(ROOT, 'client-handover/screens/01-customer-app-new');
fs.mkdirSync(OUT, { recursive: true });

function startServer(dir, port) {
  const p = spawn('node', ['scripts/spa-server.mjs', dir, String(port)], { stdio: 'pipe', shell: false });
  return p;
}

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Server not ready: ${url}`);
}

const ROUTES = [
  ['03-stores', '/stores'],
  ['04-search', '/search'],
  ['07-offers', '/offers'],
  ['08-cart', '/cart'],
  ['09-checkout', '/checkout'],
  ['10-payment', '/payment'],
  ['11-order-confirmation', '/order-confirmation/demo-order-01'],
  ['12-orders-list', '/orders'],
  ['13-order-detail', '/orders/demo-order-01'],
  ['14-order-tracking', '/orders/demo-order-01/track'],
  ['15-auth-login', '/auth/login'],
  ['16-auth-otp', '/auth/otp'],
  ['17-profile', '/profile'],
  ['18-profile-edit', '/profile/edit'],
  ['19-profile-addresses', '/profile/addresses'],
  ['20-address-create', '/addresses/create'],
  ['21-profile-favorites', '/profile/favorites'],
  ['22-profile-notifications', '/profile/notifications'],
  ['23-profile-settings', '/profile/settings'],
  ['24-support', '/support'],
  ['25-about', '/about'],
  ['26-terms', '/terms'],
  ['27-privacy', '/privacy'],
  ['28-maintenance', '/maintenance'],
  ['29-force-update', '/force-update'],
];

async function dismissPrivacy(page) {
  try {
    const accept = page.getByRole('button', { name: /accept & continue/i });
    if (await accept.count() > 0) await accept.first().click({ timeout: 3000 });
  } catch {}
}

async function shot(page, outName) {
  await page.waitForTimeout(4000);
  const bootFailed = await page.getByText('The app could not start').count();
  if (bootFailed > 0) {
    const detail = await page.locator('details pre').first().textContent().catch(() => '(no detail)');
    console.log(`BOOT-FAIL ${outName}: ${String(detail).slice(0, 200)}`);
    return { ok: false, error: String(detail).slice(0, 300) };
  }
  await page.screenshot({ path: path.join(OUT, `${outName}.png`), fullPage: false });
  console.log(`OK ${outName} -> ${page.url()}`);
  return { ok: true, finalUrl: page.url(), file: `${outName}.png` };
}

const server = startServer('burgonomics-foundation-core/dist/mobile', PORT);
const results = [];
try {
  await waitForServer(`http://localhost:${PORT}/`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const base = `http://localhost:${PORT}`;

  // 1. Stores first (also dismisses privacy for the whole context).
  await page.goto(`${base}/stores`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await dismissPrivacy(page);
  await page.waitForTimeout(5000);
  results.push({ name: '01-splash-root', ...(await shot(page, '01-splash-root')) });

  // 2. Real store-selection flow: click first store row chevron, pick
  // fulfillment if the sheet opens, land on Home with a store set.
  let storeSelected = false;
  try {
    const card = page.getByRole('button', { name: /Burgonomics Akshar Chowk/ }).first();
    if (await card.count() > 0) {
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(500);
      await card.evaluate((el) => el.click());
      await page.waitForTimeout(3000);
      console.log(`after card click: url=${page.url()}`);
      try {
        const persisted = await page.evaluate(() => window.localStorage.getItem('burg.store'));
        console.log(`burg.store: ${String(persisted).slice(0, 300)}`);
      } catch (e) { console.log(`ls read failed: ${String(e?.message || e).slice(0, 120)}`); }
      // No goto from here: reloads strip mock store ids (v3 migrate).
      // All store-scoped shots below use in-app navigation (no reload).
      await page.waitForTimeout(4000);
      storeSelected = page.url().includes('/home');
      console.log(`home check: url=${page.url()} selected=${storeSelected}`);
    } else {
      console.log('store card button not found');
    }
  } catch (e) {
    console.log(`store flow skipped: ${String(e?.message || e).slice(0, 200)}`);
  }

  // 3. Home as landed (in-app nav, no reload so the store survives).
  await dismissPrivacy(page);
  results.push({ name: '02-home', ...(await shot(page, '02-home')) });
  results.push({ name: '03-stores-dup', skip: true });

  // 4. Menu via bottom tab (SPA nav, no reload).
  try {
    const menuTab = page.getByRole('link', { name: /^menu$/i }).first();
    if (await menuTab.count() > 0) await menuTab.click({ timeout: 5000 });
    else await page.getByRole('button', { name: /^menu$/i }).first().click({ timeout: 5000 });
    await page.waitForTimeout(3000);
    console.log(`menu tab -> ${page.url()}`);
  } catch (e) {
    console.log(`menu tab skipped: ${String(e?.message || e).slice(0, 150)}`);
  }
  await dismissPrivacy(page);
  results.push({ name: '05-menu', ...(await shot(page, '05-menu')) });

  // 5. Real product: click first product card on menu, else fake-id state.
  let productDone = false;
  try {
    const card = page.locator('a[href*="/menu/product/"]').first();
    if (await card.count() > 0) {
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await card.evaluate((el) => el.click());
      await page.waitForTimeout(3000);
      console.log(`product click -> ${page.url()}`);
      await dismissPrivacy(page);
      results.push({ name: '06-product-detail', ...(await shot(page, '06-product-detail')) });
      productDone = true;
    } else {
      console.log('no product links on menu page');
    }
  } catch (e) {
    console.log(`product click skipped: ${String(e?.message || e).slice(0, 150)}`);
  }
  if (!productDone) {
    await page.goto(`${base}/menu/product/demo-burger-01`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await dismissPrivacy(page);
    results.push({ name: '06-product-detail', ...(await shot(page, '06-product-detail')) });
  }

  // 5. Everything else in route order.
  for (const [name, route] of ROUTES) {
    if (name === '03-stores') {
      await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await dismissPrivacy(page);
      results.push({ name, ...(await shot(page, name)) });
      continue;
    }
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await dismissPrivacy(page);
    results.push({ name, ...(await shot(page, name)) });
  }

  await ctx.close();
  await browser.close();
  const clean = results.filter(r => !r.skip);
  fs.writeFileSync(path.join(ROOT, 'client-handover/screens/capture-customer-report.json'), JSON.stringify({ capturedAt: new Date().toISOString(), viewport: '390x844 mobile viewport (fullPage off)', storeSelected, results: clean }, null, 2));
  const ok = clean.filter(r => r.ok).length;
  console.log(`\nDone. Customer: ${ok}/${clean.length} storeSelected=${storeSelected}`);
  if (ok < clean.length) process.exitCode = 1;
} finally {
  server.kill();
}
