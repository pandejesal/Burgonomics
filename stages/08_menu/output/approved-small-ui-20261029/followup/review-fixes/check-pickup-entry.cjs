// Read-only live directory, fresh guest browser, explicitly simulated public-area
// position. Never touches phone GPS, auth, orders, payments or persisted user data.
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const fs = require('node:fs/promises');
const path = require('node:path');
const base = 'http://127.0.0.1:48176';
const report = { status: 'FAIL', position: 'Explicit isolated-browser location 20 km from a public outlet; not phone GPS', providerAcceptance: false, cases: [], pageErrors: [], blockedWrites: [] };
async function newContext(browser, extra = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block', ...extra });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
    const read = url.hostname === 'firestore.googleapis.com' && /Listen|RunQuery|BatchGetDocuments|runQuery|batchGet/.test(url.pathname);
    if (/^(identitytoolkit|securetoken)\.googleapis\.com$/.test(url.hostname) || (!local && !read && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()))) {
      report.blockedWrites.push({ host: url.hostname, method: request.method() });
      return route.abort();
    }
    return route.continue();
  });
  return context;
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe` });
  try {
    const setupContext = await newContext(browser);
    const setup = await setupContext.newPage();
    await setup.goto(`${base}/stores`, { waitUntil: 'domcontentloaded' });
    const fixture = await setup.evaluate(async () => {
      const { storeRepository } = await import('/src/features/stores/repositories/StoreRepository.ts');
      const { selectVisibleStores } = await import('/src/features/stores/utils/serviceArea.ts');
      const result = await storeRepository.list();
      if (!result.success) throw new Error('Read-only directory unavailable');
      const store = result.data.find(value => /Mansi Circle/i.test(value.name) && value.supports.takeaway && value.supports.dineIn);
      if (!store) throw new Error('Public outlet supporting both pickup modes unavailable');
      for (let angle = 0; angle < 360; angle += 30) {
        const radians = angle * Math.PI / 180;
        const coords = { lat: store.lat + Math.cos(radians) * 20 / 111.195, lng: store.lng + Math.sin(radians) * 20 / (111.195 * Math.cos(store.lat * Math.PI / 180)) };
        if (selectVisibleStores(result.data, coords, 'delivery').length === 0 && selectVisibleStores(result.data, coords, 'takeaway').some(value => value.id === store.id)) {
          return { latitude: coords.lat, longitude: coords.lng, storeId: store.id };
        }
      }
      throw new Error('No suitable public-area position for the explicit 20 km browser case');
    });
    await setupContext.close();
    const context = await newContext(browser, { permissions: ['geolocation'], geolocation: { latitude: fixture.latitude, longitude: fixture.longitude } });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(`${base}/stores`, { waitUntil: 'domcontentloaded' });
    const consent = page.getByRole('button', { name: 'Accept & Continue', exact: true });
    if (await consent.isVisible()) await consent.click();
    await page.getByText('No stores deliver here yet', { exact: true }).waitFor({ state: 'visible', timeout: 90000 });
    for (const mode of ['Takeaway', 'Dine-in']) {
      await page.getByRole('radio', { name: mode, exact: true }).click();
      await page.waitForFunction(async id => {
        const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
        const { selectVisibleStores } = await import('/src/features/stores/utils/serviceArea.ts');
        const state = useStoreSelection.getState();
        return selectVisibleStores(state.stores, state.coords, state.fulfillment).some(store => store.id === id);
      }, fixture.storeId);
      // The existing nearest-outlet sheet may ASK after a mode change; dismiss
      // it, never confirm/select it, then inspect the underlying eligible row.
      const chooseAnother = page.getByRole('button', { name: 'Choose another store', exact: true });
      if (await chooseAnother.isVisible()) await chooseAnother.click();
      const sample = await page.evaluate(async id => {
        const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
        const { useCartStore } = await import('/src/features/cart/state/cartStore.ts');
        const state = useStoreSelection.getState();
        const target = state.stores.find(store => store.id === id);
        const labels = [...document.querySelectorAll('button[aria-label]')].map(element => element.getAttribute('aria-label'));
        return { mode: state.fulfillment, activeStoreStillNull: state.activeStore === null, cartStillEmpty: useCartStore.getState().lines.length === 0, targetRowRendered: labels.some(label => label.startsWith(target.name)), overflow: document.documentElement.scrollWidth - innerWidth };
      }, fixture.storeId);
      report.cases.push(sample);
      if (!sample.activeStoreStillNull || !sample.cartStillEmpty || !sample.targetRowRendered || sample.overflow !== 0) throw new Error('Pickup choice failed or altered store/cart');
      await page.screenshot({ path: path.join(__dirname, `first-store-${mode.toLowerCase()}.png`) });
      await page.getByRole('radio', { name: 'Delivery', exact: true }).click();
      await page.getByText('No stores deliver here yet', { exact: true }).waitFor({ state: 'visible' });
    }
    report.deliveryEmptyWithPickupReachable = true;
    report.status = report.pageErrors.length ? 'FAIL' : 'PASS';
    await context.close();
  } catch (error) {
    report.error = error.message;
  } finally {
    await browser.close();
    await fs.writeFile(path.join(__dirname, 'pickup-entry-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  }
})();
