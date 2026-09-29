// Partner app screens — viewport shots (true phone screens), ?demo=1 auth
// bypass (temporary local patch, reverted after), blocking modals dismissed.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = 5194;
const OUT = path.join(ROOT, 'client-handover/screens/02-partner-app-new');
fs.mkdirSync(OUT, { recursive: true });

function startServer(dir, port) {
  return spawn('node', ['scripts/spa-server.mjs', dir, String(port)], { stdio: 'pipe', shell: false });
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

async function dismissModals(page) {
  // KDS kitchen-audio prompt + any generic dismiss buttons.
  for (const pat of [/not now/i, /^dismiss$/i, /^close$/i, /maybe later/i, /^no thanks$/i]) {
    try {
      const b = page.getByRole('button', { name: pat }).first();
      if (await b.count() > 0) { await b.click({ timeout: 2500 }); await page.waitForTimeout(800); }
    } catch {}
  }
}

const server = startServer('burgonomics-partner/dist', PORT);
const results = [];
try {
  await waitForServer(`http://localhost:${PORT}/login`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const base = `http://localhost:${PORT}`;
  for (const [name, route] of ROUTES) {
    try {
      await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2500);
      await dismissModals(page);
      await page.waitForTimeout(3500);
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
      results.push({ name, route, finalUrl: page.url(), file: `${name}.png`, ok: true });
      console.log(`OK ${name} -> ${page.url()}`);
    } catch (e) {
      results.push({ name, route, ok: false, error: String(e?.message || e).slice(0, 200) });
      console.log(`FAIL ${name}: ${e?.message}`);
    }
  }
  await ctx.close();
  await browser.close();
  fs.writeFileSync(path.join(ROOT, 'client-handover/screens/capture-partner-report.json'), JSON.stringify({ capturedAt: new Date().toISOString(), viewport: '390x844 mobile viewport (fullPage off)', results }, null, 2));
  const ok = results.filter(r => r.ok).length;
  console.log(`\nDone. Partner: ${ok}/${results.length}`);
  if (ok < results.length) process.exitCode = 1;
} finally {
  server.kill();
}
