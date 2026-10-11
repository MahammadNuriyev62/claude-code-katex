// Runs when the extension is uninstalled from VSCode
// Restores Claude Code's original webview files

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { replaceFiles } = require('./patch-files');

function findClaudeCodeDir() {
  const searchDirs = [
    path.join(require('os').homedir(), '.vscode-server', 'extensions'),
    path.join(require('os').homedir(), '.vscode', 'extensions'),
    path.join(require('os').homedir(), '.cursor', 'extensions'),
  ];
  for (const base of searchDirs) {
    try {
      const entries = fs.readdirSync(base);
      const match = entries
        .filter(e => e.startsWith('anthropic.claude-code-'))
        .sort()
        .pop();
      if (match) return path.join(base, match);
    } catch {}
  }
  return null;
}

function cleanupClaudeCode(extDir) {
  for (const [f, marker] of [
    ['webview/index.js', '/* === KaTeX LaTeX Rendering Patch === */'],
    ['webview/index.css', '/* === KaTeX LaTeX Rendering CSS Patch === */'],
  ]) {
    const bak = path.join(extDir, f + '.katex-bak');
    const orig = path.join(extDir, f);
    if (fs.existsSync(bak)) {
      // An upstream update may already have replaced the patched file. Never
      // downgrade that unpatched bundle to an older saved original.
      if (fs.existsSync(orig) && fs.readFileSync(orig, 'utf8').includes(marker)) {
        const original = fs.readFileSync(bak, 'utf8');
        try {
          if (original.includes(marker) || (f.endsWith('.js') && !original.trim())) {
            throw new Error('original backup is invalid');
          }
          if (f.endsWith('.js')) new vm.Script(original);
          replaceFiles([{ target: orig, body: original }]);
        } catch (error) {
          console.warn('[Claude Code LaTeX] Could not restore ' + f + ': ' + error.message);
          continue;
        }
      }
      fs.unlinkSync(bak);
    }
  }
  // Claude Code's host bundle, patched for the plan approval view (issue #17).
  // Restored only from a backup that is itself unpatched, so a half-applied
  // state can never be written back over a working file.
  const hostBak = path.join(extDir, 'extension.js.katex-bak');
  try {
    if (fs.existsSync(hostBak)) {
      const original = fs.readFileSync(hostBak, 'utf8');
      const hostPath = path.join(extDir, 'extension.js');
      const current = fs.existsSync(hostPath) ? fs.readFileSync(hostPath, 'utf8') : '';
      if (current.includes('/* === KaTeX plan-preview patch === */') &&
          original.length > 0 &&
          !original.includes('/* === KaTeX plan-preview patch === */')) {
        fs.writeFileSync(hostPath, original);
      }
      fs.unlinkSync(hostBak);
    }
  } catch (e) {
    console.warn('[Claude Code LaTeX] Could not clean up the plan-preview patch:', e && e.message);
  }

  const fontsDir = path.join(extDir, 'webview', 'fonts');
  const jsPath = path.join(extDir, 'webview', 'index.js');
  const stillPatched = fs.existsSync(jsPath) &&
    fs.readFileSync(jsPath, 'utf8').includes('/* === KaTeX LaTeX Rendering Patch === */');
  if (!stillPatched && fs.existsSync(fontsDir)) {
    fs.rmSync(fontsDir, { recursive: true });
  }
}

if (require.main === module) {
  const extDir = findClaudeCodeDir();
  if (extDir) cleanupClaudeCode(extDir);
}

module.exports = { cleanupClaudeCode, findClaudeCodeDir };
