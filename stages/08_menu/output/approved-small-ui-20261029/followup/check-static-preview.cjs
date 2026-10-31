const { chromium } = require(String.raw`C:\Users\DELL\AppData\Local\BurgonomicsDevTools\playwright-mcp-0.0.83\node_modules\playwright`);
const fs = require('node:fs/promises');
const path = require('node:path');
const output = path.resolve(__dirname, process.argv[2] || '.');
if (output !== __dirname && !output.startsWith(__dirname + path.sep)) throw new Error('Evidence must stay in the follow-up directory');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe` });
  const results = [];
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    for (const theme of ['light', 'dark']) {
      await page.goto(`http://127.0.0.1:48244/home-${theme}.html`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: path.join(output, `home-static-${theme}-top.png`) });
      await page.locator('#awards').screenshot({ path: path.join(output, `awards-static-${theme}.png`) });
      results.push(await page.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), bodyFont: getComputedStyle(document.body).fontFamily, overflow: document.documentElement.scrollWidth - innerWidth, activeScripts: document.scripts.length })));
    }
    const hidden = await context.request.get('http://127.0.0.1:48244/native-qa/installed-before.apk');
    const traversal = await context.request.get('http://127.0.0.1:48244/images/%2e%2e/native-qa/installed-before.apk');
    if (hidden.status() !== 404 || traversal.status() !== 404) throw new Error('Preview exposed non-preview evidence');
    await page.goto('http://127.0.0.1:48244/followup/index.html?theme=dark', { waitUntil: 'load' });
    if (!await page.locator('#home-frame').getAttribute('src').then(value => value.endsWith('home-dark.html'))) throw new Error('Gallery theme did not select dark Home');
    const report = { status: results.some((r, i) => r.dark !== (i === 1) || r.overflow > 0 || r.activeScripts !== 0 || !r.bodyFont.startsWith('Montserrat')) ? 'FAIL' : 'PASS', results, gallery: 'http://127.0.0.1:48244/followup/index.html', privateEvidenceBlocked: true };
    await fs.writeFile(path.join(output, 'static-preview-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
