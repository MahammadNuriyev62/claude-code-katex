const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanupClaudeCode } = require('./uninstall-hook');

let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'katex-uninstall-'));
  fs.mkdirSync(path.join(tmp, 'webview'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('restores patched webview and host files from pristine backups', () => {
  fs.writeFileSync(path.join(tmp, 'webview', 'index.js'), 'patched js');
  fs.writeFileSync(path.join(tmp, 'webview', 'index.js.katex-bak'), 'original js');
  fs.writeFileSync(path.join(tmp, 'webview', 'index.css'), 'patched css');
  fs.writeFileSync(path.join(tmp, 'webview', 'index.css.katex-bak'), 'original css');
  fs.writeFileSync(path.join(tmp, 'extension.js'), '/* === KaTeX plan-preview patch === */ patched');
  fs.writeFileSync(path.join(tmp, 'extension.js.katex-bak'), 'original host');

  cleanupClaudeCode(tmp);

  expect(fs.readFileSync(path.join(tmp, 'webview', 'index.js'), 'utf8')).toBe('original js');
  expect(fs.readFileSync(path.join(tmp, 'webview', 'index.css'), 'utf8')).toBe('original css');
  expect(fs.readFileSync(path.join(tmp, 'extension.js'), 'utf8')).toBe('original host');
});

test('does not overwrite an already-unpatched host with a stale backup', () => {
  fs.writeFileSync(path.join(tmp, 'extension.js'), 'new Claude Code host');
  fs.writeFileSync(path.join(tmp, 'extension.js.katex-bak'), 'older Claude Code host');

  cleanupClaudeCode(tmp);

  expect(fs.readFileSync(path.join(tmp, 'extension.js'), 'utf8')).toBe('new Claude Code host');
  expect(fs.existsSync(path.join(tmp, 'extension.js.katex-bak'))).toBe(false);
});
