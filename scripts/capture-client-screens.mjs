// Auto-capture client handover screens - mobile 390x844 PNG, mock demo (no real login)
// Serves existing dist builds via spa-server, screenshots each route in order.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_CUSTOMER = path.join(ROOT, 'client-handover/screens/01-customer-app');
const OUT_PARTNER = path.join(ROOT, 'client-handover/screens/02-partner-app');
fs.mkdirSync(OUT_CUSTOMER, { recursive: true });
fs.mkdirSync(OUT_PARTNER, { recursive: true });

function startServer(dir, port) {
  const p = spawn('node', ['scripts/spa-server.mjs', dir, String(port)], { stdio: 'pipe', shell: false });
  p.stdout.on('data', d => process.stdout.write(`[${port}] ${d}`));
  p.stderr.on('data', d => process.stderr.write(`[${port}] ${d}`));
  return p;
}

async function waitForServer(url, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Server not ready: ${url}`);
}

// Ordered customer routes (matches TanStack routeTree, user-flow order)
const CUSTOMER_ROUTES = [
  ['01-splash-root', '/'],
  ['02-home', '/home'],
  ['03-stores', '/stores'],
  ['04-search', '/search'],
  ['05-menu', '/menu'],
  ['06-product-detail', '/menu/product/demo-burger-01'],
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

// Partner routes — ?demo=1 bypasses ProtectedRoute (temporary local patch, reverted after)
const PARTNER_ROUTES = [
  ['01-login', '/login?demo=1'],
  ['02-dashboard', '/dashboard?demo=1'],
  ['03-orders', '/orders?demo=1'],
  ['04-order-detail', '/orders/demo-order-01?demo=1'],
  ['05-delivery-queue', '/delivery-queue?demo=1'],
  ['06-kds', '/kds?demo=1'],
  ['07-chat', '/chat?demo=1'],
  ['08-customers', '/customers?demo=1'],
  ['09-customer-detail', '/customers/demo-customer-01?demo=1'],
  ['10-tickets', '/tickets?demo=1'],
  ['11-ticket-detail', '/tickets/demo-ticket-01?demo=1'],
  ['12-menu', '/menu?demo=1'],
  ['13-notifications', '/notifications?demo=1'],
  ['14-branches', '/branches?demo=1'],
  ['15-analytics', '/analytics?demo=1'],
  ['16-users', '/users?demo=1'],
  ['17-settings', '/settings?demo=1'],
  ['18-admin-login', '/admin/login?demo=1'],
  ['19-admin-dashboard', '/admin?demo=1'],
  ['20-admin-orders', '/admin/orders?demo=1'],
  ['21-admin-stores', '/admin/stores?demo=1'],
  ['22-admin-menu', '/admin/menu?demo=1'],
];

async function capture(browser, base, routes, outDir) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const results = [];
  for (const [name, route] of routes) {
    const url = `${base}${route}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);
      // dismiss splash / wait for app root
      try { await page.waitForSelector('#app, #root, main, body', { timeout: 8000 }); } catch {}
      await page.waitForTimeout(1000);
      const file = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const finalUrl = page.url();
      results.push({ name, route, finalUrl, file: path.basename(file), ok: true });
      console.log(`OK ${name} -> ${finalUrl}`);
    } catch (e) {
      results.push({ name, route, ok: false, error: String(e?.message || e) });
      console.log(`FAIL ${name}: ${e?.message}`);
    }
  }
  await ctx.close();
  return results;
}

const coreServer = startServer('burgonomics-foundation-core/dist/mobile', 5173);
const partnerServer = startServer('burgonomics-partner/dist', 5174);

try {
  await waitForServer('http://localhost:5173/');
  await waitForServer('http://localhost:5174/login');
  const browser = await chromium.launch({ headless: true });
  const cust = await capture(browser, 'http://localhost:5173', CUSTOMER_ROUTES, OUT_CUSTOMER);
  const part = await capture(browser, 'http://localhost:5174', PARTNER_ROUTES, OUT_PARTNER);
  await browser.close();
  fs.writeFileSync(path.join(ROOT, 'client-handover/screens/capture-report.json'), JSON.stringify({ capturedAt: new Date().toISOString(), viewport: '390x844 mobile', customer: cust, partner: part }, null, 2));
  const fails = [...cust, ...part].filter(r => !r.ok);
  console.log(`\nDone. Customer: ${cust.filter(r=>r.ok).length}/${cust.length}, Partner: ${part.filter(r=>r.ok).length}/${part.length}`);
  if (fails.length) { console.log('Failures:', fails); process.exitCode = 1; }
} finally {
  coreServer.kill();
  partnerServer.kill();
}
