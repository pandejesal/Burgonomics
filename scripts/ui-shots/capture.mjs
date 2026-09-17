#!/usr/bin/env node
/**
 * Playwright UI Screenshot Capture Harness
 * Captures baseline screenshots for Burgonomics apps across viewports
 * 
 * Usage: node scripts/ui-shots/capture.mjs [--app=core|partner] [--viewport=desktop|tablet|mobile] [--route=all|<route>]
 */

import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, '.swarm', 'ui-shots', 'baseline');

// Viewport configurations
const VIEWPORTS = {
  desktop: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  tablet: { width: 768, height: 1024, deviceScaleFactor: 2 },
  mobile: { width: 375, height: 667, deviceScaleFactor: 3 },
};

// App configurations
const APPS = {
  core: {
    name: 'burgonomics-foundation-core',
    buildDir: 'burgonomics-foundation-core/dist',
    routes: [
      '/',
      '/menu',
      '/cart',
      '/checkout',
      '/payment',
      '/orders',
      '/offers',
      '/stores',
      '/support',
      '/auth/login',
      '/about',
      '/privacy',
    ],
    baseUrl: 'http://localhost:5173',
  },
  partner: {
    name: 'burgonomics-partner',
    buildDir: 'burgonomics-partner/dist',
    routes: [
      '/',
      '/login',
      '/orders',
      '/order/:id',
      '/kds',
      '/delivery-queue',
      '/branches',
      '/admin',
      '/admin/stores',
      '/admin/orders',
      '/admin/customers',
      '/admin/analytics',
      '/admin/settings',
    ],
    baseUrl: 'http://localhost:5174',
  },
};

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function captureRoute(page, appName, fullUrl, viewportName, viewport, baseUrl) {
  // Extract route name from URL relative to baseUrl
  const relativePath = fullUrl.replace(baseUrl, '');
  const urlPath = relativePath.startsWith('/') ? relativePath : '/' + relativePath;
  // Remove leading slash and .html extension, replace special chars
  const safeRoute = urlPath.replace(/^\//, '').replace(/\.html$/, '').replace(/[/:]/g, '_') || 'home';
  const outputDir = path.join(OUTPUT_DIR, appName, safeRoute);
  await ensureDir(outputDir);
  
  const outputPath = path.join(outputDir, `${viewportName}.png`);
  
  try {
    await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000); // Allow animations to settle
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(`✓ Captured: ${appName}/${safeRoute}/${viewportName}.png`);
    return true;
  } catch (error) {
    console.error(`✗ Failed: ${appName}/${safeRoute}/${viewportName} - ${error.message}`);
    return false;
  }
}

function toFileUrl(filePath) {
  // Convert Windows path to file:// URL with forward slashes
  const normalized = filePath.replace(/\\/g, '/');
  // Ensure it starts with file:///
  if (!normalized.startsWith('/')) {
    return `file:///${normalized}`;
  }
  return `file://${normalized}`;
}

async function captureApp(appKey, viewportName, viewport, routes) {
  const app = APPS[appKey];
  const buildDir = path.join(PROJECT_ROOT, app.buildDir);
  const buildPath = path.join(buildDir, 'index.html');
  
  if (!fs.existsSync(buildPath)) {
    console.error(`Build not found for ${appKey}: ${buildPath}`);
    console.error('Run `npm run build` in the app directory first');
    return;
  }

  const baseUrl = toFileUrl(buildDir);
  console.log(`  Base URL: ${baseUrl}`);
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...viewport,
  });
  const page = await context.newPage();

  console.log(`\n📸 Capturing ${appKey} (${viewportName})...`);
  
  for (const route of routes) {
    // Skip dynamic routes for baseline (they need specific IDs)
    if (route.includes(':')) continue;
    
    const fullRoute = route === '/' ? '/index.html' : `${route}.html`;
    // Construct full file URL since baseURL doesn't work well with file:// protocol
    const fullUrl = `${baseUrl}${fullRoute}`;
    await captureRoute(page, appKey, fullUrl, viewportName, viewport, baseUrl);
  }

  await browser.close();
}

async function main() {
  const args = process.argv.slice(2);
  const appFilter = args.find(a => a.startsWith('--app='))?.split('=')[1];
  const viewportFilter = args.find(a => a.startsWith('--viewport='))?.split('=')[1];
  const routeFilter = args.find(a => a.startsWith('--route='))?.split('=')[1];

  const appsToCapture = appFilter ? [appFilter] : Object.keys(APPS);
  const viewportsToCapture = viewportFilter ? [viewportFilter] : Object.keys(VIEWPORTS);

  console.log('🚀 Starting UI Screenshot Capture');
  console.log(`Apps: ${appsToCapture.join(', ')}`);
  console.log(`Viewports: ${viewportsToCapture.join(', ')}`);
  console.log(`Output: ${OUTPUT_DIR}\n`);

  for (const appKey of appsToCapture) {
    const app = APPS[appKey];
    let routes = app.routes;
    
    if (routeFilter && routeFilter !== 'all') {
      routes = routes.filter(r => r.includes(routeFilter));
    }

    for (const viewportName of viewportsToCapture) {
      const viewport = VIEWPORTS[viewportName];
      await captureApp(appKey, viewportName, viewport, routes);
    }
  }

  console.log('\n✅ Capture complete!');
  console.log(`Screenshots saved to: ${OUTPUT_DIR}`);
}

main().catch(console.error);