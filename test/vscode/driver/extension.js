// Test extension only. Use VS Code's supported command/configuration APIs to
// prepare the real UI; leave the actual math interactions to keyboard/mouse.
const vscode = require('vscode');
const http = require('http');
function activate(context) {
  const port = Number(process.env.KATEX_TEST_DRIVER_PORT);
  const token = process.env.KATEX_TEST_DRIVER_TOKEN;
  if (!port || !token) return;
  const allowed = new Set(['workbench.action.reloadWindow', 'claude-vscode.primaryEditor.open', 'claude-code-katex.disable']);
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(403).end(); return; }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 4096) { response.writeHead(413).end(); return; }
    }
    try {
      const { command, theme } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (command === 'paste') {
        const document = await vscode.workspace.openTextDocument({ language: 'latex' });
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        response.writeHead(200).end(JSON.stringify({ pasted: document.getText() })); return;
      } else if (theme && ['Default Dark Modern', 'Default Light Modern'].includes(theme)) {
        await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
      } else if (allowed.has(command)) {
        if (command === 'workbench.action.reloadWindow') {
          response.writeHead(200).end('{}');
          void vscode.commands.executeCommand(command); return;
        }
        await vscode.commands.executeCommand(command);
      } else if (command !== 'ready') { response.writeHead(400).end(); return; }
      response.writeHead(200).end('{}');
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: error.message })); }
  });
  server.listen(port, '127.0.0.1');
  context.subscriptions.push({ dispose: () => server.close() });
}
module.exports = { activate };
