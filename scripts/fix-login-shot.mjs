// Targeted re-shoot for 01-login.png after the brand header switched from
// the generic SVG Logo to the Burgonomics mascot. Same viewport/scale as the
// original capture run (390x844 @2x, mobile, touch).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = 5194;
const OUT = path.join(ROOT, 'client-handover/screens/02-partner-app');

const ROUTES = [['01-login', '/login?demo=1']];

const server = spawn('node', ['scripts/spa-server.mjs', 'burgonomics-partner/dist', String(PORT)], { stdio: 'pipe', shell: false });
async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server not ready');
}

try {
  await waitForServer(`http://localhost:${PORT}/login`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e?.message || e).slice(0, 250)));
  for (const [name, route] of ROUTES) {
    await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.locator('img[alt="Burgonomics mascot"]').first().waitFor({ timeout: 15000 });
    // Wait for the mascot bitmap itself, not just the element.
    await page.waitForFunction(() => {
      const img = document.querySelector('img[alt="Burgonomics mascot"]');
      return !!img && img.complete && img.naturalWidth > 0;
    }, null, { timeout: 15000 }).catch(() => console.log(`${name}: mascot bitmap not ready, shooting anyway`));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
    console.log(`OK ${name} -> ${page.url()}`);
  }
  console.log('pageerrors:', JSON.stringify([...new Set(errs)].slice(0, 10)));
  await ctx.close();
  await browser.close();
} finally {
  server.kill();
}
