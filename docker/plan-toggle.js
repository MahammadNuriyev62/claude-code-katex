const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE_URL = process.env.CODE_URL || 'http://127.0.0.1:8080/?folder=/workspace';
const EXT_ROOT = '/root/.local/share/code-server/extensions';
const SETTINGS = '/root/.local/share/code-server/User/settings.json';
const OUT_DIR = '/app/test-results';
const SETTING = 'claudeCodeKatex.renderPlanPreview';
const MARKER = '/* === KaTeX plan-preview patch === */';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findClaudeCodeHost() {
  const entry = fs.readdirSync(EXT_ROOT)
    .filter((name) => name.startsWith('anthropic.claude-code-'))
    .sort()
    .pop();
  return entry ? path.join(EXT_ROOT, entry, 'extension.js') : null;
}

function readSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}

function updateSetting(enabled) {
  const settings = readSettings();
  settings[SETTING] = enabled;
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
}

async function waitFor(check, description, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function runCommand(page, command) {
  await page.keyboard.press('Control+Shift+P');
  await sleep(400);
  await page.keyboard.type('>' + command, { delay: 5 });
  await sleep(500);
  await page.keyboard.press('Enter');
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const host = findClaudeCodeHost();
  if (!host) throw new Error('Claude Code host bundle not found.');

  const pristine = fs.readFileSync(host, 'utf8');
  const supportsPlanPatch =
    /function [A-Za-z_$][\w$]{0,40}\([A-Za-z_$][\w$]{0,40}\)\{let [A-Za-z_$][\w$]{0,40}=[A-Za-z_$][\w$]{0,40}\.parse\(/.test(pristine) &&
    pristine.includes('replaceAll("{{NONCE}}"');
  if (!supportsPlanPatch) {
    throw new Error('Pinned Claude Code host no longer has the supported plan-preview anchors.');
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
    .then((context) => context.newPage());

  const die = async (message) => {
    console.error(`\n[plan-toggle] ${message}`);
    try { await page.screenshot({ path: `${OUT_DIR}/plan-toggle-fail.png`, fullPage: true }); } catch (_) {}
    await browser.close();
    process.exit(1);
  };

  console.log('[plan-toggle] opening code-server:', CODE_URL);
  await page.goto(CODE_URL, { waitUntil: 'domcontentloaded' });
  await sleep(9000);

  const backup = host + '.katex-bak';
  if (readSettings()[SETTING] !== false) await die(`expected ${SETTING}=false at startup.`);
  if (fs.readFileSync(host, 'utf8').includes(MARKER)) await die('plan patch applied while disabled.');
  if (fs.existsSync(backup)) await die('plan backup created while disabled.');
  console.log('[plan-toggle] default-off activation left the host untouched');

  updateSetting(true);
  await runCommand(page, 'Developer: Reload Window');
  await sleep(9000);
  await waitFor(() => fs.readFileSync(host, 'utf8').includes(MARKER), 'plan patch application');
  if (!fs.existsSync(backup)) await die('enabling did not create a host backup.');
  if (fs.readFileSync(backup, 'utf8') !== pristine) await die('host backup is not byte-identical to the original.');
  try {
    new vm.Script(fs.readFileSync(host, 'utf8'));
  } catch (error) {
    await die(`patched host does not compile: ${error.message}`);
  }
  console.log('[plan-toggle] enabled setting applied a parseable host patch after reload');

  updateSetting(false);
  await runCommand(page, 'Developer: Reload Window');
  await sleep(9000);
  await waitFor(() => !fs.readFileSync(host, 'utf8').includes(MARKER), 'plan patch restoration');
  if (fs.readFileSync(host, 'utf8') !== pristine) await die('disabling did not restore the host byte-for-byte.');

  await page.screenshot({ path: `${OUT_DIR}/plan-toggle.png`, fullPage: true });
  console.log('[plan-toggle] ✅ setting toggled false -> true -> false across real window reloads and host restored');
  await browser.close();
})().catch((error) => {
  console.error('[plan-toggle]', error);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  process.exit(1);
});
