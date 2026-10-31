// Targeted re-shoot: 06-product-detail (wait for settled not-available state),
// 13-order-detail (wait for login redirect to complete).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = 5193;
const OUT = path.join(ROOT, 'client-handover/screens/01-customer-app');

const server = spawn('node', ['scripts/spa-server.mjs', 'burgonomics-foundation-core/dist/mobile', String(PORT)], { stdio: 'pipe', shell: false });
async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server not ready');
}

try {
  await waitForServer(`http://localhost:${PORT}/`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e?.message || e).slice(0, 200)));
  const base = `http://localhost:${PORT}`;

  // 06: settle to PRODUCT NOT AVAILABLE (was shot mid-skeleton).
  await page.goto(`${base}/menu/product/demo-burger-01`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  try { await page.getByText(/product not available/i).first().waitFor({ timeout: 20000 }); }
  catch { console.log('06: settled text not found, shooting anyway'); }
  await page.waitForTimeout(1000);
  try {
    const accept = page.getByRole('button', { name: /accept & continue/i }).first();
    if (await accept.count() > 0) await accept.click({ timeout: 3000 });
    await page.waitForTimeout(800);
  } catch {}
  await page.screenshot({ path: path.join(OUT, '06-product-detail.png'), fullPage: false });
  console.log(`OK 06 -> ${page.url()}`);

  // 13: allow the ProtectedRoute redirect to finish (was shot mid-transition = blank).
  await page.goto(`${base}/orders/demo-order-01`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  try {
    await page.waitForFunction(() => window.location.href.includes('/auth/login'), { timeout: 20000 });
    console.log('13: redirected to login');
  } catch { console.log('13: no redirect, shooting settled state'); }
  await page.waitForTimeout(2000);
  try {
    const accept = page.getByRole('button', { name: /accept & continue/i }).first();
    if (await accept.count() > 0) await accept.click({ timeout: 3000 });
    await page.waitForTimeout(800);
  } catch {}
  await page.screenshot({ path: path.join(OUT, '13-order-detail.png'), fullPage: false });
  console.log(`OK 13 -> ${page.url()}`);
  console.log('pageerrors:', JSON.stringify([...new Set(errs)].slice(0, 10)));
  await ctx.close();
  await browser.close();
} finally {
  server.kill();
}
