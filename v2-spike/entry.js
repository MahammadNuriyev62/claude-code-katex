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

// Escape every single `$` that is NOT part of a valid inline-math pair, so
// currency ($100, $5M, "$100 is less than $200", "$50-$100") stays literal
// while real math keeps working — including math whose content starts with a
// digit ($10^{-4}$), which the old /\$(?=\d)/ rule wrongly killed by escaping
// a legitimate *opening* delimiter.
//
// Mirrors Pandoc's tex_math_dollars flanking rules for a single-$ inline span:
//   - an opening `$` must be immediately followed by a non-space character;
//   - a closing `$` must be immediately preceded by a non-space character and
//     must NOT be immediately followed by a digit.
// Currency never satisfies the closing-side rules (amounts are space- or
// digit-flanked at the second `$`), so it is left as literal text. `$$` display
// delimiters and already-escaped `\$` are skipped. Implemented with plain
// scans rather than lookbehind so it does not depend on RegExp lookbehind.
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

  // Pair left-to-right honoring the flanking rules; record valid delimiters.
  const valid = new Set();
  let open = -1;
  for (const pos of singles) {
    const canOpen = !isSpace(line[pos + 1]);
    if (open === -1) {
      if (canOpen) open = pos;
    } else if (!isSpace(line[pos - 1]) && !isDigit(line[pos + 1])) {
      valid.add(open); valid.add(pos); open = -1; // valid close
    } else {
      open = canOpen ? pos : -1;                  // bad close; maybe a new open
    }
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

// --- \[ \] and \( \) support, plus currency disambiguation ----------------
//
// remark-math only knows $ and $$. Claude also emits \[...\] (display) and
// \(...\) (inline). Those delimiters are NOT recoverable after micromark runs
// (`\[` -> `[`), so we normalise them on the raw markdown string, before the
// parser sees it, by wrapping the parser. Fenced code blocks are left alone.
function normalizeMathDelims(src) {
  if (typeof src !== 'string') return src;
  if (src.indexOf('\\') === -1 && src.indexOf('$') === -1) return src;
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
    // remark-math's display-math *flow* construct only recognizes `$$` when
    // it is alone on its line. If a fence shares its line with content
    // (`$$\begin{aligned}` or `\end{aligned}$$`), move the `$$` onto its own
    // line so the block parses. A self-contained single-line `$$...$$` keeps
    // a `$$` in the remainder, so it is left as inline display math.
    let m = line.match(/^(\s*)\$\$(.+)$/);
    if (m && m[2].trim() !== '' && m[2].indexOf('$$') === -1) {
      line = m[1] + '$$\n' + m[1] + m[2];
    } else {
      m = line.match(/^(.+)\$\$\s*$/);
      if (m && m[1].trim() !== '' && m[1].indexOf('$$') === -1) {
        line = m[1] + '\n$$';
      }
    }
    lines[i] = line;
  }
  return lines.join('\n');
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

window.__remarkMath = remarkMath && remarkMath.default ? remarkMath.default : remarkMath;
window.__rehypeKatex = rehypeKatex && rehypeKatex.default ? rehypeKatex.default : rehypeKatex;
window.__remarkBracketMath = remarkBracketMath;
window.__KATEX_V2_LOADED = true;
console.log('[Claude Code LaTeX v2] math pipeline loaded:',
  typeof window.__remarkMath, typeof window.__rehypeKatex, typeof window.__remarkBracketMath);
