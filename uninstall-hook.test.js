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
  fs.writeFileSync(path.join(tmp, 'webview', 'index.js'), '/* === KaTeX LaTeX Rendering Patch === */ patched js');
  fs.writeFileSync(path.join(tmp, 'webview', 'index.js.katex-bak'), '/* original js */');
  fs.writeFileSync(path.join(tmp, 'webview', 'index.css'), '/* === KaTeX LaTeX Rendering CSS Patch === */ patched css');
  fs.writeFileSync(path.join(tmp, 'webview', 'index.css.katex-bak'), 'original css');
  fs.writeFileSync(path.join(tmp, 'extension.js'), '/* === KaTeX plan-preview patch === */ patched');
  fs.writeFileSync(path.join(tmp, 'extension.js.katex-bak'), 'original host');

  cleanupClaudeCode(tmp);

  expect(fs.readFileSync(path.join(tmp, 'webview', 'index.js'), 'utf8')).toBe('/* original js */');
  expect(fs.readFileSync(path.join(tmp, 'webview', 'index.css'), 'utf8')).toBe('original css');
  expect(fs.readFileSync(path.join(tmp, 'extension.js'), 'utf8')).toBe('original host');
});

test('a corrupt webview backup leaves its working patch and fonts intact', () => {
  const current = '/* === KaTeX LaTeX Rendering Patch === */ var original=1;';
  fs.writeFileSync(path.join(tmp, 'webview', 'index.js'), current);
  fs.writeFileSync(path.join(tmp, 'webview', 'index.js.katex-bak'), 'function broken(');
  fs.mkdirSync(path.join(tmp, 'webview', 'fonts'));
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try { cleanupClaudeCode(tmp); } finally { warning.mockRestore(); }
  expect(fs.readFileSync(path.join(tmp, 'webview', 'index.js'), 'utf8')).toBe(current);
  expect(fs.existsSync(path.join(tmp, 'webview', 'index.js.katex-bak'))).toBe(true);
  expect(fs.existsSync(path.join(tmp, 'webview', 'fonts'))).toBe(true);
});

test('does not overwrite new upstream webview files with stale backups', () => {
  for (const name of ['index.js', 'index.css']) {
    fs.writeFileSync(path.join(tmp, 'webview', name), 'new upstream ' + name);
    fs.writeFileSync(path.join(tmp, 'webview', name + '.katex-bak'), 'old upstream ' + name);
  }
  cleanupClaudeCode(tmp);
  for (const name of ['index.js', 'index.css']) {
    expect(fs.readFileSync(path.join(tmp, 'webview', name), 'utf8')).toBe('new upstream ' + name);
    expect(fs.existsSync(path.join(tmp, 'webview', name + '.katex-bak'))).toBe(false);
  }
});

test('does not overwrite an already-unpatched host with a stale backup', () => {
  fs.writeFileSync(path.join(tmp, 'extension.js'), 'new Claude Code host');
  fs.writeFileSync(path.join(tmp, 'extension.js.katex-bak'), 'older Claude Code host');

  cleanupClaudeCode(tmp);

  expect(fs.readFileSync(path.join(tmp, 'extension.js'), 'utf8')).toBe('new Claude Code host');
  expect(fs.existsSync(path.join(tmp, 'extension.js.katex-bak'))).toBe(false);
});
