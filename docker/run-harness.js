// Level-2 torture-harness driver.
//
// Loads v2-spike/test.html (the real shipping bundle run through Claude Code's
// actual react-markdown -> remark-math -> rehype-katex plugin chain) in headless
// Chromium, waits for window.__DONE, and reports the per-case PASS/FAIL that the
// harness records on window.__RESULTS. Exits non-zero if any case fails, so it
// gates CI. No Claude Code and no auth are involved at this level.
//
// On top of the in-page cases it runs one trusted-path copy-tex check: a real
// keyboard Ctrl+C over selected rendered math (the in-page COPYTEX cases use a
// synthetic ClipboardEvent, which never hits the browser's native copy path).
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

    // Trusted-path copy-tex check: select a rendered display formula, press a
    // real Ctrl+C, and capture what the copy-tex handler put on the clipboard.
    // The capture listener is registered after copy-tex's (page scripts ran at
    // load), so it observes the rewritten DataTransfer of the native copy event.
    const setup = await page.evaluate(() => {
      const target = [...document.querySelectorAll('.case .render')].find((r) => {
        const a = r.querySelector('annotation[encoding="application/x-tex"]');
        return a && a.textContent.includes('\\oint_C');
      });
      if (!target) return 'no \\oint_C case rendered';
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(target);
      sel.addRange(range);
      document.addEventListener('copy', (e) => {
        window.__COPY_TRUSTED = { text: e.clipboardData.getData('text/plain'), trusted: e.isTrusted };
      }, { once: true });
      return null;
    });
    let ok = false, detail = setup || '';
    if (!setup) {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
      try {
        await page.waitForFunction('!!window.__COPY_TRUSTED', { timeout: 5000 });
        const c = await page.evaluate(() => window.__COPY_TRUSTED);
        const t = (c.text || '').trim();
        ok = c.trusted && t.startsWith('$$') && t.endsWith('$$') && t.includes('\\oint_C');
        detail = 'trusted=' + c.trusted + ' text=' + JSON.stringify(c.text);
      } catch {
        detail = 'no copy event fired within 5s of Ctrl+C';
      }
    }
    results.push({ name: 'TRUSTED — real Ctrl+C over selected display math copies $$-wrapped LaTeX', ok, detail });
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
