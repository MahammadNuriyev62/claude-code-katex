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

// Covers general rendering AND the regressions we care about: issue #8
// (display math with \tag, which errors unless rendered in display mode),
// PR #9 (digit-leading inline math like $10^{-4}$ vs currency $5), and
// issue #14 (\label{...} in display math, which KaTeX would render as a red
// error — the zero-katex-error gate below covers it). Override with
// E2E_PROMPT to probe something specific.
// The macro line uses \vv, \RR and \myspan, which exist ONLY in the macro file
// entrypoint.sh writes before launch (issue #15). If macros did not reach the
// webview, KaTeX renders them as red text — which is why redErrors below is
// gated, not just .katex-error: an undefined macro produces no .katex-error at
// all, so the original gate would have passed with every macro broken.
const PROMPT = process.env.E2E_PROMPT ||
  ('Reply with EXACTLY the following lines and nothing else. Do not use code blocks. ' +
   'Do not edit any files, just reply in chat. Keep each display equation on its own line:\n\n' +
   'Inline: $E = mc^2$, digit-leading $10^{-4}$ and $3t^2 - 2t^3$, and $5 stays money.\n\n' +
   '$$A = \\sum_{k=1}^n \\lambda_k \\cdot v_k \\overline{v_k\'} \\tag{4} \\label{eq:spectral}$$\n\n' +
   '$$\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}$$\n\n' +
   '$$\\vv{x} \\in \\RR^n \\quad \\myspan(v_1, v_2)$$\n\n' +
   'By $\\eqref{eq:spectral}$ and \\eqref{eq:spectral}, done.');

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
      // An undefined control sequence is NOT a .katex-error — KaTeX renders it
      // as red text. Without this, a reply full of broken macros would score
      // zero errors and pass.
      redErrors: root.querySelectorAll('[mathcolor="#cc0000"]').length,
      // Evidence the macro file took effect: \vv expands to \mathbf and \RR to
      // \mathbb, neither of which appears anywhere else in the prompt.
      mathbf: root.querySelectorAll('.mathbf').length,
      mathbb: root.querySelectorAll('.mathbb').length,
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
  if (snap.redErrors > 0) await die(`${snap.redErrors} red error(s) — an undefined command reached the render (a macro did not load?).`);
  if (snap.katex === 0) await die('No .katex elements rendered — math left unrendered (patch not applied or no reply).');

  console.log(`\n[L3] ✅ ${snap.katex} .katex (${snap.display} display), 0 errors — render PASS`);

  // Issue #15 live: the macros exist only in the file entrypoint.sh wrote, so
  // \mathbf / \mathbb in the output can only come from them having loaded.
  if (snap.mathbf === 0) await die('\\vv{x} did not expand to \\mathbf — the user macro file did not reach the live webview.');
  if (snap.mathbb === 0) await die('\\RR did not expand to \\mathbb — the user macro file did not reach the live webview.');
  console.log(`[L3] ✅ user macros rendered live (${snap.mathbf} mathbf, ${snap.mathbb} mathbb) — macro PASS`);

  // Issue #14 live: \label must produce its anchor, and BOTH \eqref forms —
  // inside math and bare in prose — must resolve to the \tag number "(4)".
  // (innerText can't be matched as one sentence: KaTeX's hidden MathML
  // annotation duplicates each formula's text right next to its rendering.)
  const xref = await cc.evaluate(() => ({
    anchor: !!document.getElementById('eq:spectral'),
    prose: (document.getElementById('root').innerText || '').includes('and (4), done.'),
    mathRef: [...document.querySelectorAll('#root .katex .katex-html')]
      .some((e) => e.textContent.trim() === '(4)'),
  }));
  if (!xref.anchor) await die('\\label{eq:spectral} did not produce its anchor (id missing).');
  if (!xref.prose) await die('bare prose \\eqref{eq:spectral} did not resolve to "(4)".');
  if (!xref.mathRef) await die('$\\eqref{eq:spectral}$ did not render as the math formula "(4)".');
  console.log('[L3] ✅ \\label anchor present, \\eqref resolved to "(4)" in prose and math — xref PASS');

  // copy-tex in the LIVE webview: select the first rendered display formula,
  // press a real Ctrl+C, and assert the copy event's payload is the $$-wrapped
  // LaTeX source (not the rendered spans' text). The capture listener runs
  // after copy-tex's (which the patch prepended to the webview bundle at load).
  // The whole user gesture, end to end: a real mouse drag from the inline
  // formula down past the first display formula, then a real Ctrl+C. If any
  // user-select CSS blocked selection, the drag would select nothing and this
  // fails — no CSS heuristics needed. The capture listener runs after
  // copy-tex's (which the patch prepended to the webview bundle at load).
  console.log('[L3] copy-tex: drag-selecting across inline + display math, pressing Ctrl+C');
  const inlineBox = await cc.locator('.katex').first().boundingBox();
  const dispBox = await cc.locator('.katex-display').first().boundingBox();
  if (!inlineBox || !dispBox) await die('could not measure rendered math for the drag.');
  await cc.evaluate(() => {
    window.getSelection().removeAllRanges();
    document.addEventListener('copy', (e) => {
      window.__E2E_COPY = { text: e.clipboardData.getData('text/plain'), trusted: e.isTrusted };
    }, { once: true });
  });
  await page.mouse.move(inlineBox.x + 2, inlineBox.y + inlineBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dispBox.x + dispBox.width / 2, dispBox.y + dispBox.height + 8, { steps: 12 });
  await page.mouse.up();
  const selInfo = await cc.evaluate(() => {
    const t = String(window.getSelection() || '');
    const us = (q) => { const el = document.querySelector(q); return el ? getComputedStyle(el).userSelect : 'n/a'; };
    return { len: t.length, katexUserSelect: us('.katex-display') };
  });
  console.log('[L3] drag selection:', JSON.stringify(selInfo));
  if (selInfo.len === 0) {
    await die(`mouse drag selected nothing (user-select on .katex-display: ${selInfo.katexUserSelect}) — users cannot select math.`);
  }
  await page.keyboard.press('Control+C');
  let copy = null;
  try {
    await cc.waitForFunction('!!window.__E2E_COPY', { timeout: 5000 });
    copy = await cc.evaluate(() => window.__E2E_COPY);
  } catch (_) {
    await die('no copy event reached the webview within 5s of Ctrl+C — copy-tex could not be exercised.');
  }
  console.log('[L3] copy payload:', JSON.stringify(copy));
  const copied = copy.text || '';
  if (!copy.trusted) await die('copy event fired but was not trusted — Ctrl+C did not reach the webview.');
  // Inline math caught by the drag must come out $-wrapped; the display
  // formula (its .katex-display wrapper is inside the dragged range) $$-wrapped.
  if (!copied.includes('$E = mc^2$')) {
    await die(`inline math is not $-wrapped LaTeX in the copy: ${JSON.stringify(copied)}`);
  }
  if (!/\$\$[^$]*\\sum_\{k=1\}\^n[^$]*\$\$/.test(copied)) {
    await die(`display math is not $$-wrapped LaTeX in the copy: ${JSON.stringify(copied)}`);
  }

  // Copying macro-using math must yield the macro CALL, not its expansion —
  // \vv{x} is what pastes back into the .tex file where \vv is defined.
  const macroCopy = await cc.evaluate(() => {
    const ann = [...document.querySelectorAll('#root annotation[encoding="application/x-tex"]')]
      .map((a) => a.textContent);
    return {
      hasCall: ann.some((t) => t.includes('\\vv{x}') && t.includes('\\RR')),
      expanded: ann.some((t) => t.includes('\\mathbf{x}') && !t.includes('\\vv{x}')),
    };
  });
  if (!macroCopy.hasCall) await die('the copyable source of the macro formula does not contain \\vv{x} / \\RR.');
  if (macroCopy.expanded) await die('the copyable source was expanded to \\mathbf — the macro call was lost.');
  console.log('[L3] ✅ macro math copies back as its \\vv{x} / \\RR source, not the expansion');

  console.log(`\n[L3] ✅ copy-tex PASS — a real drag + Ctrl+C copied ${JSON.stringify(copied.slice(0, 80))}…`);
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('[L3]', e); process.exit(1); });
