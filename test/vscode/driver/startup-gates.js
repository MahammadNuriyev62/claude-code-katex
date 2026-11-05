// Deterministic scheduler for the real two-host startup test. Never packaged.
// Delay actual VS Code activation until CDP is attached, then pause window A
// after preparation while window B commits to their shared extension files.
const fs = require('fs');
const path = require('path');
const { setTimeout: pause } = require('timers/promises');

function install(vscode) {
  const root = process.env.KATEX_STARTUP_RACE_DIR;
  const role = process.env.KATEX_STARTUP_RACE_ROLE;
  if (!root || !['A', 'B'].includes(role)) return;
  const write = fs.writeFileSync.bind(fs);
  const signal = name => write(path.join(root, role + '-' + name), 'ready');
  const extension = vscode.extensions.getExtension('nuriyev.claude-code-katex');
  const claude = vscode.extensions.getExtension('anthropic.claude-code');
  const main = require(path.join(extension.extensionPath, 'extension.js'));
  const originalActivate = main.activate;
  main.activate = async context => {
    signal('waiting');
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(path.join(root, role + '-open'))) {
      if (Date.now() > deadline) throw new Error('Startup test did not attach its browser');
      await pause(50);
    }
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('claude-vscode.primaryEditor.open');
    signal('opened');
    return originalActivate(context);
  };
  if (role !== 'A') return;
  let paused = false;
  fs.writeFileSync = function(file, ...args) {
    if (!paused && typeof file === 'string' && file.startsWith(claude.extensionPath) &&
        /index\.js\.katex-bak\.katex-[a-f0-9]+\.tmp$/.test(file)) {
      paused = true; signal('prepared');
      const deadline = Date.now() + 60000, sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(path.join(root, 'A-release'))) {
        if (Date.now() > deadline) throw new Error('Startup test did not release the staged writer');
        Atomics.wait(sleeper, 0, 0, 25);
      }
      signal('released');
    }
    return write(file, ...args);
  };
}
module.exports = { install };
