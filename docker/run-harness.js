// Level-2 torture-harness driver.
//
// Loads each harness page (the real shipping bundle run through Claude Code's
// actual react-markdown -> remark-math -> rehype-katex plugin chain) in
// headless Chromium, waits for window.__DONE, and reports the per-case
// PASS/FAIL that the page records on window.__RESULTS. Exits non-zero if any
// case fails, so it gates CI. No Claude Code and no auth are involved here.
//
// Two pages are driven:
//   v2-spike/test.html        — the core math suite. Deliberately loads NO user
//                               macros, so it also proves the macro feature
//                               changes nothing for someone who configures none.
//   v2-spike/test-macros.html — the same bundle with a user macro payload set
//                               before load, the way the patch bakes it in.
//
// On top of the in-page cases it runs one trusted-path copy-tex check: a real
// keyboard Ctrl+C over selected rendered math (the in-page COPYTEX cases use a
// synthetic ClipboardEvent, which never hits the browser's native copy path).
// That check runs on whichever page renders the \oint_C case.
const { chromium } = require('playwright');

const DONE_TIMEOUT_MS = 60000;

// HARNESS_URLS (comma-separated) wins; HARNESS_URL keeps the old single-page
// contract working; otherwise both pages are driven off the default base.
const urls = (() => {
  if (process.env.HARNESS_URLS) return process.env.HARNESS_URLS.split(',').map((s) => s.trim()).filter(Boolean);
  const base = (process.env.HARNESS_URL || 'http://127.0.0.1:8088/v2-spike/test.html')
    .replace(/\/v2-spike\/[^/]*$/, '');
  return [`${base}/v2-spike/test.html`, `${base}/v2-spike/test-macros.html`];
})();

// Formulas the trusted-copy check looks for, in order. The first one present on
// the page is selected, copied with a real Ctrl+C, and the clipboard payload
// asserted to be its $$-wrapped LaTeX source. Both needles must appear only in
// DISPLAY math — inline math correctly copies as `$…$`, which would fail the
// `$$` assertion. `\RR^n` covers the macro page: copying macro-using math must
// yield the macro CALL, not its expansion.
const COPY_TARGETS = ['\\oint_C', '\\RR^n'];

// Selects one of those formulas, presses a real Ctrl+C, and reports what the
// copy-tex handler put on the clipboard. Returns null when this page renders
// none of them.
async function trustedCopyCheck(page) {
  const setup = await page.evaluate((needles) => {
    let found = null;
    const target = [...document.querySelectorAll('.case .render')].find((r) => {
      const a = r.querySelector('annotation[encoding="application/x-tex"]');
      if (!a) return false;
      found = needles.find((n) => a.textContent.includes(n)) || null;
      return found !== null;
    });
    if (!target) return 'absent';
    window.__COPY_NEEDLE = found;
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(target);
    sel.addRange(range);
    document.addEventListener('copy', (e) => {
      window.__COPY_TRUSTED = { text: e.clipboardData.getData('text/plain'), trusted: e.isTrusted };
    }, { once: true });
    return null;
  }, COPY_TARGETS);
  if (setup === 'absent') return null;

  const needle = await page.evaluate(() => window.__COPY_NEEDLE);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C');
  try {
    await page.waitForFunction('!!window.__COPY_TRUSTED', { timeout: 5000 });
    const c = await page.evaluate(() => window.__COPY_TRUSTED);
    const t = (c.text || '').trim();
    return {
      name: `TRUSTED — real Ctrl+C over selected display math copies $$-wrapped LaTeX (${needle})`,
      ok: c.trusted && t.startsWith('$$') && t.endsWith('$$') && t.includes(needle),
      detail: 'trusted=' + c.trusted + ' text=' + JSON.stringify(c.text),
    };
  } catch {
    return {
      name: 'TRUSTED — real Ctrl+C over selected display math copies $$-wrapped LaTeX',
      ok: false,
      detail: 'no copy event fired within 5s of Ctrl+C',
    };
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const all = [];
  for (const url of urls) {
    const pageName = url.split('/').pop();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    let results;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction('window.__DONE === true', { timeout: DONE_TIMEOUT_MS });
      results = await page.evaluate(() => window.__RESULTS);
      const trusted = await trustedCopyCheck(page);
      if (trusted) results.push(trusted);
    } catch (e) {
      console.error(`\n[L2] ${pageName} did not complete: ${e.message}`);
      if (consoleErrors.length) console.error('[L2] page errors:\n  ' + consoleErrors.join('\n  '));
      await browser.close();
      process.exit(1);
    }

    if (!Array.isArray(results) || results.length === 0) {
      console.error(`[L2] ${pageName}: window.__RESULTS was empty — the page produced no cases.`);
      await browser.close();
      process.exit(1);
    }

    console.log(`\n[L2] ${pageName}`);
    for (const r of results) {
      console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.ok ? '' : '  — ' + (r.detail || 'failed')}`);
    }
    if (results.some((r) => !r.ok) && consoleErrors.length) {
      console.error('[L2] page errors:\n  ' + consoleErrors.join('\n  '));
    }
    all.push(...results);
    await page.close();
  }

  await browser.close();

  const failed = all.filter((r) => !r.ok);
  console.log(`\n[L2] ${all.length - failed.length}/${all.length} cases passed across ${urls.length} page(s)`);
  if (failed.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
