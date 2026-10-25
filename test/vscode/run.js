// Real desktop VS Code + official Claude extension + packaged candidate.
// Fixture data is passed to the original chat component inside the real
// webview; screenshots/reports explicitly distinguish it from a live reply.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');
const { chatProbe, PROBE_MARKER } = require('./chat-probe');
const { cases, interaction } = require('./cases');

const repo = path.resolve(__dirname, '../..');
const out = path.resolve(process.env.TEST_RESULTS_DIR || path.join(repo, 'test-results/vscode'));
const vsix = path.resolve(process.env.EXTENSION_VSIX_PATH || path.join(repo, `claude-code-katex-${require('../../package.json').version}.vsix`));
const pause = ms => new Promise(r => setTimeout(r, ms));
const metaKey = process.platform === 'darwin' ? 'Meta' : 'Control';
fs.mkdirSync(out, { recursive: true });

async function poll(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await pause(250);
  }
  throw new Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
}
async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${url}`);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}
async function upstream(temp) {
  const platform = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`;
  const version = process.env.CLAUDE_VERSION || 'latest';
  const response = await fetch(`https://open-vsx.org/api/anthropic/claude-code/${platform}/${version}`);
  if (!response.ok) throw new Error(`Upstream metadata HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.name !== 'claude-code' || metadata.namespace.toLowerCase() !== 'anthropic') throw new Error('Unexpected upstream identity');
  if (version !== 'latest' && metadata.version !== version) throw new Error('Upstream version mismatch');
  const file = path.join(temp, 'claude-code.vsix');
  await download(metadata.files.download, file);
  const checksumResponse = await fetch(metadata.files.sha256);
  if (!checksumResponse.ok) throw new Error('Upstream checksum unavailable');
  const expected = (await checksumResponse.text()).trim().split(/\s/)[0];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (expected !== actual) throw new Error('Upstream VSIX checksum mismatch');
  return { file, version: metadata.version, sha256: actual };
}

(async () => {
  if (!fs.existsSync(vsix)) throw new Error(`Package the candidate VSIX first: ${vsix}`);
  const temp = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'katex-vscode-'));
  const profile = path.join(temp, 'profile'), extensions = path.join(temp, 'extensions'), workspace = path.join(temp, 'workspace');
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false, 'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false, 'update.mode': 'none',
    'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
    'workbench.colorTheme': 'Default Dark Modern',
  }));
  const executable = process.env.VSCODE_EXECUTABLE || await downloadAndUnzipVSCode({ version: process.env.VSCODE_VERSION || 'stable', cachePath: path.join(os.tmpdir(), 'katex-vscode-download') });
  const [cli] = resolveCliArgsFromVSCodeExecutablePath(executable);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const cliArgs = ['--user-data-dir=' + profile, '--extensions-dir=' + extensions, '--no-sandbox'];
  const install = file => execFileSync(cli, [...cliArgs, '--install-extension', file, '--force'], { env, stdio: 'inherit', timeout: 120000 });
  if (process.env.CLAUDE_EXTENSION_PATH) {
    const source = path.resolve(process.env.CLAUDE_EXTENSION_PATH);
    fs.mkdirSync(extensions, { recursive: true });
    fs.cpSync(source, path.join(extensions, path.basename(source)), { recursive: true });
  } else install((await upstream(temp)).file);
  install(vsix);
  const installed = fs.readdirSync(extensions).find(name => name.startsWith('anthropic.claude-code-'));
  if (!installed) throw new Error('Official Claude Code extension not installed');
  const claude = path.join(extensions, installed);
  const version = JSON.parse(fs.readFileSync(path.join(claude, 'package.json'))).version;
  const bundle = path.join(claude, 'webview/index.js');
  const own = fs.readdirSync(extensions).find(name => name.startsWith('nuriyev.claude-code-katex-'));
  const candidate = JSON.parse(fs.readFileSync(path.join(extensions, own, 'package.json'))).version;
  const vscodeVersion = execFileSync(cli, ['--version', '--no-sandbox'], { env, encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  const report = { fixture: true, desktopVSCode: vscodeVersion, claudeCode: version, extension: candidate,
    package: vsix, sha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'), cases: [], consoleErrors: [] };
  const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise(r => server.close(r));
  const driverSocket = net.createServer(); await new Promise(r => driverSocket.listen(0, '127.0.0.1', r));
  const driverPort = driverSocket.address().port; await new Promise(r => driverSocket.close(r));
  env.KATEX_TEST_DRIVER_PORT = String(driverPort); env.KATEX_TEST_DRIVER_TOKEN = crypto.randomBytes(32).toString('hex');
  const control = async body => {
    const response = await fetch(`http://127.0.0.1:${driverPort}`, { method: 'POST', headers: { authorization: 'Bearer ' + env.KATEX_TEST_DRIVER_TOKEN }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('VS Code test driver: ' + await response.text());
    return true;
  };
  const log = fs.openSync(path.join(out, 'vscode.log'), 'a');
  const app = spawn(executable, [...cliArgs, '--extensionDevelopmentPath=' + path.join(__dirname, 'driver'), '--remote-debugging-port=' + port, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', workspace], { env, stdio: ['ignore', log, log] });
  let browser, page, frame;
  const check = (condition, name, detail) => {
    report.cases.push({ name, passed: !!condition, detail });
    const summary = detail?.text ? { ...detail, text: detail.text.slice(0, 200) } : detail;
    console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${summary ? ': ' + JSON.stringify(summary) : ''}`);
  };
  try {
    browser = await poll(() => chromium.connectOverCDP(`http://127.0.0.1:${port}`), 'desktop debug endpoint');
    page = await poll(() => browser.contexts()[0].pages().find(p => p.url().includes('workbench')), 'VS Code workbench');
    page.on('console', m => { if (m.type() === 'error' && m.text().includes('Error rendering content:')) report.consoleErrors.push(m.text().slice(0, 8000)); });
    await poll(() => fs.readFileSync(bundle, 'utf8').includes(`katex-ext-version: ${candidate}`), 'packaged candidate activation');
    let source = fs.readFileSync(bundle, 'utf8');
    if (source.includes(PROBE_MARKER)) throw new Error('Unexpected pre-existing test hook');
    fs.appendFileSync(bundle, '\n' + chatProbe(source));
    await poll(() => control({ command: 'ready' }), 'VS Code extension API driver');
    await control({ command: 'workbench.action.reloadWindow' }); await pause(3500);
    await poll(() => control({ command: 'ready' }), 'reloaded VS Code extension host');
    await control({ command: 'claude-vscode.primaryEditor.open' });
    frame = await poll(async () => {
      const candidates = [];
      for (const f of page.frames()) { try { if (await f.evaluate(() => !!window.__KATEX_CHAT_PROBE)) candidates.push({ f, width: await f.evaluate(() => innerWidth) }); } catch {} }
      return candidates.sort((a, b) => b.width - a.width)[0]?.f;
    }, 'actual Claude chat probe');
    const render = async (content, streaming, native = true) => {
      await frame.evaluate(({ content, streaming, native }) => window.__KATEX_CHAT_PROBE.render(content, streaming, native), { content, streaming, native });
      await poll(() => frame.evaluate(() => window.__KATEX_CHAT_PROBE.committed === window.__KATEX_CHAT_PROBE.serial), 'React chat commit');
      await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return frame.evaluate(() => {
        const root = document.querySelector('#katex-chat-output');
        return { text: root.innerText, count: root.querySelectorAll('.katex').length, tables: root.querySelectorAll('table').length,
          code: [...root.querySelectorAll('pre code')].map(n => n.textContent.trim()),
          errors: root.querySelectorAll('.katex-error,[mathcolor="#cc0000"]').length,
          crashed: root.innerText.includes('Error rendering content:'), native: window.__KATEX_CHAT_PROBE.effectiveGate };
      });
    };
    report.hasNativeGate = await frame.evaluate(() => window.__KATEX_CHAT_PROBE.hasNativeGate);
    if (report.hasNativeGate) {
      await frame.evaluate(() => { window.__KATEX_V2_LOADED = false; });
      await render('Native fallback $x^2$ and $y^2$.');
      const fallback = await poll(async () => { const s = await render('Native fallback $x^2$ and $y^2$.'); return s.count === 2 && s; }, 'native-only renderer');
      check(fallback.native && !fallback.crashed, 'native fallback when injected runtime is unavailable');
      await frame.evaluate(() => { window.__KATEX_V2_LOADED = true; });
      check(await frame.evaluate(() => window.__KATEX_CHAT_PROBE.gate(true) === false), 'only injected renderer owns math while loaded');
      check(await frame.evaluate(() => window.__KATEX_CHAT_PROBE.gate(false) === false), 'upstream disabled gate stays disabled');
    }
    for (const test of cases) for (const streaming of [undefined, 'allText']) {
      const s = await render(test.markdown, streaming);
      check(!s.crashed && !s.errors && s.count === test.count && (!test.tables || s.tables === test.tables) &&
        (!test.text || test.text.every(t => s.text.includes(t))) && (!test.code || s.code.includes(test.code)),
      `${test.name} (${streaming || 'complete'})`, s);
      if (s.crashed) await page.screenshot({ path: path.join(out, 'chat-render-failure.png') });
    }
    const stream = cases[4].markdown;
    for (const mode of ['allText', 'settledBlocks']) {
      let crashed = false;
      for (let end = 1; end < stream.length; end += 113) {
        const s = await render(stream.slice(0, end), mode); crashed ||= s.crashed;
      }
      const s = await render(stream);
      check(!crashed && !s.crashed && s.count === cases[4].count && !s.errors, 'streaming prefixes recover and finish: ' + mode);
    }
    await render(interaction);
    const equation = frame.locator('#katex-chat-output .katex-source').first();
    check(await equation.count() === 1, 'source control exists on actual chat output');
    if (await equation.count()) {
      const tex = await equation.locator('annotation[encoding="application/x-tex"]').textContent();
      await page.screenshot({ path: path.join(out, 'rendered-dark.png') });
      const button = equation.locator('button'); await equation.hover(); await button.click();
      const source = equation.locator('.katex-source-code');
      check(await source.isVisible() && await source.textContent() === '$$\n' + tex + '\n$$', 'source reveal keeps exact equation');
      await page.screenshot({ path: path.join(out, 'source-dark.png') });
      await button.press('Enter');
      check(await equation.locator('.katex-display').isVisible() && !(await source.isVisible()), 'Enter restores rendered equation');
      const first = await frame.locator('#katex-chat-output .katex').first().boundingBox();
      const display = await equation.locator('.katex-display').boundingBox();
      await frame.evaluate(() => { document.addEventListener('copy', e => { window.__KATEX_COPY_PROBE = { text: e.clipboardData.getData('text/plain'), trusted: e.isTrusted }; }, { once: true }); });
      await page.mouse.move(first.x + 1, first.y + first.height / 2); await page.mouse.down();
      await page.mouse.move(display.x + display.width / 2, display.y + display.height + 5, { steps: 15 }); await page.mouse.up();
      await page.keyboard.press(`${metaKey}+c`);
      const copied = await poll(() => frame.evaluate(() => window.__KATEX_COPY_PROBE), 'trusted keyboard copy');
      check(copied.trusted && copied.text.includes('$E=mc^2$') && copied.text.includes('$$' + tex + '$$'), 'trusted copy preserves inline and display LaTeX', copied);
      await control({ theme: 'Default Light Modern' });
      await poll(() => frame.evaluate(() => document.body.classList.contains('vscode-light')), 'real VS Code light theme');
      await page.screenshot({ path: path.join(out, 'rendered-light.png') });
    }
    if (report.hasNativeGate) {
      await control({ command: 'claude-code-katex.disable' });
      await poll(() => !fs.readFileSync(bundle, 'utf8').includes('katex-ext-version:'), 'disable restores native bundle');
      const restored = fs.readFileSync(bundle, 'utf8');
      check(restored === fs.readFileSync(bundle + '.katex-bak', 'utf8'), 'disable restores original upstream bytes');
    }
    if (report.cases.some(c => !c.passed)) throw new Error('Desktop chat regression checks failed');
    console.log(`Desktop VS Code ${vscodeVersion}, Claude ${version}, packaged extension ${candidate}: ${report.cases.length} checks passed.`);
  } catch (error) {
    report.failure = error.stack;
    if (page) { try { await page.screenshot({ path: path.join(out, 'failure.png') }); } catch {} }
    throw error;
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close();
    app.kill('SIGTERM');
    if (app.exitCode === null) await Promise.race([new Promise(resolve => app.once('exit', resolve)), pause(5000)]);
    if (app.exitCode === null) app.kill('SIGKILL');
    fs.closeSync(log);
    if (process.env.KEEP_VSCODE_PROFILE) console.log('Retained isolated test profile:', temp);
    else fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
