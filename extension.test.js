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
const mockGetExtension = jest.fn();
const mockOpenExternal = jest.fn();
const mockStatusBarItem = {
  text: '', tooltip: '', command: '',
  show: jest.fn(), hide: jest.fn(), dispose: jest.fn(),
};
const mockCreateStatusBarItem = jest.fn().mockReturnValue(mockStatusBarItem);

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
  env: { openExternal: mockOpenExternal },
  Uri: { parse: (s) => s },
  StatusBarAlignment: { Left: 1, Right: 2 },
}), { virtual: true });

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
  return extDir;
}

function setupFakeVendorDir() {
  vendorDir = path.join(tmpDir, 'vendor');
  const fontsDir = path.join(vendorDir, 'fonts');
  fs.mkdirSync(fontsDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, 'katex.min.js'), '/* katex core mock */');
  fs.writeFileSync(path.join(vendorDir, 'remark-math-bundle.js'), '/* bundle mock */ window.__KATEX_V2_LOADED=true;');
  fs.writeFileSync(path.join(vendorDir, 'katex.min.css'), '/* katex css mock */');
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'katex-test-'));
  jest.clearAllMocks();
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

  test('does not overwrite existing backups', () => {
    applyPatch(extDir, vendorDir);
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'PRESERVED');
    fs.writeFileSync(path.join(extDir, 'webview', 'index.js'), FIXTURE_JS); // un-patch on disk
    applyPatch(extDir, vendorDir);
    expect(fs.readFileSync(path.join(extDir, 'webview', 'index.js.katex-bak'), 'utf8')).toBe('PRESERVED');
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

  test('registers 3 commands', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    const registered = mockRegisterCommand.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(expect.arrayContaining([
      'claude-code-katex.enable',
      'claude-code-katex.disable',
      'claude-code-katex.status',
    ]));
    expect(registered).not.toContain('claude-code-katex.rerender');
    expect(registered.length).toBe(3);
  });

  test('creates a status bar item wired to the status command', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(mockCreateStatusBarItem).toHaveBeenCalledWith(2 /* Right */, 100);
    expect(mockStatusBarItem.show).toHaveBeenCalled();
    expect(mockStatusBarItem.command).toBe('claude-code-katex.status');
    expect(mockStatusBarItem.text).toMatch(/LaTeX/);
  });

  test('pushes 5 disposables (3 commands + status bar + onDidChange)', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(context.subscriptions.length).toBe(5);
  });

  test('registers an onDidChange watcher', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    activate(context);
    expect(mockOnDidChange).toHaveBeenCalled();
  });

  test('handles Claude Code not being installed without throwing', () => {
    mockGetExtension.mockReturnValue(undefined);
    expect(() => activate(context)).not.toThrow();
    expect(mockRegisterCommand).toHaveBeenCalled();
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

  test('reports Active when patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    mockShowInformationMessage.mockClear();
    getHandler('claude-code-katex.status')();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Active'));
  });

  test('reports Not active when not patched', () => {
    mockGetExtension.mockReturnValue({ extensionPath: extDir });
    applyPatch(extDir, vendorDir);
    activate(context);
    removePatch(extDir);
    mockShowInformationMessage.mockClear();
    getHandler('claude-code-katex.status')();
    expect(mockShowInformationMessage).toHaveBeenCalledWith(expect.stringContaining('Not active'));
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
