#!/usr/bin/env node
/**
 * UI/UX review capture harness (v2).
 * Serves production builds via scripts/spa-server.mjs, captures routes x
 * viewports with full-page screenshots, and records console/page errors.
 *
 * Usage: node scripts/ui-shots/capture-v2.mjs [--app=customer|partner]
 *         [--viewport=mobile|tablet|desktop] [--route=<substring>]
 * Output: .swarm/ui-shots/review/<app>/<route>/<viewport>.png + report.json
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, '.swarm', 'ui-shots', 'review');

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
};

const APPS = {
  customer: {
    rootId: 'app',
    buildDir: 'burgonomics-foundation-core/dist/mobile',
    port: 5173,
    routes: ['/', '/home', '/about', '/auth/login', '/auth/otp', '/cart',
      '/checkout', '/menu', '/offers', '/orders', '/payment', '/privacy',
      '/profile', '/profile/settings', '/search', '/stores', '/support', '/terms'],
  },
  partner: {
    rootId: 'root',
    buildDir: 'burgonomics-partner/dist',
    port: 5174,
    routes: ['/', '/login', '/admin/login', '/dashboard', '/orders', '/kds',
      '/delivery-queue', '/customers', '/chat', '/tickets', '/menu',
      '/notifications', '/settings', '/branches', '/analytics', '/users', '/admin'],
  },
};

const safeRoute = (r) => (r === '/' ? 'home' : r.replace(/^\//, '').replace(/[/:]/g, '_'));

function startServer(buildDir, port) {
  const proc = spawn('node', ['scripts/spa-server.mjs', buildDir, String(port)], {
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
  });
  return proc;
}

async function waitForPort(port, tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server on :${port} did not start`);
}

async function captureOne(page, app, appKey, route, viewportName, viewport, report) {
  const url = `http://localhost:${app.port}${route}`;
  const dir = path.join(OUTPUT_DIR, appKey, safeRoute(route));
  fs.mkdirSync(dir, { recursive: true });
  const shotPath = path.join(dir, `${viewportName}.png`);
  const entry = { app: appKey, route, viewport: viewportName, shot: shotPath, ok: false, errors: [] };

  const logs = [];
  const onConsole = (msg) => { if (msg.type() === 'error') logs.push(msg.text()); };
  const onPageError = (err) => logs.push(`pageerror: ${String(err).slice(0, 300)}`);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(
      (id) => { const el = document.getElementById(id); return el && el.children.length > 0; },
      app.rootId,
      { timeout: 30000 },
    );
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shotPath, fullPage: true });
    entry.ok = true;
    entry.errors = logs.filter((e) => !e.includes('favicon'));
    console.log(`ok  ${appKey} ${route} [${viewportName}]${entry.errors.length ? ` (${entry.errors.length} console errors)` : ''}`);
  } catch (err) {
    entry.errors = [...logs, `capture failed: ${String(err).slice(0, 200)}`];
    console.log(`FAIL ${appKey} ${route} [${viewportName}]: ${String(err).slice(0, 120)}`);
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }
  report.push(entry);
}

async function main() {
  const args = process.argv.slice(2);
  const appFilter = args.find((a) => a.startsWith('--app='))?.split('=')[1];
  const viewportFilter = args.find((a) => a.startsWith('--viewport='))?.split('=')[1];
  const routeFilter = args.find((a) => a.startsWith('--route='))?.split('=')[1];

  const appKeys = appFilter ? [appFilter] : Object.keys(APPS);
  const viewportNames = viewportFilter ? [viewportFilter] : Object.keys(VIEWPORTS);

  const servers = [];
  for (const key of appKeys) {
    const app = APPS[key];
    if (!fs.existsSync(path.join(PROJECT_ROOT, app.buildDir, 'index.html'))) {
      throw new Error(`Build missing: ${app.buildDir}`);
    }
    servers.push(startServer(app.buildDir, app.port));
  }
  try {
    for (const key of appKeys) await waitForPort(APPS[key].port);

    const browser = await chromium.launch({ headless: true });
    const report = [];
    for (const key of appKeys) {
      const app = APPS[key];
      const routes = routeFilter ? app.routes.filter((r) => r.includes(routeFilter)) : app.routes;
      for (const vpName of viewportNames) {
        const vp = VIEWPORTS[vpName];
        const context = await browser.newContext({ viewport: vp });
        const page = await context.newPage();
        for (const route of routes) {
          await captureOne(page, app, key, route, vpName, vp, report);
        }
        await context.close();
      }
    }
    await browser.close();

    const reportPath = path.join(OUTPUT_DIR, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    const failed = report.filter((e) => !e.ok);
    console.log(`\nCaptured ${report.length - failed.length}/${report.length}. Report: ${reportPath}`);
  } finally {
    for (const s of servers) s.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
