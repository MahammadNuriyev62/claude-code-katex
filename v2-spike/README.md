# v2 spike: remark-math + rehype-katex pipeline

End-to-end proof that math can render through react-markdown's proper plugin
pipeline instead of the v1 DOM-observer post-processor.

## Architecture

```
Claude Code's react-markdown call site (verified to be the only one):
    V8.default.createElement(yo, {remarkPlugins: [Of], components: {...}})

v2 injection (at patch time, via regex):
    V8.default.createElement(yo, {
        remarkPlugins: [Of, window.__remarkMath],
        rehypePlugins: [window.__rehypeKatex],
        components: {...}
    })

Pipeline: text -> remark-parse -> remark-gfm -> remark-math (new) ->
          remark-rehype -> rehype-katex (new) -> react-markdown -> DOM
```

## What's here

- `entry.js` — esbuild entry that imports remark-math and rehype-katex and
  exposes them as globals. `katex` is aliased to `katex-global-shim.js`
  because the webview already has `window.katex` from v1's vendored KaTeX.
- `remark-math-bundle.js` — 35 kB bundled output (katex externalized).
- `test.html` — standalone harness that validates the pipeline works without
  Claude Code.

## Verified

- Inline `$x^2$` renders
- Display `$$...$$` renders as a display block (in the standalone harness)
- **`$\{1, 2\}$` renders correctly** — backslash-escaped braces survive
  because remark-math's tokenizer runs before CommonMark's characterEscape
- **`\,` thin space preserved** in rendered math
- End-to-end inside real Claude Code 2.1.116: "generate some latex equations"
  produces 11 katex elements, 0 raw `$` signs, no mutation observer needed

## Still TODO before v2 ships

1. Currency regression test — spike test showed `$100 and $200` can parse as
   one math span. Verify remark-math's actual rules vs. the 27 currency tests
   in v1.
2. Display math rendering in real Claude Code (spike test showed 0 `.katex-display`
   elements; need to confirm whether model used `$$` or pipeline stripped it).
3. Fallback path — if the regex injection fails (future bundle shape change),
   fall back to v1's DOM observer so the extension doesn't silently break.
4. Version resilience — test against Claude Code 2.0.x and 2.1.x variants;
   consider a more robust detection than a raw regex.
5. Port all 73 Jest + 39 UI tests to validate v2 behavior matches v1.
