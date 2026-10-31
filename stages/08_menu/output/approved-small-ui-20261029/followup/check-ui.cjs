// Actual app UI, isolated guest contexts. Synthetic location is a public store's
// coordinates, never phone GPS. No provider/auth/Firestore writes are permitted.
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const fs = require('node:fs/promises');
const path = require('node:path');
const output = path.resolve(__dirname, process.argv[2] || '.');
if (output !== __dirname && !output.startsWith(__dirname + path.sep)) throw new Error('Evidence must stay in the follow-up directory');
const base = 'http://127.0.0.1:48176';
const report = { samples: [], failures: [], pageErrors: [], blockedWrites: [], locationFixture: 'public outlet coordinates; not device GPS', providerAcceptance: false, physicalDeviceAcceptance: false };
async function context(browser, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', colorScheme: 'light', serviceWorkers: 'block', ...extra });
  await ctx.route('**/*', route => {
    const q = route.request(), u = new URL(q.url());
    const local = ['127.0.0.1', 'localhost'].includes(u.hostname);
    const firestoreRead = u.hostname === 'firestore.googleapis.com' && /Listen|RunQuery|BatchGetDocuments|runQuery|batchGet/.test(u.pathname);
    if (/^(identitytoolkit|securetoken)\.googleapis\.com$/.test(u.hostname) || (!local && !firestoreRead && !['GET', 'HEAD', 'OPTIONS'].includes(q.method()))) {
      report.blockedWrites.push({ host: u.hostname, method: q.method() });
      return route.abort();
    }
    return route.continue();
  });
  return ctx;
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe` });
  try {
    const bootstrap = await context(browser);
    const setup = await bootstrap.newPage();
    await setup.goto(`${base}/stores`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const store = await setup.evaluate(async () => {
      const { storeRepository } = await import('/src/features/stores/repositories/StoreRepository.ts');
      const res = await storeRepository.list();
      if (!res.success) throw new Error('Read-only public directory bootstrap failed');
      const outlet = res.data.find(s => /Mansi Circle/i.test(s.name));
      if (!outlet) throw new Error('The known public outlet is not in the directory');
      return outlet;
    });
    await bootstrap.close();
    const ctx = await context(browser, { permissions: ['geolocation'], geolocation: { latitude: store.lat, longitude: store.lng } });
    const page = await ctx.newPage();
    page.on('pageerror', e => report.pageErrors.push(e.message));
    await page.goto(`${base}/stores`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const consent = page.getByRole('button', { name: 'Accept & Continue', exact: true });
    if (await consent.isVisible()) await consent.click();
    const confirm = page.getByRole('button', { name: `Continue with ${store.name}`, exact: true });
    const choose = page.getByRole('button', { name: new RegExp(store.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
    await Promise.race([confirm.waitFor({ state: 'visible', timeout: 90000 }), choose.waitFor({ state: 'visible', timeout: 90000 })]);
    report.storesLoadedWithoutRetry = true;
    report.storeModeChoiceCount = await page.locator('[aria-label="Fulfillment mode"] [role="radio"]').count();
    report.falseEmptyAtLoadedState = await page.getByText('No stores found', { exact: true }).isVisible();
    report.radiusVisibility = await page.evaluate(async (origin) => {
      const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
      const { getDeliveryDistanceKm, DEFAULT_DELIVERY_RADIUS_KM } = await import('/src/features/stores/utils/serviceArea.ts');
      const state = useStoreSelection.getState();
      const labels = [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label'));
      const far = state.stores.filter(s => getDeliveryDistanceKm(s, origin.lat, origin.lng) > (s.deliveryRadiusKm ?? DEFAULT_DELIVERY_RADIUS_KM));
      return { farStoresChecked: far.length, farStoresRendered: far.filter(s => labels.some(label => label.includes(s.name))).map(s => s.name) };
    }, { lat: store.lat, lng: store.lng });
    if (await confirm.isVisible()) await confirm.click();
    else await choose.click();
    await page.getByRole('button', { name: 'Burgers', exact: true }).waitFor({ state: 'visible', timeout: 90000 });
    const privacy = page.getByRole('button', { name: 'Dismiss privacy banner' });
    if (await privacy.isVisible()) await privacy.click();
    await page.evaluate(() => document.fonts.ready);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const mode of ['Dine-in', 'Delivery']) {
        await page.getByRole('radio', { name: mode, exact: true }).click();
        await page.evaluate(() => window.scrollTo(0, 0));
        const sample = await page.evaluate(({ mode }) => {
          const hero = document.querySelector('[aria-roledescription="slide"]');
          const tiles = [...document.querySelectorAll('button[aria-label="Burgers"],button[aria-label="Sides"],button[aria-label="Shakes & Drinks"]')];
          return { mode, width: innerWidth, tileWidths: tiles.map(e => e.getBoundingClientRect().width), heroHeight: hero.getBoundingClientRect().height, firstTitle: hero.querySelector('h3').textContent, headlineLeft: hero.querySelector('h3').getBoundingClientRect().left, wordmarkSize: parseFloat(getComputedStyle(document.querySelector('[aria-label="Burgonomics Home"] > span')).fontSize), overflow: document.documentElement.scrollWidth - innerWidth, wraps: !!document.querySelector('[aria-label="Wraps"]') };
        }, { mode });
        const last = page.getByRole('button', { name: 'Shakes & Drinks', exact: true });
        await last.evaluate(e => e.scrollIntoView({ block: 'center' }));
        sample.lowerRowClearWhenScrolled = await last.evaluate(e => e.getBoundingClientRect().bottom < document.querySelector('nav[aria-label="Primary"]').getBoundingClientRect().top - 8);
        report.samples.push(sample);
        await page.screenshot({ path: path.join(output, `home-${mode.toLowerCase()}-${width}.png`) });
      }
    }
    report.promoContrast = [];
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.waitForFunction(value => document.documentElement.classList.contains('dark') === (value === 'dark'), theme);
      const badge = page.locator('[aria-roledescription="slide"] span').first();
      const contrast = await badge.evaluate(element => {
        const style = getComputedStyle(element);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const color = value => {
          context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
          return Array.from(context.getImageData(0, 0, 1, 1).data);
        };
        const luminance = rgb => rgb.slice(0, 3).map(value => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
        const foreground = color(style.color), background = color(style.backgroundColor);
        const ratios = [0, 255].map(backdrop => {
          const alpha = background[3] / 255;
          const composite = background.slice(0, 3).map(channel => channel * alpha + backdrop * (1 - alpha));
          const a = luminance(foreground), b = luminance(composite);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        return { foreground: style.color, badgeBackground: style.backgroundColor, minimumAgainstBlackOrWhiteBackdrop: Math.min(...ratios) };
      });
      report.promoContrast.push({ theme, ...contrast });
    }
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    const favorites = page.getByRole('heading', { name: 'Your favourites', exact: true });
    report.emptyFavoritesHidden = await favorites.count() === 0;
    await page.evaluate(async () => {
      const { useFavoritesStore } = await import('/src/features/favorites/state/favoritesStore.ts');
      // Explicit local QA fixture; navigation-only metadata, not an availability claim.
      useFavoritesStore.getState().add({ id: 'qa-saved-category', kind: 'category', refId: 'qa-category', name: 'Sample saved favourite', addedAt: new Date().toISOString() });
    });
    await favorites.waitFor({ state: 'visible' });
    report.populatedFavoritesVisible = true;
    await page.evaluate(async () => (await import('/src/features/favorites/state/favoritesStore.ts')).useFavoritesStore.getState().clear());
    await favorites.waitFor({ state: 'hidden' });
    report.clearedFavoritesHidden = await favorites.count() === 0;
    await page.locator('#awards').scrollIntoViewIfNeeded();
    report.awardPhotoRatio = await page.locator('#awards > div img').first().evaluate(e => e.getBoundingClientRect().width / e.getBoundingClientRect().height);
    await page.locator('#upcoming-stores').scrollIntoViewIfNeeded();
    report.branchCounterAbsent = !/\b\d+\s*\/\s*\d+\b/.test(await page.locator('#upcoming-stores').innerText());
    await page.locator('#upcoming-stores').screenshot({ path: path.join(output, 'upcoming-no-counter.png') });
    await page.goto(`${base}/cart`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Your burger box is empty' }).waitFor();
    report.emptyCartHasNoInstructions = await page.getByRole('button', { name: 'Add cooking instructions', exact: true }).count() === 0;
    await page.goto(`${base}/search`, { waitUntil: 'domcontentloaded' });
    const search = page.getByRole('searchbox', { name: 'Search the menu', exact: true });
    await search.focus();
    report.searchFocus = await search.evaluate(e => {
      const input = getComputedStyle(e), wrapper = getComputedStyle(e.closest('.search-field'));
      return { inputOutline: input.outlineStyle, wrapperOutline: wrapper.outlineStyle, wrapperWidth: wrapper.outlineWidth, radius: parseFloat(wrapper.borderTopLeftRadius), overflow: document.documentElement.scrollWidth - innerWidth };
    });
    await page.screenshot({ path: path.join(output, 'search-rounded-focus.png') });
    if (report.samples.some(s => s.tileWidths.some(w => w < (s.width - 32) * 0.42) || s.heroHeight < 180 || s.headlineLeft < 16 || s.wordmarkSize < 24 || s.overflow > 0 || s.wraps || !s.lowerRowClearWhenScrolled)) report.failures.push('Home sizing/clearance');
    if (!report.emptyFavoritesHidden || !report.populatedFavoritesVisible || !report.clearedFavoritesHidden) report.failures.push('conditional favourites');
    if (!report.emptyCartHasNoInstructions || !report.branchCounterAbsent || report.awardPhotoRatio < 2.9) report.failures.push('Cart/announcements');
    if (report.falseEmptyAtLoadedState || report.radiusVisibility.farStoresRendered.length > 0) report.failures.push('store initial load/radius visibility');
    if (report.storeModeChoiceCount !== 3) report.failures.push('store fulfilment choice missing');
    if (report.promoContrast.some(sample => sample.minimumAgainstBlackOrWhiteBackdrop < 4.5)) report.failures.push('promo badge contrast below 4.5:1');
    if (report.searchFocus.inputOutline !== 'none' || report.searchFocus.wrapperOutline !== 'solid' || report.searchFocus.wrapperWidth !== '2px' || report.searchFocus.radius < 12 || report.searchFocus.overflow > 0) report.failures.push('rounded focus');
    report.status = report.failures.length || report.pageErrors.length ? 'FAIL' : 'PASS';
    await ctx.close();
  } catch (error) {
    report.status = 'FAIL';
    report.failures.push(error.message);
  } finally {
    await browser.close();
    await fs.writeFile(path.join(output, 'browser-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  }
})();
