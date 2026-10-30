const vm = require('vm');
const { injectMathPlugins } = require('./markdown-patch');

const SHARED_MARKDOWN = `function M(p){
  const children=p.children,components=p.components,options=p.remarkRehypeOptions;
  const remark=p.remarkPlugins||[],rehype=p.rehypePlugins||[];
  const processor=unified().use(parser).use(remark).use(bridge,options).use(rehype);
  const parsed=processor.parse(children);return processor.runSync(parsed);
}`;

function evaluateProcessor(source, loaded = true) {
  const patched = injectMathPlugins(source);
  expect(patched).not.toBeNull();
  const context = { window: { __KATEX_V2_LOADED: loaded, __rehypeKatex: 'katex',
    __remarkBracketMath: 'brackets', __remarkMath: 'math' },
    parser: 'parser', bridge: 'bridge', F: (component, props) => component(props),
    gfm: 'gfm', extra: 'extra', existing: 'existing', calls: 0,
    unified: () => {
      const plugins = [];
      return {
        use(value) { plugins.push(...(Array.isArray(value) ? value : [value])); return this; },
        parse(value) { return { value }; },
        runSync(tree) { return { ...tree, plugins }; },
      };
    } };
  vm.runInNewContext(patched, context);
  return context;
}

test('one shared processor covers independently added renderers without patching their props', () => {
  const renderers = 'var first=F(M,{remarkPlugins:[gfm],components:{},children:"first"});' +
    'function helper(){calls++;return {remarkPlugins:[extra],rehypePlugins:[existing]}};' +
    'var second=F(M,{...helper(),components:{},children:"second"});' +
    'var third=F(M,{children:"third"});';
  const patched = injectMathPlugins(SHARED_MARKDOWN + renderers);
  expect(patched.endsWith(renderers)).toBe(true);
  const c = evaluateProcessor(SHARED_MARKDOWN + renderers);
  expect(Array.from(c.first.plugins)).toEqual(['parser', 'gfm', 'brackets', 'math', 'bridge', 'katex']);
  expect(Array.from(c.second.plugins)).toEqual(['parser', 'extra', 'brackets', 'math', 'bridge', 'existing', 'katex']);
  expect(Array.from(c.third.plugins)).toEqual(['parser', 'brackets', 'math', 'bridge', 'katex']);
  expect(c.first.value).toBe('first');
  expect(c.second.value).toBe('second');
  expect(c.third.value).toBe('third');
  expect(c.calls).toBe(1);
});

test.each([
  SHARED_MARKDOWN.replace('function M(p)', 'const M=(p)=>').replace(/}$/, '};'),
  SHARED_MARKDOWN.replace(/p\.remarkPlugins/g, 'p["remarkPlugins"]').replace(/p\.rehypePlugins/g, 'p["rehypePlugins"]'),
  SHARED_MARKDOWN.replace(/\|\|/g, '??'),
  SHARED_MARKDOWN.replace('.use(remark)', '.use(p.remarkPlugins||[])').replace('.use(rehype)', '.use(p.rehypePlugins||[])'),
  SHARED_MARKDOWN.replace('const processor=', 'const alias=remark,htmlAlias=rehype;const processor=').replace('.use(remark)', '.use(alias)').replace('.use(rehype)', '.use(htmlAlias)'),
  SHARED_MARKDOWN.replace('const children=p.children,components=p.components,options=p.remarkRehypeOptions;', 'const {children,components,remarkRehypeOptions:options}=p;'),
  SHARED_MARKDOWN.replace('components=p.components', '{components}=p'),
  SHARED_MARKDOWN.replace('components=p.components', '{["components"]:components}=p'),
  SHARED_MARKDOWN.replace('const children=', 'const props=p;const children=').replaceAll('p.', 'props.'),
  SHARED_MARKDOWN.replace('const children=p.children,components=p.components,options=p.remarkRehypeOptions;', 'const alias=p,props=alias;const {children,components,remarkRehypeOptions:options}=props;'),
])('recognizes compiler variations in the shared processor', processor => {
  const c = evaluateProcessor(processor + ';var result=M({remarkPlugins:[gfm],children:"text"});');
  expect(Array.from(c.result.plugins)).toEqual(['parser', 'gfm', 'brackets', 'math', 'bridge', 'katex']);
});

test.each([true, false])('shared processor preserves frozen props, arrays, getter counts and fallback: %s', loaded => {
  const c = evaluateProcessor(SHARED_MARKDOWN + `
    var original=Object.freeze([gfm]);
    var props=Object.freeze({get remarkPlugins(){calls++;return original},children:'text'});
    var result=M(props);`, loaded);
  expect(Array.from(c.result.plugins)).toEqual(loaded
    ? ['parser', 'gfm', 'brackets', 'math', 'bridge', 'katex'] : ['parser', 'gfm', 'bridge']);
  expect(Array.from(c.original)).toEqual(['gfm']);
  expect(c.calls).toBe(1);
  expect(c.props.rehypePlugins).toBeUndefined();
});

test.each([
  SHARED_MARKDOWN.replace('.use(bridge,options).use(rehype)', '.use(rehype).use(bridge,options)'),
  SHARED_MARKDOWN.replace('return processor.runSync(parsed)', 'return unrelated.runSync(parsed)'),
  SHARED_MARKDOWN.replace('processor.parse(children)', 'unrelated.parse(children)'),
  SHARED_MARKDOWN.replace('const processor=', 'p=unknown;const processor='),
  SHARED_MARKDOWN.replace('const remark=', 'let remark=').replace('const processor=', 'remark=unknown;const processor='),
  SHARED_MARKDOWN.replace('const parsed=', 'processor=unknown;const parsed='),
  SHARED_MARKDOWN.replace('const children=', '{let p=unknown;const children=').replace(/}$/, '}}'),
  SHARED_MARKDOWN.replace('components=p.components', '{components}=unrelated'),
  SHARED_MARKDOWN.replace('components=p.components', '{[dynamicKey]:components}=p'),
  SHARED_MARKDOWN.replace('components=p.components', 'components=unknown').replace('const processor=', 'function decoy(){const {components}=p;}const processor='),
  SHARED_MARKDOWN.replace('const children=', 'let alias=p;alias=unknown;const children=').replaceAll('p.', 'alias.'),
  SHARED_MARKDOWN + SHARED_MARKDOWN.replace(/\bM\b/g, 'Other'),
])('refuses ambiguous processors and unproven plugin or processor bindings', source => {
  expect(injectMathPlugins(source)).toBeNull();
});

test('reports why a patch was rejected without including bundle contents', () => {
  const reports = [];
  expect(injectMathPlugins('F(M,{remarkPlugins:[],components:{}});F(M,{remarkPlugins:[],components:{}});', d => reports.push(d))).toBeNull();
  expect(reports).toEqual([{ reason: 'ambiguous-markdown-props', count: 2 }]);
});

test.each([true, false])('native math ownership follows runtime availability: %s', loaded => {
  const source = SHARED_MARKDOWN + `
    class Native {
      get mathRenderingEnabled(){return this.config.experimentGates.tengu_vscode_math_rendering!==false}
    }
    var context=new Native();context.config={experimentGates:{}};
    var originalDecision=context.mathRenderingEnabled;
    context.config.experimentGates.tengu_vscode_math_rendering=false;
    var disabledDecision=context.mathRenderingEnabled;
    var result=M({remarkPlugins:[gfm],children:'$x$'});`;
  const c = evaluateProcessor(source, loaded);
  expect(c.originalDecision).toBe(loaded ? false : true);
  expect(c.disabledDecision).toBe(false);
  expect(Array.from(c.result.plugins)).toEqual(loaded
    ? ['parser', 'gfm', 'brackets', 'math', 'bridge', 'katex'] : ['parser', 'gfm', 'bridge']);
});

test('native gate preserves its receiver and all original behavior after runtime failure or shutdown', () => {
  const c = evaluateProcessor(SHARED_MARKDOWN + `
    class N {get ['mathRenderingEnabled'](){return this.read()}}
    var native=new N();native.read=()=>{calls++;return 'native-decision'};
    var active=native.mathRenderingEnabled;
    window.__KATEX_V2_LOADED=false;
    var fallback=native.mathRenderingEnabled;
    window.__KATEX_V2_LOADED=true;
    var activeAgain=native.mathRenderingEnabled;`);
  expect(c.active).toBe(false);
  expect(c.activeAgain).toBe(false);
  expect(c.fallback).toBe('native-decision');
  expect(c.calls).toBe(1);
});

test('missing runtime preserves a multi-statement native getter without changing its side effects', () => {
  const c = evaluateProcessor(SHARED_MARKDOWN + `
    delete window.__KATEX_V2_LOADED;
    class N {get mathRenderingEnabled(){calls++;if(this.disabled)return false;return true}}
    var native=new N(),enabled=native.mathRenderingEnabled;
    native.disabled=true;var disabled=native.mathRenderingEnabled;
    var result=M({remarkPlugins:[gfm],children:'text'});`);
  expect(c.enabled).toBe(true);
  expect(c.disabled).toBe(false);
  expect(c.calls).toBe(2);
  expect(Array.from(c.result.plugins)).toEqual(['parser', 'gfm', 'bridge']);
});

test.each([
  'var n={get mathRenderingEnabled(){return true}};',
  'class Minified {get mathRenderingEnabled ( ) { /* retain upstream */ return flag??true; }}',
  'class Expanded {get mathRenderingEnabled(){const enabled=this.config.enabled;if(!enabled)return false;return this.isAllowed()}}',
])('supports native gate compiler layouts without minified names: %s', gate => {
  expect(injectMathPlugins(gate + SHARED_MARKDOWN)).toContain('if(window.__KATEX_V2_LOADED)return false;');
  expect(injectMathPlugins(SHARED_MARKDOWN + gate)).toContain('if(window.__KATEX_V2_LOADED)return false;');
});

test.each([
  'class N {mathRenderingEnabled(){return true}}',
  'class N {static get mathRenderingEnabled(){return true}}',
  'class N {get mathRenderingEnabled(){return true}} class Other {get mathRenderingEnabled(){return false}}',
  'function newLayout(){return config.experimentGates.tengu_vscode_math_rendering!==false}',
])('rejects unproven native math ownership without applying a partial patch: %s', gate => {
  const reports = [];
  expect(injectMathPlugins(SHARED_MARKDOWN + gate, r => reports.push(r))).toBeNull();
  expect(reports[0].reason).toBe('unsupported-native-math-gate');
});

test('native gate names inside strings and comments are not rewritten', () => {
  const decoy = 'class N {get mathRenderingEnabled(){return true}}';
  const suffix = `;var doc=${JSON.stringify(decoy)};/* ${decoy} */`;
  expect(injectMathPlugins(SHARED_MARKDOWN + suffix)).toContain(suffix);
  expect(injectMathPlugins(SHARED_MARKDOWN + suffix)).not.toContain('if(window.__KATEX_V2_LOADED)return false;');
});

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
