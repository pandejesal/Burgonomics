// Visual check of inert actual-DOM exports, not a live provider/phone test.
const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` });
  const report = { status: 'FAIL', samples: [], pageErrors: [], liveRuntimeAcceptance: false, phoneAcceptance: false };
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    for (const theme of ['light', 'dark']) {
      await page.goto(`http://127.0.0.1:48244/home-${theme}.html`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        for (const [id, label] of [['best-heading', 'best-sellers'], ['combos-heading', 'meals']]) {
          const section = page.locator(`[aria-labelledby="${id}"]`);
          await section.evaluate(element => element.scrollIntoView({ block: 'center' }));
          const sample = await section.evaluate(element => ({
            heading: element.querySelector('h2').textContent,
            firstProduct: element.querySelector('h3').textContent,
            cards: element.querySelectorAll('h3').length,
            pricePresent: /₹[\d,]+/.test(element.innerText),
            sectionBottom: element.getBoundingClientRect().bottom,
            navTop: document.querySelector('nav[aria-label="Primary"]').getBoundingClientRect().top,
            overflow: document.documentElement.scrollWidth - innerWidth,
            activeScripts: document.querySelectorAll('script,iframe,object,embed').length,
          }));
          report.samples.push({ theme, width, ...sample });
          if (sample.sectionBottom > sample.navTop - 8 || sample.overflow !== 0 || !sample.pricePresent || sample.activeScripts !== 0) {
            throw new Error('Exported section is obscured, overflowing, missing a price or not inert');
          }
          await section.screenshot({ path: path.join(__dirname, `static-${label}-${theme}-${width}.png`) });
        }
      }
    }
    report.status = report.pageErrors.length === 0 ? 'PASS' : 'FAIL';
    await context.close();
  } catch (error) {
    report.error = error.message;
  } finally {
    await browser.close();
    await fs.writeFile(path.join(__dirname, 'inert-section-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
