// Inspect only inert, actual-DOM exports in an isolated browser. No app/provider
// actions, customer session, auth, GPS or basket mutation.
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe` });
  const report = { status: 'FAIL', samples: [], pageErrors: [], providerAcceptance: false, phoneAcceptance: false };
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    for (const theme of ['light', 'dark']) {
      await page.goto(`http://127.0.0.1:48244/home-${theme}.html`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const section = page.locator('#upcoming-stores');
      await section.scrollIntoViewIfNeeded();
      const branch = await section.evaluate(element => {
        const list = element.querySelector('ul');
        const copy = element.innerText;
        return {
          subtitleAbsent: !/Announced openings|not yet orderable/.test(copy),
          visibleControls: element.querySelectorAll('button').length,
          announcementCount: list.children.length,
          horizontallyScrollable: list.scrollWidth > list.clientWidth,
          trailingBorderPx: getComputedStyle(list.parentElement).borderBottomWidth,
          orderActions: element.querySelectorAll('a,form,input').length,
        };
      });
      await section.screenshot({ path: path.join(__dirname, `branches-${theme}.png`) });
      await page.goto(`http://127.0.0.1:48244/cart-${theme}.html`, { waitUntil: 'load' });
      const cart = await page.evaluate(() => ({
        lockPillAbsent: !/Prices locked for this order|Price lock expired/.test(document.body.innerText),
        notesEditors: document.querySelectorAll('textarea').length,
        overflow: document.documentElement.scrollWidth - innerWidth,
      }));
      await page.screenshot({ path: path.join(__dirname, `cart-${theme}.png`) });
      report.samples.push({ theme, branch, cart });
    }
    report.status = report.pageErrors.length === 0 && report.samples.every(({ branch, cart }) =>
      branch.subtitleAbsent && branch.visibleControls === 0 && branch.announcementCount === 8 &&
      branch.horizontallyScrollable && branch.trailingBorderPx === '0px' && branch.orderActions === 0 &&
      cart.lockPillAbsent && cart.notesEditors === 1 && cart.overflow === 0) ? 'PASS' : 'FAIL';
    await context.close();
  } finally {
    await browser.close();
    await fs.writeFile(path.join(__dirname, 'browser-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
