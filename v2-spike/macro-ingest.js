// Turns a LaTeX macro file into a KaTeX `macros` object.
//
// KaTeX already knows how to read \newcommand / \def / \let: given
// `globalGroup: true` and a macros object, every definition it parses is
// written into that object, which later renders can reuse. So this module
// writes no LaTeX parser — it only decides *what to hand KaTeX*, which is the
// part that has to be defensive, because a real macro file is usually a slice
// of a paper preamble: comments, \usepackage lines, prose, and commands KaTeX
// does not implement.
//
// Shared deliberately: entry.js bundles it for the webview, and extension.js
// requires it (vendor/katex.min.js is UMD and loads in Node) to build the
// report shown in VS Code. One implementation, unit-tested in jest against the
// exact KaTeX build that ships.
//
// Contract: this function NEVER throws and NEVER blocks rendering. Whatever
// goes wrong, the worst result is an empty macros object and math that renders
// exactly as it does without the feature.

// Commands that introduce a definition. \b sits before the optional star so
// both `\newcommand{` and `\newcommand*{` match, while `\definecolor` does not
// match `\def` (no word boundary between "f" and "i").
const DEF_RE = /^\s*\\(?:newcommand|renewcommand|providecommand|def|gdef|edef|xdef|let|newenvironment|renewenvironment|DeclareMathOperator)\b\*?/;

const DEFAULTS = {
  maxChars: 512 * 1024, // total preamble text considered
  maxChunks: 2000,      // definitions applied
  maxChunkLines: 20,    // lines one definition may span before we cut it loose
};

const EMPTY = () => ({ macros: {}, loaded: 0, skipped: [], truncated: false });

// Removes TeX comments: an unescaped `%` to end of line. A backslash escapes
// the next character, so `\%` is literal while `\\%` starts a comment.
function stripComments(text) {
  return text.split('\n').map((line) => {
    let out = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { out += line.slice(i, i + 2); i++; continue; }
      if (line[i] === '%') break;
      out += line[i];
    }
    return out;
  }).join('\n');
}

// Net brace depth of a line, ignoring escaped braces.
function braceDelta(line) {
  let d = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '{') d++;
    else if (line[i] === '}') d--;
  }
  return d;
}

// Reads a balanced {...} group starting at `i`. Returns null if `i` is not `{`
// or the group never closes.
function readGroup(text, i) {
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    if (text[k] === '\\') { k++; continue; }
    if (text[k] === '{') depth++;
    else if (text[k] === '}') {
      depth--;
      if (depth === 0) return { body: text.slice(i + 1, k), end: k + 1 };
    }
  }
  return null;
}

// KaTeX has no \DeclareMathOperator, and it is the single most common command
// in a real macro file that KaTeX cannot do (\argmax, \Var, \Tr ...). Rewrite
// it into an equivalent \newcommand so those macros render instead of being
// reported as skipped. The starred form takes limits below the operator.
function polyfillDeclareMathOperator(text) {
  const RE = /\\DeclareMathOperator(\*?)\s*/g;
  let out = '', last = 0, m;
  while ((m = RE.exec(text)) !== null) {
    const name = readGroup(text, m.index + m[0].length);
    if (!name) continue;
    const body = readGroup(text, name.end);
    if (!body) continue;
    const op = m[1] === '*' ? '\\operatorname*' : '\\operatorname';
    out += text.slice(last, m.index) + `\\newcommand{${name.body.trim()}}{${op}{${body.body}}}`;
    last = body.end;
    RE.lastIndex = body.end;
  }
  return out + text.slice(last);
}

// Pulls the definitions out of a preamble, dropping everything else. Anything
// that is not a definition — \usepackage, \documentclass, prose — is never
// handed to KaTeX, which is what lets a paper preamble work at all.
//
// A definition continues across lines while its braces are open, but stops at
// a line that starts a new definition: an unterminated `{` would otherwise
// swallow every definition below it.
function extractDefinitions(text, maxChunkLines) {
  const lines = text.split('\n');
  const chunks = [];
  let i = 0;
  while (i < lines.length) {
    if (!DEF_RE.test(lines[i])) { i++; continue; }
    let buf = lines[i];
    let depth = braceDelta(lines[i]);
    let j = i + 1;
    while (depth > 0 && j < lines.length && j - i < maxChunkLines && !DEF_RE.test(lines[j])) {
      buf += '\n' + lines[j];
      depth += braceDelta(lines[j]);
      j++;
    }
    chunks.push(buf);
    i = j;
  }
  return chunks;
}

function snippet(chunk) {
  const s = String(chunk).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

// Applies `chunk` to a COPY of `macros`, returning the copy only if KaTeX
// accepted the whole thing. All-or-nothing: a definition that fails partway
// cannot leave a half-defined macro behind.
//
// throwOnError must be true here. With false, KaTeX renders a parse error in
// red and returns normally, so a broken macro would be counted as loaded.
function applyChunk(katex, chunk, macros) {
  const scratch = { ...macros };
  katex.renderToString(chunk, {
    macros: scratch,
    globalGroup: true,
    throwOnError: true,
    displayMode: false,
  });
  return scratch;
}

// KaTeX rejects \newcommand for a name it already defines (it ships \vec,
// \argmax, \Pr and many more) and \renewcommand for a name nothing defined.
// Either way the user's file states the intent plainly — this macro means
// this — so retry once with the other spelling instead of losing it. Both
// KaTeX messages end in "use \renewcommand" / "use \newcommand", which is the
// only signal this retry fires on.
const SPELLING_MISMATCH_RE = /use \\(?:re)?newcommand/;

function swapDefineSpelling(chunk) {
  if (/\\newcommand/.test(chunk)) return chunk.replace(/\\newcommand(\*?)/g, '\\renewcommand$1');
  if (/\\renewcommand/.test(chunk)) return chunk.replace(/\\renewcommand(\*?)/g, '\\newcommand$1');
  return null;
}

// Applies one definition, with the spelling retry. Returns the new macro set,
// or null with the reason it could not be applied.
function applyDefinition(katex, chunk, macros) {
  try {
    return { macros: applyChunk(katex, chunk, macros) };
  } catch (e) {
    const message = (e && e.message) || String(e);
    if (SPELLING_MISMATCH_RE.test(message)) {
      const alt = swapDefineSpelling(chunk);
      if (alt) {
        try {
          return { macros: applyChunk(katex, alt, macros) };
        } catch (retryError) {
          return { reason: (retryError && retryError.message) || String(retryError) };
        }
      }
    }
    return { reason: message };
  }
}

/**
 * @param katex          the KaTeX module (window.katex, or the vendored UMD build)
 * @param preamble       raw macro-file text
 * @param inlineMacros   macros in KaTeX's own object form; these win over the file
 * @param limits         optional {maxChars, maxChunks, maxChunkLines}
 * @returns {{macros: object, loaded: number, skipped: Array<{snippet: string, reason: string}>, truncated: boolean}}
 */
function ingestMacros(katex, preamble, inlineMacros, limits) {
  const result = EMPTY();
  // Without KaTeX nothing renders anyway, so stay completely inert.
  if (!katex || typeof katex.renderToString !== 'function') return result;

  try {
    const lim = { ...DEFAULTS, ...(limits || {}) };
    let text = typeof preamble === 'string' ? preamble : '';
    if (text.length > lim.maxChars) {
      text = text.slice(0, lim.maxChars);
      result.truncated = true;
    }
    text = polyfillDeclareMathOperator(stripComments(text));

    let chunks = extractDefinitions(text, lim.maxChunkLines);
    // Nothing recognizable but the file is not empty: hand KaTeX the raw text
    // rather than silently ignoring a file shaped in some way we do not know.
    if (chunks.length === 0 && text.trim() !== '') chunks = [text];
    if (chunks.length > lim.maxChunks) {
      chunks = chunks.slice(0, lim.maxChunks);
      result.truncated = true;
    }

    if (chunks.length) {
      try {
        // Fast path: one render for the whole file.
        result.macros = applyChunk(katex, chunks.join('\n'), {});
        result.loaded = chunks.length;
      } catch {
        // Something in there is not valid KaTeX. Apply definitions one at a
        // time so only the offending ones are lost, and report them.
        let acc = {};
        for (const chunk of chunks) {
          const applied = applyDefinition(katex, chunk, acc);
          if (applied.macros) {
            acc = applied.macros;
            result.loaded++;
          } else {
            result.skipped.push({ snippet: snippet(chunk), reason: applied.reason });
          }
        }
        result.macros = acc;
      }
    }
  } catch (e) {
    // Belt and braces: any unforeseen failure yields no macros, never an
    // exception into the render pipeline.
    return EMPTY();
  }

  // Inline settings win over the file, and the caller's object is never mutated.
  if (inlineMacros && typeof inlineMacros === 'object') {
    for (const key of Object.keys(inlineMacros)) result.macros[key] = inlineMacros[key];
  }
  return result;
}

module.exports = { ingestMacros, _test: { stripComments, extractDefinitions, polyfillDeclareMathOperator } };
