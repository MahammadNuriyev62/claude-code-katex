// Test-only adapter: expose the upstream chat Markdown component, JSX factory,
// root mount and error boundary from the installed, compiled Claude webview.
// No minified identifiers, replacement parser, React copy or test hook ships
// in the extension. A changed/ambiguous upstream layout fails the UI test.
const { parseJavaScript } = require('../../javascript');

const PROBE_MARKER = '/* Claude Code chat regression probe (test only) */';
function key(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return node.value;
  return null;
}
function chatProbe(source, pristineSource = source) {
  if (pristineSource.startsWith('/* === KaTeX LaTeX Rendering Patch === */')) {
    throw new Error('Expected pristine upstream source for the native fallback baseline');
  }
  const ast = parseJavaScript(source);
  const markdown = [], gates = [], nativeGetters = [], mounts = [], boundaries = [];
  const stack = [{ node: ast, parent: null }];
  while (stack.length) {
    const { node, parent } = stack.pop();
    if (['MethodDefinition', 'Property'].includes(node.type) && node.kind === 'get' &&
        key(node.key) === 'mathRenderingEnabled') nativeGetters.push(node);
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
      if (node.body.body.some(m => m.kind === 'get' && key(m.key) === 'mathRenderingEnabled')) gates.push({ node });
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
  if (nativeGetters.length !== gates.length || nativeGetters.some(n => n.static)) {
    throw new Error('Unsupported native math getter layout');
  }
  const factories = [...new Map(mounts.map(m => [m.createRoot + ':' + m.jsx, m])).values()];
  if (markdown.length !== 1 || factories.length !== 1 || boundaries.length !== 1 || gates.length > 1) {
    throw new Error(`Cannot prove upstream chat UI adapter: markdown=${markdown.length}, mounts=${mounts.length}, boundaries=${boundaries.length}, gates=${gates.length}`);
  }
  const gate = gates.length ? 'context.mathRenderingEnabled' : 'false';
  let originalBody = '';
  if (gates.length) {
    // Retain a pristine getter inside the SAME class so private-field brands,
    // super and lexical bindings remain valid. It is an independent oracle for
    // the packaged guard, not a prediction made by the patched implementation.
    const originals = [], pending = [pristineSource === source ? ast : parseJavaScript(pristineSource)];
    while (pending.length) {
      const node = pending.pop();
      if (node.kind === 'get' && key(node.key) === 'mathRenderingEnabled') originals.push(node);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) { if (child?.type) pending.push(child); }
        else if (value?.type) pending.push(value);
      }
    }
    if (originals.length !== 1 || originals[0].type !== 'MethodDefinition' || originals[0].static) {
      throw new Error('Cannot prove pristine native math getter');
    }
    originalBody = pristineSource.slice(originals[0].value.body.start, originals[0].value.body.end);
  }
  // Capture the instance created by the real app, including private fields and
  // computed signals. A class initializer also works with derived constructors;
  // it never recreates settings, invokes a constructor, or reads private paths.
  const capture = ";[Symbol.for('katex.test.context')]=(window.__KATEX_CHAT_CONTEXTS??=[]).push(this);" +
    `get [Symbol.for('katex.test.originalMathGate')]()${originalBody}`;
  const position = gates.length ? gates[0].node.body.start + 1 : 0;
  const instrumented = gates.length ? source.slice(0, position) + capture + source.slice(position) : source;
  const { jsx, createRoot } = factories[0];
  return `${instrumented}\n${PROBE_MARKER}
window.__KATEX_CHAT_PROBE={errors:[],hasNativeGate:${gates.length === 1},
  context(){
    if(!this.hasNativeGate)return this.legacyContext??={host:'vscode',platform:'${process.platform === 'win32' ? 'windows' : process.platform}',fileOpener:{open(){}}};
    const contexts=window.__KATEX_CHAT_CONTEXTS??[];
    if(!contexts.length)throw new Error('No upstream chat context instance was constructed');
    if(contexts.length!==1)throw new Error('Ambiguous upstream chat context instances: '+contexts.length);
    return contexts[0];
  },
  gate(){const context=this.context();return ${gate}},
  nativeBaseline(){return this.hasNativeGate?this.context()[Symbol.for('katex.test.originalMathGate')]:false},
  verifyNativeFallback(){
    const baseline=this.nativeBaseline(),actual=this.gate();
    if(typeof baseline!=='boolean'||actual!==baseline)throw new Error('Native fallback differs from pristine upstream: expected '+baseline+', got '+actual);
    return baseline;
  },
  describe(){this.context();return {contextSource:this.hasNativeGate?'upstream-instance':'pre-native-fixture',instances:window.__KATEX_CHAT_CONTEXTS?.length??0}},
  render(content,streaming){
    if(!this.root){
      const host=document.createElement('section');host.id='katex-chat-regression';
      host.style='position:fixed;inset:0;overflow:auto;z-index:2147483647;padding:24px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)';
      const label=document.createElement('p');label.textContent='Chat renderer regression — deterministic fixture';
      const output=document.createElement('div');output.id='katex-chat-output';host.append(label,output);document.body.append(host);
      this.root=${createRoot}(output);
    }
    const state=this,context=this.context();
    this.effectiveGate=this.gate();
    const serial=this.serial=(this.serial||0)+1;
    this.root.render(${jsx}('div',{ref:()=>{state.committed=serial},children:${jsx}(${boundaries[0]},{resetKey:content+streaming,onError(){state.errors.push('upstream-chat-render-error')},children:${jsx}(${markdown[0]},{content,context,streaming,isPartialText:streaming==='settledBlocks'})})}));
  }
};`;
}

module.exports = { chatProbe, PROBE_MARKER };
