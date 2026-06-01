// Level-3 end-to-end driver.
//
// Drives a real code-server running the real Claude Code extension — patched by
// the real extension-under-test (installed as a .vsix; it self-patches on
// activation) — and asserts that math actually renders as KaTeX in Claude Code's
// webview, with no .katex-error.
//
// The prompt asks Claude to echo a FIXED block of LaTeX verbatim, so the test
// exercises the renderer (the thing we patch), not the model's creativity. It
// still needs Claude auth (CLAUDE_CODE_OAUTH_TOKEN or a mounted ~/.claude) and
// network egress to Anthropic — that's what makes it L3.
//
// Selectors target Claude Code 2.1.x: the chat composer is a contenteditable
// div[aria-label="Message input"] inside a webview frame that only attaches once
// the view is focused; messages carry no data-testid, so we count .katex in the
// frame's #root directly.
const { chromium } = require('playwright');
const fs = require('fs');

const CODE_URL = process.env.CODE_URL || 'http://127.0.0.1:8080/?folder=/workspace';
const OPEN_CMD = process.env.CLAUDE_OPEN_CMD || 'Claude Code: Focus on Claude Code View';
const OUT_DIR = '/app/test-results';

// Covers general rendering AND the two regressions we care about: issue #8
// (display math with \tag, which errors unless rendered in display mode) and
// PR #9 (digit-leading inline math like $10^{-4}$ vs currency $5). Override with
// E2E_PROMPT to probe something specific.
const PROMPT = process.env.E2E_PROMPT ||
  ('Reply with EXACTLY the following lines and nothing else. Do not use code blocks. ' +
   'Do not edit any files, just reply in chat. Keep each display equation on its own line:\n\n' +
   'Inline: $E = mc^2$, digit-leading $10^{-4}$ and $3t^2 - 2t^3$, and $5 stays money.\n\n' +
   '$$A = \\sum_{k=1}^n \\lambda_k \\cdot v_k \\overline{v_k\'} \\tag{★}$$\n\n' +
   '$$\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}$$');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCommand(page, cmd) {
  await page.keyboard.press('Control+Shift+P');
  await sleep(500);
  await page.keyboard.type('>' + cmd, { delay: 10 });
  await sleep(800);
  await page.keyboard.press('Enter');
}

// The chat webview is a nested iframe with no stable URL. Match it by the
// composer's aria-label (which also disambiguates it from the "sessions" sidebar
// webview, another #root frame). The frame only attaches after the view is
// focused, so this retries.
async function findChatFrame(page, attempts = 45) {
  for (let i = 0; i < attempts; i++) {
    for (const f of page.frames()) {
      try {
        if ((await f.locator('[aria-label="Message input"]').count()) > 0) return f;
      } catch (_) { /* frame detached mid-iteration */ }
    }
    await sleep(1000);
  }
  return null;
}

function readRoot(frame) {
  return frame.evaluate(() => {
    const root = document.getElementById('root');
    if (!root) return null;
    return {
      len: (root.innerText || '').length,
      katex: root.querySelectorAll('.katex').length,
      display: root.querySelectorAll('.katex-display').length,
      errors: root.querySelectorAll('.katex-error').length,
      rawDollars: ((root.innerText || '').match(/\$/g) || []).length,
    };
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } }).then((c) => c.newPage());

  const markers = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('KaTeX') || t.includes('__KATEX')) markers.push(t); });

  const die = async (msg, code = 1) => {
    console.error(`\n[L3] ${msg}`);
    try { await page.screenshot({ path: `${OUT_DIR}/e2e-fail.png`, fullPage: true }); } catch (_) {}
    try { console.error('[L3] code-server log tail:\n' + fs.readFileSync('/tmp/code-server.log', 'utf8').split('\n').slice(-20).join('\n')); } catch (_) {}
    await browser.close();
    process.exit(code);
  };

  console.log('[L3] opening code-server:', CODE_URL);
  await page.goto(CODE_URL, { waitUntil: 'domcontentloaded' });
  await sleep(9000); // workbench + extension host startup (extension self-patches here)

  // Focus the Claude Code view so its chat webview frame attaches. (Do NOT click
  // the activity-bar item first — if the panel is already open that toggles it
  // shut and the composer frame never attaches.)
  console.log('[L3] focusing Claude Code view:', OPEN_CMD);
  await runCommand(page, OPEN_CMD);
  await sleep(7000);

  if (markers.length) console.log('[L3] KaTeX markers:', markers);

  const cc = await findChatFrame(page);
  if (!cc) await die('Claude Code chat webview not found (is the extension installed and signed in?).');

  console.log('[L3] sending fixed-LaTeX prompt');
  const input = cc.locator('[aria-label="Message input"]').first();
  await input.click();
  await sleep(300);
  await page.keyboard.insertText(PROMPT);
  await sleep(400);
  // Submit: prefer the send button (Enter may insert a newline in a multiline box).
  const sendBtn = cc.locator('[class*="sendButton"]').first();
  if (await sendBtn.count()) {
    await sendBtn.click({ force: true });
  } else {
    await page.keyboard.press('Enter');
  }

  // Wait for the reply to arrive and stop growing. No testids in 2.1.x, so watch
  // the whole chat #root: length stable for 5s past a real reply, with .katex.
  let lastLen = -1, stable = 0, snap = null;
  for (let i = 0; i < 100; i++) {
    await sleep(1000);
    snap = await readRoot(cc);
    if (snap && snap.len > 40 && snap.len === lastLen) {
      if (++stable >= 5) break;
    } else if (snap) {
      if (snap.len !== lastLen) { lastLen = snap.len; stable = 0; }
    }
    if (i % 5 === 0) console.log(`[L3] [${i}s]`, JSON.stringify(snap));
  }

  await page.screenshot({ path: `${OUT_DIR}/e2e-final.png`, fullPage: true });

  if (!snap) await die('Chat #root never appeared.', 2);
  console.log('\n[L3] FINAL:', JSON.stringify(snap));

  if (snap.errors > 0) await die(`${snap.errors} .katex-error element(s) — KaTeX failed to parse some math.`);
  if (snap.katex === 0) await die('No .katex elements rendered — math left unrendered (patch not applied or no reply).');

  console.log(`\n[L3] ✅ ${snap.katex} .katex (${snap.display} display), 0 errors — PASS`);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('[L3]', e); process.exit(1); });
