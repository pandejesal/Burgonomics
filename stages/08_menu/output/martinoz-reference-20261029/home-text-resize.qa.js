async (page) => {
  // Local public-catalogue QA only. Never sign in, submit checkout or send OTP.
  const browser = page.context().browser();
  let target = browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("http://127.0.0.1:48176"));
  if (!target) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, reducedMotion: "reduce",
      colorScheme: "light", serviceWorkers: "block",
    });
    await context.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      const readTransport = url.hostname === "firestore.googleapis.com" &&
        /(?:Listen|RunQuery|BatchGetDocuments|runQuery|batchGet)/.test(url.pathname);
      const auth = /^(identitytoolkit|securetoken)\.googleapis\.com$/.test(url.hostname);
      if (auth || (!local && !readTransport && !["GET", "HEAD", "OPTIONS"].includes(request.method()))) {
        return route.abort();
      }
      return route.continue();
    });
    target = await context.newPage();
  }
  const errors = [];
  target.on("pageerror", (error) => errors.push(error.message));
  await target.setViewportSize({ width: 390, height: 844 });
  await target.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await target.goto("http://127.0.0.1:48176/home", { waitUntil: "domcontentloaded" });
  const consent = target.getByRole("button", { name: "Accept & Continue" });
  if (await consent.isVisible()) await consent.click();
  // A fresh isolated context has no selected outlet; choose the real public row.
  const store = target.getByRole("button", { name: /Burgonomics Gota/ }).first();
  const burger = target.getByRole("button", { name: "Burgers", exact: true });
  await Promise.race([
    store.waitFor({ state: "visible", timeout: 90000 }).catch(() => {}),
    burger.waitFor({ state: "visible", timeout: 90000 }).catch(() => {}),
  ]);
  if (await store.isVisible()) await store.click();
  await burger.waitFor({ state: "visible", timeout: 90000 });
  const privacy = target.getByRole("button", { name: "Dismiss privacy banner" });
  if (await privacy.isVisible()) await privacy.click();
  await target.evaluate(() => document.fonts.ready);
  const samples = [];
  for (const fontPercent of [100, 200]) {
    const style = fontPercent === 200
      ? await target.addStyleTag({ content: "html { font-size: 200% !important; }" })
      : null;
    try {
      for (const width of [390, 320]) {
        await target.setViewportSize({ width, height: width === 390 ? 844 : 780 });
        await burger.scrollIntoViewIfNeeded();
        samples.push(await target.evaluate(({ fontPercent }) => {
          const rect = (element) => {
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
          };
          const contains = (outer, inner) => !!outer && !!inner &&
            inner.y >= outer.y - 0.5 && inner.bottom <= outer.bottom + 0.5 &&
            inner.x >= outer.x - 0.5 && inner.x + inner.width <= outer.x + outer.width + 0.5;
          return {
            fontPercent, viewport: [innerWidth, innerHeight],
            rootFont: getComputedStyle(document.documentElement).fontSize,
            overflow: document.documentElement.scrollWidth - innerWidth,
            navHeight: rect(document.querySelector('nav[aria-label="Primary"]'))?.height,
            navOffset: getComputedStyle(document.documentElement).getPropertyValue("--bottom-nav-offset").trim(),
            cards: ["Burgers", "Wraps", "Sides", "Shakes & Drinks"].map((label) => {
              const element = document.querySelector(`button[aria-label="${label}"]`);
              const card = rect(element);
              const heading = rect(element?.querySelector("h4"));
              const description = rect(element?.querySelector("span[id]"));
              return { label, card, heading, description,
                minHeight: element ? getComputedStyle(element).minHeight : null,
                labelContained: contains(card, heading),
                descriptionContained: !description || contains(card, description) };
            }),
          };
        }, { fontPercent }));
        await target.screenshot({
          path: `C:/Users/DELL/Desktop/Burgonomics/stages/08_menu/output/martinoz-reference-20261029/text-resize-r3-${fontPercent}-${width}.png`,
        });
      }
    } finally {
      if (style) await style.evaluate((element) => element.remove());
    }
  }
  await target.setViewportSize({ width: 390, height: 844 });
  const failures = samples.flatMap((sample) => sample.cards
    .filter((card) => !card.labelContained || !card.descriptionContained)
    .map((card) => `${sample.viewport[0]}px / ${sample.fontPercent}%: ${card.label} clipped`));
  if (samples.some((sample) => sample.overflow > 0)) failures.push("horizontal overflow");
  const result = { status: failures.length || errors.length ? "FAIL" : "PASS", samples, failures, pageErrors: errors };
  return result;
}
