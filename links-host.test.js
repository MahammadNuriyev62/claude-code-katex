const fs = require('fs');
const os = require('os');
const path = require('path');

const mockExec = jest.fn();
const mockOpenExternal = jest.fn();
const mockShowTextDocument = jest.fn();
const mockWarn = jest.fn();
const mockRegistered = {};
const mockInfo = jest.fn();
const mockCloseTabs = jest.fn();
let mockTabs = [];
class MockTabInputText { constructor(uri) { this.uri = uri; } }
const mockFileUri = (p) => ({ fsPath: p, scheme: 'file', toString: () => 'file://' + p });

jest.mock('vscode', () => ({
  Uri: { file: (p) => mockFileUri(p) },
  Range: class { constructor(...a) { this.a = a; } },
  TabInputText: MockTabInputText,
  commands: { executeCommand: (...a) => mockExec(...a) },
  env: { openExternal: (...a) => mockOpenExternal(...a) },
  window: {
    showTextDocument: (...a) => mockShowTextDocument(...a),
    registerUriHandler: (h) => { mockRegistered.uri = h; return {}; },
    onDidChangeActiveTextEditor: (f) => { mockRegistered.editor = f; return {}; },
    showWarningMessage: (...a) => mockWarn(...a),
    showInformationMessage: (...a) => mockInfo(...a),
    tabGroups: { get all() { return [{ tabs: mockTabs }]; }, close: (...a) => mockCloseTabs(...a) },
  },
  workspace: { workspaceFolders: [] },
}), { virtual: true });

const vscode = require('vscode');
const { handleLink, fixBinaryEditor } = require('./links-host')._test;
const { registerLinks } = require('./links-host');

let ws, outside;
const link = (q) => handleLink({ query: new URLSearchParams(q).toString() });
const touch = (p, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); if (mode) fs.chmodSync(p, mode); return p; };

beforeEach(() => {
  jest.clearAllMocks();
  mockTabs = [];
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-ws-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ccl-out-'));
  vscode.workspace.workspaceFolders = [{ uri: { fsPath: ws } }];
});
afterEach(() => { fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

test('Open on a PDF uses vscode.open (the PDF viewer), not a text editor', async () => {
  const p = touch(path.join(outside, 'paper.pdf'));
  await link({ action: 'open', path: p });
  expect(mockExec).toHaveBeenCalledWith('vscode.open', expect.objectContaining({ fsPath: p }));
  expect(mockShowTextDocument).not.toHaveBeenCalled();
});

test('Open on an Office file hands it to the system app', async () => {
  const p = touch(path.join(ws, 'draft.docx'));
  await link({ action: 'open', path: p });
  expect(mockOpenExternal).toHaveBeenCalledWith(expect.objectContaining({ fsPath: p }));
});

test('Open on a text file goes to its line', async () => {
  const p = touch(path.join(ws, 'a.R'));
  await link({ action: 'open', path: p, line: '12' });
  expect(mockShowTextDocument.mock.calls[0][1].selection.a).toEqual([11, 0, 11, 0]);
});

test('relative paths resolve against the workspace folder', async () => {
  touch(path.join(ws, 'sub', 'b.txt'));
  await link({ action: 'open', path: 'sub/b.txt' });
  expect(mockShowTextDocument.mock.calls[0][0].fsPath).toBe(path.join(ws, 'sub', 'b.txt'));
});

test('Open on a folder opens it in the file manager, inside the workspace or out', async () => {
  fs.mkdirSync(path.join(ws, 'figs'));
  await link({ action: 'open', path: path.join(ws, 'figs') });
  await link({ action: 'open', path: outside });
  expect(mockOpenExternal.mock.calls.map((c) => c[0].fsPath)).toEqual([path.join(ws, 'figs'), outside]);
  expect(mockExec).not.toHaveBeenCalled();
});

test('Open on an extensionless file (the panel guessed folder) opens it in the editor', async () => {
  const p = touch(path.join(ws, 'Makefile'));
  await link({ action: 'open', path: p });
  expect(mockShowTextDocument.mock.calls[0][0].fsPath).toBe(p);
  expect(mockOpenExternal).not.toHaveBeenCalled();
});

test('Reveal in sidebar: sidebar inside the workspace, a message outside', async () => {
  const inside = touch(path.join(ws, 'c.txt'));
  const out = touch(path.join(outside, 'd.txt'));
  await link({ action: 'reveal', path: inside });
  expect(mockExec).toHaveBeenLastCalledWith('revealInExplorer', expect.objectContaining({ fsPath: inside }));
  mockExec.mockClear();
  await link({ action: 'reveal', path: out });
  expect(mockExec).not.toHaveBeenCalled();
  expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining(out));
});

test('Open containing folder always uses the file manager', async () => {
  const p = touch(path.join(ws, 'e.txt'));
  await link({ action: 'folder', path: p });
  expect(mockExec).toHaveBeenCalledWith('revealFileInOS', expect.objectContaining({ fsPath: p }));
});

test('system app: opens documents, refuses scripts and executables', async () => {
  const pdf = touch(path.join(outside, 'f.pdf'));
  await link({ action: 'system', path: pdf });
  expect(mockOpenExternal).toHaveBeenCalledTimes(1);
  await link({ action: 'system', path: touch(path.join(outside, 'run.sh')) });
  await link({ action: 'system', path: touch(path.join(outside, 'tool'), 0o755) });
  await link({ action: 'system', path: touch(path.join(outside, 'x.desktop')) });
  expect(mockOpenExternal).toHaveBeenCalledTimes(1);
  expect(mockWarn).toHaveBeenCalledTimes(3);
});

test('a missing file or unknown action only warns', async () => {
  await link({ action: 'open', path: path.join(ws, 'nope.txt') });
  await link({ action: 'delete', path: touch(path.join(ws, 'g.txt')) });
  expect(mockWarn).toHaveBeenCalledTimes(2);
  expect(mockExec).not.toHaveBeenCalled();
  expect(mockOpenExternal).not.toHaveBeenCalled();
});

test('a PDF opened as text is closed and reopened in its viewer', async () => {
  const p = touch(path.join(outside, 'h.pdf'));
  const uri = mockFileUri(p);
  mockTabs = [{ input: new MockTabInputText(uri) }];
  await fixBinaryEditor({ document: { uri } });
  expect(mockCloseTabs).toHaveBeenCalledWith(mockTabs);
  expect(mockExec).toHaveBeenCalledWith('vscode.open', expect.objectContaining({ fsPath: p }));
});

test('a text file opened as text is left alone', async () => {
  const p = touch(path.join(ws, 'i.tex'));
  await fixBinaryEditor({ document: { uri: mockFileUri(p) } });
  expect(mockCloseTabs).not.toHaveBeenCalled();
  expect(mockExec).not.toHaveBeenCalled();
});

test('with the setting off, the URI handler and the binary-file fix do nothing', async () => {
  let on = false;
  registerLinks({ subscriptions: [] }, () => on);
  const p = touch(path.join(outside, 'j.pdf'));
  const uri = mockFileUri(p);
  mockTabs = [{ input: new MockTabInputText(uri) }];
  await mockRegistered.uri.handleUri({ path: '/link', query: new URLSearchParams({ action: 'open', path: p }).toString() });
  await mockRegistered.editor({ document: { uri } });
  expect(mockExec).not.toHaveBeenCalled();
  expect(mockCloseTabs).not.toHaveBeenCalled();
  on = true;
  await mockRegistered.uri.handleUri({ path: '/link', query: new URLSearchParams({ action: 'open', path: p }).toString() });
  expect(mockExec).toHaveBeenCalledWith('vscode.open', expect.objectContaining({ fsPath: p }));
});
