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
    // remark-math's display-math *flow* construct only recognizes `$$` when it
    // is alone on its line — and, crucially, KaTeX commands like `\tag` work
    // ONLY in display mode. A self-contained single-line `$$ … $$` is otherwise
    // parsed as *inline* math (displayMode:false), so `\tag` throws a
    // katex-error (issue #8). So:
    //  - a whole-line `$$ … $$` is exploded onto its own three lines, making it
    //    proper flow (display) math — `\tag` works and it renders as a block;
    //  - a fence that merely shares its line with content (`$$\begin{aligned}`
    //    or `\end{aligned}$$`) has just that fence moved onto its own line.
    // Mid-sentence `$$…$$` (text on both sides) is left inline, untouched.
    let mFull = line.match(/^(\s*)\$\$(.+?)\$\$\s*$/);
    if (mFull && mFull[2].trim() !== '' && mFull[2].indexOf('$$') === -1) {
      line = mFull[1] + '$$\n' + mFull[1] + mFull[2].trim() + '\n' + mFull[1] + '$$';
    } else {
      let m = line.match(/^(\s*)\$\$(.+)$/);
      if (m && m[2].trim() !== '' && m[2].indexOf('$$') === -1) {
        line = m[1] + '$$\n' + m[1] + m[2];
      } else {
        m = line.match(/^(.+)\$\$\s*$/);
        if (m && m[1].trim() !== '' && m[1].indexOf('$$') === -1) {
          line = m[1] + '\n$$';
        }
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
