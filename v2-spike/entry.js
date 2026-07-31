// v2 webview bundle entry.
//
// Bundles the remark-math + rehype-katex pipeline and exposes the three
// plugins as globals. The extension's patch injects them into Claude Code's
// react-markdown call:
//
//   createElement(Markdown, { remarkPlugins: [gfm], components: {...} }, text)
//        -> remarkPlugins: [gfm, __remarkBracketMath, __remarkMath]
//           rehypePlugins: [__rehypeKatex]
//
// Why this fixes what v1 could not: remark-math tokenises $...$ / $$...$$
// during micromark tokenisation, capturing the LaTeX verbatim BEFORE
// CommonMark's characterEscape collapses `\\` (matrix row breaks) and before
// block parsing can mis-read a lone `=` line as a setext heading.
//
// `katex` is externalised to the global shim — v1's vendored katex.min.js
// already defines window.katex.
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { ingestMacros } from '../macro-ingest.js';

// Escape every single `$` that is NOT part of a valid inline-math pair, so
// currency ($100, $5M, "$50-$100") stays literal while real math keeps working
// — including math whose content starts with a digit ($10^{-4}$), which the old
// /\$(?=\d)/ rule wrongly killed by escaping a legitimate *opening* delimiter.
//
// Mirrors Pandoc's tex_math_dollars flanking rules for a single-$ inline span:
//   - an opening `$` must be immediately followed by a non-space character;
//   - a closing `$` must be immediately preceded by a non-space character and
//     must NOT be immediately followed by a digit.
// Currency never satisfies the closing-side rules (amounts are space- or
// digit-flanked at the second `$`), so it is left as literal text. `$$` display
// delimiters and already-escaped `\$` are skipped. Implemented with plain scans
// rather than lookbehind so it does not depend on RegExp lookbehind support.
// (Originally contributed by @ReHoss in PR #9.)
function escapeCurrencyDollars(line) {
  const isSpace = c => c === undefined || /\s/.test(c);
  const isDigit = c => c >= '0' && c <= '9'; // c === undefined -> false

  // Collect single-`$` delimiter positions.
  const singles = [];
  for (let k = 0; k < line.length; k++) {
    if (line[k] !== '$') continue;
    if (line[k + 1] === '$') { k++; continue; } // `$$` -> display, leave it
    if (line[k - 1] === '\\') continue;         // already escaped `\$`
    singles.push(k);
  }

  // Pair left-to-right honoring the flanking rules.
  const pairs = [];
  let open = -1;
  for (const pos of singles) {
    const canOpen = !isSpace(line[pos + 1]);
    if (open === -1) {
      if (canOpen) open = pos;
    } else if (!isSpace(line[pos - 1]) && !isDigit(line[pos + 1])) {
      pairs.push([open, pos]); open = -1; // valid close
    } else {
      open = canOpen ? pos : -1;          // bad close; maybe a new open
    }
  }

  // Reject currency false positives. A digit-leading opener (`$5`) is allowed so
  // that real digit-leading math renders ($10^{-4}$, $2x + y - z = 8$) — but a
  // digit-leading `$` is also how currency starts, so two currency amounts can
  // pair across prose ("($5), but writing it after (5$)" would otherwise turn
  // "5), but writing it after (5" into a math span). The tell is the content:
  // real inline math is variables/numbers/operators, while that prose has
  // consecutive English words. So drop a digit-leading pair whose content
  // contains two adjacent multi-letter words. Non-digit openers are untouched,
  // so ordinary prose-y math (`$a + b = c$`) and \commands are unaffected.
  const PROSE = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/;
  const valid = new Set();
  for (const [o, c] of pairs) {
    if (isDigit(line[o + 1]) && PROSE.test(line.slice(o + 1, c))) continue;
    valid.add(o); valid.add(c);
  }

  // Escape the unpaired single `$`.
  let out = '';
  for (let k = 0; k < line.length; k++) {
    if (line[k] === '$' && line[k + 1] === '$') { out += '$$'; k++; continue; }
    if (line[k] === '$' && line[k - 1] !== '\\' && !valid.has(k)) { out += '\\$'; continue; }
    out += line[k];
  }
  return out;
}

// Moves display math ($$...$$) onto its own block lines so remark-math parses it
// as *flow* (display) math. This matters for two reasons: KaTeX `\tag` works only
// in display mode (inline $$...$$ throws a katex-error — issue #8), and display
// math should render as a centered block. Returns the (possibly several) lines
// the input line becomes. Handles a whole-line equation, an equation sharing its
// line with prose, an equation as a list item, and multiple per line. Lines that
// are a lone `$$` fence (opening/closing a multi-line block) are left untouched.
function explodeDisplayMath(line) {
  if (/^\s*\$\$\s*$/.test(line)) return [line];          // lone fence line
  const span = /\$\$(.+?)\$\$/;                            // a complete same-line $$...$$

  if (!span.test(line)) {
    // No complete pair: a single `$$` that opens or closes a multi-line block,
    // sharing its line with content -> move just that fence onto its own line.
    let m = line.match(/^(\s*)\$\$(.+)$/);
    if (m && m[2].trim() !== '' && m[2].indexOf('$$') === -1) return [m[1] + '$$', m[1] + m[2]];
    m = line.match(/^(.+)\$\$\s*$/);
    if (m && m[1].trim() !== '' && m[1].indexOf('$$') === -1) return [m[1], '$$'];
    return [line];
  }

  // A list item whose content is exactly one equation -> keep it a list item,
  // with the `$$` fences as the item's (indented) flow content.
  const li = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+)\$\$(.+?)\$\$\s*$/);
  if (li && li[2].indexOf('$$') === -1) {
    const indent = ' '.repeat(li[1].length);
    return [li[1] + '$$', indent + li[2].trim(), indent + '$$'];
  }

  // General: split prose and each $$...$$ into separate blocks (blank-separated).
  const out = [];
  const re = /\$\$(.+?)\$\$/g;
  let idx = 0, m;
  while ((m = re.exec(line)) !== null) {
    const pre = line.slice(idx, m.index).trim();
    if (pre) out.push(pre, '');
    out.push('$$', m[1].trim(), '$$', '');
    idx = re.lastIndex;
  }
  const post = line.slice(idx).trim();
  if (post) out.push(post);
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

// --- \[ \] and \( \) support, plus currency disambiguation ----------------
//
// remark-math only knows $ and $$. Claude also emits \[...\] (display) and
// \(...\) (inline). Those delimiters are NOT recoverable after micromark runs
// (`\[` -> `[`), so we normalise them on the raw markdown string, before the
// parser sees it, by wrapping the parser. Fenced code blocks are left alone.
function normalizeMathDelims(src) {
  if (typeof src !== 'string') return src;
  if (src.indexOf('\\') === -1 && src.indexOf('$') === -1) return src;
  const lookupLabel = buildLabelMap(src);
  const lines = src.split('\n');
  let inFence = false, fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) { inFence = true; fenceChar = fence[1][0]; }
      else if (fence[1][0] === fenceChar) { inFence = false; }
      continue;
    }
    if (inFence) continue;
    let line = escapeCurrencyDollars(lines[i])
      // \[ \] -> $$ (display); \( \) -> $ (inline). The (?<!\\) guard keeps
      // amsmath row separators (`\\[6pt]`, `\\[1em]`, ...) from having their
      // `[` consumed: without it, `\\[6pt]` becomes `\$$6pt]` and the math
      // is destroyed.
      .replace(/(?<!\\)\\\[/g, '$$$$').replace(/(?<!\\)\\\]/g, '$$$$')
      .replace(/(?<!\\)\\\(/g, '$').replace(/(?<!\\)\\\)/g, '$');
    // KaTeX has no `\leftroot` / `\uproot` (amsmath root-index nudging) and errors
    // on them. They are purely cosmetic, so strip them and their braced or
    // unbraced numeric argument; `\sqrt[\leftroot-2\uproot2 n]{…}` then renders as
    // a normal `\sqrt[n]{…}` instead of a katex-error.
    line = line.replace(/\\(?:leftroot|uproot)\s*(?:\{[^{}]*\}|-?\d+)?/g, '');

    // \eqref{name} / \ref{name} -> the labeled equation's \tag number, in
    // prose and math alike. Unresolved names fall through to the katex macros.
    line = resolveRefs(line, lookupLabel);

    // Move display math onto its own block lines (flow/display mode) — needed so
    // KaTeX `\tag` works (it is display-only) and so display equations render as
    // centered blocks, in every context: whole-line, mid-sentence, or a list item.
    lines[i] = explodeDisplayMath(line).join('\n');
  }
  return lines.join('\n');
}

// --- \label / \ref / \eqref resolution (issue #14) -------------------------
//
// LaTeX resolves \eqref{name} to the labeled equation's NUMBER. KaTeX has no
// document counter, but chat math that labels equations tags them too
// ($$... \tag{4} \label{eq:x}$$), so the mapping is right there in the source.
// Scan every display block for a \tag + \label pair and build name -> number.
// The map is kept on a window-level registry so a reference in a later chat
// message still resolves to an equation labeled in an earlier one (all
// messages render through this same pipeline); the current document's own
// labels win on collision.
//
// Resolved references are rewritten as plain text — "\eqref{eq:x}" -> "(4)",
// "\ref{eq:x}" -> "4" — which is correct BOTH in prose and inside math, so one
// string-level pass handles the skill's "From \eqref{eq:x} we see..." prose as
// well as $\eqref{eq:x}$. Unresolved references (no \tag anywhere) are left
// for the katex macros below, which render them as the readable "(name)".
function buildLabelMap(src) {
  const registry = (window.__KATEX_LABELS = window.__KATEX_LABELS || new Map());
  const local = new Map();
  const block = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
  let m;
  while ((m = block.exec(src)) !== null) {
    const body = m[1] !== undefined ? m[1] : m[2];
    const tag = body.match(/\\tag\*?\{([^{}]*)\}/);
    if (!tag) continue;
    const labelRe = /\\label\{([^{}]*)\}/g;
    let lm;
    while ((lm = labelRe.exec(body)) !== null) {
      local.set(lm[1], tag[1]);
      registry.set(lm[1], tag[1]);
    }
  }
  return (name) => (local.has(name) ? local.get(name) : registry.get(name));
}

function resolveRefs(line, lookup) {
  return line.replace(/\\(eqref|ref)\{([^{}]*)\}/g, (whole, cmd, name) => {
    const n = lookup(name);
    if (n === undefined) return whole;          // unresolved -> katex macro fallback
    return cmd === 'eqref' ? '(' + n + ')' : n;
  });
}

// A remark plugin that wraps the parser so normalizeMathDelims runs on the
// raw document string. remark-parse has already set this.parser by the time
// remark plugins are applied.
function remarkBracketMath() {
  const parser = this.parser;
  if (typeof parser === 'function') {
    this.parser = (doc, file) => parser(normalizeMathDelims(doc), file);
  }
}

// KaTeX implements none of LaTeX's cross-referencing commands — \label, \ref,
// \eqref — and renders them as red errors spliced into the formula (issue #14;
// a popular math-reasoning skill appends \label{eq:...} to every equation).
// Map them to what KaTeX *can* do, via macros passed through rehype-katex:
//   \label{x} -> \htmlId{x}{}   invisible anchor, like LaTeX (consumes the arg)
//   \eqref{x} -> \text{(x)}     readable textual reference
//   \ref{x}   -> \text{x}
const CROSSREF_MACROS = {
  '\\label': '\\htmlId{#1}{}',
  '\\eqref': '\\text{(#1)}',
  '\\ref': '\\text{#1}',
};

// --- user-defined macros (issue #15) ---------------------------------------
//
// The extension bakes the user's macro files and settings into the patched
// bundle as these two globals — the webview is a sandboxed browser context
// with no filesystem access, so this is how they arrive.
//
// Ingestion runs exactly once, here at load: no macro work ever happens per
// render, so even a pathological macro file cannot slow down rendering. It is
// wrapped so that any failure yields no macros rather than broken math.
const USER_MACROS = (function loadUserMacros() {
  try {
    const preamble = typeof window.__KATEX_USER_PREAMBLE === 'string' ? window.__KATEX_USER_PREAMBLE : '';
    const inline = window.__KATEX_USER_MACROS;
    if (!preamble && !inline) return {};

    const report = ingestMacros(window.katex, preamble, inline || {});
    // Exposed for the status popup, the L2 harness, and anyone debugging why
    // one of their macros did not take.
    window.__KATEX_MACRO_REPORT = {
      loaded: report.loaded,
      skipped: report.skipped,
      truncated: report.truncated,
    };
    console.log('[Claude Code LaTeX] user macros: ' + report.loaded + ' loaded, ' +
      report.skipped.length + ' skipped' + (report.truncated ? ' (truncated)' : ''),
      report.skipped);

    const reserved = Object.keys(CROSSREF_MACROS).filter((name) => name in report.macros);
    if (reserved.length) {
      console.warn('[Claude Code LaTeX] ' + reserved.join(', ') +
        ' keep their built-in meaning (\\label/\\ref/\\eqref resolution) and ignore your definition.');
    }
    return report.macros;
  } catch (e) {
    console.warn('[Claude Code LaTeX] user macros could not be loaded; math renders without them', e);
    return {};
  }
})();

// \htmlId needs `trust`, granted for that single command only, and its
// htmlExtension strict-mode warning is silenced (it would log per formula).
// The macros object is rebuilt per plugin instantiation: KaTeX mutates it when
// input uses \gdef, so a shared object would leak definitions across renders.
// User macros go in first, so the cross-reference macros above always win —
// a user macro named \ref must not break issue #14's resolution.
const realRehypeKatex = rehypeKatex && rehypeKatex.default ? rehypeKatex.default : rehypeKatex;
function rehypeKatexWithCrossrefs(options) {
  return realRehypeKatex.call(this, {
    ...options,
    macros: {
      ...USER_MACROS,
      ...CROSSREF_MACROS,
      ...(options && options.macros),
    },
    trust: (context) => context.command === '\\htmlId',
    strict: (errorCode) => (errorCode === 'htmlExtension' ? 'ignore' : 'warn'),
  });
}

window.__remarkMath = remarkMath && remarkMath.default ? remarkMath.default : remarkMath;
window.__rehypeKatex = rehypeKatexWithCrossrefs;
window.__remarkBracketMath = remarkBracketMath;
window.__KATEX_V2_LOADED = true;
console.log('[Claude Code LaTeX v2] math pipeline loaded:',
  typeof window.__remarkMath, typeof window.__rehypeKatex, typeof window.__remarkBracketMath);
