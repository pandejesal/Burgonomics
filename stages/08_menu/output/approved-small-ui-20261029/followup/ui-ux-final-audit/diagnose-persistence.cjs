// Isolated persistence diagnosis: does a normal in-app reload retain the store?
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const base = 'http://127.0.0.1:48176';
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` });
  const report = { status: 'FAIL', steps: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', error => report.steps.push({ pageError: error.message }));
    await page.goto(`${base}/stores`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(1500);
    await page.evaluate(async () => {
      const { storeRepository } = await import('/src/features/stores/repositories/StoreRepository.ts');
      const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
      const result = await storeRepository.list();
      const outlet = result.success && result.data.find(value => /Mansi Circle/i.test(value.name));
      if (!outlet) throw new Error('Known outlet unavailable');
      useStoreSelection.getState().setActiveStore(outlet);
      await new Promise(resolve => setTimeout(resolve, 500));
    });
    report.steps.push({ afterSet: await page.evaluate(() => ({ storage: Object.keys(localStorage), store: localStorage.getItem('burgonomics-stores')?.slice(0, 300) })) });
    await page.goto(`${base}/home`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(4000);
    report.steps.push({ afterNavigate: await page.evaluate(async () => {
      const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
      return { url: location.pathname, activeStoreId: useStoreSelection.getState().activeStore?.id ?? null, storageKeys: Object.keys(localStorage) };
    }) });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    report.steps.push({ afterReload: await page.evaluate(async () => {
      const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
      return { url: location.pathname, activeStoreId: useStoreSelection.getState().activeStore?.id ?? null, hydrated: useStoreSelection.getState().isHydrated, storageKeys: Object.keys(localStorage) };
    }) });
    await page.goto(`${base}/home`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForTimeout(3000);
    report.steps.push({ homeAgain: await page.evaluate(async () => {
      const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
      return { url: location.pathname, activeStoreId: useStoreSelection.getState().activeStore?.id ?? null };
    }) });
    report.status = 'OBSERVED';
  } catch (error) {
    report.error = error.message;
  } finally {
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
