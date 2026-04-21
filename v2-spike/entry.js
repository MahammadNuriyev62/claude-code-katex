// Bundle remark-math + rehype-katex and expose as globals for the webview
// intercept to pick up. rehype-katex handles rendering inline via KaTeX's
// renderToString; no DOM observer or post-processing needed.
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

// Both packages default-export the plugin function. Explicitly unwrap any
// default-in-default wrapping that esbuild may introduce.
window.__remarkMath = remarkMath?.default || remarkMath;
window.__rehypeKatex = rehypeKatex?.default || rehypeKatex;
window.__KATEX_V2_LOADED = true;
console.log('[katex v2] remarkMath=', typeof window.__remarkMath, 'rehypeKatex=', typeof window.__rehypeKatex);
