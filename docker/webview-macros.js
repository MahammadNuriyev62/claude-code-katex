// Auth-free in-webview macro probe.
//
// Sits between the smoke level (which only greps the patched file on disk) and
// Level 3 (which needs Claude auth): it attaches to the REAL Claude Code
// webview running in code-server and asks the page itself what happened.
//
// That answers the question neither of the others does — did the payload the
// extension wrote actually parse as JavaScript, and did KaTeX ingest it, in
// the real webview rather than in a test page? Then it renders with the
// resolved macros through the webview's own KaTeX, so the assertion is about
// output, not about a marker being present.
//
// No Claude auth is needed: Claude Code's webview bundle — and therefore our
// prepended payload and ingestion — loads regardless of whether anyone is
// signed in. Only the chat itself needs a session.
//
// Version-sensitive like e2e.js: it depends on the command that focuses the
// Claude Code view, because the webview frame only attaches once it is open.
// The frame is then found by shape (the frame whose window carries our own
// globals), never by URL.
const { chromium } = require('playwright');
const fs = require('fs');

const CODE_URL = process.env.CODE_URL || 'http://127.0.0.1:8080/?folder=/workspace';
const OPEN_CMD = process.env.CLAUDE_OPEN_CMD || 'Claude Code: Focus on Claude Code View';
const OUT_DIR = '/app/test-results';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCommand(page, cmd) {
  await page.keyboard.press('Control+Shift+P');
  await sleep(500);
  await page.keyboard.type('>' + cmd, { delay: 10 });
  await sleep(800);
  await page.keyboard.press('Enter');
}

// The webview frame identified by our own globals rather than by URL or by any
// Claude Code selector — whatever else changes, the frame we care about is the
// one that loaded our patch.
async function findPatchedFrame(page, attempts = 45) {
  for (let i = 0; i < attempts; i++) {
    for (const f of page.frames()) {
      try {
        if (await f.evaluate(() => window.__KATEX_V2_LOADED === true)) return f;
      } catch (_) { /* frame detached or not ready */ }
    }
    await sleep(1000);
  }
  return null;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage());

  const die = async (msg) => {
    console.error(`\n[macros] ${msg}`);
    try { await page.screenshot({ path: `${OUT_DIR}/webview-macros-fail.png`, fullPage: true }); } catch (_) {}
    await browser.close();
    process.exit(1);
  };

  console.log('[macros] opening code-server:', CODE_URL);
  await page.goto(CODE_URL, { waitUntil: 'domcontentloaded' });
  await sleep(9000); // workbench + extension host startup (the extension self-patches here)

  console.log('[macros] focusing Claude Code view:', OPEN_CMD);
  await runCommand(page, OPEN_CMD);
  await sleep(7000);

  const frame = await findPatchedFrame(page);
  if (!frame) await die('No webview frame carries __KATEX_V2_LOADED — the patched bundle never loaded.');
  console.log('[macros] found the patched webview frame');

  // 1. Did ingestion run in there, and what did it produce?
  const report = await frame.evaluate(() => {
    const r = window.__KATEX_MACRO_REPORT;
    if (!r) return null;
    return { loaded: r.loaded, skipped: r.skipped, truncated: r.truncated, names: Object.keys(r.macros || {}) };
  });
  if (!report) await die('__KATEX_MACRO_REPORT is absent — the macro payload never reached ingestion.');
  console.log('[macros] report:', JSON.stringify(report));

  for (const expected of ['\\RR', '\\vv', '\\myspan']) {
    if (!report.names.includes(expected)) {
      await die(`${expected} missing from the resolved macros (got ${JSON.stringify(report.names)}).`);
    }
  }
  console.log('[macros] ✅ ingestion ran inside the real webview:', report.loaded, 'macros loaded');

  // 2. Do those macros actually render, using the webview's own KaTeX?
  //    An undefined macro renders as red text (mathcolor #cc0000) rather than a
  //    .katex-error element, so the red count is the assertion that matters.
  const render = await frame.evaluate(() => {
    const macros = { ...(window.__KATEX_MACRO_REPORT.macros || {}) };
    const html = window.katex.renderToString('\\vv{x} \\in \\RR^n \\quad \\myspan(v_1, v_2)', {
      macros,
      throwOnError: false,
      displayMode: true,
    });
    return {
      mathbf: html.includes('mathbf'),
      mathbb: html.includes('mathbb'),
      span: html.includes('span<') || html.includes('>span'),
      red: (html.match(/cc0000/g) || []).length,
    };
  });
  console.log('[macros] render:', JSON.stringify(render));

  if (render.red > 0) await die(`${render.red} red error(s) — the macros did not resolve when rendering.`);
  if (!render.mathbf) await die('\\vv{x} did not expand to \\mathbf — the file macro is not in effect.');
  if (!render.mathbb) await die('\\RR did not expand to \\mathbb — the file macro is not in effect.');

  await page.screenshot({ path: `${OUT_DIR}/webview-macros.png`, fullPage: true });
  console.log('\n[macros] ✅ user macros resolve and render inside the real Claude Code webview (no auth used)');
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('[macros]', e); process.exit(1); });
