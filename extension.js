const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const PATCH_MARKER = '/* === KaTeX LaTeX Rendering Patch === */';
const PATCH_CSS_MARKER = '/* === KaTeX LaTeX Rendering CSS Patch === */';

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
//   createElement(<Markdown>, {remarkPlugins:[<plugins>], components:{...}}, <text>)
// The patch injects the math plugins here. $1 = the Markdown component
// identifier, $2 = the existing remark plugin list. `remarkPlugins` is
// react-markdown's stable public prop name, so this survives minification-hash
// churn; if a future Claude Code reshapes the call entirely, applyPatch reports
// it as unsupported rather than patching blind.
const V2_INJECT_RE = /createElement\(([A-Za-z_$][\w$]*),\{remarkPlugins:\[([A-Za-z_$][\w$,]*)\]/;

function findClaudeCodeExtDir() {
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  return ext ? ext.extensionPath : null;
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

// Patches Claude Code's webview to render math through its own react-markdown
// pipeline. Returns true if patched, or false if the react-markdown injection
// point was not found (a future Claude Code reshaped its bundle) — in which
// case nothing on disk is touched and the caller surfaces an "unsupported"
// message.
function applyPatch(extDir, vendorDir) {
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
  const v2Bundle = fs.readFileSync(path.join(vendorDir, 'remark-math-bundle.js'), 'utf8');
  const injectedBody = body.replace(
    V2_INJECT_RE,
    'createElement($1,{rehypePlugins:window.__KATEX_V2_LOADED?[window.__rehypeKatex]:[],' +
    'remarkPlugins:[$2].concat(window.__KATEX_V2_LOADED?[window.__remarkBracketMath,window.__remarkMath]:[])'
  );
  fs.writeFileSync(jsPath,
    `${PATCH_MARKER}\n${PATCH_VERSION_PREFIX}${EXTENSION_VERSION} */\n` +
    `/* KaTeX Core - MIT License - https://katex.org */\n${katexCore}\n` +
    `/* remark-math + rehype-katex pipeline */\n${v2Bundle}\n` +
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
function ensurePatched(extDir, vendorDir) {
  if (!isPatched(extDir)) {
    return applyPatch(extDir, vendorDir) ? 'fresh' : 'unsupported';
  }
  if (getPatchedVersion(extDir) === EXTENSION_VERSION) {
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
  return applyPatch(extDir, vendorDir) ? 'refreshed' : 'unsupported';
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

function activate(context) {
  const vendorDir = path.join(context.extensionPath, 'vendor');

  // Auto-patch on startup. Files stay patched on disk between sessions so the
  // webview always loads the patched version (it loads before this extension).
  const extDir = findClaudeCodeExtDir();
  if (extDir) {
    try {
      const result = ensurePatched(extDir, vendorDir);
      if (result === 'fresh') {
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
        if (applyPatch(dir, vendorDir)) {
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
      let status;
      if (!isPatched(dir)) {
        status = 'Not active — reload the window to apply';
      } else {
        const patchVer = getPatchedVersion(dir);
        if (patchVer === EXTENSION_VERSION) status = 'Active — patch up to date';
        else if (patchVer) status = 'Active — applied patch is v' + patchVer + ' (older than the extension); reload to refresh';
        else status = 'Active — applied patch predates version stamping; reload to refresh';
      }
      vscode.window.showInformationMessage(
        'Claude Code LaTeX v' + EXTENSION_VERSION + '\n' + status + '\nClaude Code: ' + dir
      );
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
        '. Click for status.';
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
          const result = ensurePatched(dir, vendorDir);
          if (result === 'fresh' || result === 'refreshed') {
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
  EXTENSION_VERSION,
  PATCH_MARKER,
  PATCH_CSS_MARKER,
  PATCH_VERSION_PREFIX,
  V2_INJECT_RE,
  ISSUES_URL,
};
