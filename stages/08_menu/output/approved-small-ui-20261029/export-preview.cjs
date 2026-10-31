// Render the real app source in an isolated browser; export inert HTML snapshots.
// Preview fixtures live here only, never in src or the production bundle.
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);

const output = __dirname;
const app = String.raw`C:\Users\DELL\Desktop\Burgonomics\.swarm-worktrees\delivery-launch-ui-20261028`;
const publicRoot = path.join(app, "public");
const base = "http://127.0.0.1:48176";
const report = { source: app, mode: "actual UI / read-only store Home and Menu / isolated sample Cart / inert HTML export", pageErrors: [], blockedWrites: [], samples: [] };

async function launch() {
  try { return await chromium.launch({ headless: true }); }
  catch (initial) {
    for (const exe of [String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`, String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`]) {
      try { await fs.access(exe); } catch { continue; }
      return chromium.launch({ headless: true, executablePath: exe });
    }
    throw initial;
  }
}

async function copyPublic(relative) {
  const clean = decodeURIComponent(relative.split("?")[0]).replace(/^\/+/, "");
  const source = path.resolve(publicRoot, clean);
  if (!source.startsWith(publicRoot + path.sep)) throw new Error("Asset path escaped public root");
  const destination = path.resolve(output, clean);
  if (!destination.startsWith(output + path.sep)) throw new Error("Asset path escaped preview root");
  await fs.access(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function snapshot(page, name, theme) {
  const content = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script,iframe,object,embed,vite-error-overlay").forEach(node => node.remove());
    clone.querySelectorAll("*").forEach(node => {
      for (const attribute of [...node.attributes]) {
        if (/^on/i.test(attribute.name) || ["href", "action", "formaction"].includes(attribute.name)) node.removeAttribute(attribute.name);
      }
    });
    const originals = [...document.querySelectorAll("textarea")];
    clone.querySelectorAll("textarea").forEach((node, i) => { node.textContent = originals[i].value; });
    const css = [...document.querySelectorAll("head style")].map(node => node.textContent).join("\n");
    return {
      body: clone.innerHTML, css,
      rootClass: document.documentElement.className,
      rootStyle: document.documentElement.getAttribute("style") || "",
      assets: [...document.querySelectorAll("img[src]")].map(node => node.getAttribute("src")).filter(src => src.startsWith("/")),
    };
  });
  for (const asset of new Set(content.assets)) await copyPublic(asset);
  const html = `<!doctype html><html lang="en" class="${content.rootClass}" style="${content.rootStyle}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; connect-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; form-action 'none'; base-uri 'none'"><title>${name} — static code preview</title><style>${content.css.replace(/<\/style/gi, "<\\/style")}</style></head><body><aside style="padding:10px 16px;background:#eaf1e8;color:#163e23;font:12px/1.5 Inter,sans-serif;text-align:center">STATIC CODE PREVIEW · actual store menu / sample Cart · no live actions</aside>${content.body}</body></html>`;
  await fs.writeFile(path.join(output, `${name}-${theme}.html`), html);
}

(async () => {
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", colorScheme: "light", serviceWorkers: "block" });
    await context.route("**/*", route => {
      const request = route.request();
      const url = new URL(request.url());
      const local = ["127.0.0.1", "localhost"].includes(url.hostname);
      const readTransport = url.hostname === "firestore.googleapis.com" && /(?:Listen|RunQuery|BatchGetDocuments|runQuery|batchGet)/.test(url.pathname);
      const auth = /^(?:identitytoolkit|securetoken)\.googleapis\.com$/.test(url.hostname);
      if (auth || (!local && !readTransport && !["GET", "HEAD", "OPTIONS"].includes(request.method()))) {
        report.blockedWrites.push({ host: url.hostname, method: request.method() });
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", error => report.pageErrors.push(error.message));
    await page.goto(`${base}/stores`, { waitUntil: "domcontentloaded" });
    // Isolated preview setup: a public outlet's position, never phone GPS. The
    // real directory read remains read-only; no far-store selection bypass.
    const outletPosition = await page.evaluate(async () => {
      const { storeRepository } = await import("/src/features/stores/repositories/StoreRepository.ts");
      const result = await storeRepository.list();
      const outlet = result.success && result.data.find(value => /Burgonomics Gota/i.test(value.name));
      if (!outlet) throw new Error("Known public preview outlet is unavailable");
      return { latitude: outlet.lat, longitude: outlet.lng };
    });
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation(outletPosition);
    await page.reload({ waitUntil: "domcontentloaded" });
    report.locationFixture = "Public outlet position in isolated browser; not device GPS";
    const store = page.getByRole("button", { name: /Burgonomics Gota/ }).first();
    await store.waitFor({ state: "visible", timeout: 90000 });
    const consent = page.getByRole("button", { name: "Accept & Continue" });
    if (await consent.isVisible()) await consent.click();
    await store.click();
    await page.getByRole("button", { name: "Burgers", exact: true }).waitFor({ state: "visible", timeout: 90000 });
    const dismiss = page.getByRole("button", { name: "Dismiss privacy banner" });
    if (await dismiss.isVisible()) await dismiss.click();

    // Home must populate from its real service; never seed rails to make them
    // appear in a preview when the installed application's data path is empty.
    await page.getByRole("heading", { name: "Best sellers", exact: true }).waitFor({ state: "visible", timeout: 90000 });
    await page.getByRole("heading", { name: "Make it a meal", exact: true }).waitFor({ state: "visible", timeout: 90000 });
    report.homeSelection = await page.evaluate(async () => {
      const { useHomeStore } = await import("/src/features/home/state/homeStore.ts");
      const state = useHomeStore.getState();
      return { storeId: state.lastLoadedStoreId, source: "actual Home service; no rail fixture",
        bestSellers: state.bundle.bestSellers.map(({ id, name, price }) => ({ id, name, price })),
        meals: state.bundle.popularCombos.map(({ id, productId, name, price }) => ({ id, productId, name, price })),
        rankingVerified: false };
    });
    await page.getByRole("heading", { name: "On the menu", exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.waitForFunction(value => document.documentElement.classList.contains("dark") === (value === "dark"), theme);
      await snapshot(page, "home", theme);
    }

    await page.goto(`${base}/menu?view=grid`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-menu-category] [data-testid="product-card-link"]').nth(3).waitFor({ state: "attached", timeout: 90000 });
    await page.locator('[data-category-id]').first().click();
    await page.evaluate(() => document.fonts.ready);
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.waitForFunction(value => document.documentElement.classList.contains("dark") === (value === "dark"), theme);
      await snapshot(page, "menu", theme);
    }

    await page.evaluate(async () => {
      const { useStoreSelection } = await import("/src/features/stores/state/storeStore.ts");
      const { useCartStore } = await import("/src/features/cart/state/cartStore.ts");
      const storeId = useStoreSelection.getState().activeStore.id;
      useStoreSelection.getState().setFulfillment("takeaway");
      for (const [id, name, price, imageUrl] of [
        ["preview-cheese", "Cheese Burst Burger", 199, "/images/menu/big-bang-burgers/cheese-burst-burger.jpg"],
        ["preview-super", "Super Hero Burger", 219, "/images/menu/big-bang-burgers/super-hero-burger.jpg"],
      ]) useCartStore.getState().addLine({ lineId: id, productId: id, storeId, name, unitPrice: price, quantity: 1, modifiers: [], veg: true, imageUrl, availability: "available" });
    });
    await page.goto(`${base}/cart`, { waitUntil: "domcontentloaded" });
    await page.getByRole("article", { name: "Cheese Burst Burger, quantity 1" }).waitFor({ state: "attached", timeout: 30000 });
    await page.getByRole("button", { name: "Add cooking instructions" }).click();
    await page.locator("#order-notes").fill("No onions, please.");
    await page.getByText("Recalculating…", { exact: true }).waitFor({ state: "hidden" });
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.waitForFunction(value => document.documentElement.classList.contains("dark") === (value === "dark"), theme);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        report.samples.push(await page.evaluate(() => {
          const nav = document.querySelector('nav[aria-label="Primary"]').getBoundingClientRect();
          const button = [...document.querySelectorAll("button")].find(node => /Proceed to Checkout|Kitchen Closed/.test(node.textContent));
          const footer = button.closest(".fixed").getBoundingClientRect();
          return { width: innerWidth, dark: document.documentElement.classList.contains("dark"), overflow: document.documentElement.scrollWidth - innerWidth, noteFields: document.querySelectorAll("textarea").length, footerGap: nav.top - footer.bottom };
        }));
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await snapshot(page, "cart", theme);
    }
    for (const filename of await fs.readdir(path.join(publicRoot, "fonts"))) await copyPublic(`fonts/${filename}`);
    await copyPublic("burgonomics-logo.png");
    report.status = report.pageErrors.length || report.samples.some(row => row.overflow > 0 || row.noteFields !== 1 || row.footerGap < 0) ? "FAIL" : "PASS";
    await fs.writeFile(path.join(output, "preview-render-results.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "PASS") process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
