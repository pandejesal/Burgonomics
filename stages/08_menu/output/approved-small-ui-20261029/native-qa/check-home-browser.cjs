// Bounded pre-native regression, not physical-phone or integration acceptance.
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const fs = require("node:fs/promises");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe` });
  try {
    const context = await browser.newContext({ viewport: { width: 360, height: 780 }, reducedMotion: "reduce", colorScheme: "light", serviceWorkers: "block" });
    await context.route("**/*", route => {
      const q = route.request(), u = new URL(q.url());
      const local = ["127.0.0.1", "localhost"].includes(u.hostname);
      const read = u.hostname === "firestore.googleapis.com" && /Listen|RunQuery|BatchGetDocuments|runQuery|batchGet/.test(u.pathname);
      if (/^(identitytoolkit|securetoken)\.googleapis\.com$/.test(u.hostname) || (!local && !read && !["GET", "HEAD", "OPTIONS"].includes(q.method()))) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("http://127.0.0.1:48176/stores", { waitUntil: "domcontentloaded", timeout: 90000 });
    const consent = page.getByRole("button", { name: "Accept & Continue" });
    const store = page.getByRole("button", { name: /Burgonomics Gota/ }).first();
    await store.waitFor({ state: "visible", timeout: 90000 });
    if (await consent.isVisible()) await consent.click();
    await store.click();
    await page.getByRole("button", { name: "Burgers", exact: true }).waitFor({ state: "visible", timeout: 90000 });
    const dismiss = page.getByRole("button", { name: "Dismiss privacy banner" });
    if (await dismiss.isVisible()) await dismiss.click();
    await page.evaluate(async () => {
      const { useCartStore } = await import("/src/features/cart/state/cartStore.ts");
      const { useStoreSelection } = await import("/src/features/stores/state/storeStore.ts");
      const storeId = useStoreSelection.getState().activeStore.id;
      useCartStore.getState().addLine({ lineId: "qa-existing", productId: "qa-product", storeId, name: "Sample saved basket", unitPrice: 109, quantity: 1, modifiers: [], veg: true, availability: "available" });
    });
    await page.evaluate(() => document.fonts.ready);
    const samples = [];
    for (const width of [360, 320]) {
      await page.setViewportSize({ width, height: 780 });
      for (const mode of ["Dine-in", "Delivery"]) {
        await page.getByRole("radio", { name: mode, exact: true }).click();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const sample = await page.evaluate(({ mode }) => {
          const carousel = document.querySelector('[aria-roledescription="carousel"]');
          const scroller = carousel.querySelector("div");
          const first = carousel.querySelector('[aria-roledescription="slide"]');
          const text = first.querySelector("h3").getBoundingClientRect();
          const nav = document.querySelector('nav[aria-label="Primary"]').getBoundingClientRect();
          const cards = [...document.querySelectorAll('button[aria-label="Burgers"],button[aria-label="Sides"],button[aria-label="Shakes & Drinks"]')].map(e => ({ name: e.getAttribute("aria-label"), top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height }));
          const basket = document.querySelector('aside[aria-label^="Floating cart summary"]');
          return { mode, width: innerWidth, scrollLeft: scroller.scrollLeft, firstHeadline: first.querySelector("h3").textContent, headlineLeft: text.left, cards, navTop: nav.top, wrapsVisible: !!document.querySelector('button[aria-label="Wraps"]'), basketPosition: basket ? getComputedStyle(basket).position : null, overflow: document.documentElement.scrollWidth - innerWidth };
        }, { mode });
        samples.push(sample);
        await page.screenshot({ path: path.join(__dirname, `browser-${mode.toLowerCase()}-${width}.png`) });
      }
    }
    const fonts = await page.evaluate(() => {
      const style = selector => {
        const value = getComputedStyle(document.querySelector(selector));
        return { family: value.fontFamily, weight: value.fontWeight };
      };
      return {
        brand: style('[aria-label="Burgonomics Home"] > span'),
        heading: style('#cats-heading'),
        subhead: style('#upcoming-stores h3'),
        content: style('#upcoming-stores p'),
        displayLoaded: document.fonts.check('18px MonstroSolid'),
        regularLoaded: document.fonts.check('400 16px Montserrat'),
        boldLoaded: document.fonts.check('700 16px Montserrat'),
      };
    });
    const branchSamples = [];
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme });
        await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, theme === 'dark');
        await page.locator('#upcoming-stores').scrollIntoViewIfNeeded();
        await page.getByRole('button', { name: 'Next branch', exact: true }).click();
        const details = await page.evaluate(() => {
          const section = document.querySelector('#upcoming-stores');
          const rail = section.querySelector('ul');
          const cards = [...rail.children];
          const first = cards[0].getBoundingClientRect(), second = cards[1].getBoundingClientRect();
          return { width: innerWidth, dark: document.documentElement.classList.contains('dark'), count: cards.length, horizontal: second.left > first.left && second.top === first.top, slideWidth: first.width, railWidth: rail.clientWidth, textFits: cards.every(e => e.scrollWidth <= e.clientWidth), hasOrderActions: !!section.querySelector('a,input,form'), targets: [...section.querySelectorAll('button')].map(e => ({ width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height })), overflow: document.documentElement.scrollWidth - innerWidth };
        });
        branchSamples.push(details);
        await page.locator('#upcoming-stores').screenshot({ path: path.join(__dirname, `branches-${theme}-${width}.png`) });
      }
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Resume branch rotation', exact: true }).click();
    await page.mouse.move(0, 0);
    const beforeRotation = await page.locator('#upcoming-stores li[data-active="true"]').textContent();
    await page.waitForFunction(before => document.querySelector('#upcoming-stores li[data-active="true"]').textContent !== before, beforeRotation, { timeout: 10000 });
    const rotationObserved = beforeRotation !== await page.locator('#upcoming-stores li[data-active="true"]').textContent();
    await page.getByRole('button', { name: 'Pause branch rotation', exact: true }).click();
    const failures = samples.flatMap(s => [s.scrollLeft !== 0 && "first-slide offset", s.headlineLeft < 16 && "headline clipped", s.wrapsVisible && "empty Wraps visible", s.cards.some(c => c.bottom > s.navTop - 8) && "grid overlaps nav", s.basketPosition === "fixed" && "basket covers Home", s.overflow > 0 && "overflow"].filter(Boolean).map(f => `${s.mode}/${s.width}: ${f}`));
    if (!fonts.brand.family.startsWith('MonstroSolid') || !fonts.heading.family.startsWith('MonstroSolid') || !fonts.subhead.family.startsWith('Montserrat') || fonts.subhead.weight !== '700' || fonts.content.weight !== '400' || !fonts.regularLoaded || !fonts.boldLoaded || !fonts.displayLoaded) failures.push('font roles/load');
    if (branchSamples.some(s => s.count !== 8 || !s.horizontal || !s.textFits || s.hasOrderActions || s.overflow > 0 || s.targets.some(t => t.width < 44 || t.height < 44))) failures.push('branch strip geometry/actions');
    if (!rotationObserved) failures.push('branch rotation not observed');
    const result = { status: failures.length || errors.length ? "FAIL" : "PASS", samples, fonts, branchSamples, rotationObserved, failures, errors, physicalDeviceAcceptance: false };
    await fs.writeFile(path.join(__dirname, "browser-home-fonts-branches-results.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "PASS") process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
