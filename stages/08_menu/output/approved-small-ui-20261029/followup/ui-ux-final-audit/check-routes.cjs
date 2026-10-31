// Bounded Delivery UI audit: real app, read-only public store data, isolated
// guest browser state. No auth, payment, provider writes or phone interaction.
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const fs = require('node:fs/promises');
const path = require('node:path');
const base = 'http://127.0.0.1:48176';
const report = {
  status: 'FAIL', scope: 'Reachable guest Delivery/UI routes; synthetic public-outlet location; not phone, provider, auth, checkout or production acceptance',
  samples: [], pageErrors: [], consoleErrors: [], blockedWrites: [],
};
const routes = [
  { name: 'home', path: '/home', heading: /Best sellers/i },
  { name: 'menu', path: '/menu?view=grid', heading: /Menu/i },
  { name: 'search', path: '/search', heading: /Search/i },
  { name: 'cart', path: '/cart', heading: /Your Cart/i },
  { name: 'offers', path: '/offers', heading: /Offers/i },
  { name: 'stores', path: '/stores', heading: /stores/i },
  { name: 'orders', path: '/orders', heading: /Orders/i },
  { name: 'profile', path: '/profile', heading: /Profile/i },
  { name: 'settings', path: '/profile/settings', heading: /Settings/i },
  { name: 'favorites', path: '/profile/favorites', heading: /Favourites/i },
  { name: 'addresses', path: '/profile/addresses', heading: /addresses/i },
  { name: 'login', path: '/auth/login', heading: /Welcome to BURGONOMICS/i },
  { name: 'support', path: '/support', heading: /support/i },
  { name: 'about', path: '/about', heading: /About|Burgonomics/i },
  { name: 'privacy', path: '/privacy', heading: /Privacy/i },
  { name: 'terms', path: '/terms', heading: /Terms/i },
  { name: 'not-found', path: '/a-route-that-does-not-exist', heading: /404|buns/i },
];
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

async function isolatedContext(browser, extra = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', colorScheme: 'light',
    serviceWorkers: 'block', ...extra,
  });
  // Consent is isolated local QA state: record it before first paint so the
  // blocking banner does not distort every audited screen.
  await context.addInitScript(() => window.localStorage.setItem('burg.dpdp_consent_granted', 'true'));
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
    const firestoreRead = url.hostname === 'firestore.googleapis.com' && /Listen|RunQuery|BatchGetDocuments|runQuery|batchGet/.test(url.pathname);
    const auth = /^(identitytoolkit|securetoken)\.googleapis\.com$/.test(url.hostname);
    if (auth || (!local && !firestoreRead && !['GET', 'HEAD', 'OPTIONS'].includes(request.method()))) {
      report.blockedWrites.push({ host: url.hostname, method: request.method() });
      return route.abort();
    }
    return route.continue();
  });
  return context;
}

async function selectStore(page, store) {
  await page.goto(`${base}/stores`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // Accepting consent is isolated local QA state, not an account/provider operation.
  const consent = page.getByRole('button', { name: 'Accept & Continue', exact: true });
  if (await consent.isVisible().catch(() => false)) await consent.click({ force: true });
  // Use the application's own store action in isolated guest state, with the
  // public outlet's coordinates (never phone GPS or a guessed nearby store).
  await page.evaluate(async (name) => {
    const { storeRepository } = await import('/src/features/stores/repositories/StoreRepository.ts');
    const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
    const result = await storeRepository.list();
    if (!result.success) throw new Error('Public store directory read failed');
    const outlet = result.data.find(value => value.name === name);
    if (!outlet) throw new Error('Known public outlet is no longer listed');
    useStoreSelection.getState().setActiveStore(outlet);
    const active = useStoreSelection.getState().activeStore;
    if (!active || active.id !== outlet.id) throw new Error('Store selection was rejected by the app');
  }, store.name);
  await page.goto(`${base}/home`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('heading', { name: 'On the menu', exact: true }).waitFor({ state: 'visible', timeout: 90000 });
  // Audit the actual resulting Home state, including a missing rail, instead of
  // waiting forever or seeding a rail fixture.
  await page.getByRole('heading', { name: 'Best sellers', exact: true }).waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  report.homeData = await page.evaluate(async () => {
    const { useHomeStore } = await import('/src/features/home/state/homeStore.ts');
    const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
    const state = useHomeStore.getState();
    return {
      status: state.status, error: state.error,
      activeStoreId: useStoreSelection.getState().activeStore?.id,
      loadedStoreId: state.lastLoadedStoreId,
      counts: state.bundle ? { categories: state.bundle.categories.length, bestSellers: state.bundle.bestSellers.length, combos: state.bundle.popularCombos.length } : null,
    };
  });
  report.store = { name: store.name, locationFixture: 'Public outlet coordinates in isolated guest browser; not device GPS' };
}

(async () => {
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
    const context = await isolatedContext(browser, {
      permissions: ['geolocation'], geolocation: { latitude: store.lat, longitude: store.lng },
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') report.consoleErrors.push({ route: new URL(page.url()).pathname, text: message.text() });
    });
    await selectStore(page, store);

    for (const route of routes) {
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${base}${route.path}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        await page.evaluate(() => document.fonts.ready);
        const text = await page.locator('body').innerText().catch(() => '');
        const sample = await page.evaluate(({ route, width }) => {
          const visible = element => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 1 && rect.height > 1;
          };
          const controls = [...document.querySelectorAll('button,a[href],[role="button"],[role="radio"],[role="tab"],input,select,textarea')]
            // Inline links inside a sentence carry the WCAG 2.5.8 inline
            // exception, so they are not counted as undersized targets.
            .filter(element => !(element.tagName === 'A' && element.closest('p')))
            .filter(visible).map(element => {
              const rect = element.getBoundingClientRect();
              return {
                label: (element.getAttribute('aria-label') || element.textContent || element.getAttribute('placeholder') || element.tagName).trim().replace(/\s+/g, ' ').slice(0, 80),
                tag: element.tagName.toLowerCase(), width: Math.round(rect.width), height: Math.round(rect.height),
              };
            });
          const headings = [...document.querySelectorAll('h1,h2,h3')].filter(visible).map(element => ({ level: element.tagName, text: element.textContent.trim().slice(0, 100) }));
          const smallTargets = controls.filter(control => control.height < 44 || control.width < 44);
          const clippedText = [...document.querySelectorAll('h1,h2,h3,p,span,a,button')].filter(visible)
            .filter(element => element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).overflow !== 'visible')
            .map(element => element.textContent.trim().slice(0, 80)).slice(0, 8);
          return {
            route: route.name, path: location.pathname + location.search, width,
            title: document.title, mainCount: document.querySelectorAll('main').length,
            h1Count: document.querySelectorAll('h1').length,
            headings: headings.slice(0, 16),
            controlCount: controls.length, smallTargets: smallTargets.slice(0, 20), smallTargetCount: smallTargets.length,
            clippedText, overflow: document.documentElement.scrollWidth - innerWidth,
            horizontalOverflowElements: [...document.querySelectorAll('body *')].filter(visible)
              .filter(element => element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).overflowX === 'visible')
              .length,
            bodyLength: document.body.innerText.trim().length,
            scrollHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight,
          };
        }, { route, width });
        sample.matchedHeading = route.heading.test(text);
        // Guest-only screens legitimately redirect to sign-in; that is not a
        // broken route, so record it as an expected gate rather than a defect.
        sample.guestGate = sample.path.startsWith("/auth/login") && route.name !== "login";
        if (route.name === "login") sample.guestGate = false;
        if (route.name === 'home') {
          sample.homeSections = {
            bestSellers: await page.getByRole('heading', { name: 'Best sellers', exact: true }).count(),
            meals: await page.getByRole('heading', { name: 'Make it a meal', exact: true }).count(),
            onTheMenu: await page.getByRole('heading', { name: 'On the menu', exact: true }).count(),
          };
        }
        sample.blank = sample.bodyLength < 12;
        report.samples.push(sample);
        await page.screenshot({ path: path.join(__dirname, `route-${route.name}-${width}.png`), fullPage: false });
      }
    }

    // Keyboard and theme checks on the shared shell / Home.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/home`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.getByRole('heading', { name: 'On the menu', exact: true }).waitFor({ state: 'visible', timeout: 20000 }).catch(async () => {
      report.secondHomeState = {
        url: page.url(),
        bodyText: (await page.locator('body').innerText().catch(() => '')).slice(0, 1200),
        state: await page.evaluate(async () => {
          const { useHomeStore } = await import('/src/features/home/state/homeStore.ts');
          const { useStoreSelection } = await import('/src/features/stores/state/storeStore.ts');
          const home = useHomeStore.getState();
          const stores = useStoreSelection.getState();
          return {
            homeStatus: home.status, homeError: home.error, bundle: !!home.bundle,
            loadedStoreId: home.lastLoadedStoreId,
            activeStoreId: stores.activeStore?.id ?? null,
            hydrated: stores.isHydrated,
            storeCount: Array.isArray(stores.stores) ? stores.stores.length : null,
          };
        }).catch(error => ({ stateError: error.message })),
      };
    });
    await page.getByRole('heading', { name: 'Best sellers', exact: true }).waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    const keyboard = [];
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press('Tab');
      keyboard.push(await page.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return { tag: 'body' };
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          label: (element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
          visible: rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden',
          outline: style.outlineStyle, outlineWidth: style.outlineWidth,
          inViewport: rect.top >= 0 && rect.bottom <= innerHeight + 1,
        };
      }));
    }
    report.keyboard = keyboard;
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.waitForFunction(value => document.documentElement.classList.contains('dark') === (value === 'dark'), theme);
      await page.goto(`${base}/cart`, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(__dirname, `theme-cart-${theme}.png`) });
    }

    // Strict checks apply to genuinely blank/broken pages and horizontal page
    // overflow. Unsupported guest-only pages are reported for human triage
    // rather than silently labelled as passing.
    const broken = report.samples.filter(sample => (!sample.matchedHeading && !sample.guestGate) || sample.blank || sample.overflow > 0 || sample.mainCount > 1);
    report.brokenRoutes = broken.map(({ route, path: routePath, width, matchedHeading, blank, overflow, mainCount, bodyLength, guestGate }) => ({ route, path: routePath, width, matchedHeading, guestGate, blank, overflow, mainCount, bodyLength }));
    report.guestGateRoutes = [...new Set(report.samples.filter(sample => sample.guestGate).map(sample => sample.route))];
    report.summary = {
      samples: report.samples.length,
      broken: broken.length,
      smallTargetInstances: report.samples.reduce((sum, sample) => sum + sample.smallTargetCount, 0),
      horizontalOverflow: report.samples.reduce((sum, sample) => sum + sample.overflow, 0),
      clippedTextInstances: report.samples.reduce((sum, sample) => sum + sample.clippedText.length, 0),
      pageErrors: report.pageErrors.length,
      consoleErrors: report.consoleErrors.length,
      unknownFocus: keyboard.filter(item => item.tag !== 'body' && item.outline === 'none').length,
    };
    report.status = broken.length || report.pageErrors.length ? 'FAIL' : 'OBSERVED';
    if (report.status === 'FAIL') process.exitCode = 1;
    await context.close();
  } catch (error) {
    report.error = error.stack || error.message;
    process.exitCode = 1;
  } finally {
    await browser.close();
    await fs.writeFile(path.join(__dirname, 'route-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, summary: report.summary, brokenRoutes: report.brokenRoutes, error: report.error }, null, 2));
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
