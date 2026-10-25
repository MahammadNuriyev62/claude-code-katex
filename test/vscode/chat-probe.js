// Test-only adapter: expose the upstream chat Markdown component, JSX factory,
// root mount and error boundary from the installed, compiled Claude webview.
// No minified identifiers, replacement parser, React copy or test hook ships
// in the extension. A changed/ambiguous upstream layout fails the UI test.
const { parse } = require('../../vendor/acorn');

const PROBE_MARKER = '/* Claude Code chat regression probe (test only) */';
function key(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return node.value;
  return null;
}
function chatProbe(source) {
  const ast = parse(source, { ecmaVersion: 'latest' });
  const markdown = [], gates = [], mounts = [], boundaries = [];
  const stack = [{ node: ast, parent: null }];
  while (stack.length) {
    const { node, parent } = stack.pop();
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      const props = node.params[0];
      const keys = props?.type === 'ObjectPattern' ? props.properties.map(p => key(p.key)) : [];
      if (['content', 'context', 'links'].every(p => keys.includes(p)) &&
          (keys.includes('streaming') || keys.includes('isPartialText'))) {
        const name = node.id?.name || (parent?.type === 'VariableDeclarator' ? parent.id.name : null);
        if (name) markdown.push(name);
      }
    }
    if (['ClassDeclaration', 'ClassExpression'].includes(node.type)) {
      const name = node.id?.name || (parent?.type === 'VariableDeclarator' ? parent.id.name : null);
      if (name && node.body.body.some(m => m.kind === 'get' && key(m.key) === 'mathRenderingEnabled')) gates.push(name);
      if (name && node.body.body.some(m => key(m.key) === 'componentDidCatch') &&
          source.slice(node.start, node.end).includes('Error rendering content:')) boundaries.push(name);
    }
    if (node.type === 'CallExpression' && key(node.callee.property) === 'render') {
      const mount = node.callee.object;
      if (mount?.type === 'CallExpression' && key(mount.callee.property) === 'createRoot' &&
          mount.arguments[0]?.type === 'CallExpression' &&
          mount.arguments[0].arguments.some(a => a.value === '#root' || a.value === 'root') &&
          node.arguments[0]?.type === 'CallExpression') {
        mounts.push({ createRoot: source.slice(mount.callee.start, mount.callee.end),
          jsx: source.slice(node.arguments[0].callee.start, node.arguments[0].callee.end) });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) { if (child?.type) stack.push({ node: child, parent: node }); }
      else if (value?.type) stack.push({ node: value, parent: node });
    }
  }
  const factories = [...new Map(mounts.map(m => [m.createRoot + ':' + m.jsx, m])).values()];
  if (markdown.length !== 1 || factories.length !== 1 || boundaries.length !== 1 || gates.length > 1) {
    throw new Error(`Cannot prove upstream chat UI adapter: markdown=${markdown.length}, mounts=${mounts.length}, boundaries=${boundaries.length}, gates=${gates.length}`);
  }
  const gate = gates.length ? `Object.getOwnPropertyDescriptor(${gates[0]}.prototype,'mathRenderingEnabled').get.call(fake)` : 'false';
  const { jsx, createRoot } = factories[0];
  return `${PROBE_MARKER}
window.__KATEX_CHAT_PROBE={errors:[],hasNativeGate:${gates.length === 1},
  gate(enabled=true){const fake={comms:{connection:{value:{config:{value:{experimentGates:{tengu_vscode_math_rendering:enabled}}}}}}};return ${gate}},
  render(content,streaming,enabled=true){
    if(!this.root){
      const host=document.createElement('section');host.id='katex-chat-regression';
      host.style='position:fixed;inset:0;overflow:auto;z-index:2147483647;padding:24px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)';
      const label=document.createElement('p');label.textContent='Chat renderer regression — deterministic fixture';
      const output=document.createElement('div');output.id='katex-chat-output';host.append(label,output);document.body.append(host);
      this.root=${createRoot}(output);
    }
    const state=this,context={host:'vscode',platform:'${process.platform === 'win32' ? 'windows' : process.platform}',fileOpener:{open(){}}};
    Object.defineProperty(context,'mathRenderingEnabled',{get:()=>state.gate(enabled)});
    this.effectiveGate=context.mathRenderingEnabled;
    const serial=this.serial=(this.serial||0)+1;
    this.root.render(${jsx}('div',{ref:()=>{state.committed=serial},children:${jsx}(${boundaries[0]},{resetKey:content+streaming,onError(){state.errors.push('upstream-chat-render-error')},children:${jsx}(${markdown[0]},{content,context,streaming,isPartialText:streaming==='settledBlocks'})})}));
  }
};`;
}

module.exports = { chatProbe, PROBE_MARKER };
