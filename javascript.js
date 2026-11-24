const { parse } = require('./vendor/acorn');

// Upstream webviews may be classic scripts or ES modules. Parse without
// executing or resolving imports; keep strict module syntax checks intact.
function parseJavaScript(source) {
  try { return parse(source, { ecmaVersion: 'latest', sourceType: 'script' }); }
  catch { return parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); }
}

module.exports = { parseJavaScript };
