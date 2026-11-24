const { parseJavaScript } = require('./javascript');

test.each([
  ['var let=1; function legacy(){} function legacy(){}', 'script'],
  ['const asset = new URL("./asset.svg", import.meta.url);', 'module'],
  ['import value from "./value.js"; export {value};', 'module'],
  ['export const value = await Promise.resolve(1);', 'module'],
])('validates scripts and modules without executing: %s', (source, type) => {
  expect(parseJavaScript(source).sourceType).toBe(type);
});

test.each([
  'const value = import.meta.;',
  'import value from "x"; import value from "y";',
  'export const value = 1; with (value) {}',
  'function broken(',
])('rejects malformed or invalid strict module syntax: %s', source => {
  expect(() => parseJavaScript(source)).toThrow();
});
