// Two real desktop VS Code processes, isolated profiles, shared official
// Claude installation and packaged VSIX. Only test scheduling is controlled;
// patching, conflict detection, retries and webview reloads run shipped code.
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { chatProbe } = require('./chat-probe');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, name, timeout = 45000) {
  let last;
  for (const end = Date.now() + timeout; Date.now() < end; await pause(150)) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
  }
  throw new Error('Startup test timed out: ' + name + (last ? ': ' + last.message : ''));
}
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve)); return value;
}

async function run(config) {
  const { executable, env, cliArgs, bundle, extensions, workspace, profile, temp, out, report } = config;
  const windows = [], gate = path.join(temp, 'startup-gates');
  fs.mkdirSync(gate);
  report.scenario = 'two extension hosts sharing files; controlled startup collision';
  report.manualReloads = 0;
  // The adapter is part of the original test fixture in both windows so the
  // window that loads it before patching can be compared after automatic reload.
  const original = fs.readFileSync(bundle, 'utf8');
  fs.appendFileSync(bundle, '\n' + chatProbe(original));
  const check = (ok, name, detail) => {
    report.cases.push({ name, passed: !!ok, detail });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ': ' + JSON.stringify(detail) : ''));
  };
  async function open(role) {
    const debug = await port(), driver = await port();
    const args = [...cliArgs];
    if (role === 'B') {
      const otherProfile = path.join(temp, 'profile-B');
      fs.mkdirSync(path.join(otherProfile, 'User'), { recursive: true });
      fs.copyFileSync(path.join(profile, 'User/settings.json'), path.join(otherProfile, 'User/settings.json'));
      args.splice(0, args.length, '--user-data-dir=' + otherProfile, '--extensions-dir=' + extensions, '--no-sandbox');
    }
    const log = fs.openSync(path.join(out, role + '-vscode.log'), 'a');
    const child = spawn(executable, [...args, '--extensionDevelopmentPath=' + path.join(__dirname, 'driver'),
      '--remote-debugging-port=' + debug, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', workspace], {
      env: { ...env, KATEX_STARTUP_RACE_DIR: gate, KATEX_STARTUP_RACE_ROLE: role,
        KATEX_TEST_DRIVER_PORT: String(driver), KATEX_TEST_DRIVER_TOKEN: crypto.randomBytes(32).toString('hex') },
      stdio: ['ignore', log, log],
    });
    const instance = { role, child, log }; windows.push(instance);
    instance.browser = await poll(() => chromium.connectOverCDP('http://127.0.0.1:' + debug), role + ' desktop');
    instance.page = await poll(() => instance.browser.contexts()[0].pages().find(p => p.url().includes('workbench')), role + ' workbench');
    await poll(() => fs.existsSync(path.join(gate, role + '-waiting')), role + ' activation wrapper');
    fs.writeFileSync(path.join(gate, role + '-open'), 'ready');
    return instance;
  }
  async function frame(instance, loaded) {
    return poll(async () => {
      for (const f of instance.page.frames()) {
        try {
          if (await f.evaluate(expected => !!window.__KATEX_CHAT_PROBE && !!window.__KATEX_V2_LOADED === expected, loaded)) return f;
        } catch { /* a reloading frame */ }
      }
    }, instance.role + (loaded ? ' recovered webview' : ' original webview'));
  }
  const sample = String.raw`Long inline $\mathcal H(p)=\sup_{\nu\in\mathbb R}\big(p\,\nu-\kappa|\nu|^{1+\beta}\big)$ and numeric $76$.

$$\int_0^1 x^2\,dx=\frac13$$

$$\begin{pmatrix}1&2\\3&4\end{pmatrix}$$`;
  async function render(f, role) {
    await f.evaluate(({ sample, role }) => {
      window.__KATEX_CHAT_PROBE.render(sample);
      const title = document.querySelector('#katex-chat-regression > p');
      if (title) title.textContent = 'Startup race — window ' + role + ' — deterministic fixture';
    }, { sample, role });
    await poll(() => f.evaluate(() => window.__KATEX_CHAT_PROBE.committed === window.__KATEX_CHAT_PROBE.serial), 'chat commit');
    await f.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return f.evaluate(() => ({ loaded: !!window.__KATEX_V2_LOADED,
      math: document.querySelectorAll('#katex-chat-output .katex').length,
      errors: document.querySelectorAll('#katex-chat-output .katex-error').length,
      native: window.__KATEX_CHAT_PROBE.gate(true),
      text: document.querySelector('#katex-chat-output').innerText }));
  }
  try {
    const a = await open('A');
    await poll(() => fs.existsSync(path.join(gate, 'A-prepared')), 'window A prepared original bytes');
    const stale = await frame(a, false);
    const before = await render(stale, 'A before recovery');
    check(!before.loaded, 'window A actually loaded the original unpatched renderer', before);
    await a.page.screenshot({ path: path.join(out, 'A-before.png') });
    const b = await open('B');
    await poll(() => fs.readFileSync(bundle, 'utf8').includes('katex-ext-version: ' + report.extension), 'window B committed the packaged patch');
    check(fs.existsSync(path.join(gate, 'A-prepared')) && !fs.existsSync(path.join(gate, 'A-released')),
      'window B wins while A still holds its stale preparation');
    fs.writeFileSync(path.join(gate, 'A-release'), 'ready');
    for (const instance of [a, b]) {
      const recovered = await frame(instance, true);
      const state = await render(recovered, instance.role + ' recovered');
      check(state.loaded && state.math === 4 && state.errors === 0 && !state.native,
        instance.role + ' automatically loads the packaged pipeline and renders all samples', state);
      await instance.page.screenshot({ path: path.join(out, instance.role + '-recovered.png') });
    }
    check(fs.readFileSync(bundle + '.katex-bak', 'utf8') === original + '\n' + chatProbe(original),
      'the losing writer preserves the winning original backup');
    if (report.cases.some(c => !c.passed)) throw new Error('Startup recovery checks failed');
    console.log('Both desktop windows recovered without manual reload.');
  } catch (error) {
    report.failure = error.stack;
    for (const instance of windows) {
      try { await instance.page?.screenshot({ path: path.join(out, instance.role + '-failure.png') }); } catch {}
    }
    throw error;
  } finally {
    // Always release a test-only blocking writer before terminating its host.
    fs.writeFileSync(path.join(gate, 'A-release'), 'ready');
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    for (const instance of windows) {
      try { await instance.browser?.close(); } catch {}
      instance.child.kill('SIGTERM');
      if (instance.child.exitCode === null) await Promise.race([new Promise(resolve => instance.child.once('exit', resolve)), pause(5000)]);
      if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
      fs.closeSync(instance.log);
    }
  }
}
module.exports = { run };
