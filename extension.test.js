const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Mock vscode module (not available outside VS Code) ---
const mockShowInformationMessage = jest.fn().mockResolvedValue(undefined);
const mockShowWarningMessage = jest.fn().mockResolvedValue(undefined);
const mockShowErrorMessage = jest.fn();
const mockExecuteCommand = jest.fn();
const mockRegisterCommand = jest.fn().mockReturnValue({ dispose: jest.fn() });
const mockOnDidChange = jest.fn().mockReturnValue({ dispose: jest.fn() });
const mockOnDidChangeConfiguration = jest.fn().mockReturnValue({ dispose: jest.fn() });
const mockGetExtension = jest.fn();
const mockOpenExternal = jest.fn();
const mockStatusBarItem = {
  text: '', tooltip: '', command: '',
  show: jest.fn(), hide: jest.fn(), dispose: jest.fn(),
};
const mockCreateStatusBarItem = jest.fn().mockReturnValue(mockStatusBarItem);
const mockGetConfiguration = jest.fn();

jest.mock('vscode', () => ({
  window: {
    showInformationMessage: mockShowInformationMessage,
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: mockShowErrorMessage,
    createStatusBarItem: mockCreateStatusBarItem,
  },
  commands: {
    registerCommand: mockRegisterCommand,
    executeCommand: mockExecuteCommand,
  },
  extensions: {
    getExtension: mockGetExtension,
    onDidChange: mockOnDidChange,
  },
  workspace: {
    getConfiguration: mockGetConfiguration,
    onDidChangeConfiguration: mockOnDidChangeConfiguration,
    workspaceFolders: undefined,
  },
  env: { openExternal: mockOpenExternal },
  Uri: { parse: (s) => s },
  StatusBarAlignment: { Left: 1, Right: 2 },
}), { virtual: true });

const vscodeMock = require('vscode');

// Makes claudeCodeKatex.* return the given settings; anything unset falls back
// to the default the extension asks for.
const setMacroConfig = (cfg) => {
  mockGetConfiguration.mockReturnValue({
    get: (key, dflt) => (cfg && Object.prototype.hasOwnProperty.call(cfg, key) ? cfg[key] : dflt),
  });
};

const { activate, deactivate, _test } = require('./extension');
const {
  findClaudeCodeExtDir,
  isPatched,
  applyPatch,
  removePatch,
  PATCH_MARKER,
  PATCH_CSS_MARKER,
} = _test;

// --- Test fixtures ---
// A stand-in for Claude Code's webview bundle carrying the real react-markdown
// call shape the patch injects into.
const FIXTURE_JS =
  '// original claude code webview js\n' +
  'var tree=R.default.createElement(Md,{remarkPlugins:[gfm],components:{a:1}},src);\n' +
  'console.log("hello");';
const FIXTURE_CSS = '/* original css */ body { margin: 0; }';
const PLAN_HOST_SOURCE = [
  'var wr={parse:function(s){return s}};',
  'function Ta(){return "n0nce"}',
  'var U_r=`<html><body><div id="content"></div></body></html>`;',
  'function $_r(e){let t=wr.parse(e);return typeof t==="string"?t:""}',
  'function F_r(){let e=Ta();return U_r.replaceAll("{{NONCE}}",e)}',
].join('\n');
// A bundle whose react-markdown call the patch can no longer locate.
const FIXTURE_NO_INJECT =
  '// claude code with a reshaped bundle\nconsole.log("no injection point here");';

let tmpDir;
let extDir;
let vendorDir;

function setupFakeClaudeCodeExt(jsContent) {
  extDir = path.join(tmpDir, 'anthropic.claude-code-1.0.0');
  const webviewDir = path.join(extDir, 'webview');
  fs.mkdirSync(webviewDir, { recursive: true });
  fs.writeFileSync(path.join(webviewDir, 'index.js'), jsContent || FIXTURE_JS);
  fs.writeFileSync(path.join(webviewDir, 'index.css'), FIXTURE_CSS);
  fs.writeFileSync(path.join(extDir, 'extension.js'), PLAN_HOST_SOURCE);
  return extDir;
}

function setupFakeVendorDir() {
  vendorDir = path.join(tmpDir, 'vendor');
  const fontsDir = path.join(vendorDir, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'katex.min.js'), '/* katex core mock */');
  fs.writeFileSync(path.join(vendorDir, 'remark-math-bundle.js'), '/* bundle mock */ window.__KATEX_V2_LOADED=true;');
  fs.writeFileSync(path.join(vendorDir, 'katex.min.css'), '/* katex css mock */');
  fs.writeFileSync(path.join(vendorDir, 'copy-tex.min.js'), '/* copy-tex mock */');
  fs.writeFileSync(path.join(fontsDir, 'KaTeX_Main.woff2'), 'fake-font-data');
  fs.writeFileSync(path.join(fontsDir, 'KaTeX_Math.woff2'), 'fake-font-data-2');
  return vendorDir;
}

// Rewrites the version stamp inside an already-applied patch to simulate a
// patch left behind by a different extension build. `fakeVersion === null`
// strips the stamp entirely, simulating a pre-versioning (<= 1.9.0) patch.
function makeStalePatch(fakeVersion) {
  const jsPath = path.join(extDir, 'webview', 'index.js');
  const stamp = _test.PATCH_VERSION_PREFIX + _test.EXTENSION_VERSION + ' */';
  let js = fs.readFileSync(jsPath, 'utf8');
  if (fakeVersion === null) {
    js = js.replace(stamp + '\n', '');
  } else {
    js = js.replace(stamp, _test.PATCH_VERSION_PREFIX + fakeVersion + ' */');
  }
  fs.writeFileSync(jsPath, js);
}

const readJs = () => fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
const readCss = () => fs.readFileSync(path.join(extDir, 'webview', 'index.css'), 'utf8');
const readHost = () => fs.readFileSync(path.join(extDir, 'extension.js'), 'utf8');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'katex-test-'));
  jest.clearAllMocks();
  // Default: no macros configured, no workspace open.
  setMacroConfig({});
  vscodeMock.workspace.workspaceFolders = undefined;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// findClaudeCodeExtDir
// ============================================================
describe('findClaudeCodeExtDir', () => {
  test('returns extensionPath when Claude Code is installed', () => {
    mockGetExtension.mockReturnValue({ extensionPath: '/some/path' });
    expect(findClaudeCodeExtDir()).toBe('/some/path');
  });

  test('returns null when Claude Code is not installed', () => {
    mockGetExtension.mockReturnValue(undefined);
    expect(findClaudeCodeExtDir()).toBeNull();
  });
});

// ============================================================
// isPatched
// ============================================================
describe('isPatched', () => {
  test('returns false for unpatched files', () => {
    setupFakeClaudeCodeExt();
    expect(isPatched(extDir)).toBe(false);
  });

  test('returns true after patching', () => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    applyPatch(extDir, vendorDir);
    expect(isPatched(extDir)).toBe(true);
  });

  test('returns false when extension dir does not exist', () => {
    expect(isPatched('/nonexistent/path')).toBe(false);
  });

  test('returns false when webview/index.js is missing', () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(isPatched(emptyDir)).toBe(false);
  });
});

// ============================================================
// applyPatch
// ============================================================
describe('applyPatch', () => {
  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  test('returns true when the react-markdown injection point is present', () => {
    expect(applyPatch(extDir, vendorDir)).toBe(true);
  });

  test('creates .katex-bak backup files containing the originals', () => {
    applyPatch(extDir, vendorDir);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'utf8')).toBe(FIXTURE_JS);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.css.katex-bak'), 'utf8')).toBe(FIXTURE_CSS);
  });

  test('refreshes the JavaScript backup after an in-place upstream update without duplicating CSS', () => {
    applyPatch(extDir, vendorDir);
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'PRESERVED');
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), FIXTURE_JS); // un-patch on disk
    applyPatch(extDir, vendorDir);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'utf8')).toBe(FIXTURE_JS);
    expect(readCss().split(PATCH_CSS_MARKER)).toHaveLength(2);
    removePatch(extDir);
    expect(readJs()).toBe(FIXTURE_JS);
    expect(readCss()).toBe(FIXTURE_CSS);
  });

  test('refreshes both originals after upstream replaces both bundles', () => {
    applyPatch(extDir, vendorDir);
    const nextJs = FIXTURE_JS + '\nvar upstream=2;';
    const nextCss = FIXTURE_CSS + '\n.upstream {color: red}';
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), nextJs);
    fs.writeFileSync(path.join(extDir, 'webview', 'index.css'), nextCss);
    expect(applyPatch(extDir, vendorDir)).toBe(true);
    removePatch(extDir);
    expect(readJs()).toBe(nextJs);
    expect(readCss()).toBe(nextCss);
  });

  test.each(['katex.min.css', 'remark-math-bundle.js', 'fonts'])(
    'a missing asset (%s) leaves bundles and backup state untouched', asset => {
      fs.rmSync(path.join(vendorDir, asset), { recursive: true });
      expect(() => applyPatch(extDir, vendorDir)).toThrow();
      expect(readJs()).toBe(FIXTURE_JS);
      expect(readCss()).toBe(FIXTURE_CSS);
      expect(fs.readdirSync(path.join(extDir, 'webview')).sort()).toEqual(['index.css', 'index.js']);
    });

  test('malformed vendor JavaScript is rejected before any mutation', () => {
    fs.writeFileSync(path.join(vendorDir, 'remark-math-bundle.js'), 'function broken( {');
    expect(() => applyPatch(extDir, vendorDir)).toThrow();
    expect(readJs()).toBe(FIXTURE_JS);
    expect(readCss()).toBe(FIXTURE_CSS);
    expect(fs.readdirSync(path.join(extDir, 'webview')).sort()).toEqual(['index.css', 'index.js']);
  });

  test('a locked JavaScript file rolls back styles, fonts, and backups', () => {
    const rename = fs.renameSync;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === path.join(extDir, 'webview', 'index.js')) throw new Error('file locked');
      return rename(from, to);
    });
    try { expect(() => applyPatch(extDir, vendorDir)).toThrow('file locked'); }
    finally { spy.mockRestore(); }
    expect(readJs()).toBe(FIXTURE_JS);
    expect(readCss()).toBe(FIXTURE_CSS);
    expect(fs.readdirSync(path.join(extDir, 'webview')).sort()).toEqual(['index.css', 'index.js']);
  });

  test('an upstream update during preparation is preserved', () => {
    const write = fs.writeFileSync;
    const nextJs = FIXTURE_JS + '\nvar newer=1;';
    let changed = false;
    const spy = jest.spyOn(fs, 'writeFileSync').mockImplementation((target, ...args) => {
      if (!changed && String(target).endsWith('.tmp')) {
        changed = true;
        write(path.join(extDir, 'webview', 'index.js'), nextJs);
      }
      return write(target, ...args);
    });
    try { expect(() => applyPatch(extDir, vendorDir)).toThrow('changed while preparing'); }
    finally { spy.mockRestore(); }
    expect(readJs()).toBe(nextJs);
    expect(readCss()).toBe(FIXTURE_CSS);
    expect(fs.readdirSync(path.join(extDir, 'webview')).sort()).toEqual(['index.css', 'index.js']);
  });

  test('a patched stylesheet with an unrelated backup is refused', () => {
    applyPatch(extDir, vendorDir);
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), FIXTURE_JS);
    fs.writeFileSync(path.join(extDir, 'webview', 'index.css.katex-bak'), 'unrelated');
    const css = readCss();
    expect(() => applyPatch(extDir, vendorDir)).toThrow('backup does not match');
    expect(readJs()).toBe(FIXTURE_JS);
    expect(readCss()).toBe(css);
  });

  test('writes the patch marker and version stamp', () => {
    applyPatch(extDir, vendorDir);
    const js = readJs();
    expect(js).toContain(PATCH_MARKER);
    expect(js).toContain(_test.PATCH_VERSION_PREFIX + _test.EXTENSION_VERSION + ' */');
  });

  test('prepends KaTeX core and the remark-math bundle', () => {
    applyPatch(extDir, vendorDir);
    const js = readJs();
    expect(js).toContain('/* katex core mock */');
    expect(js).toContain('/* bundle mock */');
  });

  test('prepends the copy-tex contrib after the core, before the bundle', () => {
    applyPatch(extDir, vendorDir);
    const js = readJs();
    expect(js).toContain('/* copy-tex mock */');
    // copy-tex must attach its copy listener in the webview document before
    // Claude Code's app (at the end of the bundle) mounts; keep it grouped with
    // the core, ahead of the pipeline bundle.
    expect(js.indexOf('/* katex core mock */')).toBeLessThan(js.indexOf('/* copy-tex mock */'));
    expect(js.indexOf('/* copy-tex mock */')).toBeLessThan(js.indexOf('/* bundle mock */'));
  });

  test('still patches when the optional copy-tex contrib is absent (graceful)', () => {
    fs.unlinkSync(path.join(vendorDir, 'copy-tex.min.js'));
    expect(applyPatch(extDir, vendorDir)).toBe(true);
    const js = readJs();
    expect(js).toContain('/* katex core mock */');
    expect(js).toContain('/* bundle mock */');
    expect(js).not.toContain('/* copy-tex mock */');
  });

  test('injects the guarded math plugins into the react-markdown call', () => {
    applyPatch(extDir, vendorDir);
    const js = readJs();
    expect(js).toContain('rehypePlugins:window.__KATEX_V2_LOADED?[window.__rehypeKatex]:[]');
    expect(js).toContain('[gfm].concat(window.__KATEX_V2_LOADED?[window.__remarkBracketMath,window.__remarkMath]:[])');
    expect(js).not.toContain('{remarkPlugins:[gfm],components:'); // original call shape consumed
  });

  test('preserves the non-injected original JS content', () => {
    applyPatch(extDir, vendorDir);
    const js = readJs();
    expect(js).toContain('// original claude code webview js');
    expect(js).toContain('console.log("hello")');
  });

  test('appends the CSS patch marker and styles, keeping the original CSS', () => {
    applyPatch(extDir, vendorDir);
    const css = readCss();
    expect(css.startsWith(FIXTURE_CSS)).toBe(true);
    expect(css).toContain(PATCH_CSS_MARKER);
    expect(css).toContain('/* katex css mock */');
    expect(css).toContain('.katex-display');
  });

  test('copies font files to webview/fonts/', () => {
    applyPatch(extDir, vendorDir);
    const fontsDir = path.join(extDir, 'webview', 'fonts');
    expect(fs.existsSync(path.join(fontsDir, 'KaTeX_Main.woff2'))).toBe(true);
    expect(fs.existsSync(path.join(fontsDir, 'KaTeX_Math.woff2'))).toBe(true);
  });

  test('returns false and touches nothing when the injection point is absent', () => {
    setupFakeClaudeCodeExt(FIXTURE_NO_INJECT);
    expect(applyPatch(extDir, vendorDir)).toBe(false);
    expect(readJs()).toBe(FIXTURE_NO_INJECT);
    expect(isPatched(extDir)).toBe(false);
    expect(fs.existsSync(path.join(extDir, 'webview', 'index.js.katex-bak'))).toBe(false);
    expect(fs.existsSync(path.join(extDir, 'webview', 'fonts'))).toBe(false);
  });

  test('is naturally idempotent: a second applyPatch is a no-op', () => {
    expect(applyPatch(extDir, vendorDir)).toBe(true);
    const markers = () => readJs().split(PATCH_MARKER).length - 1;
    expect(markers()).toBe(1);
    // Injection point was consumed by the first patch — second call finds nothing.
    expect(applyPatch(extDir, vendorDir)).toBe(false);
    expect(markers()).toBe(1);
  });
});

// ============================================================
// Patch golden — byte-identity for a zero-config user
//
// Pins the exact bytes applyPatch writes when no user macros are configured.
// Written and committed BEFORE the custom-macro feature, so the snapshot is a
// genuine record of the shipping patch rather than a description of whatever
// the code happens to do afterwards. Any later change that alters the patch a
// zero-config user receives has to break this test deliberately.
//
// The version stamp is normalized: a release bump is not a structural change.
// ============================================================
describe('patch golden — byte-identity for a zero-config user', () => {
  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  const normalize = (s) =>
    s.split(_test.EXTENSION_VERSION).join('<VERSION>');

  test('patched index.js is exactly this', () => {
    expect(applyPatch(extDir, vendorDir)).toBe(true);
    expect(normalize(readJs())).toMatchSnapshot();
  });

  test('patched index.css is exactly this', () => {
    expect(applyPatch(extDir, vendorDir)).toBe(true);
    expect(normalize(readCss())).toMatchSnapshot();
  });
});

// ============================================================
// removePatch
// ============================================================
describe('removePatch', () => {
  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  test('restores original files from backups, byte-identically', () => {
    applyPatch(extDir, vendorDir);
    expect(isPatched(extDir)).toBe(true);
    removePatch(extDir);
    expect(readJs()).toBe(FIXTURE_JS);
    expect(readCss()).toBe(FIXTURE_CSS);
  });

  test('removes the fonts directory', () => {
    applyPatch(extDir, vendorDir);
    expect(fs.existsSync(path.join(extDir, 'webview', 'fonts'))).toBe(true);
    removePatch(extDir);
    expect(fs.existsSync(path.join(extDir, 'webview', 'fonts'))).toBe(false);
  });

  test('returns true when backups existed, false otherwise', () => {
    applyPatch(extDir, vendorDir);
    expect(removePatch(extDir)).toBe(true);
  });

  test('returns false when no backups exist', () => {
    expect(removePatch(extDir)).toBe(false);
  });

  test('isPatched returns false after removePatch', () => {
    applyPatch(extDir, vendorDir);
    removePatch(extDir);
    expect(isPatched(extDir)).toBe(false);
  });

  test('does not downgrade files already replaced by an upstream update', () => {
    applyPatch(extDir, vendorDir);
    const nextJs = FIXTURE_JS + '\nvar upstream=3;';
    const nextCss = FIXTURE_CSS + '\n.upstream {}';
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), nextJs);
    fs.writeFileSync(path.join(extDir, 'webview', 'index.css'), nextCss);
    removePatch(extDir);
    expect(readJs()).toBe(nextJs);
    expect(readCss()).toBe(nextCss);
  });

  test('patch -> remove -> patch cycle works', () => {
    applyPatch(extDir, vendorDir);
    expect(isPatched(extDir)).toBe(true);
    removePatch(extDir);
    expect(isPatched(extDir)).toBe(false);
    expect(readJs()).toBe(FIXTURE_JS);

    for (const f of ['index.js.katex-bak', 'index.css.katex-bak']) {
      const bakPath = path.join(extDir, 'webview', f);
      if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
    }
    applyPatch(extDir, vendorDir);
    expect(isPatched(extDir)).toBe(true);
    removePatch(extDir);
    expect(isPatched(extDir)).toBe(false);
    expect(readJs()).toBe(FIXTURE_JS);
  });

  test('handles a missing fonts dir gracefully', () => {
    applyPatch(extDir, vendorDir);
    fs.rmSync(path.join(extDir, 'webview', 'fonts'), { recursive: true });
    expect(() => removePatch(extDir)).not.toThrow();
  });

  test.each(['', 'function broken(', PATCH_MARKER])('refuses a corrupt JS backup without removing fonts: %s', backup => {
    applyPatch(extDir, vendorDir);
    const beforeJs = readJs(), beforeCss = readCss();
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), backup);
    expect(() => removePatch(extDir)).toThrow();
    expect(readJs()).toBe(beforeJs);
    expect(readCss()).toBe(beforeCss);
    expect(fs.existsSync(path.join(extDir, 'webview', 'fonts', 'KaTeX_Main.woff2'))).toBe(true);
  });
});

// ============================================================
// getPatchedVersion
// ============================================================
describe('getPatchedVersion', () => {
  const { getPatchedVersion } = _test;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  test('returns null when the webview is unpatched', () => {
    expect(getPatchedVersion(extDir)).toBeNull();
  });

  test('returns this extension version after applyPatch', () => {
    applyPatch(extDir, vendorDir);
    expect(getPatchedVersion(extDir)).toBe(_test.EXTENSION_VERSION);
  });

  test('returns null for a patch with no version stamp (<= 1.9.0 build)', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch(null);
    expect(isPatched(extDir)).toBe(true);
    expect(getPatchedVersion(extDir)).toBeNull();
  });

  test('returns null when index.js cannot be read', () => {
    expect(getPatchedVersion(path.join(tmpDir, 'no-such-dir'))).toBeNull();
  });
});

// ============================================================
// canRestoreOriginals
// ============================================================
describe('canRestoreOriginals', () => {
  const { canRestoreOriginals } = _test;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  test('true when backups exist and are clean originals', () => {
    applyPatch(extDir, vendorDir);
    expect(canRestoreOriginals(extDir)).toBe(true);
  });

  test('false when a backup file is missing', () => {
    applyPatch(extDir, vendorDir);
    fs.unlinkSync(path.join(extDir, 'webview', 'index.js.katex-bak'));
    expect(canRestoreOriginals(extDir)).toBe(false);
  });

  test('false when the JS backup is itself patched', () => {
    applyPatch(extDir, vendorDir);
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'junk ' + PATCH_MARKER + ' junk');
    expect(canRestoreOriginals(extDir)).toBe(false);
  });

  test('false when the CSS backup is itself patched', () => {
    applyPatch(extDir, vendorDir);
    fs.writeFileSync(path.join(extDir, 'webview', 'index.css.katex-bak'), 'junk ' + PATCH_CSS_MARKER + ' junk');
    expect(canRestoreOriginals(extDir)).toBe(false);
  });
});

// ============================================================
// ensurePatched
// ============================================================
describe('ensurePatched', () => {
  const { ensurePatched, getPatchedVersion } = _test;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  const patchMarkerCount = () => readJs().split(PATCH_MARKER).length - 1;

  test('"fresh" when unpatched: applies the patch', () => {
    expect(ensurePatched(extDir, vendorDir)).toBe('fresh');
    expect(isPatched(extDir)).toBe(true);
    expect(getPatchedVersion(extDir)).toBe(_test.EXTENSION_VERSION);
  });

  test('"unsupported" when the injection point is absent', () => {
    setupFakeClaudeCodeExt(FIXTURE_NO_INJECT);
    expect(ensurePatched(extDir, vendorDir)).toBe('unsupported');
    expect(isPatched(extDir)).toBe(false);
  });

  test('"current" when already patched with this version: file unchanged', () => {
    applyPatch(extDir, vendorDir);
    const before = fs.readFileSync(path.join(extDir, 'webview', 'index.js'));
    expect(ensurePatched(extDir, vendorDir)).toBe('current');
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js')).equals(before)).toBe(true);
  });

  test('repairs a stylesheet-only upstream replacement and preserves its new original', () => {
    applyPatch(extDir, vendorDir);
    const nextCss = FIXTURE_CSS + '\n.upstream {}';
    fs.writeFileSync(path.join(extDir, 'webview', 'index.css'), nextCss);
    expect(ensurePatched(extDir, vendorDir)).toBe('refreshed');
    expect(readCss().split(PATCH_CSS_MARKER)).toHaveLength(2);
    removePatch(extDir);
    expect(readJs()).toBe(FIXTURE_JS);
    expect(readCss()).toBe(nextCss);
  });

  test('failed refresh preserves the old working patch', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    const js = readJs(), css = readCss();
    fs.writeFileSync(path.join(vendorDir, 'remark-math-bundle.js'), 'function broken( {');
    expect(() => ensurePatched(extDir, vendorDir)).toThrow();
    expect(readJs()).toBe(js);
    expect(readCss()).toBe(css);
  });

  test('"refreshed" for an older-version patch: restores then re-patches once', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    expect(getPatchedVersion(extDir)).toBe('0.0.1');
    expect(ensurePatched(extDir, vendorDir)).toBe('refreshed');
    expect(getPatchedVersion(extDir)).toBe(_test.EXTENSION_VERSION);
    expect(patchMarkerCount()).toBe(1);
  });

  test('"refreshed" for a pre-versioning patch with no stamp', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch(null);
    expect(getPatchedVersion(extDir)).toBeNull();
    expect(ensurePatched(extDir, vendorDir)).toBe('refreshed');
    expect(getPatchedVersion(extDir)).toBe(_test.EXTENSION_VERSION);
    expect(patchMarkerCount()).toBe(1);
  });

  test('"skipped" when stale but a backup is missing: patch left untouched', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    fs.unlinkSync(path.join(extDir, 'webview', 'index.js.katex-bak'));
    const before = fs.readFileSync(path.join(extDir, 'webview', 'index.js'));
    expect(ensurePatched(extDir, vendorDir)).toBe('skipped');
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js')).equals(before)).toBe(true);
    expect(patchMarkerCount()).toBe(1);
  });

  test('"skipped" when stale but a backup is itself patched', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'poisoned ' + PATCH_MARKER);
    expect(ensurePatched(extDir, vendorDir)).toBe('skipped');
    expect(patchMarkerCount()).toBe(1);
  });

  test('refresh is idempotent: a second call reports "current", still one patch', () => {
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    expect(ensurePatched(extDir, vendorDir)).toBe('refreshed');
    expect(ensurePatched(extDir, vendorDir)).toBe('current');
    expect(patchMarkerCount()).toBe(1);
  });
});

// ============================================================
// activate
// ============================================================
describe('activate', () => {
  let context;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
  });

  test('auto-patches when Claude Code is found and unpatched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(isPatched(extDir)).toBe(true);
  });

  test('auto-reloads the webview and notifies after auto-patching', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX enabled. The webview was reloaded; reload again if any math still looks unrendered.',
      'Reload Webview', 'Reload Window'
    );
  });

  test('does not re-patch or reload if already patched with this version', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    mockExecuteCommand.mockClear();
    activate(context);
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
  });

  test('refreshes a stale patch on activation and notifies', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    makeStalePatch('0.0.1');
    mockExecuteCommand.mockClear();
    activate(context);
    expect(_test.getPatchedVersion(extDir)).toBe(_test.EXTENSION_VERSION);
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX updated. The webview was reloaded; reload again if any math still looks unrendered.',
      'Reload Webview', 'Reload Window'
    );
  });

  test('warns (unsupported) when the injection point is not found', () => {
    setupFakeClaudeCodeExt(FIXTURE_NO_INJECT);
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(isPatched(extDir)).toBe(false);
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('could not apply its patch'),
      'Check for Updates', 'Report an Issue'
    );
  });

  test('registers 4 commands', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    const registered = mockRegisterCommand.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(expect.arrayContaining([
      'claude-code-katex.enable',
      'claude-code-katex.disable',
      'claude-code-katex.status',
      'claude-code-katex.reloadMacros',
    ]));
    expect(registered).not.toContain('claude-code-katex.rerender');
    expect(registered.length).toBe(4);
  });

  test('creates a status bar item wired to the status command', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(mockCreateStatusBarItem).toHaveBeenCalledWith(2 /* Right */, 100);
    expect(mockStatusBarItem.show).toHaveBeenCalled();
    expect(mockStatusBarItem.command).toBe('claude-code-katex.status');
    expect(mockStatusBarItem.text).toMatch(/LaTeX/);
  });

  test('pushes 7 disposables (4 commands + status bar + extension/config watchers)', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(context.subscriptions.length).toBe(7);
  });

  test('registers an onDidChange watcher', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(mockOnDidChange).toHaveBeenCalled();
  });

  test('leaves the plan host untouched by default', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(readHost()).toBe(PLAN_HOST_SOURCE);
    expect(fs.existsSync(path.join(extDir, 'extension.js.katex-bak'))).toBe(false);
  });

  test('enabling plan rendering applies the host patch and offers Reload Window', async () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    const changed = mockOnDidChangeConfiguration.mock.calls[0][0];
    mockShowInformationMessage.mockClear();
    mockShowInformationMessage.mockResolvedValueOnce('Reload Window');
    setMacroConfig({ renderPlanPreview: true });

    await changed({ affectsConfiguration: (name) => name === 'claudeCodeKatex.renderPlanPreview' });
    await Promise.resolve();

    expect(readHost()).toContain('KaTeX plan-preview patch');
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/enabled.*reload/i),
      'Reload Window',
    );
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  test('disabling plan rendering restores the host and offers Reload Window', async () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    setMacroConfig({ renderPlanPreview: true });
    activate(context);
    expect(readHost()).toContain('KaTeX plan-preview patch');
    const changed = mockOnDidChangeConfiguration.mock.calls[0][0];
    mockShowInformationMessage.mockClear();
    mockShowInformationMessage.mockResolvedValueOnce('Reload Window');
    setMacroConfig({ renderPlanPreview: false });

    await changed({ affectsConfiguration: (name) => name === 'claudeCodeKatex.renderPlanPreview' });
    await Promise.resolve();

    expect(readHost()).toBe(PLAN_HOST_SOURCE);
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringMatching(/disabled.*reload/i),
      'Reload Window',
    );
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  test('handles Claude Code not being installed without throwing', () => {
    mockGetExtension.mockReturnValue(undefined);
    expect(() => activate(context)).not.toThrow();
    expect(mockRegisterCommand).toHaveBeenCalled();
  });
});

// ============================================================
// Reload Macros command
//
// Macros are read at activation and refreshed only on request, so this command
// is the whole refresh story. Each row of its behavior matters: it must never
// rewrite Claude Code's bundle when nothing changed, and must still work on a
// patch applied by a build that knew nothing about macros.
// ============================================================
describe('Reload Macros command', () => {
  let context;
  const getHandler = (name) => mockRegisterCommand.mock.calls.find((c) => c[0] === name)[1];
  const reload = () => getHandler('claude-code-katex.reloadMacros')();

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
  });

  test('errors when Claude Code is not installed', () => {
    activate(context);
    mockGetExtension.mockReturnValue(undefined);
    reload();
    expect(mockShowErrorMessage).toHaveBeenCalledWith('Claude Code extension not found.');
  });

  test('reports "not active" when the webview is unpatched', () => {
    activate(context);
    removePatch(extDir);
    mockShowInformationMessage.mockClear();
    reload();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('not active'),
    );
  });

  test('writes nothing when the macros have not changed', () => {
    setMacroConfig({ macros: { '\\RR': '\\mathbb{R}' } });
    activate(context);
    const before = readJs();
    mockExecuteCommand.mockClear();

    reload();

    expect(readJs()).toBe(before);
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
    expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining('unchanged'));
  });

  test('rewrites the block and reloads the webview when a macro changed', () => {
    setMacroConfig({ macros: { '\\RR': '\\mathbb{R}' } });
    activate(context);
    const before = readJs();

    setMacroConfig({ macros: { '\\RR': '\\mathbb{Q}' } });
    reload();

    const after = readJs();
    expect(after).not.toBe(before);
    expect(after).toContain('\\\\mathbb{Q}');
    expect(_test.getMacroHash(after)).not.toBe(_test.getMacroHash(before));
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
  });

  test('adds macros to a patch applied before any were configured', () => {
    activate(context);
    expect(readJs()).not.toContain(_test.MACRO_BEGIN);

    setMacroConfig({ macros: { '\\RR': '\\mathbb{R}' } });
    reload();

    expect(readJs()).toContain(_test.MACRO_BEGIN);
    expect(_test.getMacroHash(readJs())).toBeTruthy();
    // Still exactly one patch, not a patch applied on top of a patch.
    expect(readJs().split(PATCH_MARKER).length - 1).toBe(1);
  });

  test('removes the block when the macros are unconfigured again', () => {
    setMacroConfig({ macros: { '\\RR': '\\mathbb{R}' } });
    activate(context);

    setMacroConfig({});
    reload();

    expect(readJs()).not.toContain(_test.MACRO_BEGIN);
    expect(_test.getMacroHash(readJs())).toBeNull();
  });

  test('reports which files could not be read', () => {
    setMacroConfig({ macroFiles: ['/definitely/not/here.tex'] });
    activate(context);
    mockShowInformationMessage.mockClear();
    mockShowWarningMessage.mockClear();
    reload();
    const shown = [...mockShowInformationMessage.mock.calls, ...mockShowWarningMessage.mock.calls]
      .map((c) => String(c[0])).join(' | ');
    expect(shown).toContain('here.tex');
  });
});

// ============================================================
// What the user actually reads
//
// The popup text is the only feedback anyone gets about why a macro did or did
// not load, and no other test looks at the wording. These pin the exact
// strings for the cases a user hits.
// ============================================================
describe('macro status wording', () => {
  let context;
  const getHandler = (name) => mockRegisterCommand.mock.calls.find((c) => c[0] === name)[1];
  const statusText = () => {
    getHandler('claude-code-katex.status')();
    return String(mockShowInformationMessage.mock.calls.at(-1)[0]);
  };

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    // The REAL vendor directory, so the report runs the real ingestion against
    // the real shipping KaTeX — the mock vendor's stub katex would make every
    // count zero and the assertions meaningless.
    context = { extensionPath: __dirname, subscriptions: [] };
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
  });

  test('says so plainly when nothing is configured', () => {
    activate(context);
    expect(statusText()).toContain('Macros: no macros configured');
  });

  test('counts the macros that loaded', () => {
    setMacroConfig({ macros: { '\\RR': '\\mathbb{R}', '\\ZZ': '\\mathbb{Z}' } });
    activate(context);
    expect(statusText()).toContain('Macros: 2 macros loaded');
  });

  test('uses the singular for one macro', () => {
    setMacroConfig({ macros: { '\\RR': '\\mathbb{R}' } });
    activate(context);
    expect(statusText()).toContain('Macros: 1 macro loaded');
  });

  test('names a file it could not read, with the reason', () => {
    const missing = path.join(tmpDir, 'not-here.tex');
    setMacroConfig({ macroFiles: [missing] });
    activate(context);
    const text = statusText();
    expect(text).toContain('could not read');
    expect(text).toContain('not-here.tex');
  });

  test('reports how many definitions were skipped', () => {
    const file = path.join(tmpDir, 'macros.tex');
    fs.writeFileSync(file, [
      '\\newcommand{\\RR}{\\mathbb{R}}',
      '\\newenvironment{thm}{}{}',
    ].join('\n'));
    setMacroConfig({ macroFiles: [file] });
    activate(context);
    expect(statusText()).toContain('1 macro loaded, 1 skipped, from 1 file');
  });
});

// ============================================================
// activate — macros
// ============================================================
describe('activate with macros', () => {
  let context;
  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
  });

  test('embeds configured macros when it patches', () => {
    setMacroConfig({ macros: { '\\RR': '\\mathbb{R}' } });
    activate(context);
    expect(readJs()).toContain(_test.MACRO_BEGIN);
  });

  test('picks up a macro edited between sessions without re-patching', () => {
    setMacroConfig({ macros: { '\\RR': '\\mathbb{R}' } });
    activate(context);
    const first = _test.getMacroHash(readJs());

    setMacroConfig({ macros: { '\\RR': '\\mathbb{Q}' } });
    mockExecuteCommand.mockClear();
    activate(context);

    expect(_test.getMacroHash(readJs())).not.toBe(first);
    expect(readJs().split(PATCH_MARKER).length - 1).toBe(1);
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
  });

  test('does nothing when neither the version nor the macros changed', () => {
    setMacroConfig({ macros: { '\\RR': '\\mathbb{R}' } });
    activate(context);
    const before = readJs();
    mockExecuteCommand.mockClear();

    activate(context);

    expect(readJs()).toBe(before);
    expect(mockExecuteCommand).not.toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
  });
});

// ============================================================
// Enable command
// ============================================================
describe('Enable command', () => {
  let context;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
  });

  const getHandler = (name) => mockRegisterCommand.mock.calls.find((c) => c[0] === name)[1];

  test('patches, reloads the webview, and notifies when not patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    removePatch(extDir);
    mockExecuteCommand.mockClear();
    mockShowInformationMessage.mockClear();

    getHandler('claude-code-katex.enable')();

    expect(isPatched(extDir)).toBe(true);
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX enabled. The webview was reloaded; reload again if any math still looks unrendered.',
      'Reload Webview', 'Reload Window'
    );
  });

  test('shows "already active" when already patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    mockShowInformationMessage.mockClear();
    getHandler('claude-code-katex.enable')();
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Claude Code LaTeX is already active.');
  });

  test('warns (unsupported) when the injection point is not found', () => {
    setupFakeClaudeCodeExt(FIXTURE_NO_INJECT);
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    mockShowWarningMessage.mockClear();
    getHandler('claude-code-katex.enable')();
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('could not apply its patch'),
      'Check for Updates', 'Report an Issue'
    );
  });

  test('shows error when Claude Code not found', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    mockGetExtension.mockReturnValue(undefined);
    getHandler('claude-code-katex.enable')();
    expect(mockShowErrorMessage).toHaveBeenCalledWith('Claude Code extension not found.');
  });
});

// ============================================================
// Disable command
// ============================================================
describe('Disable command', () => {
  let context;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
  });

  const getHandler = (name) => mockRegisterCommand.mock.calls.find((c) => c[0] === name)[1];

  test('removes the patch, reloads the webview, and notifies when patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    mockExecuteCommand.mockClear();
    mockShowInformationMessage.mockClear();

    getHandler('claude-code-katex.disable')();

    expect(isPatched(extDir)).toBe(false);
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX disabled. The webview was reloaded.',
      'Reload Webview', 'Reload Window'
    );
  });

  test('shows "not active" when not patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    removePatch(extDir);
    mockShowInformationMessage.mockClear();
    getHandler('claude-code-katex.disable')();
    expect(mockShowInformationMessage).toHaveBeenCalledWith('Claude Code LaTeX is not active.');
  });

  test('shows error when Claude Code not found', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    mockGetExtension.mockReturnValue(undefined);
    getHandler('claude-code-katex.disable')();
    expect(mockShowErrorMessage).toHaveBeenCalledWith('Claude Code extension not found.');
  });
});

// ============================================================
// Status command
// ============================================================
describe('Status command', () => {
  let context;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
  });

  const getHandler = (name) => mockRegisterCommand.mock.calls.find((c) => c[0] === name)[1];

  test('reports Active with reload/disable actions when patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    mockShowInformationMessage.mockClear();
    getHandler('claude-code-katex.status')();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Active'), 'Reload Webview', 'Reload Macros', 'Reload Window', 'Disable');
  });

  test('reports the macro configuration', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    setMacroConfig({ macros: { '\\RR': '\\mathbb{R}' } });
    activate(context);
    mockShowInformationMessage.mockClear();
    getHandler('claude-code-katex.status')();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Macros:'), expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  test('reports Not active with enable/reload actions when not patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    removePatch(extDir);
    mockShowInformationMessage.mockClear();
    getHandler('claude-code-katex.status')();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Not active'), 'Enable', 'Reload Window');
  });

  test('"Reload Webview" action reloads the webview', async () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    mockExecuteCommand.mockClear();
    mockShowInformationMessage.mockResolvedValueOnce('Reload Webview');
    getHandler('claude-code-katex.status')();
    await Promise.resolve(); await Promise.resolve();
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
  });

  test('"Disable" action delegates to the disable command', async () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    mockExecuteCommand.mockClear();
    mockShowInformationMessage.mockResolvedValueOnce('Disable');
    getHandler('claude-code-katex.status')();
    await Promise.resolve(); await Promise.resolve();
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-code-katex.disable');
  });

  test('"Enable" action delegates to the enable command when not patched', async () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    removePatch(extDir);
    mockExecuteCommand.mockClear();
    mockShowInformationMessage.mockResolvedValueOnce('Enable');
    getHandler('claude-code-katex.status')();
    await Promise.resolve(); await Promise.resolve();
    expect(mockExecuteCommand).toHaveBeenCalledWith('claude-code-katex.enable');
  });

  test('shows message when Claude Code not found', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    mockGetExtension.mockReturnValue(undefined);
    getHandler('claude-code-katex.status')();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Claude Code extension not found.'));
  });
});

// ============================================================
// onDidChange (Claude Code updates)
// ============================================================
describe('onDidChange (Claude Code update)', () => {
  let context;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    context = { extensionPath: tmpDir, subscriptions: [] };
  });

  test('re-patches when Claude Code updates (files overwritten)', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(isPatched(extDir)).toBe(true);

    // Simulate a Claude Code update: a fresh, unpatched webview bundle.
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), FIXTURE_JS);
    expect(isPatched(extDir)).toBe(false);

    mockExecuteCommand.mockClear();
    mockOnDidChange.mock.calls[0][0]();

    expect(isPatched(extDir)).toBe(true);
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Claude Code LaTeX re-applied after a Claude Code update. The webview was reloaded; reload again if any math still looks unrendered.',
      'Reload Webview', 'Reload Window'
    );
  });

  test('does not re-patch when already patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    mockShowInformationMessage.mockClear();
    mockOnDidChange.mock.calls[0][0]();
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('re-applied'), 'Reload Webview', 'Reload Window'
    );
  });
});

// ============================================================
// reloadWebviewAndNotify
// ============================================================
describe('reloadWebviewAndNotify', () => {
  const { reloadWebviewAndNotify } = _test;

  test('reloads the webview immediately', () => {
    reloadWebviewAndNotify('hello');
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');
  });

  test('shows the message with Reload Webview before Reload Window', () => {
    reloadWebviewAndNotify('hello');
    expect(mockShowInformationMessage).toHaveBeenCalledWith('hello', 'Reload Webview', 'Reload Window');
  });

  test('"Reload Webview" button reloads the webview again', async () => {
    mockShowInformationMessage.mockResolvedValueOnce('Reload Webview');
    reloadWebviewAndNotify('hello');
    await Promise.resolve(); await Promise.resolve();
    const reloads = mockExecuteCommand.mock.calls.filter(
      (c) => c[0] === 'workbench.action.webview.reloadWebviewAction'
    );
    expect(reloads.length).toBe(2);
  });

  test('"Reload Window" button triggers a full window reload', async () => {
    mockShowInformationMessage.mockResolvedValueOnce('Reload Window');
    reloadWebviewAndNotify('hello');
    await Promise.resolve(); await Promise.resolve();
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });
});

// ============================================================
// notifyUnsupported
// ============================================================
describe('notifyUnsupported', () => {
  const { notifyUnsupported, ISSUES_URL } = _test;

  test('shows a warning with "Check for Updates" and "Report an Issue"', () => {
    notifyUnsupported();
    expect(mockShowWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('could not apply its patch'),
      'Check for Updates', 'Report an Issue'
    );
  });

  test('"Check for Updates" runs the extensions update command', async () => {
    mockShowWarningMessage.mockResolvedValueOnce('Check for Updates');
    notifyUnsupported();
    await Promise.resolve(); await Promise.resolve();
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.extensions.action.checkForUpdates');
  });

  test('"Report an Issue" opens the issue tracker', async () => {
    mockShowWarningMessage.mockResolvedValueOnce('Report an Issue');
    notifyUnsupported();
    await Promise.resolve(); await Promise.resolve();
    expect(mockOpenExternal).toHaveBeenCalledWith(ISSUES_URL);
  });
});

// ============================================================
// deactivate
// ============================================================
describe('deactivate', () => {
  test('is a function and does not throw', () => {
    expect(typeof deactivate).toBe('function');
    expect(() => deactivate()).not.toThrow();
  });

  test('does not remove patches (intentionally empty)', () => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    applyPatch(extDir, vendorDir);
    deactivate();
    expect(isPatched(extDir)).toBe(true);
  });
});

// ============================================================
// Edge cases
// ============================================================
describe('edge cases', () => {
  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
  });

  test('removePatch is idempotent (no backup = no-op)', () => {
    expect(removePatch(extDir)).toBe(false);
    expect(readJs()).toBe(FIXTURE_JS);
  });

  test('large bundle (simulating the real ~5MB webview) patches and restores', () => {
    const large = '// ' + 'x'.repeat(1024 * 1024) + '\n' + FIXTURE_JS;
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), large);
    expect(applyPatch(extDir, vendorDir)).toBe(true);
    expect(isPatched(extDir)).toBe(true);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'utf8')).toBe(large);
    removePatch(extDir);
    expect(readJs()).toBe(large);
  });

  test('the patched bundle keeps the marker exactly once', () => {
    applyPatch(extDir, vendorDir);
    expect(readJs().split(PATCH_MARKER).length - 1).toBe(1);
  });
});

// ============================================================
// Annotation pop-up (opt-in, claudeCodeKatex.annotate)
// ============================================================
describe('annotation pop-up', () => {
  const { ensurePatched, hasAnnotate, ANNOTATE_MARKER, ANNOTATE_CSS_BEGIN } = _test;

  beforeEach(() => {
    setupFakeClaudeCodeExt();
    setupFakeVendorDir();
    fs.writeFileSync(path.join(vendorDir, 'annotate.js'), '/* annotate mock */');
    fs.writeFileSync(path.join(vendorDir, 'annotate.css'), '/* annotate css mock */');
  });

  test('off by default: no block, no CSS', () => {
    applyPatch(extDir, vendorDir);
    expect(hasAnnotate(readJs())).toBe(false);
    expect(readJs()).not.toContain('annotate mock');
    expect(readCss()).not.toContain(ANNOTATE_CSS_BEGIN);
  });

  test('when enabled: block after the math bundle, CSS inside the CSS patch', () => {
    applyPatch(extDir, vendorDir, undefined, undefined, true);
    const js = readJs();
    expect(js.indexOf(ANNOTATE_MARKER)).toBeGreaterThan(js.indexOf(_test.BUNDLE_ANCHOR));
    expect(js.indexOf('/* annotate mock */')).toBeLessThan(js.indexOf('original claude code webview js'));
    const css = readCss();
    expect(css).toContain('/* annotate css mock */');
    expect(css.indexOf(ANNOTATE_CSS_BEGIN)).toBeLessThan(css.indexOf('/* === End KaTeX CSS Patch === */'));
  });

  test('enabled but the vendor files are missing: patches without the pop-up', () => {
    fs.unlinkSync(path.join(vendorDir, 'annotate.js'));
    expect(applyPatch(extDir, vendorDir, undefined, undefined, true)).toBe(true);
    expect(hasAnnotate(readJs())).toBe(false);
  });

  test('turning it on re-applies the patch once, with the pop-up', () => {
    applyPatch(extDir, vendorDir);
    expect(ensurePatched(extDir, vendorDir, undefined, true)).toBe('refreshed');
    expect(hasAnnotate(readJs())).toBe(true);
    expect(readJs().split(PATCH_MARKER).length - 1).toBe(1);
  });

  test('turning it off restores the zero-config patch exactly', () => {
    applyPatch(extDir, vendorDir);
    const plainJs = readJs();
    const plainCss = readCss();
    ensurePatched(extDir, vendorDir, undefined, true);
    expect(ensurePatched(extDir, vendorDir, undefined, false)).toBe('refreshed');
    expect(readJs()).toBe(plainJs);
    expect(readCss()).toBe(plainCss);
  });

  test('"current" when the setting matches the applied patch', () => {
    applyPatch(extDir, vendorDir, undefined, undefined, true);
    expect(ensurePatched(extDir, vendorDir, undefined, true)).toBe('current');
  });

  test('activate reads the setting and patches with the pop-up', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    setMacroConfig({ annotate: true });
    activate({ extensionPath: tmpDir, subscriptions: [] });
    expect(hasAnnotate(readJs())).toBe(true);
  });

  test('changing the setting re-patches and reloads the webview', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate({ extensionPath: tmpDir, subscriptions: [] });
    expect(hasAnnotate(readJs())).toBe(false);
    const onChange = mockOnDidChangeConfiguration.mock.calls[mockOnDidChangeConfiguration.mock.calls.length - 1][0];

    setMacroConfig({ annotate: true });
    mockExecuteCommand.mockClear();
    onChange({ affectsConfiguration: (k) => k === 'claudeCodeKatex.annotate' });
    expect(hasAnnotate(readJs())).toBe(true);
    expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.action.webview.reloadWebviewAction');

    mockExecuteCommand.mockClear();
    onChange({ affectsConfiguration: (k) => k === 'claudeCodeKatex.macros' });
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });
});
