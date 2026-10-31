// Real app + read-only public outlet catalog. No Home rail fixtures, phone data,
// auth, provider actions, Add/quantity actions or Firestore writes.
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const fs = require('node:fs/promises');
const path = require('node:path');
const base = 'http://127.0.0.1:48176';
const output = path.resolve(__dirname, process.argv[2] || '.');
if (output !== __dirname && !output.startsWith(__dirname + path.sep)) throw new Error('Evidence must stay in the Home-sections directory');
const report = { status: 'FAIL', samples: [], pageErrors: [], consoleErrors: [], failures: [], blockedWrites: [], railFixtures: false, phoneAcceptance: false, providerAcceptance: false };
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

async function isolatedContext(browser, extra = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', colorScheme: 'light', serviceWorkers: 'block', ...extra });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
    const readTransport = url.hostname === 'firestore.googleapis.com' && /Listen|RunQuery|BatchGetDocuments|runQuery|batchGet/.test(url.pathname);
    const auth = /^(identitytoolkit|securetoken)\.googleapis\.com$/.test(url.hostname);
    if (auth || (!local && !readTransport && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()))) {
      report.blockedWrites.push({ host: url.hostname, method: request.method() });
      return route.abort();
    }
    return route.continue();
  });
  return context;
}

(async () => {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` });
  try {
    const bootstrap = await isolatedContext(browser);
    const setup = await bootstrap.newPage();
    await setup.goto(`${base}/stores`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const store = await setup.evaluate(async () => {
      const { storeRepository } = await import('/src/features/stores/repositories/StoreRepository.ts');
      const result = await storeRepository.list();
      const outlet = result.success && result.data.find(value => /Mansi Circle/i.test(value.name));
      if (!outlet) throw new Error('Known public outlet is unavailable');
      return { id: outlet.id, name: outlet.name, lat: outlet.lat, lng: outlet.lng };
    });
    await bootstrap.close();
    const context = await isolatedContext(browser, { permissions: ['geolocation'], geolocation: { latitude: store.lat, longitude: store.lng } });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(`${base}/stores`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const consent = page.getByRole('button', { name: 'Accept & Continue', exact: true });
    if (await consent.isVisible()) await consent.click();
    const confirm = page.getByRole('button', { name: `Continue with ${store.name}`, exact: true });
    const choose = page.getByRole('button', { name: new RegExp(store.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
    await Promise.race([confirm.waitFor({ state: 'visible', timeout: 90000 }), choose.waitFor({ state: 'visible', timeout: 90000 })]);
    if (await confirm.isVisible()) await confirm.click(); else await choose.click();
    await page.getByRole('heading', { name: 'Best sellers', exact: true }).waitFor({ state: 'visible', timeout: 90000 });
    await page.getByRole('heading', { name: 'Make it a meal', exact: true }).waitFor({ state: 'visible', timeout: 90000 });
    const privacy = page.getByRole('button', { name: 'Dismiss privacy banner' });
    if (await privacy.isVisible()) await privacy.click();
    await page.evaluate(() => document.fonts.ready);
    await page.locator('[data-sonner-toast]').last().waitFor({ state: 'hidden', timeout: 20000 });

    report.catalog = await page.evaluate(async () => {
      const { useHomeStore } = await import('/src/features/home/state/homeStore.ts');
      const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
      const { menuService } = await import('/src/features/menu/services/menuService.ts');
      const store = useStoreSelection.getState().activeStore;
      const state = useHomeStore.getState();
      const catalog = await menuService.listHomeCatalog(store.id);
      if (!catalog.success) throw new Error('Canonical catalog comparison failed');
      const byId = new Map(catalog.data.products.map(product => [product.id, product]));
      const matchesProduct = product => {
        const actual = byId.get(product.productId ?? product.id);
        return !!actual && actual.inStock === true && actual.name === product.name && actual.price === product.price;
      };
      return {
        storeId: store.id, loadedStoreMatches: state.lastLoadedStoreId === store.id,
        catalogProductCount: catalog.data.products.length,
        bestSellers: state.bundle.bestSellers.map(({ id, name, price }) => ({ id, name, price })),
        meals: state.bundle.popularCombos.map(({ id, productId, name, price }) => ({ id, productId, name, price })),
        allRowsMatchActualStoreProducts: state.bundle.bestSellers.every(matchesProduct) && state.bundle.popularCombos.every(matchesProduct),
        rankingVerified: false,
      };
    });
    requireCondition(report.catalog.storeId === store.id && report.catalog.loadedStoreMatches, 'Home scope mismatch');
    requireCondition(report.catalog.bestSellers.length > 0 && report.catalog.meals.length > 0, 'Promised rails are empty');
    requireCondition(report.catalog.allRowsMatchActualStoreProducts, 'A rail differs from real outlet products');
    report.locationFixture = 'Public outlet coordinates in an isolated guest browser; never phone GPS';

    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.waitForFunction(value => document.documentElement.classList.contains('dark') === (value === 'dark'), theme);
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        for (const mode of ['Delivery', 'Dine-in']) {
          await page.getByRole('radio', { name: mode, exact: true }).click();
          const sample = await page.evaluate(({ theme, mode }) => {
            const ids = ['cats-heading', 'best-heading', 'combos-heading', 'home-awards-heading', 'home-upcoming-heading'];
            const headings = [...document.querySelectorAll('h2')].filter(element => ids.includes(element.id));
            const best = document.querySelector('[aria-labelledby="best-heading"]');
            const meals = document.querySelector('[aria-labelledby="combos-heading"]');
            return { theme, mode, width: innerWidth,
              sectionIds: headings.map(element => element.id),
              headingFont: getComputedStyle(document.querySelector('#best-heading')).fontFamily,
              bestSellerCards: best.querySelectorAll('h3').length, mealCards: meals.querySelectorAll('h3').length,
              minimumAddTargetHeight: Math.min(...[...best.querySelectorAll('button')].map(element => element.getBoundingClientRect().height)),
              overflow: document.documentElement.scrollWidth - innerWidth,
            };
          }, { theme, mode });
          report.samples.push(sample);
          requireCondition(sample.sectionIds.join(',') === 'cats-heading,best-heading,combos-heading,home-awards-heading,home-upcoming-heading', 'Home section order mismatch');
          requireCondition(sample.overflow === 0 && sample.minimumAddTargetHeight >= 44, 'Overflow or undersized Add target');
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('[aria-labelledby="best-heading"]').screenshot({ path: path.join(output, `best-sellers-${theme}.png`) });
      await page.locator('[aria-labelledby="combos-heading"]').screenshot({ path: path.join(output, `make-it-a-meal-${theme}.png`) });
    }

    const meal = report.catalog.meals[0];
    const beforeCount = await page.evaluate(async () => (await import('/src/features/cart/state/cartStore.ts')).useCartStore.getState().lines.length);
    await page.locator('[aria-labelledby="combos-heading"] button').first().click();
    await page.waitForURL(url => decodeURIComponent(url.pathname) === `/menu/product/${meal.productId}`, { timeout: 30000 });
    await page.getByRole('heading', { name: meal.name, exact: true }).first().waitFor({ state: 'visible', timeout: 60000 });
    const afterCount = await page.evaluate(async () => (await import('/src/features/cart/state/cartStore.ts')).useCartStore.getState().lines.length);
    report.mealNavigation = { productId: meal.productId, correctProductOpened: true, cartCountBefore: beforeCount, cartCountAfter: afterCount };
    requireCondition(beforeCount === afterCount, 'Navigation changed the isolated Cart');
    requireCondition(report.pageErrors.length === 0 && report.consoleErrors.length === 0, 'Browser errors observed');
    report.status = 'PASS';
    await context.close();
  } catch (error) {
    report.failures.push(error.message);
  } finally {
    await browser.close();
    await fs.writeFile(path.join(output, 'browser-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
