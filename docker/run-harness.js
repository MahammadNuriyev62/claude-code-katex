// Level-2 torture-harness driver.
//
// Loads v2-spike/test.html (the real shipping bundle run through Claude Code's
// actual react-markdown -> remark-math -> rehype-katex plugin chain) in headless
// Chromium, waits for window.__DONE, and reports the per-case PASS/FAIL that the
// harness records on window.__RESULTS. Exits non-zero if any case fails, so it
// gates CI. No Claude Code and no auth are involved at this level.
const { chromium } = require('playwright');

const URL = process.env.HARNESS_URL || 'http://127.0.0.1:8088/v2-spike/test.html';
const DONE_TIMEOUT_MS = 60000;

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  let results = null;
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__DONE === true', { timeout: DONE_TIMEOUT_MS });
    results = await page.evaluate(() => window.__RESULTS);
  } catch (e) {
    console.error(`\n[L2] Harness did not complete: ${e.message}`);
    if (consoleErrors.length) console.error('[L2] page errors:\n  ' + consoleErrors.join('\n  '));
    await browser.close();
    process.exit(1);
  }
  await browser.close();

  if (!Array.isArray(results) || results.length === 0) {
    console.error('[L2] window.__RESULTS was empty — harness produced no cases.');
    process.exit(1);
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.ok ? '' : '  — ' + (r.detail || 'failed')}`);
  }
  console.log(`\n[L2] ${results.length - failed.length}/${results.length} cases passed`);

  if (failed.length) {
    if (consoleErrors.length) console.error('[L2] page errors:\n  ' + consoleErrors.join('\n  '));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
