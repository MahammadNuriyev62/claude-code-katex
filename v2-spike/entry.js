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
    // Move display math onto its own block lines (flow/display mode) — needed so
    // KaTeX `\tag` works (it is display-only) and so display equations render as
    // centered blocks, in every context: whole-line, mid-sentence, or a list item.
    lines[i] = explodeDisplayMath(line).join('\n');
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
