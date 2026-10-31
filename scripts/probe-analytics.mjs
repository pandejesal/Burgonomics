// Check whether the analytics query runs at all under demo mock user.
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
  page.on('console', m => console.log(`CONSOLE-${m.type()}:`, m.text().slice(0, 200)));
  page.on('pageerror', e => console.log('PAGEERROR:', String(e?.message || e).slice(0, 200)));
  await page.goto(`http://localhost:${PORT}/analytics?demo=1`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(25000);
  const state = await page.evaluate(() => {
    const t = document.body.innerText;
    return { len: t.length, start: t.slice(0, 150) };
  });
  console.log('STATE:', JSON.stringify(state));
  await ctx.close();
  await browser.close();
} finally {
  server.kill();
}
