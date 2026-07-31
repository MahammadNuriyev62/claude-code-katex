// Tests for the macro payload: resolving the configured sources, embedding
// them in the patched webview bundle, and updating them in place afterwards.
//
// The embedding is the dangerous part. The payload is user-controlled text
// spliced into a multi-megabyte JS file that Claude Code loads, and the
// in-place update finds its region by markers — so a macro file containing the
// end marker, a `*/`, or a stray quote must be incapable of truncating the
// block or corrupting the bundle. Those cases are tested by round-tripping
// through a real JS parse, not by eyeballing the string.
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

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
  resolveMacroPath,
  readMacroSources,
  buildMacroPayload,
  renderMacroBlock,
  applyMacroBlock,
  getMacroHash,
  applyPatch,
  ensurePatched,
  MACRO_BEGIN,
  MACRO_END,
  MACRO_LIMITS,
} = _test;

const FIXTURE_JS =
  'var el=R.createElement(Md,{remarkPlugins:[gfm],components:{a:1}},src);\nconsole.log("cc");';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'katex-macros-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const write = (name, content) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
};

const makeExtDir = () => {
  const dir = path.join(tmp, 'anthropic.claude-code-1.0.0');
  fs.mkdirSync(path.join(dir, 'webview'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'webview', 'index.js'), FIXTURE_JS);
  fs.writeFileSync(path.join(dir, 'webview', 'index.css'), '/* cc css */');
  return dir;
};

const makeVendorDir = () => {
  const dir = path.join(tmp, 'vendor');
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'katex.min.js'), '/* KATEX CORE */');
  fs.writeFileSync(path.join(dir, 'remark-math-bundle.js'), '/* BUNDLE */ window.__KATEX_V2_LOADED=true;');
  fs.writeFileSync(path.join(dir, 'katex.min.css'), '/* css */');
  fs.writeFileSync(path.join(dir, 'copy-tex.min.js'), '/* copytex */');
  fs.writeFileSync(path.join(dir, 'fonts', 'KaTeX_Main.woff2'), 'font');
  return dir;
};

const readJs = (extDir) => fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');

// Runs the generated block the way the webview would and returns the globals
// it set. Proves the embedding is both valid JS and lossless.
const evalBlock = (block) => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  new vm.Script(block).runInContext(sandbox);
  return sandbox.window;
};

// ============================================================
// resolveMacroPath
// ============================================================
describe('resolveMacroPath', () => {
  const ctx = { home: '/home/u', workspaceFolder: '/ws' };

  test('expands ~ to the home directory', () => {
    expect(resolveMacroPath('~/tex/m.tex', ctx)).toBe(path.join('/home/u', 'tex/m.tex'));
  });

  test('expands ${workspaceFolder}', () => {
    expect(resolveMacroPath('${workspaceFolder}/m.tex', ctx)).toBe(path.join('/ws', 'm.tex'));
  });

  test('expands ${userHome}', () => {
    expect(resolveMacroPath('${userHome}/m.tex', ctx)).toBe(path.join('/home/u', 'm.tex'));
  });

  test('leaves an absolute path alone', () => {
    expect(resolveMacroPath('/etc/macros.tex', ctx)).toBe(path.resolve('/etc/macros.tex'));
  });

  test('resolves a relative path against the workspace folder', () => {
    expect(resolveMacroPath('macros.tex', ctx)).toBe(path.join('/ws', 'macros.tex'));
  });

  test('returns null for a relative path when no workspace is open', () => {
    expect(resolveMacroPath('macros.tex', { home: '/home/u', workspaceFolder: null })).toBeNull();
  });

  test('returns null for ${workspaceFolder} when no workspace is open', () => {
    expect(resolveMacroPath('${workspaceFolder}/m.tex', { home: '/home/u', workspaceFolder: null })).toBeNull();
  });

  test('returns null for junk input', () => {
    expect(resolveMacroPath('', ctx)).toBeNull();
    expect(resolveMacroPath(undefined, ctx)).toBeNull();
    expect(resolveMacroPath(42, ctx)).toBeNull();
  });
});

// ============================================================
// readMacroSources
// ============================================================
describe('readMacroSources', () => {
  const ctx = () => ({ home: tmp, workspaceFolder: tmp });

  test('reads a file into the preamble', () => {
    write('a.tex', '\\newcommand{\\RR}{\\mathbb{R}}');
    const r = readMacroSources(['a.tex'], ctx());
    expect(r.preamble).toContain('\\newcommand{\\RR}');
    expect(r.sources[0].error).toBeUndefined();
  });

  test('concatenates several files in the configured order', () => {
    write('a.tex', 'FIRST');
    write('b.tex', 'SECOND');
    const r = readMacroSources(['a.tex', 'b.tex'], ctx());
    expect(r.preamble.indexOf('FIRST')).toBeLessThan(r.preamble.indexOf('SECOND'));
  });

  test('a missing file is reported but does not stop the others', () => {
    write('good.tex', 'GOOD');
    const r = readMacroSources(['nope.tex', 'good.tex'], ctx());
    expect(r.preamble).toContain('GOOD');
    expect(r.sources.find((s) => s.path.endsWith('nope.tex')).error).toBeTruthy();
  });

  test('a directory is reported as an error, not a crash', () => {
    fs.mkdirSync(path.join(tmp, 'adir'));
    const r = readMacroSources(['adir'], ctx());
    expect(r.sources[0].error).toBeTruthy();
    expect(r.preamble).toBe('');
  });

  test('a file over the per-file cap is skipped and reported', () => {
    write('big.tex', 'x'.repeat(MACRO_LIMITS.maxFileBytes + 10));
    write('small.tex', 'SMALL');
    const r = readMacroSources(['big.tex', 'small.tex'], ctx());
    expect(r.sources[0].error).toMatch(/too large/i);
    expect(r.preamble).toContain('SMALL');
  });

  test('strips a UTF-8 BOM', () => {
    write('bom.tex', '﻿\\newcommand{\\RR}{1}');
    const r = readMacroSources(['bom.tex'], ctx());
    expect(r.preamble.startsWith('﻿')).toBe(false);
    expect(r.preamble).toContain('\\newcommand');
  });

  test('stops at the total cap and says so', () => {
    // Each file sits exactly on the per-file cap, so it is the TOTAL cap that
    // has to stop the third one.
    write('one.tex', 'a'.repeat(MACRO_LIMITS.maxFileBytes));
    write('two.tex', 'b'.repeat(MACRO_LIMITS.maxFileBytes));
    write('three.tex', 'LAST');
    const r = readMacroSources(['one.tex', 'two.tex', 'three.tex'], ctx());
    expect(r.truncated).toBe(true);
    expect(r.preamble).not.toContain('LAST');
  });

  test('an unreadable path never throws', () => {
    expect(() => readMacroSources(['\0bad'], ctx())).not.toThrow();
  });
});

// ============================================================
// buildMacroPayload
// ============================================================
describe('buildMacroPayload', () => {
  const ctx = () => ({ home: tmp, workspaceFolder: tmp });

  test('no files and no inline macros is empty', () => {
    const p = buildMacroPayload({ macroFiles: [], macros: {} }, ctx());
    expect(p.isEmpty).toBe(true);
  });

  test('inline macros alone are not empty', () => {
    const p = buildMacroPayload({ macroFiles: [], macros: { '\\RR': '\\mathbb{R}' } }, ctx());
    expect(p.isEmpty).toBe(false);
  });

  test('a file whose every path failed is still empty', () => {
    const p = buildMacroPayload({ macroFiles: ['nope.tex'], macros: {} }, ctx());
    expect(p.isEmpty).toBe(true);
  });

  test('the hash is stable for identical content', () => {
    write('a.tex', 'CONTENT');
    const one = buildMacroPayload({ macroFiles: ['a.tex'], macros: { '\\A': '1' } }, ctx());
    const two = buildMacroPayload({ macroFiles: ['a.tex'], macros: { '\\A': '1' } }, ctx());
    expect(one.hash).toBe(two.hash);
  });

  test('the hash changes when the file content changes', () => {
    write('a.tex', 'ONE');
    const before = buildMacroPayload({ macroFiles: ['a.tex'], macros: {} }, ctx()).hash;
    write('a.tex', 'TWO');
    const after = buildMacroPayload({ macroFiles: ['a.tex'], macros: {} }, ctx()).hash;
    expect(after).not.toBe(before);
  });

  test('the hash changes when an inline macro changes', () => {
    const before = buildMacroPayload({ macroFiles: [], macros: { '\\A': '1' } }, ctx()).hash;
    const after = buildMacroPayload({ macroFiles: [], macros: { '\\A': '2' } }, ctx()).hash;
    expect(after).not.toBe(before);
  });

  test('junk configuration does not throw', () => {
    expect(() => buildMacroPayload({}, ctx())).not.toThrow();
    expect(() => buildMacroPayload({ macroFiles: 'not-an-array', macros: null }, ctx())).not.toThrow();
    expect(() => buildMacroPayload(null, ctx())).not.toThrow();
  });
});

// ============================================================
// renderMacroBlock — the embedding
// ============================================================
describe('renderMacroBlock', () => {
  const payloadFor = (preamble, macros) => ({
    preamble,
    macros: macros || {},
    hash: 'deadbeef',
    isEmpty: false,
  });

  test('is valid JS and sets both globals', () => {
    const w = evalBlock(renderMacroBlock(payloadFor('\\newcommand{\\RR}{\\mathbb{R}}', { '\\A': '1' })));
    expect(w.__KATEX_USER_PREAMBLE).toBe('\\newcommand{\\RR}{\\mathbb{R}}');
    expect(w.__KATEX_USER_MACROS).toEqual({ '\\A': '1' });
  });

  test('round-trips quotes, backslashes and newlines', () => {
    const nasty = 'a "quoted" \\ backslash\nsecond \'line\'\n\\def\\x#1{"#1"}';
    const w = evalBlock(renderMacroBlock(payloadFor(nasty)));
    expect(w.__KATEX_USER_PREAMBLE).toBe(nasty);
  });

  test('round-trips a comment terminator without ending the comment', () => {
    const nasty = '\\newcommand{\\a}{*/}  /* and an opener */';
    const w = evalBlock(renderMacroBlock(payloadFor(nasty)));
    expect(w.__KATEX_USER_PREAMBLE).toBe(nasty);
  });

  test('round-trips a script tag', () => {
    const nasty = '\\newcommand{\\a}{</script><script>alert(1)</script>}';
    const w = evalBlock(renderMacroBlock(payloadFor(nasty)));
    expect(w.__KATEX_USER_PREAMBLE).toBe(nasty);
  });

  test('round-trips U+2028 and U+2029', () => {
    const nasty = 'before middle after';
    const w = evalBlock(renderMacroBlock(payloadFor(nasty)));
    expect(w.__KATEX_USER_PREAMBLE).toBe(nasty);
  });

  test('a preamble containing the end marker cannot close the block early', () => {
    const nasty = `\\newcommand{\\evil}{1} ${MACRO_END} trailing`;
    const block = renderMacroBlock(payloadFor(nasty));
    // Exactly one real terminator, at the very end.
    expect(block.indexOf(MACRO_END)).toBe(block.length - MACRO_END.length);
    expect(evalBlock(block).__KATEX_USER_PREAMBLE).toBe(nasty);
  });

  test('carries the hash', () => {
    expect(renderMacroBlock(payloadFor('x'))).toContain('deadbeef');
  });
});

// ============================================================
// applyPatch with a payload
// ============================================================
describe('applyPatch with macros', () => {
  const payload = () => buildMacroPayload(
    { macroFiles: [], macros: { '\\RR': '\\mathbb{R}' } },
    { home: tmp, workspaceFolder: tmp },
  );

  test('embeds the block after KaTeX core and before the math bundle', () => {
    const extDir = makeExtDir();
    expect(applyPatch(extDir, makeVendorDir(), payload())).toBe(true);
    const js = readJs(extDir);
    expect(js.indexOf('/* KATEX CORE */')).toBeLessThan(js.indexOf(MACRO_BEGIN));
    expect(js.indexOf(MACRO_BEGIN)).toBeLessThan(js.indexOf('/* BUNDLE */'));
  });

  test('the patched bundle is still valid JavaScript', () => {
    const extDir = makeExtDir();
    applyPatch(extDir, makeVendorDir(), payload());
    expect(() => new vm.Script(readJs(extDir))).not.toThrow();
  });

  test('emits no block at all when no macros are configured', () => {
    const extDir = makeExtDir();
    applyPatch(extDir, makeVendorDir(), buildMacroPayload({ macroFiles: [], macros: {} }, { home: tmp, workspaceFolder: tmp }));
    expect(readJs(extDir)).not.toContain(MACRO_BEGIN);
  });

  test('emits no block when no payload is passed at all', () => {
    const extDir = makeExtDir();
    applyPatch(extDir, makeVendorDir());
    expect(readJs(extDir)).not.toContain(MACRO_BEGIN);
  });

  test('getMacroHash reads back what was embedded', () => {
    const extDir = makeExtDir();
    const p = payload();
    applyPatch(extDir, makeVendorDir(), p);
    expect(getMacroHash(readJs(extDir))).toBe(p.hash);
  });

  test('getMacroHash is null for a patch without macros', () => {
    const extDir = makeExtDir();
    applyPatch(extDir, makeVendorDir());
    expect(getMacroHash(readJs(extDir))).toBeNull();
  });
});

// ============================================================
// applyMacroBlock — the in-place update
// ============================================================
describe('applyMacroBlock', () => {
  const ctx = () => ({ home: tmp, workspaceFolder: tmp });
  const setup = () => {
    const extDir = makeExtDir();
    const first = buildMacroPayload({ macroFiles: [], macros: { '\\A': '1' } }, ctx());
    applyPatch(extDir, makeVendorDir(), first);
    return { extDir, first, body: readJs(extDir) };
  };

  test('replaces only the marked region, leaving the rest byte-identical', () => {
    const { body, first } = setup();
    const second = buildMacroPayload({ macroFiles: [], macros: { '\\B': '2' } }, ctx());
    const updated = applyMacroBlock(body, second);

    const strip = (s) => s.slice(0, s.indexOf(MACRO_BEGIN)) + s.slice(s.indexOf(MACRO_END) + MACRO_END.length);
    expect(strip(updated)).toBe(strip(body));
    expect(updated).toContain(second.hash);
    expect(updated).not.toContain(first.hash);
  });

  test('is idempotent for the same payload', () => {
    const { body } = setup();
    const p = buildMacroPayload({ macroFiles: [], macros: { '\\B': '2' } }, ctx());
    expect(applyMacroBlock(applyMacroBlock(body, p), p)).toBe(applyMacroBlock(body, p));
  });

  test('keeps the result valid JavaScript', () => {
    const { body } = setup();
    write('m.tex', '\\newcommand{\\q}{"*/"}\n% a comment\n');
    const p = buildMacroPayload({ macroFiles: ['m.tex'], macros: {} }, ctx());
    expect(() => new vm.Script(applyMacroBlock(body, p))).not.toThrow();
  });

  test('a macro file containing the end marker cannot truncate the bundle', () => {
    const { body } = setup();
    write('evil.tex', `\\newcommand{\\a}{1} ${MACRO_END} \\newcommand{\\b}{2}`);
    const p = buildMacroPayload({ macroFiles: ['evil.tex'], macros: {} }, ctx());
    const updated = applyMacroBlock(body, p);
    expect(() => new vm.Script(updated)).not.toThrow();
    // Everything that followed the block is still there.
    expect(updated).toContain('/* BUNDLE */');
    expect(updated).toContain('console.log("cc")');
    expect(getMacroHash(updated)).toBe(p.hash);
  });

  test('returns null when the body has no macro block', () => {
    const extDir = makeExtDir();
    applyPatch(extDir, makeVendorDir());
    expect(applyMacroBlock(readJs(extDir), buildMacroPayload({ macroFiles: [], macros: { '\\A': '1' } }, ctx()))).toBeNull();
  });

  test('removes the block when the new payload is empty', () => {
    const { body } = setup();
    const updated = applyMacroBlock(body, buildMacroPayload({ macroFiles: [], macros: {} }, ctx()));
    expect(updated).not.toContain(MACRO_BEGIN);
    expect(updated).toContain('/* BUNDLE */');
    expect(getMacroHash(updated)).toBeNull();
  });
});

// ============================================================
// The whole seam: file -> payload -> embedded block -> ingestion -> render
//
// Every other test here stops at the block, and the harness tests start from
// hand-written globals. This closes the gap between them: the exact text the
// extension writes into Claude Code's bundle is parsed as JS and fed to the
// real ingestion against the real shipping KaTeX.
// ============================================================
describe('end to end: a macro file becomes rendered math', () => {
  test('a realistic macros.tex survives embedding and renders', () => {
    write('macros.tex', [
      '% my shortcuts',
      '\\usepackage{amsmath}',
      '\\newcommand{\\RR}{\\mathbb{R}}',
      '\\DeclareMathOperator{\\myspan}{span}',
      '\\newcommand{\\weird}{\\text{*/}}',
    ].join('\n'));

    const payload = buildMacroPayload(
      { macroFiles: ['macros.tex'], macros: { '\\ZZ': '\\mathbb{Z}' } },
      { home: tmp, workspaceFolder: tmp },
    );

    // Exactly what the webview would see.
    const globals = evalBlock(renderMacroBlock(payload));

    const { ingestMacros } = require('./macro-ingest');
    const katex = require('./vendor/katex.min.js');
    const report = ingestMacros(katex, globals.__KATEX_USER_PREAMBLE, globals.__KATEX_USER_MACROS);

    expect(report.loaded).toBe(3);
    expect(report.skipped).toEqual([]);
    const html = katex.renderToString('\\RR \\myspan(v) \\ZZ \\weird', {
      macros: { ...report.macros },
      throwOnError: true,
    });
    expect(html).toContain('mathbb');
    expect(html).toContain('span');
  });
});

// ============================================================
// ensurePatched — macro changes between sessions
// ============================================================
describe('ensurePatched with macros', () => {
  const ctx = () => ({ home: tmp, workspaceFolder: tmp });

  test('applies the block on a fresh patch', () => {
    const extDir = makeExtDir();
    const p = buildMacroPayload({ macroFiles: [], macros: { '\\A': '1' } }, ctx());
    expect(ensurePatched(extDir, makeVendorDir(), p)).toBe('fresh');
    expect(getMacroHash(readJs(extDir))).toBe(p.hash);
  });

  test('reports current and writes nothing when macros are unchanged', () => {
    const extDir = makeExtDir();
    const vendorDir = makeVendorDir();
    const p = buildMacroPayload({ macroFiles: [], macros: { '\\A': '1' } }, ctx());
    ensurePatched(extDir, vendorDir, p);
    const before = readJs(extDir);
    expect(ensurePatched(extDir, vendorDir, p)).toBe('current');
    expect(readJs(extDir)).toBe(before);
  });

  test('updates the block in place when only the macros changed', () => {
    const extDir = makeExtDir();
    const vendorDir = makeVendorDir();
    ensurePatched(extDir, vendorDir, buildMacroPayload({ macroFiles: [], macros: { '\\A': '1' } }, ctx()));
    const next = buildMacroPayload({ macroFiles: [], macros: { '\\A': '2' } }, ctx());

    expect(ensurePatched(extDir, vendorDir, next)).toBe('macros-updated');
    expect(getMacroHash(readJs(extDir))).toBe(next.hash);
    // A single patch, not a re-application on top of itself.
    expect(readJs(extDir).split(_test.PATCH_MARKER).length - 1).toBe(1);
  });

  test('adds a block to a patch that never had one', () => {
    const extDir = makeExtDir();
    const vendorDir = makeVendorDir();
    ensurePatched(extDir, vendorDir);
    const p = buildMacroPayload({ macroFiles: [], macros: { '\\A': '1' } }, ctx());
    expect(ensurePatched(extDir, vendorDir, p)).toBe('macros-updated');
    expect(getMacroHash(readJs(extDir))).toBe(p.hash);
  });
});
