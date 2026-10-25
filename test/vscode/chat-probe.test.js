const { chatProbe } = require('./chat-probe');

const bootstrap = `class Boundary {componentDidCatch(){console.error('Error rendering content:')}render(){return this.props.children}}
Dom.createRoot(document.querySelector('#root')).render(jsx(App,{}));`;
const current = `function Chat({content:c,context:x,streaming:s,links:l='live'}){return c}
class State {get mathRenderingEnabled(){return this.enabled}}`;

test('adapter resolves actual component and factories without depending on minified names', () => {
  const probe = chatProbe(current + bootstrap);
  expect(probe).toContain('Dom.createRoot(output)');
  expect(probe).toContain('jsx(Chat,');
  expect(probe).toContain("Object.getOwnPropertyDescriptor(State.prototype,'mathRenderingEnabled')");
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
