const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PATCH_MARKER = '/* === KaTeX LaTeX Rendering Patch === */';
const PATCH_CSS_MARKER = '/* === KaTeX LaTeX Rendering CSS Patch === */';

// --- user macros (issue #15) ----------------------------------------------
//
// The webview is a sandboxed browser context: it cannot read the filesystem
// and there is no runtime channel to it, so a user's macros have to be on
// disk, inside the patched bundle, before it loads. They live in their own
// delimited block, which lets "the user changed a macro" be a rewrite of just
// that region rather than a re-application of the whole patch.
//
// When nothing is configured, no block is emitted at all and the patch is
// byte-for-byte what it was before this feature existed.
const MACRO_BEGIN = '/* === KaTeX user macros === */';
const MACRO_END = '/* === End KaTeX user macros === */';
const MACRO_HASH_PREFIX = '/* katex-macros-hash: ';
// Where a block is inserted into a patch that predates macro support. Written
// by applyPatch itself, so it is a stable anchor.
const BUNDLE_ANCHOR = '/* remark-math + rehype-katex pipeline */';

const MACRO_LIMITS = {
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 512 * 1024,
};

// This extension's own version. It is stamped into the patch (right after
// PATCH_MARKER) so a newer build can recognize "patched, but by an older
// build" and refresh the injected code instead of leaving it stale.
const EXTENSION_VERSION = require('./package.json').version;
// Version-agnostic prefix of the stamp line: `/* katex-ext-version: X.Y.Z */`.
// Patches from builds <= 1.9.0 have no stamp at all (getPatchedVersion -> null).
const PATCH_VERSION_PREFIX = '/* katex-ext-version: ';

// Where users report a Claude Code build the patch no longer fits.
const ISSUES_URL = 'https://github.com/MahammadNuriyev62/claude-code-katex/issues';

// The react-markdown call site in Claude Code's webview bundle:
//   <factory>(<Markdown>, {remarkPlugins:[<plugins>], components:{...}}, <text>)
// The patch injects the math plugins here. $1 = the JSX factory (React's
// `createElement`, or a minified alias like `b` — Claude Code 2.1.186 switched
// to the short-alias form), $2 = the Markdown component identifier, $3 = the
// existing remark plugin list. `remarkPlugins` is react-markdown's stable
// public prop name, and `<ident>(<ident>,{remarkPlugins:[` is specific enough
// to pin the one call site, so this survives minification-hash churn; if a
// future Claude Code reshapes the call entirely, applyPatch reports it as
// unsupported rather than patching blind.
//
// The identifier runs are length-bounded ({0,N}) rather than open-ended (*).
// This regex is matched against the multi-MB minified webview bundle; an
// open-ended `[\w$]*\(` backtracks O(n^2) across a long word-run that isn't
// followed by `(`, which on a megabyte-scale bundle hangs the patch. Real JSX
// factory / component / plugin identifiers are short, so the bounds never
// exclude a genuine match while keeping the scan linear.
const V2_INJECT_RE = /([A-Za-z_$][\w$]{0,40})\(([A-Za-z_$][\w$]{0,40}),\{remarkPlugins:\[([A-Za-z_$][\w$,]{0,200})\]/;

function findClaudeCodeExtDir() {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  return ext ? ext.extensionPath : null;
}

// Expands ~, ${userHome} and ${workspaceFolder}, and resolves a relative path
// against the workspace. Returns null when the path cannot be resolved at all
// (a relative path with no folder open), which the caller reports like any
// other unreadable source rather than treating as fatal.
function resolveMacroPath(raw, ctx) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const home = ctx && ctx.home;
  const workspace = ctx && ctx.workspaceFolder;
  let p = raw.trim();

  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    if (!home) return null;
    p = path.join(home, p.slice(1));
  }
  if (p.includes('${userHome}')) {
    if (!home) return null;
    p = p.split('${userHome}').join(home);
  }
  if (p.includes('${workspaceFolder}')) {
    if (!workspace) return null;
    p = p.split('${workspaceFolder}').join(workspace);
  }
  if (!path.isAbsolute(p)) {
    if (!workspace) return null;
    p = path.join(workspace, p);
  }
  return path.resolve(p);
}

// Reads the configured macro files into one preamble. Every failure — missing,
// a directory, oversize, unreadable — is recorded against that source and the
// remaining files are still read.
function readMacroSources(files, ctx, limits) {
  const lim = { ...MACRO_LIMITS, ...(limits || {}) };
  const result = { preamble: '', sources: [], truncated: false };
  if (!Array.isArray(files)) return result;

  const parts = [];
  let total = 0;
  for (const raw of files) {
    const resolved = resolveMacroPath(raw, ctx);
    if (!resolved) {
      result.sources.push({ path: String(raw), error: 'could not be resolved (no workspace folder open?)' });
      continue;
    }
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        result.sources.push({ path: resolved, error: 'not a file' });
        continue;
      }
      if (stat.size > lim.maxFileBytes) {
        result.sources.push({ path: resolved, error: `too large (${stat.size} bytes; limit ${lim.maxFileBytes})` });
        continue;
      }
      if (total + stat.size > lim.maxTotalBytes) {
        result.truncated = true;
        result.sources.push({ path: resolved, error: 'skipped: total macro size limit reached' });
        continue;
      }
      let text = fs.readFileSync(resolved, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
      parts.push(text);
      total += stat.size;
      result.sources.push({ path: resolved, bytes: stat.size });
    } catch (e) {
      result.sources.push({ path: resolved, error: (e && e.message) || String(e) });
    }
  }
  result.preamble = parts.join('\n');
  return result;
}

// The resolved macro configuration, plus a hash of exactly what will be
// embedded. The hash is over content, not paths or mtimes, so re-running with
// an unchanged macro file writes nothing.
function buildMacroPayload(config, ctx) {
  const cfg = config && typeof config === 'object' ? config : {};
  const macros = cfg.macros && typeof cfg.macros === 'object' ? cfg.macros : {};
  const read = readMacroSources(cfg.macroFiles, ctx);

  const isEmpty = read.preamble.trim() === '' && Object.keys(macros).length === 0;
  const canonical = JSON.stringify([
    read.preamble,
    Object.keys(macros).sort().map((k) => [k, macros[k]]),
  ]);

  return {
    preamble: read.preamble,
    macros,
    sources: read.sources,
    truncated: read.truncated,
    isEmpty,
    hash: isEmpty ? null : crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12),
  };
}

// Embeds arbitrary user text as a JS literal. JSON.stringify handles quotes,
// backslashes and newlines; escaping every `/` as `\/` (an identity escape in
// both JSON and JS) additionally makes the sequences `*/` and the block's own
// end marker impossible to express inside the payload — without that, a macro
// file containing `*/` would truncate the block and corrupt the bundle.
// U+2028/U+2029 are escaped so the literal is safe in any parser.
function embedJs(value) {
  return JSON.stringify(value)
    .replace(/\//g, '\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderMacroBlock(payload) {
  return MACRO_BEGIN + '\n' +
    MACRO_HASH_PREFIX + payload.hash + ' */\n' +
    'window.__KATEX_USER_PREAMBLE = ' + embedJs(payload.preamble) + ';\n' +
    'window.__KATEX_USER_MACROS = ' + embedJs(payload.macros) + ';\n' +
    MACRO_END;
}

// The macro hash carried by a patched bundle, or null when it has no block.
function getMacroHash(body) {
  const start = body.indexOf(MACRO_HASH_PREFIX);
  if (start === -1) return null;
  const rest = body.slice(start + MACRO_HASH_PREFIX.length);
  const end = rest.indexOf(' */');
  return end === -1 ? null : rest.slice(0, end).trim();
}

// Rewrites just the macro block of an already-patched bundle. Returns the new
// body, or null when there is no block to replace. An empty payload removes
// the block entirely, which is the canonical form of "no macros configured".
function applyMacroBlock(body, payload) {
  const start = body.indexOf(MACRO_BEGIN);
  if (start === -1) return null;
  const endAt = body.indexOf(MACRO_END, start);
  if (endAt === -1) return null;
  const after = endAt + MACRO_END.length;

  if (!payload || payload.isEmpty) {
    return body.slice(0, start) + body.slice(after).replace(/^\n/, '');
  }
  return body.slice(0, start) + renderMacroBlock(payload) + body.slice(after);
}

// Adds a block to a bundle patched by a build that had no macro support.
// Returns null when the anchor is missing, leaving the caller to re-patch.
function insertMacroBlock(body, payload) {
  if (!payload || payload.isEmpty) return body;
  const at = body.indexOf(BUNDLE_ANCHOR);
  if (at === -1) return null;
  return body.slice(0, at) + renderMacroBlock(payload) + '\n' + body.slice(at);
}

function isPatched(extDir) {
  try {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    return js.includes(PATCH_MARKER);
  } catch {
    return false;
  }
}

// Reads the extension version stamped into the patch. Returns the version
// string, or null when the webview is unpatched or carries a patch from a
// pre-versioning build (<= 1.9.0, which wrote no stamp).
function getPatchedVersion(extDir) {
  try {
    const js = fs.readFileSync(path.join(extDir, 'webview', 'index.js'), 'utf8');
    const start = js.indexOf(PATCH_VERSION_PREFIX);
    if (start === -1) return null;
    const rest = js.slice(start + PATCH_VERSION_PREFIX.length);
    const end = rest.indexOf(' */');
    if (end === -1) return null;
    return rest.slice(0, end).trim();
  } catch {
    return null;
  }
}

// --- macro configuration -------------------------------------------------

function readMacroConfig() {
  try {
    const cfg = vscode.workspace.getConfiguration('claudeCodeKatex');
    return { macroFiles: cfg.get('macroFiles', []), macros: cfg.get('macros', {}) };
  } catch {
    return { macroFiles: [], macros: {} };
  }
}

function currentMacroContext() {
  let workspaceFolder = null;
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length && folders[0].uri && folders[0].uri.fsPath) {
      workspaceFolder = folders[0].uri.fsPath;
    }
  } catch { /* no workspace */ }
  return { home: os.homedir(), workspaceFolder };
}

const EMPTY_PAYLOAD = { preamble: '', macros: {}, sources: [], truncated: false, isEmpty: true, hash: null };

function currentMacroPayload() {
  try {
    return buildMacroPayload(readMacroConfig(), currentMacroContext());
  } catch (e) {
    console.warn('[Claude Code LaTeX] Could not read the macro configuration:', e && e.message);
    return EMPTY_PAYLOAD;
  }
}

// The same ingestion the webview runs, loaded lazily and never fatally: this
// copy exists only to tell the user how many macros loaded. If it is missing
// or KaTeX will not load in Node, macros still work — only the count is lost.
let ingestFn;
function loadIngest() {
  if (ingestFn === undefined) {
    try {
      ingestFn = require('./macro-ingest').ingestMacros;
    } catch (e) {
      ingestFn = null;
      console.warn('[Claude Code LaTeX] Macro report unavailable:', e && e.message);
    }
  }
  return ingestFn;
}

let vendoredKatex;
function loadVendoredKatex(vendorDir) {
  if (vendoredKatex === undefined) {
    try {
      vendoredKatex = require(path.join(vendorDir, 'katex.min.js'));
    } catch (e) {
      vendoredKatex = null;
      console.warn('[Claude Code LaTeX] Could not load KaTeX for the macro report:', e && e.message);
    }
  }
  return vendoredKatex;
}

// One line describing what the user's macro configuration amounts to, shown in
// the status popup and after a reload. Unreadable sources are always named,
// even when nothing loaded — silence is the worst answer to "why is my macro
// not working?".
function describeMacros(payload, vendorDir) {
  const failed = (payload.sources || []).filter((s) => s.error);
  const describeFailures = () => failed.length
    ? ' — could not read: ' + failed.map((f) => `${f.path} (${f.error})`).join('; ')
    : '';

  if (payload.isEmpty) return 'no macros configured' + describeFailures();

  const parts = [];
  const ingest = loadIngest();
  const katex = ingest ? loadVendoredKatex(vendorDir) : null;
  if (ingest && katex) {
    const report = ingest(katex, payload.preamble, payload.macros);
    parts.push(`${report.loaded} macro${report.loaded === 1 ? '' : 's'} loaded`);
    if (report.skipped.length) parts.push(`${report.skipped.length} skipped`);
  } else {
    const n = Object.keys(payload.macros).length;
    parts.push(`${n} inline macro${n === 1 ? '' : 's'}`);
  }
  const fileCount = (payload.sources || []).filter((s) => !s.error).length;
  if (fileCount) parts.push(`from ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  if (payload.truncated) parts.push('size limit reached');
  return parts.join(', ') + describeFailures();
}

// Patches Claude Code's webview to render math through its own react-markdown
// pipeline. Returns true if patched, or false if the react-markdown injection
// point was not found (a future Claude Code reshaped its bundle) — in which
// case nothing on disk is touched and the caller surfaces an "unsupported"
// message.
function applyPatch(extDir, vendorDir, macroPayload) {
  const webviewDir = path.join(extDir, 'webview');
  const jsPath = path.join(webviewDir, 'index.js');
  const cssPath = path.join(webviewDir, 'index.css');

  const body = fs.readFileSync(jsPath, 'utf8');
  if (!V2_INJECT_RE.test(body)) {
    // The injection point is gone — leave the webview completely untouched.
    return false;
  }

  // Back up originals if not already backed up
  for (const f of [jsPath, cssPath]) {
    if (!fs.existsSync(f + '.katex-bak')) {
      fs.copyFileSync(f, f + '.katex-bak');
    }
  }

  // Copy KaTeX fonts
  const fontsTarget = path.join(webviewDir, 'fonts');
  const fontsSrc = path.join(vendorDir, 'fonts');
  if (!fs.existsSync(fontsTarget)) {
    fs.mkdirSync(fontsTarget, { recursive: true });
  }
  for (const font of fs.readdirSync(fontsSrc)) {
    fs.copyFileSync(path.join(fontsSrc, font), path.join(fontsTarget, font));
  }

  // Patch index.js — inject remark-math + rehype-katex into Claude Code's
  // react-markdown call, then prepend KaTeX core + the remark-math bundle.
  // remark-math tokenizes $...$ / $$...$$ during micromark parsing, capturing
  // the LaTeX verbatim BEFORE CommonMark's characterEscape collapses `\\`
  // (matrix row separators) and before block parsing can mis-read a lone `=`
  // line as a setext heading. The injected plugin references are guarded on
  // window.__KATEX_V2_LOADED so that if the bundle ever fails to load, Claude
  // Code's markdown still renders normally. Prepended, not appended: Claude
  // Code mounts its React app at the end of the bundle, so window.__remarkMath
  // etc. must be defined before that runs.
  const katexCore = fs.readFileSync(path.join(vendorDir, 'katex.min.js'), 'utf8');
  // Optional KaTeX contrib, prepended right after the core: copy-tex rewrites
  // the clipboard on copy so selected math yields its LaTeX source ($...$ /
  // $$...$$) instead of the rendered spans' garbled text. It is standalone DOM
  // code (reads the x-tex <annotation> KaTeX emits); a missing file degrades
  // gracefully — core math still renders, copying just stays unfixed.
  const copyTexPath = path.join(vendorDir, 'copy-tex.min.js');
  const copyTex = fs.existsSync(copyTexPath) ? fs.readFileSync(copyTexPath, 'utf8') : '';
  const v2Bundle = fs.readFileSync(path.join(vendorDir, 'remark-math-bundle.js'), 'utf8');
  const injectedBody = body.replace(
    V2_INJECT_RE,
    '$1($2,{rehypePlugins:window.__KATEX_V2_LOADED?[window.__rehypeKatex]:[],' +
    'remarkPlugins:[$3].concat(window.__KATEX_V2_LOADED?[window.__remarkBracketMath,window.__remarkMath]:[])'
  );
  // The user's macros, if any. Emitted after KaTeX core (ingestion needs
  // window.katex) and before the math bundle (which consumes them at load).
  // No macros configured -> no block, and the patch is byte-for-byte what it
  // was before this feature existed.
  const macroBlock = macroPayload && !macroPayload.isEmpty
    ? renderMacroBlock(macroPayload) + '\n'
    : '';

  fs.writeFileSync(jsPath,
    `${PATCH_MARKER}\n${PATCH_VERSION_PREFIX}${EXTENSION_VERSION} */\n` +
    `/* KaTeX Core - MIT License - https://katex.org */\n${katexCore}\n` +
    (copyTex ? `/* KaTeX copy-tex extension (copy selection as LaTeX) - MIT License */\n${copyTex}\n` : '') +
    macroBlock +
    `${BUNDLE_ANCHOR}\n${v2Bundle}\n` +
    `/* === End KaTeX Patch — Claude Code bundle (math plugins injected) follows === */\n` +
    injectedBody
  );

  // Patch index.css — KaTeX styles
  const katexCss = fs.readFileSync(path.join(vendorDir, 'katex.min.css'), 'utf8');
  const cssPatch = `
${PATCH_CSS_MARKER}
${katexCss}
.katex-display {
  margin: 0.5em 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 0.25em 0;
}
.katex-display > .katex {
  white-space: normal;
}
.katex {
  font-size: 1.1em;
}
/* === End KaTeX CSS Patch === */`;
  fs.appendFileSync(cssPath, cssPatch);

  return true;
}

function removePatch(extDir) {
  const webviewDir = path.join(extDir, 'webview');
  const jsPath = path.join(webviewDir, 'index.js');
  const cssPath = path.join(webviewDir, 'index.css');

  let restored = false;
  for (const f of [jsPath, cssPath]) {
    const bak = f + '.katex-bak';
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, f);
      restored = true;
    }
  }

  const fontsDir = path.join(webviewDir, 'fonts');
  if (fs.existsSync(fontsDir)) {
    fs.rmSync(fontsDir, { recursive: true });
  }

  return restored;
}

// True only when the `.katex-bak` originals exist AND are themselves unpatched,
// so removePatch() would restore genuine pristine files. This guards the
// refresh path in ensurePatched(): we never treat an already-patched file as
// if it were the backup-able original.
function canRestoreOriginals(extDir) {
  const webviewDir = path.join(extDir, 'webview');
  const jsBak = path.join(webviewDir, 'index.js.katex-bak');
  const cssBak = path.join(webviewDir, 'index.css.katex-bak');
  try {
    if (!fs.existsSync(jsBak) || !fs.existsSync(cssBak)) return false;
    if (fs.readFileSync(jsBak, 'utf8').includes(PATCH_MARKER)) return false;
    if (fs.readFileSync(cssBak, 'utf8').includes(PATCH_CSS_MARKER)) return false;
    return true;
  } catch {
    return false;
  }
}

// Ensures Claude Code's webview carries THIS build's patch. Returns:
//   'fresh'       - was unpatched; patch applied
//   'refreshed'   - carried an older/unstamped patch; originals restored, re-patched
//   'current'     - already patched with this exact version; nothing done
//   'skipped'     - patch is stale but cannot be refreshed safely; left untouched
//   'unsupported' - the react-markdown injection point was not found
// May throw on filesystem errors from applyPatch/removePatch; callers handle.
function ensurePatched(extDir, vendorDir, macroPayload) {
  if (!isPatched(extDir)) {
    return applyPatch(extDir, vendorDir, macroPayload) ? 'fresh' : 'unsupported';
  }
  if (getPatchedVersion(extDir) === EXTENSION_VERSION) {
    // Right build already patched. The macros may still have changed since the
    // last session — that is a rewrite of one delimited region, not a reason to
    // restore and re-apply the whole patch.
    const jsPath = path.join(extDir, 'webview', 'index.js');
    const body = fs.readFileSync(jsPath, 'utf8');
    const wanted = macroPayload && !macroPayload.isEmpty ? macroPayload.hash : null;
    if (getMacroHash(body) === wanted) return 'current';

    const rewritten = applyMacroBlock(body, macroPayload);
    if (rewritten !== null) {
      fs.writeFileSync(jsPath, rewritten);
      return 'macros-updated';
    }
    // Patched by a build that had no macro block: splice one in at the anchor.
    const inserted = insertMacroBlock(body, macroPayload);
    if (inserted !== null) {
      fs.writeFileSync(jsPath, inserted);
      return 'macros-updated';
    }
    return 'current';
  }
  // A patch from an older (or pre-versioning) build is present. Refresh it so
  // the injected code matches this build — but only if the pristine originals
  // can be safely restored first.
  if (!canRestoreOriginals(extDir)) {
    console.warn('[Claude Code LaTeX] Webview carries a stale patch but the original backup is missing or invalid; leaving the existing patch in place.');
    return 'skipped';
  }
  removePatch(extDir);
  if (isPatched(extDir)) {
    console.error('[Claude Code LaTeX] Restore did not clear the old patch; not re-applying.');
    return 'skipped';
  }
  return applyPatch(extDir, vendorDir, macroPayload) ? 'refreshed' : 'unsupported';
}

// Reloads the Claude Code webview so an on-disk patch change takes effect
// immediately. A webview reload re-fetches the patched bundle; a full window
// reload is not required. The notification keeps manual fallbacks for the rare
// case the auto-reload did not take.
function reloadWebviewAndNotify(message) {
  vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
  vscode.window
    .showInformationMessage(message, 'Reload Webview', 'Reload Window')
    .then(function(choice) {
      if (choice === 'Reload Webview') {
        vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
      } else if (choice === 'Reload Window') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
}

// Shown when applyPatch reports the react-markdown injection point is gone
// (a Claude Code update reshaped its bundle). The patch is NOT applied, so
// Claude Code keeps working — just without math rendering — and the user is
// pointed at an extension update or the issue tracker.
function notifyUnsupported() {
  vscode.window
    .showWarningMessage(
      'Claude Code LaTeX could not apply its patch — this version of Claude Code changed its internals. ' +
      'Update the extension if an update is available; if there is no update yet, please report it so it can be fixed.',
      'Check for Updates',
      'Report an Issue'
    )
    .then(function(choice) {
      if (choice === 'Check for Updates') {
        vscode.commands.executeCommand('workbench.extensions.action.checkForUpdates');
      } else if (choice === 'Report an Issue') {
        vscode.env.openExternal(vscode.Uri.parse(ISSUES_URL));
      }
    });
}

// Re-reads the macro configuration and rewrites just the macro block of the
// already-patched webview. Macros are otherwise read only at activation, so
// this command is the entire refresh story — deliberately explicit rather than
// a file watcher rewriting Claude Code's bundle behind the user's back.
function reloadMacros(vendorDir) {
  const dir = findClaudeCodeExtDir();
  if (!dir) {
    vscode.window.showErrorMessage('Claude Code extension not found.');
    return;
  }
  if (!isPatched(dir)) {
    vscode.window.showInformationMessage(
      'Claude Code LaTeX is not active, so there is nothing to reload macros into. Reload the window to apply the patch first.');
    return;
  }

  const payload = currentMacroPayload();
  const summary = describeMacros(payload, vendorDir);
  const jsPath = path.join(dir, 'webview', 'index.js');
  try {
    const body = fs.readFileSync(jsPath, 'utf8');
    if (getMacroHash(body) === (payload.isEmpty ? null : payload.hash)) {
      vscode.window.showInformationMessage(`Claude Code LaTeX: macros unchanged (${summary}).`);
      return;
    }

    // Rewrite the existing block, or splice one into a patch that predates
    // macro support.
    const updated = applyMacroBlock(body, payload) ?? insertMacroBlock(body, payload);
    if (updated === null) {
      vscode.window.showWarningMessage(
        'Claude Code LaTeX could not locate where to place macros in the patched webview. Reload the window to re-apply the patch.');
      return;
    }
    fs.writeFileSync(jsPath, updated);
    reloadWebviewAndNotify(`Claude Code LaTeX macros reloaded — ${summary}. The webview was reloaded.`);
  } catch (e) {
    vscode.window.showErrorMessage('Failed to reload macros: ' + e.message);
  }
}

function activate(context) {
  const vendorDir = path.join(context.extensionPath, 'vendor');

  // Auto-patch on startup. Files stay patched on disk between sessions so the
  // webview always loads the patched version (it loads before this extension).
  const extDir = findClaudeCodeExtDir();
  if (extDir) {
    try {
      const macroPayload = currentMacroPayload();
      const result = ensurePatched(extDir, vendorDir, macroPayload);
      if (result === 'macros-updated') {
        reloadWebviewAndNotify(
          `Claude Code LaTeX macros updated — ${describeMacros(macroPayload, vendorDir)}. The webview was reloaded.`);
      } else if (result === 'fresh') {
        reloadWebviewAndNotify('Claude Code LaTeX enabled. The webview was reloaded; reload again if any math still looks unrendered.');
      } else if (result === 'refreshed') {
        reloadWebviewAndNotify('Claude Code LaTeX updated. The webview was reloaded; reload again if any math still looks unrendered.');
      } else if (result === 'unsupported') {
        notifyUnsupported();
      }
    } catch (e) {
      console.error('[Claude Code LaTeX] Auto-patch failed:', e);
    }
  } else {
    console.warn('[Claude Code LaTeX] Claude Code extension not found.');
  }

  // Enable command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.enable', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showErrorMessage('Claude Code extension not found.');
        return;
      }
      if (isPatched(dir)) {
        vscode.window.showInformationMessage('Claude Code LaTeX is already active.');
        return;
      }
      try {
        if (applyPatch(dir, vendorDir, currentMacroPayload())) {
          reloadWebviewAndNotify('Claude Code LaTeX enabled. The webview was reloaded; reload again if any math still looks unrendered.');
        } else {
          notifyUnsupported();
        }
      } catch (e) {
        vscode.window.showErrorMessage('Failed to apply patch: ' + e.message);
      }
    })
  );

  // Disable command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.disable', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showErrorMessage('Claude Code extension not found.');
        return;
      }
      if (!isPatched(dir)) {
        vscode.window.showInformationMessage('Claude Code LaTeX is not active.');
        return;
      }
      try {
        removePatch(dir);
        reloadWebviewAndNotify('Claude Code LaTeX disabled. The webview was reloaded.');
      } catch (e) {
        vscode.window.showErrorMessage('Failed to remove patch: ' + e.message);
      }
    })
  );

  // Reload Macros command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.reloadMacros', function() {
      reloadMacros(vendorDir);
    })
  );

  // Status command
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-katex.status', function() {
      const dir = findClaudeCodeExtDir();
      if (!dir) {
        vscode.window.showInformationMessage(
          'Claude Code LaTeX v' + EXTENSION_VERSION + ': Claude Code extension not found.');
        return;
      }
      // Show the extension version AND the version stamped into the applied
      // patch, so it is clear whether the running webview carries this build.
      const active = isPatched(dir);
      let status;
      if (!active) {
        status = 'Not active — reload the window to apply';
      } else {
        const patchVer = getPatchedVersion(dir);
        if (patchVer === EXTENSION_VERSION) status = 'Active — patch up to date';
        else if (patchVer) status = 'Active — applied patch is v' + patchVer + ' (older than the extension); reload to refresh';
        else status = 'Active — applied patch predates version stamping; reload to refresh';
      }
      // Offer the relevant actions inline so the status-bar click is not a dead
      // end: the reload controls users look for here, plus a quick enable/disable.
      // Each button delegates to the existing command / built-in action.
      const actions = active
        ? ['Reload Webview', 'Reload Macros', 'Reload Window', 'Disable']
        : ['Enable', 'Reload Window'];
      vscode.window
        .showInformationMessage(
          'Claude Code LaTeX v' + EXTENSION_VERSION + '\n' + status +
            '\nMacros: ' + describeMacros(currentMacroPayload(), vendorDir) +
            '\nClaude Code: ' + dir,
          ...actions
        )
        .then(function(choice) {
          if (choice === 'Reload Webview') {
            vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
          } else if (choice === 'Reload Macros') {
            vscode.commands.executeCommand('claude-code-katex.reloadMacros');
          } else if (choice === 'Reload Window') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
          } else if (choice === 'Enable') {
            vscode.commands.executeCommand('claude-code-katex.enable');
          } else if (choice === 'Disable') {
            vscode.commands.executeCommand('claude-code-katex.disable');
          }
        });
    })
  );

  // Status bar indicator. Always visible; text reflects whether the patch is
  // active. Clicking it shows the status message.
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'claude-code-katex.status';
  function refreshStatusBar() {
    const dir = findClaudeCodeExtDir();
    if (dir && isPatched(dir)) {
      const patchVer = getPatchedVersion(dir);
      const fresh = patchVer === EXTENSION_VERSION;
      statusBarItem.text = '$(symbol-operator) LaTeX';
      statusBarItem.tooltip = 'Claude Code LaTeX v' + EXTENSION_VERSION +
        (fresh ? ' — active (up to date)'
               : ' — active (patch ' + (patchVer ? 'v' + patchVer : 'unversioned') + '; reload to refresh)') +
        '. Click for status & reload options.';
    } else if (dir) {
      statusBarItem.text = '$(symbol-operator) LaTeX (off)';
      statusBarItem.tooltip = 'Claude Code LaTeX is not patched. Run "Claude Code LaTeX: Enable" or reload after install.';
    } else {
      statusBarItem.text = '$(symbol-operator) LaTeX (no CC)';
      statusBarItem.tooltip = 'Claude Code extension not found.';
    }
  }
  refreshStatusBar();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Watch for Claude Code extension changes (updates). A Claude Code update
  // installs a fresh (unpatched) webview; this re-patches it.
  context.subscriptions.push(
    vscode.extensions.onDidChange(function() {
      const dir = findClaudeCodeExtDir();
      if (dir) {
        try {
          const result = ensurePatched(dir, vendorDir, currentMacroPayload());
          if (result === 'fresh' || result === 'refreshed' || result === 'macros-updated') {
            reloadWebviewAndNotify('Claude Code LaTeX re-applied after a Claude Code update. The webview was reloaded; reload again if any math still looks unrendered.');
          } else if (result === 'unsupported') {
            notifyUnsupported();
          }
        } catch (e) {
          console.error('[Claude Code LaTeX] Re-patch after update failed:', e);
        }
      }
      refreshStatusBar();
    })
  );
}

function deactivate() {
  // Intentionally empty. Files stay patched on disk so Claude Code's webview
  // (which loads before our extension activates) always gets the patched version.
  // Cleanup happens via: "Disable" command, or uninstall-hook.js on uninstall.
}

module.exports = { activate, deactivate };

// Exposed for testing only
module.exports._test = {
  findClaudeCodeExtDir,
  isPatched,
  getPatchedVersion,
  canRestoreOriginals,
  applyPatch,
  removePatch,
  ensurePatched,
  reloadWebviewAndNotify,
  notifyUnsupported,
  reloadMacros,
  describeMacros,
  readMacroConfig,
  currentMacroContext,
  currentMacroPayload,
  EXTENSION_VERSION,
  PATCH_MARKER,
  PATCH_CSS_MARKER,
  PATCH_VERSION_PREFIX,
  V2_INJECT_RE,
  ISSUES_URL,
  resolveMacroPath,
  readMacroSources,
  buildMacroPayload,
  renderMacroBlock,
  applyMacroBlock,
  insertMacroBlock,
  getMacroHash,
  MACRO_BEGIN,
  MACRO_END,
  MACRO_HASH_PREFIX,
  MACRO_LIMITS,
  BUNDLE_ANCHOR,
};
