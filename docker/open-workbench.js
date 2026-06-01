// Opens the code-server workbench once so the extension host starts and our
// extension's onStartupFinished activation fires (which patches Claude Code's
// webview on disk). Auth-independent: it just needs a browser to connect.
// The entrypoint then greps the patched bundle for the patch marker.
const { chromium } = require('playwright');

const CODE_URL = process.env.CODE_URL || 'http://127.0.0.1:8080/?folder=/workspace';
const WAIT_MS = Number(process.env.WORKBENCH_WAIT_MS || 20000);

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  try {
    await page.goto(CODE_URL, { waitUntil: 'domcontentloaded' });
    // Wait for the workbench shell, then give the extension host time to reach
    // onStartupFinished and run the patch.
    await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, WAIT_MS));
    console.log('[smoke] workbench loaded; extension host had time to activate');
  } catch (e) {
    console.error('[smoke] workbench did not load:', e.message);
    await browser.close();
    process.exit(1);
  }
  await browser.close();
})();
