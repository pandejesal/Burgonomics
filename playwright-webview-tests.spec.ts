/**
 * Playwright WebView Test Suite for Burgonomics Apps
 * Tests both Customer and Partner apps from production builds.
 *
 * Servers (Python http.server) are started automatically by playwright.config.ts:
 *   Customer app  → http://localhost:5173  (dist/mobile)
 *   Partner  app  → http://localhost:5174  (dist)
 *
 * Run:  npx playwright test playwright-webview-tests.spec.ts
 */

import { test, expect } from '@playwright/test';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/** Wait until the root element has at least one child (React rendered). */
async function waitForReact(page: { waitForFunction: (fn: () => boolean, opts?: { timeout?: number }) => Promise<unknown>; }, rootId: string, timeoutMs = 30_000) {
  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(id);
      return el && el.children.length > 0;
    },
    rootId,
    { timeout: timeoutMs },
  );
}

const CUSTOMER = 'http://localhost:5173';
const PARTNER = 'http://localhost:5174';

/* ================================================================== */
/*  Customer App                                                      */
/* ================================================================== */

test.describe('Burgonomics Customer App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(CUSTOMER, { waitUntil: 'networkidle' });
    await waitForReact(page, 'app');
  });

  test('loads without errors', async ({ page }) => {
    await expect(page.locator('#app')).toBeVisible();
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForReact(page, 'app');
    const critical = consoleErrors.filter(
      (e) => !e.includes('favicon') && !e.includes('manifest') && !e.includes('Extension'),
    );
    expect(critical).toHaveLength(0);
  });

  test('home page shows Burgonomics branding', async ({ page }) => {
    const brand = page.getByText(/BURGONOMICS/i).first();
    await expect(brand).toBeVisible({ timeout: 15_000 });
  });

  test('phone login screen loads', async ({ page }) => {
    await page.goto(`${CUSTOMER}/auth/login`, { waitUntil: 'networkidle' });
    await waitForReact(page, 'app');

    const phoneInput = page.locator(
      'input[type="tel"], input[inputmode="numeric"], input[name="phone"], input[placeholder*="phone" i], input[placeholder*="mobile" i]',
    ).first();
    await expect(phoneInput).toBeVisible({ timeout: 15_000 });
  });

  test('menu route renders store gate', async ({ page }) => {
    // /menu requires a chosen store first: unauthenticated users land on the
    // "CHOOSE A STORE" gate (geolocation denied headless -> manual pick).
    await page.goto(`${CUSTOMER}/menu`, { waitUntil: 'networkidle' });
    await waitForReact(page, 'app');

    await expect(page.getByText(/choose a store/i).first()).toBeVisible({ timeout: 15_000 });
    const search = page.locator('input[type="search"], input[placeholder*="search" i]').first();
    await expect(search).toBeVisible({ timeout: 15_000 });
  });

  test('cart page renders empty state', async ({ page }) => {
    // Fresh browser profile -> empty cart: heading + empty-state CTA render,
    // and no "Proceed to Checkout" button (correct: nothing to check out).
    await page.goto(`${CUSTOMER}/cart`, { waitUntil: 'networkidle' });
    await waitForReact(page, 'app');

    await expect(page.getByText(/your cart/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/burger box is empty/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/explore menu/i)).toBeVisible();
  });
});

/* ================================================================== */
/*  Partner App                                                       */
/* ================================================================== */

test.describe('Burgonomics Partner App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(PARTNER, { waitUntil: 'networkidle' });
    await waitForReact(page, 'root');
  });

  test('loads without errors', async ({ page }) => {
    await expect(page.locator('#root')).toBeVisible();
  });

  test('login screen loads with Burgonomics logo', async ({ page }) => {
    await page.goto(`${PARTNER}/login`, { waitUntil: 'networkidle' });
    await waitForReact(page, 'root');

    const logo = page.locator('svg[aria-label="Burgonomics"], svg:has-text("BURGONOMICS"), .logo, [data-testid="logo"]').first();
    await expect(logo).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('admin login screen loads', async ({ page }) => {
    await page.goto(`${PARTNER}/admin/login`, { waitUntil: 'networkidle' });
    await waitForReact(page, 'root');

    const logo = page.locator('svg[aria-label="Burgonomics"], svg:has-text("BURGONOMICS"), .logo, [data-testid="logo"]').first();
    await expect(logo).toBeVisible({ timeout: 15_000 });
  });

  test('unauthenticated admin redirects to login', async ({ page }) => {
    await page.goto(`${PARTNER}/admin`, { waitUntil: 'networkidle' });
    await waitForReact(page, 'root');
    await expect(page).toHaveURL(/login/);
  });
});
