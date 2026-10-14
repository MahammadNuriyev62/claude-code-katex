// Locate a Markdown props object structurally, without depending on minified
// names, whitespace, property order, or the number of branches in its helper.
// Acorn is bundled locally; no parser dependency is needed after installation.
const { parse } = require('./vendor/acorn');

const V2_INJECT_RE = /([A-Za-z_$][\w$]{0,40})\(([A-Za-z_$][\w$]{0,40}),\{remarkPlugins:\[([A-Za-z_$][\w$,]{0,200})\]/;

function propertyName(node) {
  if (node.type !== 'Property') return null;
  if (!node.computed && node.key.type === 'Identifier') return node.key.name;
  return node.key.type === 'Literal' && typeof node.key.value === 'string' ? node.key.value : null;
}

function children(node) {
  const out = [];
  for (const value of Object.values(node)) {
    if (value && typeof value.type === 'string') out.push(value);
    else if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') out.push(child);
    }
  }
  return out;
}

function isFunction(node) {
  return node && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
}

function lookup(scope, name) {
  for (let s = scope; s; s = s.parent) if (s.bindings.has(name)) return s.bindings.get(name);
  return null;
}

// Destructured parameters and declarations also shadow outer bindings.
function bind(scope, pattern, value) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') {
    scope.bindings.set(pattern.name, scope.bindings.has(pattern.name) ? null : value);
  } else if (pattern.type === 'RestElement') bind(scope, pattern.argument, null);
  else if (pattern.type === 'AssignmentPattern') bind(scope, pattern.left, null);
  else if (pattern.type === 'ArrayPattern') for (const item of pattern.elements) bind(scope, item, null);
  else if (pattern.type === 'ObjectPattern') for (const prop of pattern.properties) {
    bind(scope, prop.type === 'RestElement' ? prop.argument : prop.value, null);
  }
}

function collect(ast) {
  const root = { parent: null, bindings: new Map(), functionScope: true };
  const candidates = [], writes = [], functions = [];
  const nodeScopes = new WeakMap();
  const stack = [{ node: ast, scope: root, declarationKind: null }];
  while (stack.length) {
    const item = stack.pop(), node = item.node;
    let scope = item.scope;
    if (node.type === 'FunctionDeclaration' && node.id) bind(scope, node.id, { node, scope });
    if (isFunction(node)) {
      scope = { parent: scope, bindings: new Map(), functionScope: true };
      if (node.type === 'FunctionExpression' && node.id) bind(scope, node.id, { node, scope });
      for (const param of node.params) bind(scope, param,
        param.type === 'Identifier' ? { node: null, scope, parameter: true } : null);
      functions.push({ node, scope });
    } else if (['BlockStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement'].includes(node.type)) {
      scope = { parent: scope, bindings: new Map(), functionScope: false };
      if (node.type === 'CatchClause') bind(scope, node.param, null);
    }
    nodeScopes.set(node, scope);
    if (node.type === 'VariableDeclarator') {
      let target = scope;
      if (item.declarationKind === 'var') while (!target.functionScope) target = target.parent;
      bind(target, node.id, node.init ? { node: node.init, scope } : null);
    }
    if (node.type === 'ClassDeclaration' && node.id) bind(scope, node.id, null);
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') writes.push({ scope, name: node.left.name });
    if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') writes.push({ scope, name: node.argument.name });
    if (node.type === 'CallExpression' && node.arguments.length >= 2) {
      const [component, props] = node.arguments;
      if (['Identifier', 'MemberExpression'].includes(component.type) && props.type === 'ObjectExpression' &&
          props.properties.some(p => propertyName(p) === 'components')) candidates.push({ node, props, scope });
    }
    const next = children(node);
    for (let i = next.length - 1; i >= 0; i--) stack.push({ node: next[i], scope,
      declarationKind: node.type === 'VariableDeclaration' ? node.kind : item.declarationKind });
  }
  // A helper that is reassigned is not statically proven to supply plugins.
  for (const write of writes) {
    for (let s = write.scope; s; s = s.parent) {
      if (s.bindings.has(write.name)) { s.bindings.set(write.name, null); break; }
    }
  }
  return { candidates, nodeScopes, functions };
}

function memberName(node) {
  if (node?.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  return node.property.type === 'Literal' ? node.property.value : null;
}

// Identify the shared react-markdown processor, rather than assuming there is
// only one renderer. Prove that both plugin lists come from the same parameter,
// feed one unified .use() chain in the right order, and that exact processor is
// parsed and run. All bindings are lexical and reassigned values are rejected.
function markdownProcessors(functions, nodeScopes) {
  const matches = [];
  for (const { node: fn, scope } of functions) {
    if (fn.params.length !== 1 || fn.params[0].type !== 'Identifier') continue;
    const parameter = lookup(scope, fn.params[0].name);
    if (!parameter?.parameter) continue;
    const own = [], stack = [fn.body];
    while (stack.length) {
      const n = stack.pop();
      if (isFunction(n)) continue;
      own.push(n);
      stack.push(...children(n));
    }
    const parameterProperty = n => n?.type === 'MemberExpression' &&
      n.object.type === 'Identifier' && lookup(nodeScopes.get(n), n.object.name) === parameter
      ? memberName(n) : null;
    const reads = new Set(own.map(parameterProperty));
    if (!['children', 'components', 'remarkRehypeOptions'].every(key => reads.has(key))) continue;
    function pluginSource(n, depth = 0) {
      if (!n || depth > 12) return null;
      const property = parameterProperty(n);
      if (property === 'remarkPlugins' || property === 'rehypePlugins') return property;
      if (n.type === 'LogicalExpression' && ['||', '??'].includes(n.operator)) return pluginSource(n.left, depth + 1);
      if (n.type === 'Identifier') {
        const binding = lookup(nodeScopes.get(n), n.name);
        return binding && pluginSource(binding.node, depth + 1);
      }
      return null;
    }
    for (const declaration of own.filter(n => n.type === 'VariableDeclarator' && n.id.type === 'Identifier')) {
      const binding = lookup(nodeScopes.get(declaration), declaration.id.name);
      if (!binding || binding.node !== declaration.init) continue;
      const uses = [];
      let call = declaration.init;
      while (call?.type === 'CallExpression' && memberName(call.callee) === 'use') {
        uses.unshift(call);
        call = call.callee.object;
      }
      const plugins = uses.map((use, index) => ({ use, index, kind: pluginSource(use.arguments[0]) }));
      const remark = plugins.filter(p => p.kind === 'remarkPlugins');
      const rehype = plugins.filter(p => p.kind === 'rehypePlugins');
      if (remark.length !== 1 || rehype.length !== 1 || remark[0].index + 1 >= rehype[0].index ||
          remark[0].use.arguments.length !== 1 || rehype[0].use.arguments.length !== 1) continue;
      const processorCalls = own.filter(n => n.type === 'CallExpression' &&
        n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier' &&
        lookup(nodeScopes.get(n), n.callee.object.name) === binding);
      const parses = processorCalls.filter(n => memberName(n.callee) === 'parse');
      const runs = processorCalls.filter(n => memberName(n.callee) === 'runSync');
      if (!parses.length || !runs.some(run => run.arguments[0]?.type === 'Identifier' &&
          parses.includes(lookup(nodeScopes.get(run), run.arguments[0].name)?.node))) continue;
      matches.push({ remark: remark[0].use.arguments[0], rehype: rehype[0].use.arguments[0] });
    }
  }
  return matches;
}

function returnsPluginProps(node, scope, nodeScopes, depth = 0, called = false) {
  if (!node || depth > 6) return false;
  if (called && !isFunction(node) && node.type !== 'Identifier') return false;
  if (node.type === 'ObjectExpression') return node.properties.some(p => propertyName(p) === 'remarkPlugins');
  if (node.type === 'ConditionalExpression') {
    return returnsPluginProps(node.consequent, scope, nodeScopes, depth + 1) &&
      returnsPluginProps(node.alternate, scope, nodeScopes, depth + 1);
  }
  if (node.type === 'SequenceExpression') return returnsPluginProps(node.expressions.at(-1), scope, nodeScopes, depth + 1);
  if (node.type === 'Identifier') {
    const binding = lookup(scope, node.name);
    return !!binding && returnsPluginProps(binding.node, binding.scope, nodeScopes, depth + 1, called);
  }
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
    const binding = lookup(scope, node.callee.name);
    return !!binding && returnsPluginProps(binding.node, binding.scope, nodeScopes, depth + 1, true);
  }
  if (isFunction(node)) {
    if (!called) return false;
    if (node.body.type !== 'BlockStatement') return returnsPluginProps(node.body, nodeScopes.get(node.body), nodeScopes, depth + 1);
    const values = [], stack = [node.body];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === 'ReturnStatement') values.push(n);
      else if (!isFunction(n)) stack.push(...children(n));
    }
    return values.length > 0 && values.every(r => returnsPluginProps(r.argument, nodeScopes.get(r), nodeScopes, depth + 1));
  }
  return false;
}

function injectMathPlugins(body, report = () => {}) {
  if (body.includes('/* === KaTeX LaTeX Rendering Patch === */')) return null;
  let ast;
  try { ast = parse(body, { ecmaVersion: 'latest', sourceType: 'script' }); }
  catch (error) { report({ reason: 'invalid-javascript', message: error.message }); return null; }
  const { candidates, nodeScopes, functions } = collect(ast);
  const processors = markdownProcessors(functions, nodeScopes);
  if (processors.length > 1) {
    report({ reason: 'ambiguous-markdown-processors', count: processors.length });
    return null;
  }
  if (processors.length === 1) {
    const { remark, rehype } = processors[0];
    const edits = [
      { node: remark, plugins: 'window.__remarkBracketMath,window.__remarkMath' },
      { node: rehype, plugins: 'window.__rehypeKatex' },
    ].sort((a, b) => b.node.start - a.node.start);
    for (const { node, plugins } of edits) {
      const original = body.slice(node.start, node.end);
      const replacement = `window.__KATEX_V2_LOADED?(${original}).concat(${plugins}):(${original})`;
      body = body.slice(0, node.start) + replacement + body.slice(node.end);
    }
    return body;
  }
  const matches = candidates.filter(({ props, scope }) => props.properties.some(p =>
    propertyName(p) === 'remarkPlugins' ||
    (p.type === 'SpreadElement' && returnsPluginProps(p.argument, scope, nodeScopes))));
  if (matches.length !== 1) {
    report({ reason: matches.length ? 'ambiguous-markdown-props' : 'no-markdown-props', count: matches.length });
    return null;
  }
  const { node, props } = matches[0];

  // Retain the existing output for the original simple call shape. Only use
  // this rewrite inside the parsed call, never against strings or comments.
  if (!props.properties.some(p => p.type === 'SpreadElement' || propertyName(p) === 'rehypePlugins')) {
    const call = body.slice(node.start, node.end);
    const match = V2_INJECT_RE.exec(call);
    const prefix = match && `${match[1]}(${match[2]},`;
    if (match && node.start + match.index + prefix.length === props.start &&
        propertyName(props.properties[0]) === 'remarkPlugins') {
      const patched = call.replace(V2_INJECT_RE,
        '$1($2,{rehypePlugins:window.__KATEX_V2_LOADED?[window.__rehypeKatex]:[],' +
        'remarkPlugins:[$3].concat(window.__KATEX_V2_LOADED?[window.__remarkBracketMath,window.__remarkMath]:[])');
      return body.slice(0, node.start) + patched + body.slice(node.end);
    }
  }
  // Evaluate the entire original props expression once. This preserves helper
  // calls, later spreads, platform-specific plugins, and URL transforms. Copy
  // getters once before reading plugin lists; never mutate the original props.
  const original = body.slice(props.start, props.end);
  const replacement = '((p)=>{if(!window.__KATEX_V2_LOADED)return p;const q={...p};' +
    'q.rehypePlugins=(q.rehypePlugins||[]).concat(window.__rehypeKatex);' +
    'q.remarkPlugins=(q.remarkPlugins||[]).concat(window.__remarkBracketMath,window.__remarkMath);' +
    `return q})(${original})`;
  return body.slice(0, props.start) + replacement + body.slice(props.end);
}

module.exports = { injectMathPlugins, V2_INJECT_RE };
