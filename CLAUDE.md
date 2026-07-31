# Claude Code LaTeX Extension

## Architecture

This extension patches Claude Code's webview to render LaTeX math via KaTeX.

(Display name is "Claude Code LaTeX"; the extension ID and repo name are still
`claude-code-katex` for marketplace continuity.)

The extension injects a math pipeline into Claude Code's own react-markdown
plugin chain, so math is tokenized *during* Markdown parsing — verbatim —
instead of being repaired in the DOM afterward.

- `applyPatch` (in `extension.js`) locates Claude Code's single react-markdown
  call — `createElement(<Markdown>, {remarkPlugins:[<gfm>], components:{...}},
  text)` — with `V2_INJECT_RE`, and rewrites it to add
  `rehypePlugins:[rehypeKatex]` and `remarkPlugins:[gfm, remarkBracketMath,
  remarkMath]`. The injected references are guarded on `window.__KATEX_V2_LOADED`
  so a bundle-load failure cannot break Claude Code's Markdown.
- It prepends, in order, `vendor/katex.min.js`, the optional KaTeX contrib
  `vendor/copy-tex.min.js` (copying a selection of rendered math yields its
  LaTeX source), and `vendor/remark-math-bundle.js` to the webview bundle
  (Claude Code mounts its React app at the end of the bundle, so the globals
  must be defined first). A missing contrib file degrades gracefully — core
  math still renders.
- If the injection point is not found — a future Claude Code reshaped its
  bundle — `applyPatch` returns `false`, touches nothing, and the extension
  shows an "update / report an issue" notice. There is no fallback renderer.

- When the user has configured macros (issue #15), a delimited block is emitted
  between the KaTeX core and the math bundle, setting
  `window.__KATEX_USER_PREAMBLE` / `window.__KATEX_USER_MACROS`. **With no
  macros configured no block is emitted at all**, so the patch stays
  byte-for-byte what it was before the feature — asserted by a jest snapshot
  written before the feature existed. Changing a macro rewrites only that block
  in place; it never restores and re-applies the patch.

The patch is version-stamped; an extension update restores the originals from
`.katex-bak` and re-applies. Claude Code's `extension.js` is **never modified** —
only the webview bundle (an isolated browser context) is patched.

## User macros — `macro-ingest.js`

Shared by both sides and therefore at the repo root, not in `v2-spike/`:
`.vscodeignore` excludes `v2-spike/**`, and `extension.js` requires this module
at runtime. `entry.js` bundles it for the webview; `extension.js` requires it
(with the UMD `vendor/katex.min.js`, which loads in Node) only to build the
report shown in the status popup — that require is fail-soft, since the webview
does its own ingestion.

It writes no LaTeX parser. KaTeX already reads `\newcommand` / `\def` / `\let`,
and with `globalGroup: true` it writes each definition into the `macros` object
passed to it, which later renders reuse. The module decides *what to hand
KaTeX*: definitions are extracted and everything else (`\usepackage`, prose,
comments) is dropped, `\DeclareMathOperator` is rewritten to `\operatorname`,
the whole file is tried in one render first, and only on failure is it applied
definition-by-definition so one bad line is isolated and reported. Each
definition is applied to a scratch copy and merged only on success. A
`\newcommand` KaTeX rejects because it already defines that name is retried as
`\renewcommand` (and vice versa) — the user's file states the intent plainly.

`ingestMacros` never throws; the worst outcome is an empty macros object.
Ingestion happens once at bundle load, never per render.

Two things to know when testing macros: ingestion reads the globals **at load**,
so a harness must set them before the bundle script tag; and an undefined macro
does not produce `.katex-error` — KaTeX renders it as red text
(`mathcolor="#cc0000"`), which is what issue #15 reports seeing.

## The math pipeline — `v2-spike/entry.js`

`remark-math` only recognizes `$...$` / `$$...$$`. `remarkBracketMath` wraps the
Markdown parser to normalize the raw source before micromark runs:

- `\[`→`$$`, `\]`→`$$`, `\(`→`$`, `\)`→`$` — each guarded with `(?<!\\)` so
  amsmath row separators like `\\[6pt]` keep their `[` and are not corrupted.
- currency `$`+digit → `\$` (so `$5` is not treated as math).
- a `$$` display fence that shares its line with content (`$$\begin{aligned}` /
  `\end{aligned}$$`) is moved onto its own line — remark-math's display-math
  flow construct only recognizes `$$` alone on a line.
- fenced code blocks are skipped.

`entry.js` also wraps `rehype-katex` (`rehypeKatexWithCrossrefs`) to pass KaTeX
macros mapping LaTeX cross-referencing to renderable output — `\label{x}` →
invisible `\htmlId{x}{}` anchor (trust granted for that command only),
`\eqref{x}` → `\text{(x)}`, `\ref{x}` → `\text{x}` — since KaTeX errors on all
three (issue #14).

After editing `entry.js`, rebuild the shipped bundle:

```sh
npm run build:bundle
```

(esbuild IIFE; KaTeX is externalized to `window.katex` via
`v2-spike/katex-global-shim.js`.)

## Where Claude Code lives

The extension auto-locates Claude Code via the `anthropic.claude-code` extension
id, so normal use needs no paths. For manual inspection, the extension folder is
under the VS Code extensions directory, which varies by setup:

- `~/.vscode/extensions/` — desktop VS Code
- `~/.vscode-server/extensions/` — Remote-SSH, WSL, Dev Containers, Codespaces
- `~/.local/share/code-server/extensions/` — code-server / browser VS Code

If more than one VS Code is in play, install into and test the instance you
actually use: plain `code --install-extension` targets your default desktop VS
Code; a remote or code-server instance has its own CLI.

## Before changing the webview patch

Verify against the actual compiled Claude Code webview bundle —
`webview/index.js` of the installed `anthropic.claude-code-*` extension. Claude
Code updates frequently and can reshape its bundle, so confirm the injection
point still matches before relying on it.

## Setup

`npm install` first (Node 18+) — it provides `jest`, `esbuild` (for the bundle
build), and `playwright`.

## Testing

All three test levels run inside one reproducible Docker image — no
hand-maintained remote VS Code, no machine-specific setup. This is the canonical
way to test, and the way a contributor verifies a fix. Full details:
[`docker/README.md`](docker/README.md).

```sh
docker build -t claude-code-katex-tests .

docker run --rm claude-code-katex-tests            # L1 + L2 (no secrets) — the everyday check
docker run --rm claude-code-katex-tests smoke      # L3 patch check (no secrets)
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" \
  claude-code-katex-tests all                      # L1 + L2 + L3 (real end-to-end)
```

`docker/entrypoint.sh` dispatches the levels; the Playwright base image tag is
pinned to the repo's `@playwright/test` version (keep them in lockstep).

### Level 1 — unit tests (no browser, no network, no auth)

`jest` — patch lifecycle (apply / refresh / remove), the `V2_INJECT_RE`
injection, the macro payload (`extension.macros.test.js`: path resolution,
size caps, embedding round-trips, in-place rewrite, hash invalidation), and
macro ingestion (`macro-ingest.test.js`, run against **`vendor/katex.min.js`** —
the build that ships, not the newer npm devDependency). In the container:
`docker run --rm img 1`. Locally: `node_modules/.bin/jest` (call the binary
directly; `npm test` can hit path issues).

### Level 2 — rendering harness (browser + network, no auth)

`v2-spike/test.html` renders the real shipping bundle
(`vendor/remark-math-bundle.js`) through Claude Code's actual plugin chain
(`react-markdown` → `remark-math` → `rehype-katex`) and records a PASS/FAIL per
case on `window.__RESULTS` (`window.__DONE` flags completion). It pulls React
from a CDN, so it needs network. In the container (`docker run --rm img 2`),
`docker/run-harness.js` serves the repo, drives the page headless, and gates on
the results. Add a case to `test.html` for every rendering bug you fix.

`v2-spike/test-macros.html` is the same harness with a user macro payload set
before the bundle loads. Keep `test.html` macro-free: it doubles as the guard
that configuring no macros changes nothing. `run-harness.js` drives both pages
(`HARNESS_URLS`, comma-separated; the older single-page `HARNESS_URL` still
works and expands to both).

### Level 3 — real end-to-end (browser + network + Claude auth)

The truest check: the **real** extension patching the **real** Claude Code in
code-server, asserting KaTeX renders in the live webview.

- `docker run --rm img smoke` — token-free. Installs the extension-under-test,
  launches code-server, and confirms the extension patched Claude Code's webview
  on activation (greps the patch marker). Gates CI without any secret.
- `docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN=... img 3` — adds the live render.
  `docker/e2e.js` opens Claude Code, sends a prompt that asks Claude to echo a
  **fixed** block of LaTeX (so it tests the renderer, not the model), asserts
  `.katex` with zero `.katex-error`, then selects a display formula, presses a
  real `Ctrl+C`, and asserts the copy payload is the `$$`-wrapped LaTeX source
  (copy-tex live). Auth is a **subscription** token from
  `claude setup-token` (not a metered `ANTHROPIC_API_KEY`) or a mounted
  `~/.claude` — see `docker/README.md`.

Two environment facts the image bakes in, both required for L3 to work at all:

- **code-server, not desktop Electron VS Code** — only a browser-served VS Code
  can be driven this way. Find the webview iframe **by shape** (`#root` + a
  message input), never by URL.
- **Workspace Trust is disabled** (`security.workspace.trust.enabled: false`).
  Claude Code declares `capabilities.untrustedWorkspaces.supported = false`, so
  in a default (untrusted) workspace VS Code refuses to activate it *or* our
  extension, and no patch is applied. Without this, L3 silently does nothing.

The patched `webview/index.js` carries a `katex-ext-version: <x.y.z>` stamp;
`webview/index.js.katex-bak` is the pristine backup.

### Running outside Docker

L1 and L2 can also run on the host directly (`npm install`, Node 18+;
`npx playwright install chromium` once for the browser). L3 is Docker-only — it
needs the full code-server + Claude Code + auth stack the image provides.

## Submitting changes

- Rebuild and commit `vendor/remark-math-bundle.js` whenever you change
  `entry.js`.
- Run levels 1–2 before committing; run level 3 for rendering changes.
- Add a `v2-spike/test.html` regression case for any bug you fix.
- Keep commit messages in the existing style (`fix:`, `feat:`, `test:`,
  `docs:`, …).
