// Tests for the v2 patch: injecting the remark-math pipeline into Claude
// Code's react-markdown call, and reporting "unsupported" (patching nothing)
// when the injection point is absent.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

jest.mock('vscode', () => ({
  window: {},
  commands: { registerCommand: jest.fn(), executeCommand: jest.fn() },
  extensions: { getExtension: jest.fn(), onDidChange: jest.fn() },
  env: { openExternal: jest.fn() },
  Uri: { parse: (s) => s },
  StatusBarAlignment: { Left: 1, Right: 2 },
}), { virtual: true });

const { _test } = require('./extension');
const VENDOR = path.join(__dirname, 'vendor');

// A minimal stand-in for Claude Code's webview bundle carrying the real
// react-markdown call: createElement(<Markdown>,{remarkPlugins:[<gfm>],
// components:{...}},<text>).
const FIXTURE_WITH = 'var a=1;' +
  'var el=B8.default.createElement(Co,{remarkPlugins:[yf],components:{a:1,pre:2}},Y);' +
  'console.log(el);';
// The same call as Claude Code 2.1.186+ ships it: the JSX factory minified to
// a short alias (`b(...)`) rather than longhand `createElement(...)`.
const FIXTURE_WITH_ALIAS = 'var a=1;' +
  'var el=b(QZ,{remarkPlugins:[GR],components:{a:1,pre:2}},Y);' +
  'console.log(el);';
// 2.1.296: the helper chooses a Windows file-link plugin and URL transform.
const FIXTURE_WITH_SPREAD = 'var pl0=[gfm],gl0=[gfm,windowsLinks];' +
  'function ul0($,J){return $==="live"&&J==="windows"?' +
  '{remarkPlugins:gl0,urlTransform:fileUrl}:{remarkPlugins:pl0,urlTransform:void 0}}' +
  'var el=F(Markdown,{...ul0(links,platform),components:{a:1},children:source});';
// A bundle whose react-markdown call shape the patch cannot find.
const FIXTURE_WITHOUT = 'var a=1;var el=B8.default.createElement(Co,{components:{a:1}},Y);';

function makeExtDir(jsBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccv2-'));
  fs.mkdirSync(path.join(dir, 'webview'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'webview', 'index.js'), jsBody);
  fs.writeFileSync(path.join(dir, 'webview', 'index.css'), '/* cc css */');
  return dir;
}
const readJs = (d) => fs.readFileSync(path.join(d, 'webview', 'index.js'), 'utf8');
const isValidJs = (code) => { try { new vm.Script(code); return true; } catch { return false; } };

describe('v2 injection regex', () => {
  test('matches the real react-markdown call shape', () => {
    expect(_test.V2_INJECT_RE.test('B8.default.createElement(Co,{remarkPlugins:[yf],components:{}})')).toBe(true);
  });
  test('matches a multi-plugin list', () => {
    expect(_test.V2_INJECT_RE.test('createElement(M,{remarkPlugins:[gfm,foo]}')).toBe(true);
  });
  test('matches a minified JSX factory alias (Claude Code 2.1.186+)', () => {
    // 2.1.186 shipped the call as `b(QZ,{remarkPlugins:[GR],...})` instead of
    // the longhand `createElement(...)`. The factory name is captured, not
    // hard-coded, so the short-alias form still matches.
    const m = 'var el=b(QZ,{remarkPlugins:[GR],components:{a:1}})'.match(_test.V2_INJECT_RE);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('b');   // factory
    expect(m[2]).toBe('QZ');  // Markdown component
    expect(m[3]).toBe('GR');  // existing plugin list
  });
  test('does not match an unrelated createElement call', () => {
    expect(_test.V2_INJECT_RE.test('createElement("div",{className:"x"})')).toBe(false);
  });
});

describe('applyPatch — injection point present', () => {
  let dir, pristineJs, pristineCss;
  beforeEach(() => {
    dir = makeExtDir(FIXTURE_WITH);
    pristineJs = readJs(dir);
    pristineCss = fs.readFileSync(path.join(dir, 'webview', 'index.css'), 'utf8');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('returns true', () => {
    expect(_test.applyPatch(dir, VENDOR)).toBe(true);
  });
  test('stamps the patch marker and this version', () => {
    _test.applyPatch(dir, VENDOR);
    expect(_test.isPatched(dir)).toBe(true);
    expect(_test.getPatchedVersion(dir)).toBe(_test.EXTENSION_VERSION);
  });
  test('injects guarded plugin references into the call', () => {
    _test.applyPatch(dir, VENDOR);
    const js = readJs(dir);
    expect(js).toContain('rehypePlugins:window.__KATEX_V2_LOADED?[window.__rehypeKatex]:[]');
    expect(js).toContain('[yf].concat(window.__KATEX_V2_LOADED?[window.__remarkBracketMath,window.__remarkMath]:[])');
    expect(js).not.toContain('{remarkPlugins:[yf],components:'); // original consumed
  });
  test('bundles the remark-math pipeline', () => {
    _test.applyPatch(dir, VENDOR);
    expect(readJs(dir)).toContain('__KATEX_V2_LOADED');
  });
  test('the patched bundle is still syntactically valid JavaScript', () => {
    _test.applyPatch(dir, VENDOR);
    expect(isValidJs(readJs(dir))).toBe(true);
  });
  test('copies KaTeX fonts and patches CSS', () => {
    _test.applyPatch(dir, VENDOR);
    expect(fs.readdirSync(path.join(dir, 'webview', 'fonts')).length).toBeGreaterThan(50);
    expect(fs.readFileSync(path.join(dir, 'webview', 'index.css'), 'utf8')).toContain('.katex-display');
  });
  test('removePatch restores index.js / index.css byte-identically', () => {
    _test.applyPatch(dir, VENDOR);
    _test.removePatch(dir);
    expect(readJs(dir)).toBe(pristineJs);
    expect(fs.readFileSync(path.join(dir, 'webview', 'index.css'), 'utf8')).toBe(pristineCss);
    expect(fs.existsSync(path.join(dir, 'webview', 'fonts'))).toBe(false);
  });
});

describe('applyPatch — minified JSX factory alias (Claude Code 2.1.186+)', () => {
  let dir, pristineJs;
  beforeEach(() => {
    dir = makeExtDir(FIXTURE_WITH_ALIAS);
    pristineJs = readJs(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('patches the short-alias call, preserving the factory and component', () => {
    expect(_test.applyPatch(dir, VENDOR)).toBe(true);
    const js = readJs(dir);
    // The original factory (`b`) and component (`QZ`) are kept verbatim.
    expect(js).toContain('b(QZ,{rehypePlugins:window.__KATEX_V2_LOADED?[window.__rehypeKatex]:[]');
    expect(js).toContain('[GR].concat(window.__KATEX_V2_LOADED?[window.__remarkBracketMath,window.__remarkMath]:[])');
    expect(js).not.toContain('{remarkPlugins:[GR],components:'); // original consumed
    expect(isValidJs(js)).toBe(true);
  });
  test('removePatch restores the alias bundle byte-identically', () => {
    _test.applyPatch(dir, VENDOR);
    _test.removePatch(dir);
    expect(readJs(dir)).toBe(pristineJs);
  });
});

describe('applyPatch — injection point absent (unsupported)', () => {
  let dir;
  beforeEach(() => { dir = makeExtDir(FIXTURE_WITHOUT); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('returns false', () => {
    expect(_test.applyPatch(dir, VENDOR)).toBe(false);
  });
  test('touches nothing — no patch, no backup, no fonts', () => {
    _test.applyPatch(dir, VENDOR);
    expect(readJs(dir)).toBe(FIXTURE_WITHOUT);
    expect(_test.isPatched(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'webview', 'index.js.katex-bak'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'webview', 'fonts'))).toBe(false);
  });
  test('ensurePatched reports "unsupported"', () => {
    expect(_test.ensurePatched(dir, VENDOR)).toBe('unsupported');
  });
});

describe('spread plugin props (Claude Code 2.1.296)', () => {
  test.each(['windows', 'darwin', 'linux'])('preserves %s plugins and URL handling', (platform) => {
    const patched = _test.injectMathPlugins(FIXTURE_WITH_SPREAD);
    expect(patched).not.toBeNull();
    const context = {
      window: { __KATEX_V2_LOADED: true, __rehypeKatex: 'katex',
        __remarkBracketMath: 'brackets', __remarkMath: 'math' },
      gfm: 'gfm', windowsLinks: 'windows', fileUrl: 'url',
      F: (_, props) => props, Markdown: {}, links: 'live', platform, source: '$x$',
    };
    vm.runInNewContext(patched, context);
    expect(Array.from(context.el.remarkPlugins)).toEqual(
      (platform === 'windows' ? ['gfm', 'windows'] : ['gfm']).concat(['brackets', 'math']));
    expect(Array.from(context.el.rehypePlugins)).toEqual(['katex']);
    expect(context.el.urlTransform).toBe(platform === 'windows' ? 'url' : undefined);
    expect(context.el.children).toBe('$x$');
    expect(context.el.components.a).toBe(1);
  });

  test('leaves helper props unchanged when the math bundle fails to load', () => {
    const context = { window: {}, gfm: 'gfm', windowsLinks: 'windows', fileUrl: 'url',
      F: (_, props) => props, Markdown: {}, links: 'live', platform: 'windows', source: '$x$' };
    vm.runInNewContext(_test.injectMathPlugins(FIXTURE_WITH_SPREAD), context);
    expect(Array.from(context.el.remarkPlugins)).toEqual(['gfm', 'windows']);
    expect(context.el.rehypePlugins).toBeUndefined();
    expect(context.el.urlTransform).toBe('url');
  });

  test('evaluates the helper once and appends to existing rehype plugins', () => {
    const source = FIXTURE_WITH_SPREAD.replace('...ul0(links,platform)', '...props(links,platform)') +
      'function props(a,b){calls++;return a?{remarkPlugins:[gfm],rehypePlugins:[existing]}:{remarkPlugins:[]}}';
    const context = { calls: 0, window: { __KATEX_V2_LOADED: true, __rehypeKatex: 'katex',
      __remarkBracketMath: 'brackets', __remarkMath: 'math' },
      gfm: 'gfm', windowsLinks: 'windows', fileUrl: 'url', existing: 'existing',
      F: (_, props) => props, Markdown: {}, links: 'live', platform: 'windows', source: '$x$' };
    vm.runInNewContext(_test.injectMathPlugins(source), context);
    expect(context.calls).toBe(1);
    expect(Array.from(context.el.rehypePlugins)).toEqual(['existing', 'katex']);
  });

  test('accepts dollar signs in minified helper identifiers', () => {
    expect(_test.injectMathPlugins(FIXTURE_WITH_SPREAD.replaceAll('ul0', '$l0'))).not.toBeNull();
  });

  test.each([
    FIXTURE_WITH_SPREAD.replaceAll('remarkPlugins:', 'otherPlugins:'),
    FIXTURE_WITH_SPREAD + FIXTURE_WITH_SPREAD,
    FIXTURE_WITH_SPREAD + FIXTURE_WITH_ALIAS,
    FIXTURE_WITH_ALIAS + FIXTURE_WITH_ALIAS,
  ])('rejects unrelated or ambiguous call sites without touching disk', (source) => {
    const dir = makeExtDir(source);
    try {
      expect(_test.applyPatch(dir, VENDOR)).toBe(false);
      expect(readJs(dir)).toBe(source);
      expect(fs.existsSync(path.join(dir, 'webview', 'index.js.katex-bak'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'webview', 'fonts'))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('applies the full patch, compiles, and restores byte-identically', () => {
    const dir = makeExtDir(FIXTURE_WITH_SPREAD);
    try {
      expect(_test.applyPatch(dir, VENDOR)).toBe(true);
      expect(isValidJs(readJs(dir))).toBe(true);
      _test.removePatch(dir);
      expect(readJs(dir)).toBe(FIXTURE_WITH_SPREAD);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// Opportunistic: if a *pristine* real Claude Code bundle is on disk, patch a
// copy of it and confirm the injection still produces valid JS against the
// real shape. A bundle the extension already patched is skipped (its injection
// point is consumed) — its .katex-bak holds the pristine original, so prefer
// that.
describe('applyPatch — against the real Claude Code bundle (if present)', () => {
  const candidates = (() => {
    const out = [];
    const bases = [
      path.join(os.homedir(), '.vscode', 'extensions'),
      path.join(os.homedir(), '.vscode-server', 'extensions'),
      path.join(os.homedir(), '.local', 'share', 'code-server', 'extensions'),
    ];
    for (const base of bases) {
      try {
        for (const d of fs.readdirSync(base)) {
          if (!d.startsWith('anthropic.claude-code-')) continue;
          for (const f of ['webview/index.js.katex-bak', 'webview/index.js']) {
            const p = path.join(base, d, f);
            if (fs.existsSync(p) && !fs.readFileSync(p, 'utf8').includes(_test.PATCH_MARKER)) {
              out.push(p); // a confirmed-pristine source
              break;
            }
          }
        }
      } catch { /* no extensions dir — skip */ }
    }
    return out;
  })();

  (candidates.length ? test.each(candidates) : test.skip)('patches a real bundle copy to valid JS: %s', (candidate) => {
    const real = fs.readFileSync(candidate, 'utf8');
    const dir = makeExtDir(real);
    try {
      expect(_test.applyPatch(dir, VENDOR)).toBe(true);
      expect(isValidJs(readJs(dir))).toBe(true);
      _test.removePatch(dir);
      expect(readJs(dir)).toBe(real);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
