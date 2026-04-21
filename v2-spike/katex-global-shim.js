// Shim: since the webview already has window.katex from vendor/katex.min.js,
// re-export it so rehype-katex's `import katex from 'katex'` resolves.
module.exports = window.katex;
module.exports.default = window.katex;
