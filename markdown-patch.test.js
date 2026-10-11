const vm = require('vm');
const { injectMathPlugins } = require('./markdown-patch');

function evaluate(source, loaded = true) {
  const patched = injectMathPlugins(source);
  expect(patched).not.toBeNull();
  const context = { window: { __KATEX_V2_LOADED: loaded, __rehypeKatex: 'katex',
    __remarkBracketMath: 'brackets', __remarkMath: 'math' },
    F: (_, props) => props, M: {}, gfm: 'gfm', extra: 'extra',
    existing: 'existing', text: '$x$', calls: 0 };
  vm.runInNewContext(patched, context);
  return context;
}

test.each([
  'F ( M, { components: {}, remarkPlugins: [gfm, extra], children: text } )',
  'F(M,{"components":{},["remarkPlugins"]:[gfm, extra],children:text})',
  'F(M,{components:{},remarkPlugins:[gfm, ...[extra]],children:text})',
  'F(M,{components:{},remarkPlugins:[gfm,extra],rehypePlugins:[existing],children:text})',
  'F(M,{/* before plugins */remarkPlugins:[gfm,extra],components:{},children:text})',
])('preserves props and existing plugins across compiler layouts: %s', call => {
  const context = evaluate('var el=' + call + ';');
  expect(Array.from(context.el.remarkPlugins)).toEqual(['gfm', 'extra', 'brackets', 'math']);
  expect(Array.from(context.el.rehypePlugins)).toEqual(
    call.includes('rehypePlugins') ? ['existing', 'katex'] : ['katex']);
  expect(context.el.children).toBe('$x$');
});

test.each([
  'function props(x){if(x)return {remarkPlugins:[gfm]};return {remarkPlugins:[gfm]}}',
  'const props=(x)=>({remarkPlugins:[gfm]});',
  'var props=function(x){return x?{remarkPlugins:[gfm]}:{remarkPlugins:[gfm]}};',
  'function props(x){return x?{remarkPlugins:[gfm]}:x===0?{remarkPlugins:[gfm]}:{remarkPlugins:[gfm]}}',
  'const sourceProps={remarkPlugins:[gfm]};function props(){return sourceProps}',
])('resolves a scoped helper independent of its compiler shape: %s', helper => {
  const context = evaluate(helper + ';var el=F(M,{...props(true),components:{}});');
  expect(Array.from(context.el.remarkPlugins)).toEqual(['gfm', 'brackets', 'math']);
});

test('later spreads win, getters and calls run once, and original props are preserved', () => {
  const source = 'var original={get remarkPlugins(){calls++;return [gfm]},rehypePlugins:[existing]};' +
    'var later={remarkPlugins:[extra]};var el=F(M,{...original,components:{},...later});';
  const context = evaluate(source);
  expect(context.calls).toBe(1);
  expect(Array.from(context.el.remarkPlugins)).toEqual(['extra', 'brackets', 'math']);
  expect(Array.from(context.el.rehypePlugins)).toEqual(['existing', 'katex']);
  expect(Array.from(context.original.rehypePlugins)).toEqual(['existing']);
  expect(Array.from(context.later.remarkPlugins)).toEqual(['extra']);
});

test('bundle-load failure preserves the original props', () => {
  const context = evaluate('var el=F(M,{components:{},remarkPlugins:[gfm],children:text});', false);
  expect(Array.from(context.el.remarkPlugins)).toEqual(['gfm']);
  expect(context.el.rehypePlugins).toBeUndefined();
});

test('string and comment decoys are never patched', () => {
  const decoy = 'F(M,{remarkPlugins:[gfm],components:{}})';
  const source = `var documentation=${JSON.stringify(decoy)};/* ${decoy} */` +
    'var el=F(M,{components:{},remarkPlugins:[gfm],children:text});';
  const patched = injectMathPlugins(source);
  expect(patched).toContain(`var documentation=${JSON.stringify(decoy)};/* ${decoy} */`);
  expect(Array.from(evaluate(source).el.remarkPlugins)).toEqual(['gfm', 'brackets', 'math']);
});

test('a nested decoy inside real props cannot trigger the legacy rewrite', () => {
  const source = 'var el=F(M,{title:"F(M,{remarkPlugins:[gfm]",components:{},remarkPlugins:[gfm]});';
  expect(evaluate(source).el.title).toBe('F(M,{remarkPlugins:[gfm]');
});

test('a local helper takes precedence over an unrelated outer helper', () => {
  const source = 'function props(){return {unrelated:[]}};' +
    'function render(){const props=()=>({remarkPlugins:[gfm]});return F(M,{...props(),components:{}})};' +
    'var el=render();';
  expect(Array.from(evaluate(source).el.remarkPlugins)).toEqual(['gfm', 'brackets', 'math']);
});

test.each([
  'const props=()=>({remarkPlugins:[]});function render(props){return F(M,{...props(),components:{}})}',
  'const props=()=>({remarkPlugins:[]});function render({props}){return F(M,{...props(),components:{}})}',
  'const props=()=>({remarkPlugins:[]});function render(props=()=>({other:[]})){return F(M,{...props(),components:{}})}',
  'function props(){return {remarkPlugins:[]}};props=unknown;F(M,{...props(),components:{}});',
  'function props(){return {remarkPlugins:[]}};F(M,{...props,components:{}});',
  'const props={remarkPlugins:[]};F(M,{...props(),components:{}});',
  'F(M,{remarkPlugins:[],components:{}});F(M,{remarkPlugins:[],components:{}});',
  'var documentation="F(M,{remarkPlugins:[],components:{}})";',
  'F(M,{remarkPlugins:[],components:{}});function malformed(',
])('rejects unproven, ambiguous, or invalid code: %s', source => {
  expect(injectMathPlugins(source)).toBeNull();
});
