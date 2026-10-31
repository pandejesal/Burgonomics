// Actual Menu DOM; isolated guest browser only. The filled-Cart case is an
// explicitly local fixture made from a real catalogue item, never a phone order.
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const fs = require('node:fs/promises');
const path = require('node:path');
const base = 'http://127.0.0.1:48176';
const report = { status: 'FAIL', samples: [], pageErrors: [], blockedWrites: [], phoneStateChanged: false, providerAcceptance: false, fixtures: 'Public-outlet browser geolocation; explicitly local one-item browser Cart sample' };
async function newContext(browser, extra = {}) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, reducedMotion: 'reduce', serviceWorkers: 'block', ...extra });
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
    const store = await setup.evaluate(async () => {
      const { storeRepository } = await import('/src/features/stores/repositories/StoreRepository.ts');
      const result = await storeRepository.list();
      const outlet = result.success && result.data.find(value => /Mansi Circle/i.test(value.name));
      if (!outlet) throw new Error('Read-only public outlet unavailable');
      return outlet;
    });
    await setupContext.close();
    const context = await newContext(browser, { permissions: ['geolocation'], geolocation: { latitude: store.lat, longitude: store.lng } });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(`${base}/stores`, { waitUntil: 'domcontentloaded' });
    const consent = page.getByRole('button', { name: 'Accept & Continue', exact: true });
    if (await consent.isVisible()) await consent.click();
    const confirm = page.getByRole('button', { name: `Continue with ${store.name}`, exact: true });
    await confirm.waitFor({ state: 'visible', timeout: 90000 });
    await confirm.click();
    await page.getByRole('button', { name: 'Burgers', exact: true }).waitFor({ state: 'visible', timeout: 90000 });
    const privacy = page.getByRole('button', { name: 'Dismiss privacy banner' });
    if (await privacy.isVisible()) await privacy.click();
    await page.goto(`${base}/menu?view=grid`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-menu-category] [data-testid="product-card-link"]').nth(3).waitFor({ state: 'visible', timeout: 90000 });
    await page.evaluate(() => document.fonts.ready);
    const fixture = await page.evaluate(async () => {
      const { useMenuStore } = await import('/src/features/menu/state/menuStore.ts');
      const state = useMenuStore.getState();
      const category = state.categories.find(value => state.buckets[value.id]?.items.length >= 4);
      if (!category) throw new Error('No loaded real category with four items');
      return { categoryId: category.id, item: state.buckets[category.id].items[0] };
    });
    for (const viewport of [{ width: 320, height: 780 }, { width: 360, height: 780 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const populated of [false, true]) {
        await page.evaluate(async ({ populated, item, storeId }) => {
          const { useCartStore } = await import('/src/features/cart/state/cartStore.ts');
          useCartStore.setState({ lines: populated ? [{ lineId: 'qa-grid-local-sample', productId: item.id, storeId, name: item.name, unitPrice: item.price, quantity: 1, imageUrl: item.imageUrl, modifiers: [], availability: 'available', veg: item.veg ?? true }] : [] });
        }, { populated, item: fixture.item, storeId: store.id });
        if (populated) {
          await page.waitForFunction(() => {
            const cart = document.querySelector('aside[aria-label^="Floating cart summary"]');
            if (!cart) return false;
            const transform = getComputedStyle(cart).transform;
            return transform === 'none' || (transform.startsWith('matrix(') && Math.abs(new DOMMatrixReadOnly(transform).m42) < 0.1);
          });
        } else {
          await page.locator('aside[aria-label^="Floating cart summary"]').waitFor({ state: 'hidden' });
        }
        await page.locator(`[data-category-id="${fixture.categoryId}"]`).click();
        await page.waitForFunction(id => {
          const section = document.querySelector(`[data-menu-category="${id}"]`);
          const nav = document.querySelector('[aria-label="Menu categories"]');
          if (!section || !nav) return false;
          const chrome = nav.parentElement.parentElement;
          return Math.abs(section.getBoundingClientRect().top - chrome.getBoundingClientRect().bottom - 8) < 12;
        }, fixture.categoryId);
        await page.waitForFunction(id => {
          const section = document.querySelector(`[data-menu-category="${id}"]`);
          return [...section.querySelectorAll('[data-testid="product-card-link"]')].slice(0, 4).every(link => {
            const button = link.parentElement.querySelector('button[aria-label^="Add "][aria-label$=" to cart"],button[aria-label^="Decrease quantity"],button[disabled]');
            if (!button) return false;
            const bounds = button.getBoundingClientRect();
            return Math.abs(bounds.height - button.offsetHeight) < 0.01 && bounds.height >= 44 && bounds.width >= 44;
          });
        }, fixture.categoryId);
        const sample = await page.evaluate(({ categoryId, populated }) => {
          const section = document.querySelector(`[data-menu-category="${categoryId}"]`);
          const chrome = document.querySelector('[aria-label="Menu categories"]').parentElement.parentElement.getBoundingClientRect();
          const nav = document.querySelector('nav[aria-label="Primary"]').getBoundingClientRect();
          const cart = document.querySelector('aside[aria-label^="Floating cart summary"]');
          const boundary = Math.min(nav.top, cart?.getBoundingClientRect().top ?? innerHeight);
          const cards = [...section.querySelectorAll('[data-testid="product-card-link"]')].slice(0, 4).map(link => {
            const root = link.parentElement, rect = root.getBoundingClientRect();
            const button = root.querySelector('button[aria-label^="Add "][aria-label$=" to cart"],button[aria-label^="Decrease quantity"],button[disabled]');
            const target = button?.getBoundingClientRect();
            const price = root.querySelector('[data-testid="product-price-badge"]');
            const heart = root.querySelector('button[aria-label*="favourites"],button[aria-label*="favorites"]');
            const heartRect = heart?.getBoundingClientRect(), priceRect = price?.getBoundingClientRect();
            const heartHit = heartRect && document.elementFromPoint(heartRect.x + heartRect.width / 2, heartRect.y + heartRect.height / 2);
            const overlaps = heartRect && priceRect && Math.min(heartRect.right, priceRect.right) > Math.max(heartRect.left, priceRect.left) && Math.min(heartRect.bottom, priceRect.bottom) > Math.max(heartRect.top, priceRect.top);
            return { top: rect.top, left: rect.left, width: rect.width, height: rect.height, bottom: rect.bottom, fullCardClear: rect.top >= chrome.bottom && rect.bottom <= boundary - 4, addTarget: target ? { width: target.width, height: target.height } : null, titleFontPx: parseFloat(getComputedStyle(root.querySelector('h3')).fontSize), priceVisible: !!price && price.getBoundingClientRect().height > 0 && getComputedStyle(price).visibility !== 'hidden', priceOverlapsFavourite: !!overlaps, favouriteHitTargetClear: !!heart && (heartHit === heart || heart.contains(heartHit)) };
          });
          return { width: innerWidth, height: innerHeight, populated, chromeBottom: chrome.bottom, occlusionTop: boundary, cards, overflow: document.documentElement.scrollWidth - innerWidth, twoColumns: cards.length === 4 && Math.abs(cards[0].top - cards[1].top) <= 1 && cards[1].left > cards[0].left && Math.abs(cards[2].top - cards[3].top) <= 1 && cards[2].top > cards[0].top };
        }, { categoryId: fixture.categoryId, populated });
        report.samples.push(sample);
        await page.screenshot({ path: path.join(__dirname, `menu-${viewport.width}-${populated ? 'filled' : 'empty'}.png`) });
      }
    }
    await page.setViewportSize({ width: 320, height: 780 });
    await page.evaluate(async id => {
      const { useMenuStore } = await import('/src/features/menu/state/menuStore.ts');
      const state = useMenuStore.getState(), bucket = state.buckets[id];
      // Explicit isolated presentation fixture for a wrapping compare price.
      useMenuStore.setState({ buckets: { ...state.buckets, [id]: { ...bucket, items: bucket.items.map((item, index) => index === 0 ? { ...item, compareAtPrice: item.price * 2 } : item) } } });
      document.documentElement.style.fontSize = '32px';
    }, fixture.categoryId);
    await page.waitForFunction(id => {
      const links = document.querySelector(`[data-menu-category="${id}"]`).querySelectorAll('[data-testid="product-card-link"]');
      return links[1].parentElement.getBoundingClientRect().top > links[0].parentElement.getBoundingClientRect().bottom;
    }, fixture.categoryId);
    report.enlargedText = await page.evaluate(id => {
      const root = document.querySelector(`[data-menu-category="${id}"] [data-testid="product-card-link"]`).parentElement;
      const price = root.querySelector('[data-testid="product-price-badge"]');
      const heart = root.querySelector('button[aria-label*="favourites"],button[aria-label*="favorites"]');
      const a = price.getBoundingClientRect(), b = heart.getBoundingClientRect();
      return { condition: '200% root font at 320px, explicit local compare-price fixture', columnsReflowToOne: true, priceOverlapsFavourite: Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top), overflow: document.documentElement.scrollWidth - innerWidth, priceClipped: price.scrollWidth > price.clientWidth, cardOverflow: root.scrollWidth - root.clientWidth };
    }, fixture.categoryId);
    report.status = report.samples.every(sample => sample.twoColumns && sample.overflow === 0 && sample.cards.every(card => card.fullCardClear && card.priceVisible && !card.priceOverlapsFavourite && card.favouriteHitTargetClear && card.titleFontPx >= 14 && card.addTarget?.height >= 44 && card.addTarget?.width >= 44)) && !report.enlargedText.priceOverlapsFavourite && !report.enlargedText.priceClipped && report.enlargedText.overflow === 0 && report.enlargedText.cardOverflow === 0 && report.pageErrors.length === 0 ? 'PASS' : 'FAIL';
    await context.close();
  } catch (error) {
    report.error = error.message;
  } finally {
    await browser.close();
    await fs.writeFile(path.join(__dirname, 'browser-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  }
})();
