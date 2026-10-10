// Lifecycle tests for the plan approval view patch (issue #17).
//
// plan-patch.test.js proves the transform itself. These tests cover what the
// extension does with it on disk, which is the part that touches a file the
// user did not install from us: back up first, refuse to write anything that
// does not compile, refresh only from a pristine backup, and restore cleanly.
const fs = require('fs');
const path = require('path');
const os = require('os');

jest.mock('vscode', () => ({
  window: {},
  commands: { registerCommand: jest.fn(), executeCommand: jest.fn() },
  extensions: { getExtension: jest.fn(), onDidChange: jest.fn() },
  workspace: { getConfiguration: jest.fn(), workspaceFolders: undefined },
  env: { openExternal: jest.fn() },
  Uri: { parse: (s) => s },
  StatusBarAlignment: { Left: 1, Right: 2 },
}), { virtual: true });

const { _test } = require('./extension');
const {
  ensurePlanPatched,
  syncPlanPreview,
  removePlanPatch,
  isPlanPatched,
  readPlanAssets,
  ensurePatched,
  removePatch,
  EXTENSION_VERSION,
} = _test;
const plan = require('./plan-patch');

// The two call sites the patch anchors on, in the shape Claude Code ships.
const HOST_SOURCE = [
  'var wr={parse:function(s){return s}};',
  'function Ta(){return "n0nce"}',
  'var U_r=`<html><body><div id="content"></div></body></html>`;',
  'function $_r(e){let t=wr.parse(e);return typeof t==="string"?t:""}',
  'function F_r(){let e=Ta();return U_r.replaceAll("{{NONCE}}",e)}',
].join('\n');

const WEBVIEW_SOURCE =
  'var el=R.createElement(Md,{remarkPlugins:[gfm],components:{a:1}},src);\nconsole.log("cc");';

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'katex-plan-'));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const makeExtDir = (hostSource = HOST_SOURCE) => {
  const dir = path.join(tmp, 'anthropic.claude-code-1.0.0');
  fs.mkdirSync(path.join(dir, 'webview'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.js'), hostSource);
  fs.writeFileSync(path.join(dir, 'webview', 'index.js'), WEBVIEW_SOURCE);
  fs.writeFileSync(path.join(dir, 'webview', 'index.css'), '/* cc css */');
  return dir;
};

const makeVendorDir = () => {
  const dir = path.join(tmp, 'vendor');
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'katex.min.js'), 'window.katex={render:function(){}};');
  fs.writeFileSync(path.join(dir, 'remark-math-bundle.js'), '/* BUNDLE */ window.__KATEX_V2_LOADED=true;');
  fs.writeFileSync(path.join(dir, 'katex.min.css'), '.katex{font:inherit}');
  fs.writeFileSync(path.join(dir, 'copy-tex.min.js'), '/* copytex */');
  fs.writeFileSync(path.join(dir, 'fonts', 'KaTeX_Main-Regular.woff2'), 'font');
  return dir;
};

const payload = (hash) => (hash
  ? { preamble: '\\newcommand{\\R}{\\mathbb{R}}', macros: {}, isEmpty: false, hash, sources: [] }
  : { preamble: '', macros: {}, isEmpty: true, hash: null, sources: [] });

const host = (dir) => fs.readFileSync(path.join(dir, 'extension.js'), 'utf8');

describe('ensurePlanPatched', () => {
  test('patches a pristine host bundle and keeps a backup of the original', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();

    expect(ensurePlanPatched(dir, vendor, payload())).toBe('applied');
    expect(isPlanPatched(dir)).toBe(true);
    expect(plan.getPlanPatchVersion(host(dir))).toBe(EXTENSION_VERSION);
    expect(fs.readFileSync(path.join(dir, 'extension.js.katex-bak'), 'utf8')).toBe(HOST_SOURCE);
  });

  test('is a no-op the second time', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();
    ensurePlanPatched(dir, vendor, payload());
    const after = host(dir);

    expect(ensurePlanPatched(dir, vendor, payload())).toBe('current');
    expect(host(dir)).toBe(after);
  });

  test('re-applies from the original when the macros change', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();
    ensurePlanPatched(dir, vendor, payload());

    expect(ensurePlanPatched(dir, vendor, payload('abc123'))).toBe('applied');
    expect(plan.getPlanMacroHash(host(dir))).toBe('abc123');
    // Patched once, not twice: the block appears a single time.
    expect(host(dir).split(plan.PLAN_BEGIN).length - 1).toBe(1);
    expect(host(dir).split('__KATEX_PLAN_MD||').length - 1).toBe(1);
  });

  test('leaves a stale patch alone when the backup cannot be trusted', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();
    ensurePlanPatched(dir, vendor, payload());
    const patched = host(dir);
    // A backup that is itself patched is not a backup.
    fs.writeFileSync(path.join(dir, 'extension.js.katex-bak'), patched);

    expect(ensurePlanPatched(dir, vendor, payload('abc123'))).toBe('skipped');
    expect(host(dir)).toBe(patched);
  });

  test('does not touch a host bundle it does not recognize', () => {
    const dir = makeExtDir('function whatever(){return 1}');
    const vendor = makeVendorDir();

    expect(ensurePlanPatched(dir, vendor, payload())).toBe('unsupported');
    expect(host(dir)).toBe('function whatever(){return 1}');
    expect(isPlanPatched(dir)).toBe(false);
  });

  test('an asset that is not valid JavaScript is still safe to embed', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();
    // Assets ride as string literals, so even a corrupt KaTeX build cannot
    // make Claude Code's host bundle unparseable.
    fs.writeFileSync(path.join(vendor, 'katex.min.js'), 'function ( {');

    expect(ensurePlanPatched(dir, vendor, payload())).toBe('applied');
    expect(() => new (require('vm').Script)(host(dir))).not.toThrow();
  });

  test('a patch result that does not compile is never written', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();
    const spy = jest.spyOn(plan, 'applyPlanPatch').mockReturnValue({ ok: true, source: 'function ( {' });

    expect(ensurePlanPatched(dir, vendor, payload())).toBe('failed');
    expect(host(dir)).toBe(HOST_SOURCE);
    spy.mockRestore();
  });

  test('leaves no temp file behind', () => {
    const dir = makeExtDir();
    ensurePlanPatched(dir, makeVendorDir(), payload());
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.katex-tmp'))).toEqual([]);
  });
});

describe('removePlanPatch', () => {
  test('restores the original host bundle byte for byte', () => {
    const dir = makeExtDir();
    ensurePlanPatched(dir, makeVendorDir(), payload());

    expect(removePlanPatch(dir)).toBe(true);
    expect(host(dir)).toBe(HOST_SOURCE);
    expect(isPlanPatched(dir)).toBe(false);
    // The backup stays, so Enable can re-apply without a Claude Code reinstall.
    expect(fs.existsSync(path.join(dir, 'extension.js.katex-bak'))).toBe(true);
  });

  test('does nothing when there is no patch to remove', () => {
    const dir = makeExtDir();
    expect(removePlanPatch(dir)).toBe(false);
    expect(host(dir)).toBe(HOST_SOURCE);
  });

  test('refuses to restore from a backup that is itself patched', () => {
    const dir = makeExtDir();
    ensurePlanPatched(dir, makeVendorDir(), payload());
    const patched = host(dir);
    fs.writeFileSync(path.join(dir, 'extension.js.katex-bak'), patched);

    expect(removePlanPatch(dir)).toBe(false);
    expect(host(dir)).toBe(patched);
  });
});

describe('with the webview patch', () => {
  test('the automatic webview patch leaves the plan panel untouched', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();

    expect(ensurePatched(dir, vendor, payload())).toBe('fresh');
    expect(isPlanPatched(dir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'webview', 'index.js'), 'utf8')).toContain('__KATEX_V2_LOADED');
  });

  test('enabling plan rendering applies the host patch', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();

    expect(syncPlanPreview(dir, vendor, payload(), true)).toBe('applied');
    expect(isPlanPatched(dir)).toBe(true);
  });

  test('disabling plan rendering restores the host bundle', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();
    syncPlanPreview(dir, vendor, payload(), true);

    expect(syncPlanPreview(dir, vendor, payload(), false)).toBe('removed');
    expect(host(dir)).toBe(HOST_SOURCE);
    expect(isPlanPatched(dir)).toBe(false);
  });

  test('removePatch restores both when plan rendering was enabled', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();
    ensurePatched(dir, vendor, payload());
    syncPlanPreview(dir, vendor, payload(), true);

    expect(removePatch(dir)).toBe(true);
    expect(host(dir)).toBe(HOST_SOURCE);
    expect(fs.readFileSync(path.join(dir, 'webview', 'index.js'), 'utf8')).toBe(WEBVIEW_SOURCE);
  });

  test('a Claude Code build with no plan panel still gets the chat patch', () => {
    const dir = makeExtDir('function whatever(){return 1}');
    const vendor = makeVendorDir();

    expect(syncPlanPreview(dir, vendor, payload(), true)).toBe('unsupported');
    expect(isPlanPatched(dir)).toBe(false);
  });

  test('disabling is idempotent when the host bundle is missing', () => {
    const dir = makeExtDir();
    const vendor = makeVendorDir();
    fs.rmSync(path.join(dir, 'extension.js'));

    expect(syncPlanPreview(dir, vendor, payload(), false)).toBe('current');
  });
});

describe('plan preview configuration', () => {
  const setting = require('./package.json').contributes.configuration.properties
    ['claudeCodeKatex.renderPlanPreview'];

  test('is opt-in and explains that it modifies Claude Code host code', () => {
    expect(setting.default).toBe(false);
    expect(setting.type).toBe('boolean');
    expect(setting.markdownDescription).toMatch(/experimental/i);
    expect(setting.markdownDescription).toMatch(/host `extension\.js`/);
    expect(setting.markdownDescription).toMatch(/reload/i);
  });
});

describe('readPlanAssets', () => {
  test('bundles KaTeX, the stylesheet with inlined fonts, and macro ingestion', () => {
    const assets = readPlanAssets(path.join(__dirname, 'vendor'), payload('abc123'));
    expect(assets.js).toContain('katex');
    expect(assets.css).toContain('data:font/woff2;base64,');
    expect(assets.css).not.toContain('url(fonts/');
    expect(assets.copyTex).not.toBe('');
    expect(assets.macroIngestSource).toContain('ingestMacros');
    expect(assets.macroHash).toBe('abc123');
    expect(assets.version).toBe(EXTENSION_VERSION);
  });

  test('reports no macros when none are configured', () => {
    const assets = readPlanAssets(path.join(__dirname, 'vendor'), payload());
    expect(assets.macroPayload).toBeNull();
    expect(assets.macroHash).toBe('none');
  });

  test('a missing copy-tex contrib is not fatal', () => {
    const vendor = makeVendorDir();
    fs.rmSync(path.join(vendor, 'copy-tex.min.js'));
    expect(readPlanAssets(vendor, payload()).copyTex).toBe('');
  });
});
