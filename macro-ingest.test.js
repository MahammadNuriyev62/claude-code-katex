// Level-1 tests for the macro ingestion module.
//
// Run against vendor/katex.min.js — the build that actually ships in the patch,
// not the (newer) npm devDependency. If the vendored KaTeX ever stops
// supporting something these tests rely on, that must fail here rather than in
// a user's webview.
const katex = require('./vendor/katex.min.js');
const { ingestMacros } = require('./macro-ingest');

// Renders with a COPY of the ingested macros, so a render's own \gdef side
// effects can never leak between assertions.
const render = (tex, macros) =>
  katex.renderToString(tex, { macros: { ...macros }, throwOnError: true });

describe('ingestMacros — definitions that KaTeX supports', () => {
  test('loads a no-argument \\newcommand and renders it', () => {
    const r = ingestMacros(katex, '\\newcommand{\\RR}{\\mathbb{R}}', {});
    expect(r.loaded).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(render('\\RR', r.macros)).toContain('mathbb');
  });

  test('loads a \\newcommand that takes an argument', () => {
    const r = ingestMacros(katex, '\\newcommand{\\vv}[1]{\\mathbf{#1}}', {});
    expect(r.loaded).toBe(1);
    expect(render('\\vv{x}', r.macros)).toContain('mathbf');
  });

  test('loads a TeX-style \\def with a parameter', () => {
    const r = ingestMacros(katex, '\\def\\vv#1{\\mathbf{#1}}', {});
    expect(r.loaded).toBe(1);
    expect(render('\\vv{x}', r.macros)).toContain('mathbf');
  });

  test('loads \\let aliases', () => {
    const r = ingestMacros(katex, '\\let\\ol\\overline', {});
    expect(r.loaded).toBe(1);
    expect(render('\\ol{x}', r.macros)).toContain('overline');
  });

  test('loads every definition in a multi-definition file', () => {
    const r = ingestMacros(katex, [
      '\\newcommand{\\RR}{\\mathbb{R}}',
      '\\newcommand{\\CC}{\\mathbb{C}}',
      '\\def\\vv#1{\\mathbf{#1}}',
    ].join('\n'), {});
    expect(r.loaded).toBe(3);
    expect(r.skipped).toEqual([]);
    expect(() => render('\\RR \\CC \\vv{x}', r.macros)).not.toThrow();
  });

  test('joins a definition that spans several lines', () => {
    const r = ingestMacros(katex, [
      '\\newcommand{\\longone}[2]{',
      '  \\frac{#1}{#2}',
      '}',
    ].join('\n'), {});
    expect(r.loaded).toBe(1);
    expect(render('\\longone{a}{b}', r.macros)).toContain('frac');
  });
});

describe('ingestMacros — real preamble junk', () => {
  test('drops \\usepackage between definitions without losing either', () => {
    const r = ingestMacros(katex, [
      '\\newcommand{\\RR}{\\mathbb{R}}',
      '\\usepackage{amsmath}',
      '\\newcommand{\\CC}{\\mathbb{C}}',
    ].join('\n'), {});
    expect(r.loaded).toBe(2);
    expect(r.skipped).toEqual([]);
    expect(() => render('\\RR + \\CC', r.macros)).not.toThrow();
  });

  test('drops \\documentclass and prose before the first definition', () => {
    const r = ingestMacros(katex, [
      '\\documentclass{article}',
      'Some stray prose that is not a definition at all.',
      '\\newcommand{\\RR}{\\mathbb{R}}',
    ].join('\n'), {});
    expect(r.loaded).toBe(1);
    expect(() => render('\\RR', r.macros)).not.toThrow();
  });

  test('strips % comments so commented-out definitions do not load', () => {
    const r = ingestMacros(katex, [
      '% \\newcommand{\\NOPE}{1}',
      '\\newcommand{\\RR}{\\mathbb{R}} % the reals',
    ].join('\n'), {});
    expect(r.loaded).toBe(1);
    expect(() => render('\\NOPE', r.macros)).toThrow();
    expect(() => render('\\RR', r.macros)).not.toThrow();
  });

  test('treats an escaped \\% as literal, not as a comment', () => {
    const r = ingestMacros(katex, '\\newcommand{\\pct}{50\\%}', {});
    expect(r.loaded).toBe(1);
    expect(() => render('\\pct', r.macros)).not.toThrow();
  });
});

describe('ingestMacros — \\DeclareMathOperator polyfill', () => {
  test('renders \\DeclareMathOperator as an operator', () => {
    const r = ingestMacros(katex, '\\DeclareMathOperator{\\argmax}{arg\\,max}', {});
    expect(r.loaded).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(render('\\argmax_x f(x)', r.macros)).toContain('arg');
  });

  test('renders the starred form with limits', () => {
    const r = ingestMacros(katex, '\\DeclareMathOperator*{\\argmin}{arg\\,min}', {});
    expect(r.loaded).toBe(1);
    expect(() => render('\\argmin_x f(x)', r.macros)).not.toThrow();
  });

  test('handles an operator body containing braces', () => {
    const r = ingestMacros(katex, '\\DeclareMathOperator{\\Var}{\\mathrm{Var}}', {});
    expect(r.loaded).toBe(1);
    expect(render('\\Var(X)', r.macros)).toContain('Var');
  });
});

describe('ingestMacros — user definitions beat KaTeX built-ins', () => {
  // KaTeX ships its own \vec, \argmax, \Pr ... and rejects \newcommand for a
  // name it already defines. A macro file that works in the user's document is
  // an unambiguous statement of intent, so it must win.
  test('a \\newcommand redefining a KaTeX built-in wins over the built-in', () => {
    const r = ingestMacros(katex, '\\newcommand{\\vec}[1]{\\mathbf{#1}}', {});
    expect(r.loaded).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(render('\\vec{x}', r.macros)).toContain('mathbf');
  });

  test('a \\renewcommand of a name nothing defined yet still loads', () => {
    // Their file renews something a LaTeX package defined; we have no packages,
    // so defining it is far more useful than losing it.
    const r = ingestMacros(katex, '\\renewcommand{\\nowhere}{\\mathbb{Z}}', {});
    expect(r.loaded).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(render('\\nowhere', r.macros)).toContain('mathbb');
  });
});

describe('ingestMacros — failure isolation', () => {
  test('a broken definition is skipped while its neighbours load', () => {
    const r = ingestMacros(katex, [
      '\\newcommand{\\RR}{\\mathbb{R}}',
      '\\newcommand{\\bad}{\\frac{1}',
      '\\newcommand{\\CC}{\\mathbb{C}}',
    ].join('\n'), {});
    expect(r.loaded).toBe(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].snippet).toContain('\\bad');
    expect(r.skipped[0].reason).toBeTruthy();
    expect(() => render('\\RR + \\CC', r.macros)).not.toThrow();
  });

  test('reports an optional-argument macro as skipped, without losing its neighbours', () => {
    // KaTeX has no \newcommand{...}[n][default] form. Pinned so that if a
    // future KaTeX gains it, this test tells us instead of the README staying
    // wrong. The neighbour must still load.
    const r = ingestMacros(katex, [
      '\\newcommand{\\pow}[2][2]{#2^{#1}}',
      '\\newcommand{\\RR}{\\mathbb{R}}',
    ].join('\n'), {});
    expect(r.loaded).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].snippet).toContain('\\pow');
    expect(() => render('\\RR', r.macros)).not.toThrow();
  });

  test('reports \\newenvironment as skipped rather than dropping it silently', () => {
    const r = ingestMacros(katex, '\\newenvironment{thm}{\\begin{it}}{\\end{it}}', {});
    expect(r.loaded).toBe(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].snippet).toContain('newenvironment');
  });

  test('a chunk that fails partway defines none of its macros', () => {
    // Both definitions share one line, so they are one unit; the second is
    // unterminated. Applying the unit must be all-or-nothing.
    const r = ingestMacros(katex, '\\newcommand{\\okpart}{1}\\newcommand{\\bad}{', {});
    expect(r.macros['\\okpart']).toBeUndefined();
    expect(() => render('\\okpart', r.macros)).toThrow();
    expect(r.skipped).toHaveLength(1);
  });

  test('an unterminated definition does not swallow the definitions after it', () => {
    const r = ingestMacros(katex, [
      '\\newcommand{\\bad}{\\frac{1}',
      '\\newcommand{\\CC}{\\mathbb{C}}',
      '\\newcommand{\\RR}{\\mathbb{R}}',
    ].join('\n'), {});
    expect(() => render('\\CC + \\RR', r.macros)).not.toThrow();
    expect(r.loaded).toBe(2);
  });
});

describe('ingestMacros — precedence', () => {
  test('inline macros override file macros', () => {
    const r = ingestMacros(katex, '\\newcommand{\\X}{\\alpha}', { '\\X': '\\beta' });
    expect(render('\\X', r.macros)).toContain('β');
  });

  test('inline macros load even when the preamble is empty', () => {
    const r = ingestMacros(katex, '', { '\\RR': '\\mathbb{R}' });
    expect(render('\\RR', r.macros)).toContain('mathbb');
  });
});

describe('ingestMacros — limits', () => {
  test('truncates a preamble past the character cap', () => {
    const filler = '\\newcommand{\\a}{1}\n'.repeat(100);
    const r = ingestMacros(katex, filler + '\\newcommand{\\zz}{9}', {}, { maxChars: 200 });
    expect(r.truncated).toBe(true);
    expect(() => render('\\zz', r.macros)).toThrow();
  });

  test('stops after the chunk cap and reports truncation', () => {
    const many = Array.from({ length: 50 }, (_, i) => `\\newcommand{\\m${'x'.repeat(i + 1)}}{${i}}`).join('\n');
    const r = ingestMacros(katex, many, {}, { maxChunks: 10 });
    expect(r.truncated).toBe(true);
    expect(r.loaded).toBeLessThanOrEqual(10);
  });
});

describe('ingestMacros — never throws', () => {
  const garbage = [
    undefined,
    null,
    12345,
    {},
    [],
    '',
    '   \n\n  ',
    '}}}{{{',
    '*/ window.evil = 1; /*',
    '</script><script>alert(1)</script>',
    '\\newcommand',
    '\\newcommand{',
    '\\def',
    ' binary junk ',
    '\\newcommand{\\deep}{' + '{'.repeat(500) + '}'.repeat(500) + '}',
  ];

  test.each(garbage.map((g, i) => [i, g]))('input #%i returns a usable result', (_i, input) => {
    let r;
    expect(() => { r = ingestMacros(katex, input, {}); }).not.toThrow();
    expect(r).toBeDefined();
    expect(typeof r.macros).toBe('object');
    expect(Array.isArray(r.skipped)).toBe(true);
  });

  test('survives a KaTeX that throws on every call', () => {
    const brokenKatex = { renderToString: () => { throw new Error('boom'); } };
    let r;
    expect(() => { r = ingestMacros(brokenKatex, '\\newcommand{\\RR}{\\mathbb{R}}', {}); }).not.toThrow();
    expect(r.macros).toEqual({});
  });

  test('survives a missing KaTeX entirely', () => {
    let r;
    expect(() => { r = ingestMacros(null, '\\newcommand{\\RR}{\\mathbb{R}}', { '\\A': '1' }); }).not.toThrow();
    expect(r.macros).toEqual({});
  });

  test('does not mutate the inline macros object it is given', () => {
    const inline = { '\\RR': '\\mathbb{R}' };
    const r = ingestMacros(katex, '\\newcommand{\\CC}{\\mathbb{C}}', inline);
    render('\\RR \\CC', r.macros);
    expect(inline).toEqual({ '\\RR': '\\mathbb{R}' });
  });
});
