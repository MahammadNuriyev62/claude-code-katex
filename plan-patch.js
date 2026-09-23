// Math rendering for Claude Code's plan approval view (issue #17).
//
// The plan panel is NOT the chat webview. Claude Code's host extension.js
// creates a second webview panel (viewType "claudePlanPreview"), renders the
// plan's Markdown to HTML *in the extension host* with marked, and posts only
// the HTML to the panel, which runs it through an allowlist sanitizer. The
// chat patch (remark-math + rehype-katex injected into react-markdown) can
// never reach it, which is exactly what issue #17 reports.
//
// So this module patches the host file instead, in two anchored places:
//
//   1. the Markdown function — math is lifted out of the raw plan text
//      *before* marked runs and put back afterwards as plain <span>s whose
//      text is the untouched LaTeX. Verbatim capture is the whole point:
//      CommonMark eats `\[` (an escaped bracket) and collapses `\\` (matrix
//      row separators) long before any DOM-level renderer could see them.
//      The spans survive the panel's sanitizer because <span> and class are
//      on its allowlist and the LaTeX rides as text, not as an attribute.
//
//   2. the panel-HTML function — its return value is wrapped so KaTeX (core,
//      stylesheet, data-URI fonts) and a small renderer are appended to the
//      document, and the panel's CSP gains `font-src data:` (it has none, so
//      `default-src 'none'` would block every font).
//
// Everything injected is guarded: each rewritten call site falls back to the
// original behaviour if the runtime globals are missing, and each runtime
// entry point catches its own failures and returns Claude Code's own result.
// The worst outcome is a plan panel with unrendered math, never a broken one.
//
// Patching another extension's *host* code deserves more care than patching a
// webview bundle: applyPlanPatch only ever returns a new source string, and
// extension.js checks it parses (vm.Script, parse only) before anything is
// written to disk.

const PLAN_BEGIN = '/* === KaTeX plan-preview patch === */';
const PLAN_END = '/* === End KaTeX plan-preview patch === */';
const PLAN_VERSION_PREFIX = '/* katex-plan-version: ';
const PLAN_HASH_PREFIX = '/* katex-plan-macros-hash: ';

// Claude Code's host-side Markdown call:
//   function X(e){let t=M.parse(e);return typeof t==="string"?t:""}
// Matched (and required to match exactly once) against the whole bundle.
const PLAN_MD_RE = /function ([A-Za-z_$][\w$]{0,40})\(([A-Za-z_$][\w$]{0,40})\)\{let ([A-Za-z_$][\w$]{0,40})=([A-Za-z_$][\w$]{0,40})\.parse\(\2\);return typeof \3==="string"\?\3:""\}/;

// The plan panel's HTML builder:
//   function Y(){let e=nonce();return TEMPLATE.replaceAll("{{NONCE}}",e)}
// `{{NONCE}}` pins this to the plan preview: Claude Code's other webview
// builds its CSP by interpolation, not from a placeholder template.
const PLAN_HTML_RE = /function ([A-Za-z_$][\w$]{0,40})\(\)\{let ([A-Za-z_$][\w$]{0,40})=([A-Za-z_$][\w$]{0,40})\(\);return ([A-Za-z_$][\w$]{0,40})\.replaceAll\("\{\{NONCE\}\}",\2\)\}/;

// Placeholder left in the Markdown where math was lifted out. Alphanumeric on
// purpose: no Markdown construct can touch it, and no escaping can alter it.
const TOKEN_PREFIX = 'KTXMATHZ';
const TOKEN_SUFFIX = 'ZKTX';

// ---------------------------------------------------------------------------
// Host runtime. Serialized with Function.prototype.toString() into the patched
// extension.js, so it must be entirely self-contained: no closures over this
// module, no require, ES5-ish syntax only. It is also called directly by the
// tests, which is why the internals are hung off the exported function.
// ---------------------------------------------------------------------------
function planHostRuntime() {
  var TOKEN_PREFIX = 'KTXMATHZ';
  var TOKEN_SUFFIX = 'ZKTX';
  var TOKEN_RE = /KTXMATHZ(\d{1,6})ZKTX/g;
  // Two adjacent multi-letter words inside a `$…$` span that starts with a
  // digit: prose that merely quotes two currency amounts, not math.
  var PROSE_RE = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/;

  function isSpace(c) { return c === undefined || /\s/.test(c); }
  function isDigit(c) { return c >= '0' && c <= '9'; }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // The end of the fenced code block opened on the line starting at `i`.
  function skipFence(src, i, fence) {
    var lineEnd = src.indexOf('\n', i);
    if (lineEnd === -1) return src.length;
    var close = new RegExp('^\\s{0,3}' + fence[0] + '{' + fence.length + ',}\\s*$');
    var at = lineEnd + 1;
    while (at < src.length) {
      var end = src.indexOf('\n', at);
      if (end === -1) end = src.length;
      if (close.test(src.slice(at, end))) return end;
      at = end + 1;
    }
    return src.length;
  }

  // Lifts every math span out of the raw Markdown, leaving a placeholder.
  // Code (fenced and inline) is stepped over untouched, so a plan that shows
  // LaTeX as an example keeps showing it as text.
  function protect(src) {
    var items = [];
    var out = '';
    var i = 0;
    var atLineStart = true;

    while (i < src.length) {
      var c = src.charAt(i);

      if (atLineStart) {
        var fence = /^[ ]{0,3}(`{3,}|~{3,})/.exec(src.slice(i, i + 16));
        if (fence) {
          var stop = skipFence(src, i, fence[1]);
          out += src.slice(i, stop);
          i = stop;
          atLineStart = true;
          continue;
        }
      }
      atLineStart = c === '\n';

      if (c === '`') {
        var run = 1;
        while (src.charAt(i + run) === '`') run++;
        var ticks = src.substr(i, run);
        var closeAt = src.indexOf(ticks, i + run);
        // Unclosed run: not a code span, emit the backticks and move on.
        if (closeAt === -1) { out += ticks; i += run; continue; }
        out += src.slice(i, closeAt + run);
        i = closeAt + run;
        continue;
      }

      if (c === '\\') {
        var next = src.charAt(i + 1);
        if (next === '[' || next === '(') {
          var closer = next === '[' ? '\\]' : '\\)';
          var end = indexOfUnescaped(src, closer, i + 2);
          if (end !== -1) {
            out += push(items, src.slice(i + 2, end), next === '[');
            i = end + 2;
            continue;
          }
        }
        // Anything else escaped — including `\\`, so an amsmath row separator
        // never leaves its `[` exposed as a display-math opener.
        out += src.substr(i, 2);
        i += 2;
        continue;
      }

      if (c === '$') {
        if (src.charAt(i + 1) === '$') {
          var dend = indexOfUnescaped(src, '$$', i + 2);
          if (dend !== -1) {
            out += push(items, src.slice(i + 2, dend), true);
            i = dend + 2;
            continue;
          }
        } else {
          var span = inlineDollar(src, i);
          if (span !== -1) {
            out += push(items, src.slice(i + 1, span), false);
            i = span + 1;
            continue;
          }
        }
      }

      out += c;
      i++;
    }

    return { text: out, items: items };
  }

  // A delimiter is escaped only when an ODD number of backslashes precedes it:
  // `\$` is an escaped dollar, but the `\\` that ends a matrix row before its
  // closing `$$` is two escaped backslashes and the `$$` after them is real.
  function isEscaped(src, at) {
    var slashes = 0;
    while (at - slashes > 0 && src.charAt(at - slashes - 1) === '\\') slashes++;
    return slashes % 2 === 1;
  }

  function indexOfUnescaped(src, needle, from) {
    var at = from;
    while (at < src.length) {
      var found = src.indexOf(needle, at);
      if (found === -1) return -1;
      if (!isEscaped(src, found)) return found;
      at = found + 1;
    }
    return -1;
  }

  // The closing `$` of an inline span opened at `open`, or -1 when this `$`
  // is not math. The flanking rules are Pandoc's (and the chat pipeline's):
  // an opener is followed by non-space, a closer is preceded by non-space and
  // not followed by a digit — which is what keeps "$5" and "$10-$20" literal.
  //
  // The FIRST `$` that cannot close abandons the span, exactly as the chat
  // pipeline's pairing does. Scanning past it would let "$5 and $10, while
  // $y = 3$" pair the price with the equation and swallow the prose between.
  // The caller then emits this `$` literally and carries on, so a later `$`
  // still gets its chance to open a real span.
  function inlineDollar(src, open) {
    if (isSpace(src.charAt(open + 1))) return -1;
    for (var j = open + 1; j < src.length; j++) {
      var ch = src.charAt(j);
      if (ch === '\n') return -1;            // inline math stays on one line
      if (ch !== '$' || isEscaped(src, j)) continue;
      if (j === open + 1) return -1;         // `$$` handled by the caller
      if (isSpace(src.charAt(j - 1)) || isDigit(src.charAt(j + 1))) return -1;
      var body = src.slice(open + 1, j);
      if (body.trim() === '') return -1;
      // A digit-leading span that reads as prose is two currency amounts
      // quoted in a sentence, not math.
      if (isDigit(body.charAt(0)) && PROSE_RE.test(body)) return -1;
      return j;
    }
    return -1;
  }

  function push(items, body, display) {
    // KaTeX has no \leftroot / \uproot (cosmetic amsmath root nudging) and
    // errors on them, exactly as in the chat pipeline.
    var tex = String(body).replace(/\\(?:leftroot|uproot)\s*(?:\{[^{}]*\}|-?\d+)?/g, '');
    items.push({ tex: tex, display: !!display });
    return TOKEN_PREFIX + (items.length - 1) + TOKEN_SUFFIX;
  }

  // \eqref{x} / \ref{x} -> the number \tag gave the equation labeled x, in
  // prose and inside math alike. Unresolved names fall through to the KaTeX
  // macros the renderer installs.
  function resolveRefs(text, items) {
    var labels = {};
    var found = false;
    for (var i = 0; i < items.length; i++) {
      if (!items[i].display) continue;
      var tag = /\\tag\*?\{([^{}]*)\}/.exec(items[i].tex);
      if (!tag) continue;
      var labelRe = /\\label\{([^{}]*)\}/g;
      var m;
      while ((m = labelRe.exec(items[i].tex)) !== null) {
        labels[m[1]] = tag[1];
        found = true;
      }
    }
    if (!found) return text;

    var sub = function(s) {
      return s.replace(/\\(eqref|ref)\{([^{}]*)\}/g, function(whole, cmd, name) {
        if (!Object.prototype.hasOwnProperty.call(labels, name)) return whole;
        return cmd === 'eqref' ? '(' + labels[name] + ')' : labels[name];
      });
    };
    for (var k = 0; k < items.length; k++) items[k].tex = sub(items[k].tex);
    return sub(text);
  }

  // Puts the math back into marked's HTML. <span> and class survive the
  // panel's sanitizer, and the LaTeX rides as text content, which it cannot
  // strip.
  function restore(html, items) {
    return String(html).replace(TOKEN_RE, function(whole, idx) {
      var item = items[Number(idx)];
      if (!item) return whole;
      return '<span class="katex-plan-math ' +
        (item.display ? 'katex-plan-display' : 'katex-plan-inline') + '">' +
        escapeHtml(item.tex) + '</span>';
    });
  }

  var renderMarkdown = function(src, render) {
    try {
      if (typeof src !== 'string') return render(src);
      var lifted = protect(src);
      if (!lifted.items.length) return render(src);
      var text = resolveRefs(lifted.text, lifted.items);
      var html = render(text);
      if (typeof html !== 'string') return '';
      return restore(html, lifted.items);
    } catch (e) {
      // Never let math handling cost the user their plan: fall back to Claude
      // Code's own rendering of the untouched source. If that fails too, the
      // failure is Claude Code's and propagates exactly as it did before.
      return render(src);
    }
  };
  renderMarkdown._internals = {
    protect: protect,
    restore: restore,
    resolveRefs: resolveRefs,
    inlineDollar: inlineDollar,
  };

  // Appends KaTeX and the renderer to the panel document, and widens the CSP
  // just enough for data-URI fonts. Returns Claude Code's own HTML unchanged
  // on any failure, including a missing asset bundle.
  var buildHtml = function(html, nonce) {
    try {
      var assets = globalThis.__KATEX_PLAN_ASSETS;
      if (typeof html !== 'string' || !assets || !assets.js) return html;
      if (html.indexOf('id="katex-plan-style"') !== -1) return html;
      var safeNonce = String(nonce == null ? '' : nonce).replace(/[^A-Za-z0-9+/=_-]/g, '');

      var out = html.replace(
        /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/i,
        function(whole, head, csp, tail) {
          if (csp.indexOf('font-src') !== -1) return whole;
          return head + csp + " font-src data:;" + tail;
        }
      );

      var block =
        '<style id="katex-plan-style">' + assets.css + '</style>' +
        '<script nonce="' + safeNonce + '">' + assets.js + '<\/script>' +
        (assets.copyTex ? '<script nonce="' + safeNonce + '">' + assets.copyTex + '<\/script>' : '') +
        '<script nonce="' + safeNonce + '">' + assets.client + '<\/script>';

      var at = out.lastIndexOf('</body>');
      return at === -1 ? out + block : out.slice(0, at) + block + out.slice(at);
    } catch (e) {
      return html;
    }
  };

  globalThis.__KATEX_PLAN_MD = renderMarkdown;
  globalThis.__KATEX_PLAN_HTML = buildHtml;
}

// ---------------------------------------------------------------------------
// Panel runtime. Serialized into the injected <script>, so it too must be
// self-contained. `payload` carries the user's macros; window.katex and
// window.__KATEX_PLAN_INGEST are defined by the scripts injected before it.
// ---------------------------------------------------------------------------
function planClientRuntime(payload) {
  var katex = window.katex;
  if (!katex || typeof katex.render !== 'function') return;

  // KaTeX implements none of LaTeX's cross-referencing commands and renders
  // them as red errors; map them to what it can do (issue #14), exactly as
  // the chat pipeline does.
  var CROSSREF = {
    '\\label': '\\htmlId{#1}{}',
    '\\eqref': '\\text{(#1)}',
    '\\ref': '\\text{#1}',
  };

  var userMacros = {};
  try {
    var ingest = window.__KATEX_PLAN_INGEST;
    var preamble = payload && typeof payload.preamble === 'string' ? payload.preamble : '';
    var inline = payload && payload.macros ? payload.macros : {};
    if (ingest && (preamble || Object.keys(inline).length)) {
      userMacros = ingest(katex, preamble, inline).macros;
    }
  } catch (e) {
    // Macros are a convenience; math still renders without them.
  }

  function macros() {
    // Rebuilt per render: KaTeX writes \gdef definitions into this object, so
    // a shared one would leak definitions between formulas. Cross-reference
    // macros go last so a user macro cannot break \ref resolution.
    var out = {};
    var k;
    for (k in userMacros) if (Object.prototype.hasOwnProperty.call(userMacros, k)) out[k] = userMacros[k];
    for (k in CROSSREF) if (Object.prototype.hasOwnProperty.call(CROSSREF, k)) out[k] = CROSSREF[k];
    return out;
  }

  function renderAll(root) {
    if (!root) return;
    var nodes = root.querySelectorAll('.katex-plan-math:not(.katex-plan-done)');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var tex = el.textContent;
      var display = el.className.indexOf('katex-plan-display') !== -1;
      el.classList.add('katex-plan-done');
      try {
        katex.render(tex, el, {
          displayMode: display,
          throwOnError: false,
          macros: macros(),
          trust: function(context) { return context.command === '\\htmlId'; },
          strict: function(code) { return code === 'htmlExtension' ? 'ignore' : 'warn'; },
        });
      } catch (e) {
        el.textContent = tex;
      }
    }
  }

  function start() {
    var content = document.getElementById('content') || document.body;
    if (!content) return;
    var pending = false;
    // The panel replaces #content's innerHTML on every plan update, so the
    // renderer has to run again on each one. The `katex-plan-done` class keeps
    // KaTeX's own DOM writes from re-triggering the work.
    var observer = new MutationObserver(function() {
      if (pending) return;
      pending = true;
      setTimeout(function() { pending = false; renderAll(content); }, 0);
    });
    observer.observe(content, { childList: true, subtree: true });
    renderAll(content);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}

// Extra styling for the panel: the injected spans are inline elements (a
// <div> would be invalid inside marked's <p>), so display math is blocked out
// here rather than by the tag.
const PLAN_EXTRA_CSS = [
  '.katex-plan-display{display:block;margin:0.6em 0;text-align:center;overflow-x:auto;overflow-y:hidden;}',
  '.katex-plan-display .katex-display{margin:0;}',
  '.katex-plan-math .katex{font-size:1.1em;}',
  '.katex-plan-math{white-space:normal;}',
].join('');

// Embeds arbitrary text as a JS literal. Escaping `/` (an identity escape in
// both JSON and JS) makes `*/` and this patch's own end marker impossible to
// express inside a payload, so no asset can terminate the block early. Same
// rule the webview macro block uses.
function embedJs(value) {
  return JSON.stringify(value)
    .replace(/\//g, '\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// KaTeX's stylesheet points at ./fonts/*; the panel has no resource root it
// could resolve those against, so each face is inlined as a data: URI and the
// woff/ttf fallbacks (which VS Code's Chromium never needs) are dropped.
function inlineFonts(css, fontsDir, readFile) {
  return css.replace(
    /src:url\(fonts\/([\w-]+)\.woff2\)\s*format\("woff2"\)(?:\s*,\s*url\(fonts\/[^)]*\)\s*format\("[^"]*"\))*/g,
    function(whole, name) {
      try {
        const data = readFile(fontsDir + '/' + name + '.woff2');
        return 'src:url(data:font/woff2;base64,' + data.toString('base64') + ') format("woff2")';
      } catch (e) {
        return whole;
      }
    }
  );
}

// The <script> body that runs inside the panel: macro ingestion (the module
// the webview bundle uses, wrapped in a CommonJS shim) plus the renderer.
function buildClientScript(macroIngestSource, payload) {
  const shim = macroIngestSource
    ? '(function(){var module={exports:{}};var exports=module.exports;\n' +
      macroIngestSource +
      '\nwindow.__KATEX_PLAN_INGEST=module.exports&&module.exports.ingestMacros;})();\n'
    : '';
  const data = JSON.stringify({
    preamble: (payload && payload.preamble) || '',
    macros: (payload && payload.macros) || {},
  });
  return shim + '(' + planClientRuntime.toString() + ')(' + data + ');';
}

// The block prepended to Claude Code's extension.js: the assets, then the
// host runtime that consumes them.
function buildPlanBlock(assets) {
  const client = buildClientScript(assets.macroIngestSource, assets.macroPayload);
  return [
    PLAN_BEGIN,
    PLAN_VERSION_PREFIX + assets.version + ' */',
    PLAN_HASH_PREFIX + (assets.macroHash || 'none') + ' */',
    'globalThis.__KATEX_PLAN_ASSETS = {',
    '  css: ' + embedJs(assets.css + PLAN_EXTRA_CSS) + ',',
    '  js: ' + embedJs(assets.js) + ',',
    // Optional, exactly as in the webview patch: without it math still
    // renders, copying a selection just stays unfixed.
    '  copyTex: ' + embedJs(assets.copyTex || '') + ',',
    '  client: ' + embedJs(client) + ',',
    '};',
    '(' + planHostRuntime.toString() + ')();',
    PLAN_END,
  ].join('\n');
}

function countMatches(source, re) {
  const global = new RegExp(re.source, 'g');
  const found = source.match(global);
  return found ? found.length : 0;
}

// Rewrites Claude Code's host bundle so the plan panel renders math. Returns
// the new source, or null with a reason when this build does not have the
// shape the patch needs — in which case the caller writes nothing and the
// plan panel keeps working exactly as it does today.
//
// Both anchors must match exactly once. Two matches would mean the shape is
// no longer specific enough to be sure which call site is the plan panel's,
// and patching the wrong one is worse than not patching at all.
function applyPlanPatch(source, assets) {
  if (typeof source !== 'string' || source === '') {
    return { ok: false, reason: 'empty source' };
  }
  if (source.includes(PLAN_BEGIN)) {
    return { ok: false, reason: 'already patched' };
  }
  if (assets.js.includes('</script') || assets.css.includes('</style') ||
      (assets.copyTex && assets.copyTex.includes('</script'))) {
    // Would close its own tag inside the panel document.
    return { ok: false, reason: 'asset contains a closing tag' };
  }

  const mdCount = countMatches(source, PLAN_MD_RE);
  if (mdCount !== 1) {
    return { ok: false, reason: `markdown call site matched ${mdCount} times (expected 1)` };
  }
  const htmlCount = countMatches(source, PLAN_HTML_RE);
  if (htmlCount !== 1) {
    return { ok: false, reason: `panel HTML call site matched ${htmlCount} times (expected 1)` };
  }

  const patched = source
    .replace(
      PLAN_MD_RE,
      'function $1($2){return (globalThis.__KATEX_PLAN_MD||function(s,r){return r(s)})($2,' +
      'function(__ktxSrc){let $3=$4.parse(__ktxSrc);return typeof $3==="string"?$3:""})}'
    )
    .replace(
      PLAN_HTML_RE,
      'function $1(){let $2=$3();return (globalThis.__KATEX_PLAN_HTML||function(h){return h})' +
      '($4.replaceAll("{{NONCE}}",$2),$2)}'
    );

  return { ok: true, source: buildPlanBlock(assets) + '\n' + patched };
}

function isPlanPatched(source) {
  return typeof source === 'string' && source.includes(PLAN_BEGIN);
}

// The extension version stamped into an applied plan patch, or null.
function getPlanPatchVersion(source) {
  return readStamp(source, PLAN_VERSION_PREFIX);
}

// The macro hash the applied plan patch was built with. 'none' when the patch
// was applied with no macros configured.
function getPlanMacroHash(source) {
  return readStamp(source, PLAN_HASH_PREFIX);
}

function readStamp(source, prefix) {
  if (typeof source !== 'string') return null;
  const start = source.indexOf(prefix);
  if (start === -1) return null;
  const rest = source.slice(start + prefix.length);
  const end = rest.indexOf(' */');
  return end === -1 ? null : rest.slice(0, end).trim();
}

module.exports = {
  applyPlanPatch,
  isPlanPatched,
  getPlanPatchVersion,
  getPlanMacroHash,
  inlineFonts,
  buildPlanBlock,
  buildClientScript,
  planHostRuntime,
  planClientRuntime,
  embedJs,
  PLAN_BEGIN,
  PLAN_END,
  PLAN_VERSION_PREFIX,
  PLAN_HASH_PREFIX,
  PLAN_MD_RE,
  PLAN_HTML_RE,
  TOKEN_PREFIX,
  TOKEN_SUFFIX,
  PLAN_EXTRA_CSS,
};
