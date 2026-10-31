// Read-only diagnosis of the real Home data state in an isolated guest browser.
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const base = 'http://127.0.0.1:48176';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` });
  const report = { status: 'FAIL', consoleErrors: [] };
  try {
    const bootstrap = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
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
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block',
      permissions: ['geolocation'], geolocation: { latitude: store.lat, longitude: store.lng },
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.goto(`${base}/stores`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const consent = page.getByRole('button', { name: 'Accept & Continue', exact: true });
    if (await consent.isVisible().catch(() => false)) await consent.click();
    const confirm = page.getByRole('button', { name: `Continue with ${store.name}`, exact: true });
    if (await confirm.isVisible()) await confirm.click();
    await page.getByRole('heading', { name: 'On the menu', exact: true }).waitFor({ state: 'visible', timeout: 90000 });
    await page.evaluate(() => document.fonts.ready);
    report.url = page.url();
    report.headings = await page.evaluate(() => [...document.querySelectorAll('h1,h2,h3')].map(element => ({ tag: element.tagName, id: element.id, text: element.textContent.trim().slice(0, 90) })));
    report.homeState = await page.evaluate(async () => {
      const { useHomeStore } = await import('/src/features/home/state/homeStore.ts');
      const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
      const state = useHomeStore.getState();
      return {
        status: state.status, error: state.error, lastLoadedStoreId: state.lastLoadedStoreId,
        activeStoreId: useStoreSelection.getState().activeStore?.id,
        bundlePresent: !!state.bundle,
        counts: state.bundle ? {
          banners: state.bundle.banners.length, categories: state.bundle.categories.length,
          bestSellers: state.bundle.bestSellers.length, combos: state.bundle.popularCombos.length,
        } : null,
        bestSellerNames: state.bundle?.bestSellers.map(item => item.name) ?? [],
        comboNames: state.bundle?.popularCombos.map(item => item.name) ?? [],
      };
    });
    report.catalog = await page.evaluate(async () => {
      const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
      const { menuService } = await import('/src/features/menu/services/menuService.ts');
      const store = useStoreSelection.getState().activeStore;
      const result = await menuService.listHomeCatalog(store.id);
      if (!result.success) return { success: false, error: result.error };
      const mealCategory = result.data.products.filter(product => /meal|combo/i.test(`${product.categoryId} ${product.categoryName ?? ''} ${product.name}`)).slice(0, 10);
      return { success: true, productCount: result.data.products.length, categories: result.data.categories, mealCandidates: mealCategory.map(product => ({ id: product.id, name: product.name, categoryId: product.categoryId, categoryName: product.categoryName, inStock: product.inStock })) };
    });
    report.bodyText = (await page.locator('body').innerText()).slice(0, 4000);
    report.status = 'OBSERVED';
  } catch (error) {
    report.error = error.message;
  } finally {
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
