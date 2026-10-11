// Host side of the file-link features (see vendor/links.js).
//
// 1. A URI handler for vscode://<this extension>/link?action=..&path=..
//    [&line=..], fired by the right-click menu in Claude's panel.
//    Any web page can send such a link, so the handler only opens, reveals
//    or shows files, and never hands an executable to the system.
// 2. Claude Code opens every clicked file with openTextDocument, so a PDF
//    shows up as raw bytes. When a binary file appears in a text editor it
//    is closed and reopened with vscode.open (LaTeX Workshop's viewer for a
//    PDF, the image preview for images), or with the system app for formats
//    VS Code cannot show.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Shown by VS Code itself through vscode.open.
const VIEWABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
// Handed to the system app.
const EXTERNAL = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp',
  '.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.m4a', '.zip', '.gz', '.tgz', '.7z']);
// Never opened with the system app: opening these can run them.
const EXECUTABLE = new Set(['.sh', '.bash', '.zsh', '.desktop', '.appimage', '.run', '.bin', '.exe',
  '.bat', '.cmd', '.com', '.ps1', '.py', '.pl', '.rb', '.js', '.mjs', '.jar', '.deb', '.rpm', '.msi', '.command']);

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : null;
}

// Relative paths resolve against the first workspace folder, as Claude Code
// does for its own links.
function resolvePath(p) {
  if (!p) return null;
  if (p === '~' || p.startsWith('~/')) p = path.join(require('os').homedir(), p.slice(1));
  if (!path.isAbsolute(p)) {
    const root = workspaceRoot();
    if (!root) return null;
    p = path.join(root, p);
  }
  return path.resolve(p);
}

function inWorkspace(p) {
  return (vscode.workspace.workspaceFolders || []).some((f) => {
    const rel = path.relative(f.uri.fsPath, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

function isExecutable(p, stat) {
  if (EXECUTABLE.has(path.extname(p).toLowerCase())) return true;
  return stat.isFile() && (stat.mode & 0o111) !== 0;
}

async function openFile(p, line) {
  const uri = vscode.Uri.file(p);
  const ext = path.extname(p).toLowerCase();
  if (EXTERNAL.has(ext)) return vscode.env.openExternal(uri);
  if (VIEWABLE.has(ext)) return vscode.commands.executeCommand('vscode.open', uri);
  const opts = line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {};
  return vscode.window.showTextDocument(uri, opts);
}

async function handleLink(uri) {
  const q = new URLSearchParams(uri.query);
  const action = q.get('action');
  const p = resolvePath(q.get('path'));
  const line = parseInt(q.get('line') || '', 10) || null;
  if (!p) {
    vscode.window.showWarningMessage('Cannot resolve that link: no workspace folder is open.');
    return;
  }
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    vscode.window.showWarningMessage(`Not found: ${p}`);
    return;
  }
  const target = vscode.Uri.file(p);
  switch (action) {
    case 'open':
      // A folder opens in the system file manager.
      if (stat.isDirectory()) return vscode.env.openExternal(target);
      return openFile(p, line);
    case 'system':
      if (isExecutable(p, stat)) {
        vscode.window.showWarningMessage(`Not opening ${path.basename(p)} with the system app: it could run as a program.`);
        return;
      }
      return vscode.env.openExternal(target);
    case 'reveal':
      // Sidebar only; the file manager is "Open containing folder".
      if (!inWorkspace(p)) {
        vscode.window.showInformationMessage(`Not in this workspace, so not in the sidebar: ${p}`);
        return;
      }
      return vscode.commands.executeCommand('revealInExplorer', target);
    case 'folder':
      return vscode.commands.executeCommand('revealFileInOS', target);
    default:
      vscode.window.showWarningMessage(`Unknown link action: ${action}`);
  }
}

// Close text tabs showing a binary file and reopen it properly.
const reopening = new Set();
async function fixBinaryEditor(editor) {
  const doc = editor && editor.document;
  if (!doc || doc.uri.scheme !== 'file') return;
  const ext = path.extname(doc.uri.fsPath).toLowerCase();
  if (!VIEWABLE.has(ext) && !EXTERNAL.has(ext)) return;
  const key = doc.uri.toString();
  if (reopening.has(key)) return;
  reopening.add(key);
  try {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key);
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    await openFile(doc.uri.fsPath, null);
  } finally {
    setTimeout(() => reopening.delete(key), 1000);
  }
}

// Both pieces do nothing unless the claudeCodeKatex.fileLinks setting is on.
function registerLinks(context, enabled) {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        if (enabled() && uri.path === '/link') return handleLink(uri);
      },
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (enabled()) return fixBinaryEditor(editor);
    })
  );
}

module.exports = { registerLinks, _test: { resolvePath, inWorkspace, isExecutable, handleLink, fixBinaryEditor, openFile } };
