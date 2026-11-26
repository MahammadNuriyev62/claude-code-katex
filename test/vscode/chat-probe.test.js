const { chatProbe } = require('./chat-probe');
const vm = require('vm');
const { injectMathPlugins } = require('../../markdown-patch');

const bootstrap = `class Boundary {componentDidCatch(){console.error('Error rendering content:')}render(){return this.props.children}}
Dom.createRoot(document.querySelector('#root')).render(jsx(App,{}));`;
const current = `function Chat({content:c,context:x,streaming:s,links:l='live'}){return c}
class State {get mathRenderingEnabled(){return this.enabled}}`;

function runProbe(source, pristineSource = source) {
  const context = { window: {}, Dom: { createRoot: () => ({ render() {} }) }, jsx() {}, App: {},
    document: { querySelector() {} }, F() {}, Markdown: {}, gfm: {} };
  // The adapter must preserve and execute the actual upstream bootstrap.
  vm.runInNewContext(chatProbe(source, pristineSource), context);
  return context;
}

test.each([
  'comms={connection:{value:{config:{value:{experimentGates:{math:DECISION}}}}}};get mathRenderingEnabled(){return this.comms.connection.value.config.value.experimentGates.math}',
  'rowState={value:{math:DECISION}};get mathRenderingEnabled(){return this.rowState.value.math}',
  'renamed={deep:{flag:DECISION}};get mathRenderingEnabled(){return this.renamed.deep.flag}',
  '#flag=DECISION;get mathRenderingEnabled(){return this.#flag}',
  '#flag=DECISION;constructor(){Object.freeze(this)}get mathRenderingEnabled(){return this.#flag}',
])('uses the actual constructed receiver across settings layouts: %s', fields => {
  for (const decision of [true, false]) {
    const source = current.slice(0, current.indexOf('class State')) +
      `class State {${fields.replaceAll('DECISION', String(decision))}}` +
      'window.realContext=new State();' + bootstrap;
    const c = runProbe(source);
    expect(c.window.__KATEX_CHAT_PROBE.context()).toBe(c.window.realContext);
    expect(c.window.__KATEX_CHAT_PROBE.gate()).toBe(decision);
  }
});

test('real computed state remains live instead of being copied into a fixture', () => {
  const source = current.slice(0, current.indexOf('class State')) +
    'class State {#flag=true;disable(){this.#flag=false}get mathRenderingEnabled(){return this.#flag}}' +
    'window.realContext=new State();' + bootstrap;
  const c = runProbe(source);
  expect(c.window.__KATEX_CHAT_PROBE.gate()).toBe(true);
  c.window.realContext.disable();
  expect(c.window.__KATEX_CHAT_PROBE.gate()).toBe(false);
});

test('a derived context is captured after super with its private-field brand intact', () => {
  const source = current.slice(0, current.indexOf('class State')) +
    'class Base {} class State extends Base {#flag=true;get mathRenderingEnabled(){return this.#flag}}' +
    'window.realContext=new State();' + bootstrap;
  const c = runProbe(source);
  expect(c.window.__KATEX_CHAT_PROBE.context()).toBe(c.window.realContext);
  expect(c.window.__KATEX_CHAT_PROBE.gate()).toBe(true);
});

test('a named class expression uses the actual property receiver, not its class-local name', () => {
  const source = current.slice(0, current.indexOf('class State')) +
    'const Exported=class Internal {#flag=true;get mathRenderingEnabled(){return this.#flag}};' +
    'window.realContext=new Exported();' + bootstrap;
  expect(runProbe(source).window.__KATEX_CHAT_PROBE.gate()).toBe(true);
});

test('unsupported object native getters cannot silently select pre-native coverage', () => {
  const source = current.slice(0, current.indexOf('class State')) +
    'const state={get mathRenderingEnabled(){return true}};' + bootstrap;
  expect(() => chatProbe(source)).toThrow('Unsupported native math getter layout');
});

test('an already-patched bundle cannot supply its own pristine baseline', () => {
  expect(() => chatProbe('/* === KaTeX LaTeX Rendering Patch === */' + current + bootstrap))
    .toThrow('Expected pristine upstream source');
});

test.each([true, false])('pristine getter is independent of a packaged native guard: %s', decision => {
  const pristine = current.slice(0, current.indexOf('class State')) +
    `class State {#flag=${decision};get mathRenderingEnabled(){return this.#flag}}` +
    'window.realContext=new State();' + bootstrap;
  const faulty = pristine.replace('get mathRenderingEnabled(){return this.#flag}', 'get mathRenderingEnabled(){return false}');
  const probe = runProbe(faulty, pristine).window.__KATEX_CHAT_PROBE;
  expect(probe.nativeBaseline()).toBe(decision);
  if (decision) expect(() => probe.verifyNativeFallback()).toThrow('Native fallback differs from pristine upstream');
  else expect(probe.verifyNativeFallback()).toBe(false);
});

test('the shipped native-math guard is exercised on a real instance and preserves native false', () => {
  for (const decision of [true, false]) {
    const source = current.slice(0, current.indexOf('class State')) +
      `class State {#flag=${decision};get mathRenderingEnabled(){return this.#flag}}` +
      'window.realContext=new State();F(Markdown,{remarkPlugins:[gfm],components:{}});' + bootstrap;
    const c = runProbe(injectMathPlugins(source), source);
    expect(c.window.__KATEX_CHAT_PROBE.gate()).toBe(decision);
    c.window.__KATEX_V2_LOADED = true;
    expect(c.window.__KATEX_CHAT_PROBE.gate()).toBe(false);
    c.window.__KATEX_V2_LOADED = false;
    expect(c.window.__KATEX_CHAT_PROBE.gate()).toBe(decision);
  }
});

test.each([
  ['', 'No upstream chat context instance'],
  ['new State();new State();', 'Ambiguous upstream chat context instances'],
])('missing or ambiguous real contexts fail explicitly', (construct, message) => {
  const c = runProbe(current + construct + bootstrap);
  expect(() => c.window.__KATEX_CHAT_PROBE.context()).toThrow(message);
});

test.each([
  'const asset=new URL("./asset.svg",import.meta.url);',
  'import asset from "./asset.js";export {asset};',
  'await Promise.resolve();',
])('adapter supports module webviews: %s', prefix => {
  expect(chatProbe(prefix + current + bootstrap)).toContain('jsx(Chat,');
});

test('adapter resolves actual component and factories without depending on minified names', () => {
  const probe = chatProbe(current + bootstrap);
  expect(probe).toContain('Dom.createRoot(output)');
  expect(probe).toContain('jsx(Chat,');
  expect(probe).toContain('hasNativeGate:true');
});

test('adapter supports the pre-native partial-text renderer', () => {
  const source = 'const Legacy=({content,context,isPartialText,links})=>content;' + bootstrap;
  expect(chatProbe(source)).toContain('jsx(Legacy,');
  expect(chatProbe(source)).toContain('hasNativeGate:false');
});

test('identical bootstrap factories can be used in more than one app entry point', () => {
  expect(chatProbe(current + bootstrap + 'Dom.createRoot(document.querySelector("#root")).render(jsx(Other,{}));'))
    .toContain('Dom.createRoot(output)');
});

test.each([
  bootstrap,
  current + bootstrap + current.replaceAll('Chat', 'Other').replaceAll('State', 'OtherState'),
  current + bootstrap.replace('createRoot', 'newRoot'),
  current + bootstrap.replace('Error rendering content:', 'different boundary'),
  current + bootstrap + 'OtherDom.createRoot(document.querySelector("#root")).render(otherJsx(Other,{}));',
])('unknown or ambiguous upstream layouts fail the test instead of silently skipping coverage', source => {
  expect(() => chatProbe(source)).toThrow('Cannot prove upstream chat UI adapter');
});
