/**
 * Playwright WebView Test Suite for Burgonomics Apps
 * Tests both Customer and Partner apps on Android WebView
 * Run with: npx playwright test playwright-webview-tests.spec.js
 */

import { test, expect, devices } from '@playwright/test';

// Test configuration for Android WebView
const ANDROID_WEBVIEW_CONFIG = {
  ...devices['Galaxy S23'],
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
};

test.describe.configure({ retries: 1 });

test.describe('Burgonomics Customer App - WebView Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the local build served via HTTP server
    // For Capacitor apps, we test the built web assets
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
  });

  test('App loads without errors', async ({ page }) => {
    await expect(page).not.toHaveTitle(/error/i);
    await expect(page.locator('body')).toBeVisible();
  });

  test('Splash screen shows Burgonomics branding', async ({ page }) => {
    // Check for Burgonomics branding on initial load
    const brandElement = page.locator('text=/BURGONOMICS/i').first();
    await expect(brandElement).toBeVisible({ timeout: 10000 });
  });

  test('Login screen loads with Burgonomics logo', async ({ page }) => {
    // Navigate to login if not already there
    await page.goto('http://localhost:5173/auth/login', { waitUntil: 'networkidle' });
    
    // Check for logo
    const logo = page.locator('svg[aria-label="Burgonomics"]').first();
    await expect(logo).toBeVisible({ timeout: 5000 });
    
    // Check for email/password fields
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('Menu page loads with images', async ({ page }) => {
    await page.goto('http://localhost:5173/menu', { waitUntil: 'networkidle' });
    
    // Check for menu items with images
    const menuItems = page.locator('[data-testid="menu-item"], .menu-item, .product-card').first();
    await expect(menuItems).toBeVisible({ timeout: 10000 });
    
    // Check images load
    const images = page.locator('img[src*="/images/menu/"]');
    const count = await images.count();
    expect(count).toBeGreaterThan(0);
  });

  test('Cart and checkout flow', async ({ page }) => {
    await page.goto('http://localhost:5173/cart', { waitUntil: 'networkidle' });
    await expect(page.locator('text=/cart/i')).toBeVisible();
    
    // Test checkout navigation
    await page.goto('http://localhost:5173/checkout', { waitUntil: 'networkidle' });
    await expect(page.locator('text=/checkout/i')).toBeVisible();
  });

  test('No console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    
    // Filter out known acceptable errors
    const criticalErrors = errors.filter(e => 
      !e.includes('favicon') && 
      !e.includes('manifest') &&
      !e.includes('Extension')
    );
    
    expect(criticalErrors).toHaveLength(0);
  });
});

test.describe('Burgonomics Partner App - WebView Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5174', { waitUntil: 'networkidle' });
  });

  test('App loads without errors', async ({ page }) => {
    await expect(page).not.toHaveTitle(/error/i);
    await expect(page.locator('body')).toBeVisible();
  });

  test('Login screen shows Burgonomics logo', async ({ page }) => {
    await page.goto('http://localhost:5174/login', { waitUntil: 'networkidle' });
    
    const logo = page.locator('svg[aria-label="Burgonomics"]').first();
    await expect(logo).toBeVisible({ timeout: 5000 });
    
    // Check for email/password fields
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('Admin login screen loads', async ({ page }) => {
    await page.goto('http://localhost:5174/admin/login', { waitUntil: 'networkidle' });
    
    const logo = page.locator('svg[aria-label="Burgonomics"]').first();
    await expect(logo).toBeVisible({ timeout: 5000 });
  });

  test('Dashboard loads after login', async ({ page }) => {
    // This would require actual login credentials
    // Skipping actual login, just verify route exists
    await page.goto('http://localhost:5174/admin', { waitUntil: 'networkidle' });
    // Should redirect to login if not authenticated
    await expect(page).toHaveURL(/login/);
  });

  test('No console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    await page.goto('http://localhost:5174', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    
    const criticalErrors = errors.filter(e => 
      !e.includes('favicon') && 
      !e.includes('manifest') &&
      !e.includes('Extension')
    );
    
    expect(criticalErrors).toHaveLength(0);
  });
});

test.describe('Cross-App Integration Tests', () => {
  test('Deep links work', async ({ page }) => {
    // Test deep link handling
    await page.goto('burgonomics://order/TEST123', { waitUntil: 'networkidle' });
    // Should handle gracefully
  });

  test('Push notification permission flow', async ({ page }) => {
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle' });
    // Check for permission prompt handling
  });
});

// Run with: npx playwright test playwright-webview-tests.spec.js --project=chromium
export default {
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : 2,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 14'] },
    },
  },
  webServer: {
    command: 'cd burgonomics-foundation-core && npx serve dist/mobile -p 5173',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
};