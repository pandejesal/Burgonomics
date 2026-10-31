// Targeted re-shoot of partner handover screens (client-handover/screens/02-partner-app)
// after the header Branch-Scope overlap fix. Extended settle: waits for loading
// spinners to clear (up to 25s), dismisses blocking modals, logs page errors.
// To re-run: temporarily re-add the localhost `?demo=1` bypass in
// authStore.initialize (it is REVERTED in the shipped source), rebuild,
// run this script, then revert the bypass and rebuild production again.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = 5194;
const OUT = path.join(ROOT, 'client-handover/screens/02-partner-app');

const ROUTES = [
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
];

const CONTENT_MARKERS = {
  '15-analytics': /Revenue Analytics/i,
};

const server = spawn('node', ['scripts/spa-server.mjs', 'burgonomics-partner/dist', String(PORT)], { stdio: 'pipe', shell: false });
async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server not ready');
}

async function dismissModals(page) {
  for (const pat of [/not now/i, /^dismiss$/i, /^close$/i, /maybe later/i, /^no thanks$/i]) {
    try {
      const b = page.getByRole('button', { name: pat }).first();
      if (await b.count() > 0) { await b.click({ timeout: 2500 }); await page.waitForTimeout(800); }
    } catch {}
  }
}

// Settle: wait until no visible loading spinner/skeleton pulse remains, or timeout.
async function settle(page, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loading = await page.evaluate(() => {
      const bodies = document.body ? document.body.innerText : '';
      if (/loading order details|loading analytics|loading\.\.\./i.test(bodies)) return true;
      const spinners = document.querySelectorAll('[class*="animate-spin"], [class*="animate-pulse"], svg[class*="spin"]');
      for (const el of spinners) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
      return false;
    }).catch(() => false);
    if (!loading) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

try {
  await waitForServer(`http://localhost:${PORT}/login`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e?.message || e).slice(0, 250)));
  const base = `http://localhost:${PORT}`;
  for (const [name, route] of ROUTES) {
    try {
      await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(3000);
      await dismissModals(page);
      const settled = await settle(page, 25000);
      // Content-marker wait: shoot when the page's real content is present
      // even if a decorative pulse element never clears.
      const marker = CONTENT_MARKERS[name];
      if (marker) {
        try {
          await page.getByText(marker).first().waitFor({ timeout: 45000 });
          console.log(`${name}: content marker found`);
        } catch { console.log(`${name}: marker timeout, shooting anyway`); }
      }
      // Let transient error toasts (e.g. live-update permission toast) fade.
      await page.waitForTimeout(8000);
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
      console.log(`${settled ? 'OK ' : 'HUNG '} ${name} -> ${page.url()}`);
    } catch (e) {
      console.log(`FAIL ${name}: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  console.log('pageerrors:', JSON.stringify([...new Set(errs)].slice(0, 10)));
  await ctx.close();
  await browser.close();
} finally {
  server.kill();
}
