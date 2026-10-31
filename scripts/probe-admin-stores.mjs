// One-off probe: why /admin/stores renders black under demo bypass.
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
try {
  await waitForServer(`http://localhost:${PORT}/login`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', String(e?.message || e).slice(0, 300), '\nSTACK:', String(e?.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 400)));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`CONSOLE-${m.type()}:`, m.text().slice(0, 250)); });
  await page.goto(`http://localhost:${PORT}/admin/stores?demo=1`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(10000);
  const info = await page.evaluate(() => {
    const spinner = document.querySelector('[class*="animate-spin"]');
    const motionDivs = [...document.querySelectorAll('div')].filter(d => d.className.includes('space-y-6')).slice(0, 3).map(d => ({
      opacity: getComputedStyle(d).opacity,
      text: (d.innerText || '').slice(0, 80),
    }));
    return {
      url: window.location.href,
      bodyLen: document.body ? document.body.innerText.length : -1,
      spinnerPresent: !!spinner,
      spinnerVisible: spinner ? (() => { const r = spinner.getBoundingClientRect(); return r.width + 'x' + r.height; })() : 'n/a',
      motionDivs,
    };
  });
  console.log('INFO:', JSON.stringify(info));
  await page.screenshot({ path: 'probe-stores.png', fullPage: false });
  console.log('saved probe-stores.png');
  await ctx.close();
  await browser.close();
} finally {
  server.kill();
}
