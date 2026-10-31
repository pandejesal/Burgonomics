// Measure settle time for /analytics and /admin/stores under demo bypass.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 5194;
const server = spawn('node', ['scripts/spa-server.mjs', 'burgonomics-partner/dist', String(PORT)], { stdio: 'pipe', shell: false });
async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server not ready');
}
async function loading(page) {
  return page.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    if (/loading order details|loading analytics|loading\.\.\./i.test(t)) return 'text-loader';
    const sp = [...document.querySelectorAll('[class*="animate-spin"]')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    if (sp.length) return 'spinner';
    return 'settled';
  }).catch(() => 'eval-fail');
}
try {
  await waitForServer(`http://localhost:${PORT}/login`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', String(e?.message || e).slice(0, 200)));
  const base = `http://localhost:${PORT}`;
  for (const route of ['/analytics?demo=1', '/admin/stores?demo=1']) {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    const t0 = Date.now();
    let state = '';
    for (let i = 0; i < 18; i++) {
      await page.waitForTimeout(5000);
      state = await loading(page);
      console.log(`${route} +${Math.round((Date.now() - t0) / 1000)}s: ${state}`);
      if (state === 'settled') break;
    }
  }
  await ctx.close();
  await browser.close();
} finally {
  server.kill();
}
