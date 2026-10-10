// Level 1 tests for the plan approval view patch (issue #17).
//
// Two things are being proven here:
//   1. the patch only ever fires on a bundle with the exact shape it expects,
//      and what it produces is valid JavaScript;
//   2. math survives Markdown verbatim — the entire reason the patch works on
//      the host side instead of repairing the rendered DOM.
//
// (2) is tested against a stand-in for marked that reproduces the two ways
// CommonMark destroys LaTeX: it collapses backslash escapes (`\[` -> `[`,
// `\\` -> `\`) and HTML-escapes what is left. Any renderer that saw the plan
// text after that has already lost the math.

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const plan = require('./plan-patch');

// --- a stand-in for Claude Code's host bundle ------------------------------
//
// Byte-identical in shape to the two call sites the patch anchors on, as they
// appear in Claude Code 2.1.220 through 2.1.239.
const FAKE_MD_FN = 'function $_r(e){let t=wr.parse(e);return typeof t==="string"?t:""}';
const FAKE_HTML_FN = 'function F_r(){let e=Ta();return U_r.replaceAll("{{NONCE}}",e)}';
const FAKE_BUNDLE = [
  'var wr={parse:function(s){return s}};',
  'function Ta(){return "abc123"}',
  'var U_r=`<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
    'style-src \'unsafe-inline\'; script-src \'nonce-{{NONCE}}\'; img-src data:;"></head>' +
    '<body><div id="content"></div></body></html>`;',
  FAKE_MD_FN,
  FAKE_HTML_FN,
  'module.exports={md:$_r,html:F_r};',
].join('\n');

const ASSETS = {
  css: '.katex{font:inherit}',
  js: 'window.katex={render:function(){}};',
  macroIngestSource: '',
  macroPayload: null,
  macroHash: 'none',
  version: '9.9.9',
};

// The host runtime, installed on a throwaway global exactly as the patch
// installs it into the extension host.
function installHostRuntime() {
  const sandbox = { globalThis: null, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext('(' + plan.planHostRuntime.toString() + ')();', sandbox);
  return sandbox;
}

// What CommonMark does to a plan before any DOM-level renderer could see it.
function markedLike(src) {
  return '<p>' + String(src)
    .replace(/\\([\\[\]()$*_{}])/g, '$1')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;') + '</p>';
}

function renderPlan(markdown) {
  const sandbox = installHostRuntime();
  return sandbox.__KATEX_PLAN_MD(markdown, markedLike);
}

// The LaTeX of every math span the patch emitted, unescaped.
function mathSpans(html) {
  const out = [];
  const re = /<span class="katex-plan-math (katex-plan-display|katex-plan-inline)">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({
      display: m[1] === 'katex-plan-display',
      tex: m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    });
  }
  return out;
}

describe('anchors', () => {
  test('each call site matches exactly once in the stand-in bundle', () => {
    expect((FAKE_BUNDLE.match(new RegExp(plan.PLAN_MD_RE.source, 'g')) || []).length).toBe(1);
    expect((FAKE_BUNDLE.match(new RegExp(plan.PLAN_HTML_RE.source, 'g')) || []).length).toBe(1);
  });

  // The real thing, when it is on this machine. Docker and CI have no VS Code
  // install, so this is a bonus check rather than a gate.
  const roots = [
    path.join(os.homedir(), '.vscode', 'extensions'),
    path.join(os.homedir(), '.vscode-server', 'extensions'),
    path.join(os.homedir(), '.cursor', 'extensions'),
  ];
  const installed = roots.flatMap((root) => {
    try {
      return fs.readdirSync(root)
        .filter((e) => e.startsWith('anthropic.claude-code-'))
        .map((e) => path.join(root, e, 'extension.js'))
        .filter((p) => fs.existsSync(p));
    } catch {
      return [];
    }
  });

  const maybe = installed.length ? test : test.skip;
  maybe('each call site matches exactly once in every installed Claude Code', () => {
    for (const file of installed) {
      const body = fs.readFileSync(file, 'utf8');
      if (!body.includes('claudePlanPreview')) continue; // no plan panel in this build
      const md = (body.match(new RegExp(plan.PLAN_MD_RE.source, 'g')) || []).length;
      const html = (body.match(new RegExp(plan.PLAN_HTML_RE.source, 'g')) || []).length;
      expect({ file, md, html }).toEqual({ file, md: 1, html: 1 });
    }
  });
});

describe('applyPlanPatch', () => {
  test('produces source that compiles and keeps both call sites callable', () => {
    const result = plan.applyPlanPatch(FAKE_BUNDLE, ASSETS);
    expect(result.ok).toBe(true);
    expect(() => new vm.Script(result.source)).not.toThrow();

    const sandbox = { module: { exports: {} }, globalThis: null, console, window: {} };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(result.source, sandbox);

    // The Markdown call site still renders Markdown...
    expect(sandbox.module.exports.md('plain text')).toBe('plain text');
    // ...and now lifts math out of it.
    expect(sandbox.module.exports.md('see $x^2$ here')).toContain('katex-plan-inline');
    // The HTML call site still returns the panel document, now carrying KaTeX.
    const html = sandbox.module.exports.html();
    expect(html).toContain('id="katex-plan-style"');
    expect(html).toContain('<script nonce="abc123">');
    expect(html).toContain('font-src data:;');
    expect(html.indexOf('id="katex-plan-style"')).toBeLessThan(html.indexOf('</body>'));
  });

  test('stamps the extension version and macro hash', () => {
    const result = plan.applyPlanPatch(FAKE_BUNDLE, { ...ASSETS, macroHash: 'deadbeef1234' });
    expect(plan.isPlanPatched(result.source)).toBe(true);
    expect(plan.getPlanPatchVersion(result.source)).toBe('9.9.9');
    expect(plan.getPlanMacroHash(result.source)).toBe('deadbeef1234');
  });

  test('refuses a bundle it has already patched', () => {
    const once = plan.applyPlanPatch(FAKE_BUNDLE, ASSETS);
    const twice = plan.applyPlanPatch(once.source, ASSETS);
    expect(twice.ok).toBe(false);
    expect(twice.reason).toBe('already patched');
  });

  test('refuses a bundle without the expected shape, touching nothing', () => {
    const reshaped = FAKE_BUNDLE.replace(FAKE_MD_FN, 'function $_r(e){return wr.render(e)}');
    const result = plan.applyPlanPatch(reshaped, ASSETS);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/markdown call site matched 0 times/);
    expect(result.source).toBeUndefined();
  });

  test('refuses an ambiguous bundle where a call site matches twice', () => {
    const doubled = FAKE_BUNDLE + '\n' + FAKE_HTML_FN.replace('F_r', 'G_r');
    const result = plan.applyPlanPatch(doubled, ASSETS);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/panel HTML call site matched 2 times/);
  });

  test('refuses an asset that would close its own tag in the panel document', () => {
    const result = plan.applyPlanPatch(FAKE_BUNDLE, { ...ASSETS, js: 'var a="</script>";' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('asset contains a closing tag');
  });

  test('no payload can terminate the injected block early', () => {
    const result = plan.applyPlanPatch(FAKE_BUNDLE, {
      ...ASSETS,
      css: '/* === End KaTeX plan-preview patch === */ */ .x{}',
    });
    expect(result.ok).toBe(true);
    expect(() => new vm.Script(result.source)).not.toThrow();
    // The marker appears once: as the patch's own terminator.
    expect(result.source.split(plan.PLAN_END).length - 1).toBe(1);
  });
});

describe('math survives Markdown verbatim', () => {
  test('display $$...$$ keeps its row separators', () => {
    const html = renderPlan('$$\n\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}\n$$');
    const spans = mathSpans(html);
    expect(spans).toHaveLength(1);
    expect(spans[0].display).toBe(true);
    expect(spans[0].tex).toContain('\\\\');
    expect(spans[0].tex).toContain('\\begin{bmatrix}');
  });

  test('\\[ ... \\] survives, which it cannot after CommonMark', () => {
    const source = 'Then:\n\n\\[ E = mc^2 \\]\n';
    expect(markedLike(source)).not.toContain('\\['); // the delimiters are gone
    const spans = mathSpans(renderPlan(source));
    expect(spans).toHaveLength(1);
    expect(spans[0].display).toBe(true);
    expect(spans[0].tex.trim()).toBe('E = mc^2');
  });

  test('\\( ... \\) is inline math', () => {
    const spans = mathSpans(renderPlan('the value \\(x_1\\) is fixed'));
    expect(spans).toHaveLength(1);
    expect(spans[0].display).toBe(false);
    expect(spans[0].tex).toBe('x_1');
  });

  test('an amsmath row separator with a length argument is not read as display math', () => {
    const spans = mathSpans(renderPlan('$$\\begin{aligned} a &= b \\\\[6pt] c &= d \\end{aligned}$$'));
    expect(spans).toHaveLength(1);
    expect(spans[0].tex).toContain('\\\\[6pt]');
  });

  test('a row separator right before the closing $$ does not swallow the document', () => {
    // `\\` is an escaped backslash, so the `$$` after it closes the block. A
    // naive "is the previous char a backslash" check reads it as escaped and
    // runs on until the next `$$`, eating the prose in between.
    const html = renderPlan('$$\\begin{matrix} a \\\\ b \\\\$$\n\nProse after. And $z$ later.');
    const spans = mathSpans(html);
    expect(spans.map((s) => s.display)).toEqual([true, false]);
    expect(spans[0].tex.endsWith('\\\\')).toBe(true);
    expect(spans[1].tex).toBe('z');
    expect(html).toContain('Prose after.');
  });

  test('an escaped dollar is not a delimiter', () => {
    expect(mathSpans(renderPlan('a \\$5 fee and $x$ too')).map((s) => s.tex)).toEqual(['x']);
  });

  test('inline $...$ is math but currency is not', () => {
    const spans = mathSpans(renderPlan('It costs $5 and $10, while $y = 3$ holds.'));
    expect(spans.map((s) => s.tex)).toEqual(['y = 3']);
  });

  test('a price range stays literal', () => {
    expect(mathSpans(renderPlan('between $50 and $100 per seat'))).toHaveLength(0);
  });

  test('math is escaped for HTML, not interpreted as markup', () => {
    const html = renderPlan('$a < b$ and $c > d$');
    expect(html).toContain('&lt; b');
    expect(mathSpans(html).map((s) => s.tex)).toEqual(['a < b', 'c > d']);
  });

  test('LaTeX inside code stays code', () => {
    const source = [
      'Use `$x$` for inline math.',
      '',
      '```latex',
      '$$ \\frac{a}{b} $$',
      '```',
      '',
      'Real math: $z$',
    ].join('\n');
    const spans = mathSpans(renderPlan(source));
    expect(spans.map((s) => s.tex)).toEqual(['z']);
  });

  test('an unterminated delimiter is left alone', () => {
    expect(mathSpans(renderPlan('costs $5 for the first item'))).toHaveLength(0);
    expect(mathSpans(renderPlan('an open $$ fence with no close'))).toHaveLength(0);
  });

  test('\\leftroot / \\uproot are dropped, as in the chat pipeline', () => {
    const spans = mathSpans(renderPlan('$\\sqrt[\\leftroot{-2}\\uproot{2}n]{x}$'));
    expect(spans[0].tex).toBe('\\sqrt[n]{x}');
  });

  test('\\eqref resolves to the \\tag of the labeled equation', () => {
    const source = [
      '$$ a = b \\tag{4} \\label{eq:key} $$',
      '',
      'From \\eqref{eq:key} and \\ref{eq:key} it follows.',
    ].join('\n');
    const html = renderPlan(source);
    expect(html).toContain('From (4) and 4 it follows.');
  });

  test('an unresolved reference is left for the KaTeX macros', () => {
    const html = renderPlan('See $\\eqref{eq:nowhere}$.');
    expect(mathSpans(html)[0].tex).toBe('\\eqref{eq:nowhere}');
  });

  test('text with no math is handed to Markdown untouched', () => {
    const sandbox = installHostRuntime();
    const seen = [];
    sandbox.__KATEX_PLAN_MD('# Plan\n\nNo math here.', (s) => { seen.push(s); return 'HTML'; });
    expect(seen).toEqual(['# Plan\n\nNo math here.']);
  });

  test('a Markdown failure is never made worse by the patch', () => {
    const sandbox = installHostRuntime();
    expect(() => sandbox.__KATEX_PLAN_MD('$x$', () => { throw new Error('boom'); })).toThrow('boom');
    // A non-string from Markdown yields '' — Claude Code's own contract.
    expect(sandbox.__KATEX_PLAN_MD('$x$', () => undefined)).toBe('');
  });
});

describe('panel document', () => {
  function buildDocument(assets, nonce) {
    const sandbox = installHostRuntime();
    const block = plan.buildPlanBlock(assets);
    vm.runInContext(block.split('\n').filter((l) => !l.startsWith('/*')).join('\n'), sandbox);
    return sandbox.__KATEX_PLAN_HTML(
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
      'script-src \'nonce-{{NONCE}}\'; img-src data:;"></head><body><div id="content"></div></body></html>'
        .replace('{{NONCE}}', nonce),
      nonce
    );
  }

  test('adds font-src so KaTeX fonts are not blocked by default-src none', () => {
    expect(buildDocument(ASSETS, 'n0nce')).toContain('img-src data:; font-src data:;');
  });

  test('does not widen a CSP that already allows fonts', () => {
    const sandbox = installHostRuntime();
    vm.runInContext('globalThis.__KATEX_PLAN_ASSETS={css:"a",js:"b",client:"c"};', sandbox);
    const html = sandbox.__KATEX_PLAN_HTML(
      '<html><head><meta http-equiv="Content-Security-Policy" content="font-src self;"></head><body></body></html>',
      'n'
    );
    expect(html.match(/font-src/g)).toHaveLength(1);
  });

  test('a hostile nonce cannot break out of the script tag', () => {
    const sandbox = installHostRuntime();
    vm.runInContext('globalThis.__KATEX_PLAN_ASSETS={css:"a",js:"b",client:"c"};', sandbox);
    const html = sandbox.__KATEX_PLAN_HTML('<html><body></body></html>', 'abc"><img src=x>');
    expect(html).toContain('<script nonce="abcimgsrc=x">');
    expect(html).not.toContain('<img src=x>');
  });

  test('injects only once even if called twice on the same document', () => {
    const sandbox = installHostRuntime();
    vm.runInContext('globalThis.__KATEX_PLAN_ASSETS={css:"a",js:"b",client:"c"};', sandbox);
    const once = sandbox.__KATEX_PLAN_HTML('<html><body></body></html>', 'n');
    const twice = sandbox.__KATEX_PLAN_HTML(once, 'n');
    expect(twice).toBe(once);
  });

  test('returns the original document when the assets are missing', () => {
    const sandbox = installHostRuntime();
    const original = '<html><body></body></html>';
    expect(sandbox.__KATEX_PLAN_HTML(original, 'n')).toBe(original);
  });
});

describe('assets', () => {
  test('fonts are inlined as data URIs and the woff/ttf fallbacks dropped', () => {
    const css = 'a{b:c}@font-face{font-display:block;font-family:KaTeX_AMS;src:url(fonts/KaTeX_AMS-Regular.woff2) ' +
      'format("woff2"),url(fonts/KaTeX_AMS-Regular.woff) format("woff"),url(fonts/KaTeX_AMS-Regular.ttf) format("truetype")}';
    const out = plan.inlineFonts(css, '/fonts', () => Buffer.from('FONTBYTES'));
    expect(out).toContain('src:url(data:font/woff2;base64,' + Buffer.from('FONTBYTES').toString('base64') + ') format("woff2")');
    expect(out).not.toContain('url(fonts/');
    expect(out).toContain('a{b:c}');
  });

  test('an unreadable font leaves that face alone rather than breaking the stylesheet', () => {
    const css = '@font-face{src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2")}';
    const out = plan.inlineFonts(css, '/fonts', () => { throw new Error('nope'); });
    expect(out).toBe(css);
  });

  test('the shipped KaTeX stylesheet inlines every face it declares', () => {
    const css = fs.readFileSync(path.join(__dirname, 'vendor', 'katex.min.css'), 'utf8');
    const out = plan.inlineFonts(css, path.join(__dirname, 'vendor', 'fonts'), (p) => fs.readFileSync(p));
    expect(out).not.toContain('url(fonts/');
    expect((out.match(/data:font\/woff2;base64,/g) || []).length).toBe((css.match(/@font-face/g) || []).length);
  });

  test('the panel script carries macro ingestion and the renderer', () => {
    const script = plan.buildClientScript(
      fs.readFileSync(path.join(__dirname, 'macro-ingest.js'), 'utf8'),
      { preamble: '\\newcommand{\\R}{\\mathbb{R}}', macros: { '\\Z': '\\mathbb{Z}' } }
    );
    expect(script).toContain('window.__KATEX_PLAN_INGEST');
    expect(script).toContain('katex-plan-done');
    expect(script).toContain('\\\\newcommand{\\\\R}');
    expect(() => new vm.Script(script)).not.toThrow();
  });

  test('the panel script is valid with no macros configured', () => {
    const script = plan.buildClientScript('', null);
    expect(script).not.toContain('__KATEX_PLAN_INGEST=');
    expect(() => new vm.Script(script)).not.toThrow();
  });
});

// The renderer's wiring, exercised against the small slice of DOM it uses.
// Whether KaTeX draws the right glyphs is the browser harness's job.
describe('panel renderer', () => {
  function fakeSpan(className, tex) {
    const classes = new Set(className.split(' '));
    return {
      className,
      textContent: tex,
      classList: {
        add(c) { classes.add(c); this.owner.className = [...classes].join(' '); },
        contains: (c) => classes.has(c),
      },
      rendered: null,
    };
  }

  function run(spans, payload) {
    const rendered = [];
    for (const s of spans) s.classList.owner = s;
    const context = {
      window: {
        katex: {
          render(tex, el, options) {
            rendered.push({ tex, options });
            el.textContent = 'RENDERED';
          },
        },
      },
      document: {
        readyState: 'complete',
        getElementById: () => ({
          querySelectorAll: (sel) => {
            expect(sel).toBe('.katex-plan-math:not(.katex-plan-done)');
            return spans.filter((s) => !s.classList.contains('katex-plan-done'));
          },
        }),
      },
      MutationObserver: function() { this.observe = () => {}; },
      console,
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext('(' + plan.planClientRuntime.toString() + ')(' + JSON.stringify(payload || {}) + ');', context);
    return rendered;
  }

  test('renders display and inline spans in the right mode', () => {
    const rendered = run([
      fakeSpan('katex-plan-math katex-plan-display', 'a = b'),
      fakeSpan('katex-plan-math katex-plan-inline', 'x^2'),
    ]);
    expect(rendered.map((r) => [r.tex, r.options.displayMode])).toEqual([
      ['a = b', true],
      ['x^2', false],
    ]);
  });

  test('marks what it rendered so a re-render does not repeat the work', () => {
    const span = fakeSpan('katex-plan-math katex-plan-inline', 'x');
    run([span]);
    expect(span.classList.contains('katex-plan-done')).toBe(true);
  });

  test('cross-reference macros are installed, and per render', () => {
    const rendered = run([
      fakeSpan('katex-plan-math katex-plan-inline', 'a'),
      fakeSpan('katex-plan-math katex-plan-inline', 'b'),
    ]);
    expect(rendered[0].options.macros['\\eqref']).toBe('\\text{(#1)}');
    expect(rendered[0].options.macros).not.toBe(rendered[1].options.macros);
    expect(rendered[0].options.trust({ command: '\\htmlId' })).toBe(true);
    expect(rendered[0].options.trust({ command: '\\url' })).toBe(false);
  });

  test('does nothing at all when KaTeX did not load', () => {
    const context = { window: {}, document: { readyState: 'complete' }, console };
    context.globalThis = context;
    vm.createContext(context);
    expect(() => vm.runInContext('(' + plan.planClientRuntime.toString() + ')({});', context)).not.toThrow();
  });
});
