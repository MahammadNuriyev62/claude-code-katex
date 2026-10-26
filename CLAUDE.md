# Claude Code LaTeX Extension

## Architecture

This extension patches Claude Code's webview to render LaTeX math via KaTeX.

(Display name is "Claude Code LaTeX"; the extension ID and repo name are still
`claude-code-katex` for marketplace continuity.)

The extension injects a math pipeline into Claude Code's own react-markdown
plugin chain, so math is tokenized *during* Markdown parsing — verbatim —
instead of being repaired in the DOM afterward.

- `applyPatch` (in `extension.js`) locates the shared react-markdown processor
  with `injectMathPlugins` in `markdown-patch.js`. Acorn proves that plugin lists
  come from the same props parameter, enter one unified `.use()` chain in the
  correct order, and that exact processor parses and runs the Markdown. Injecting
  into the two `.use()` arguments covers every renderer, including callers with
  no plugin props. Getter reads stay unchanged; plugin arrays are copied with
  `concat`, and the original arguments remain when bundle loading fails.
  Multiple proven processors are rejected rather than guessed.
  On upstream builds with native math, the uniquely identified
  `mathRenderingEnabled` getter is guarded so only one pipeline owns the source.
  The full original getter body remains unchanged and runs whenever
  `__KATEX_V2_LOADED` is absent/false. This matters because native math tokenizers
  retain original-source offsets while our normalization can add line breaks.
  An unknown or ambiguous native gate rejects the entire patch.
  A fallback for older or isolated call shapes retains the existing output.
  Vendored Acorn parses
  JavaScript structure, accepting direct plugin props and helper-props spreads
  regardless of minified names, whitespace, comments, or property order.
  Helper definitions are resolved within their lexical scope; reassigned or
  shadowed helpers cannot establish an injection point. It adds
  `rehypePlugins:[rehypeKatex]` and `remarkPlugins:[gfm, remarkBracketMath,
  remarkMath]`. The injected references are guarded on `window.__KATEX_V2_LOADED`
  so a bundle-load failure cannot break Claude Code's Markdown.
  The spread form evaluates the original helper once and preserves its plugins
  and URL transform, including the Windows file-link plugin. Multiple candidate
  fallback call sites are rejected as unsupported. Structural rejection reasons
  are logged so compatibility failures can be diagnosed without guesswork.
- The complete patched JavaScript must compile before any files change. All
  assets are read first, then backups, fonts, CSS, and JS are staged and replaced
  with per-file renames. Ordinary write failures roll back prior replacements;
  a process crash between renames is not an atomic transaction across files.
  Fresh upstream files replace stale backups. If only JS was replaced, the
  existing CSS backup must match before its old patch is replaced. Disable and
  uninstall never restore an old backup over an unpatched upstream file.
- It prepends, in order, `vendor/katex.min.js`, the optional KaTeX contrib
  `vendor/copy-tex.min.js` (copying a selection of rendered math yields its
  LaTeX source), and `vendor/remark-math-bundle.js` to the webview bundle
  (Claude Code mounts its React app at the end of the bundle, so the globals
  must be defined first). A missing contrib file degrades gracefully — core
  math still renders.
  The contrib has a small local adaptation: its cloned selection drops hidden
  source blocks, hidden rendered equations and source-toggle buttons before
  serialization. Otherwise a selection across display math copies its hidden
  source too, duplicating the equation. Keep this adaptation when updating
  `vendor/copy-tex.min.js`.
- If the injection point is not found — a future Claude Code reshaped its
  bundle — `applyPatch` returns `false`, touches nothing, and the extension
  shows an "update / report an issue" notice. There is no fallback renderer.
- Display-math HAST nodes are wrapped after `rehype-katex` renders them with a
  source toggle and the `application/x-tex` annotation exposed as selectable
  `$$`-wrapped code (issue #18). One delegated click handler covers streamed
  equations; inline math is not decorated.

- When the user has configured macros (issue #15), a delimited block is emitted
  between the KaTeX core and the math bundle, setting
  `window.__KATEX_USER_PREAMBLE` / `window.__KATEX_USER_MACROS`. **With no
  macros configured no block is emitted at all**, so the patch stays
  byte-for-byte what it was before the feature — asserted by a jest snapshot
  written before the feature existed. Changing a macro rewrites only that block
  in place; it never restores and re-applies the patch.

The patch is version-stamped; an extension update prepares its replacement from
the `.katex-bak` originals before changing the existing patch.

## The plan approval view - `plan-patch.js`

The plan panel Claude Code opens on the side is a **second webview**
(viewType `claudePlanPreview`) that the host `extension.js` creates, renders
Markdown for with marked, and posts only sanitized HTML to. Nothing about the
webview-bundle patch can reach it (issue #17), so this is the one place the
extension patches Claude Code's **host** `extension.js`.

This integration is experimental and gated by the default-off
`claudeCodeKatex.renderPlanPreview` setting. Changing the setting applies or
restores the host patch immediately and offers a full window reload.

Two anchored rewrites, both required to match exactly once or nothing is
touched:

- the Markdown function (`function X(e){let t=M.parse(e);return typeof
  t==="string"?t:""}`) is wrapped so math is lifted out of the raw plan text
  **before** marked runs and put back afterwards as
  `<span class="katex-plan-math ...">` carrying the LaTeX as **text**. Verbatim
  capture is the point, exactly as in chat: CommonMark eats `\[` and collapses
  `\\`. Text (not attributes) because the panel runs the HTML through an
  allowlist sanitizer, which keeps `<span>` and `class`.
- the panel-HTML function (`function Y(){let e=nonce();return
  T.replaceAll("{{NONCE}}",e)}`) is wrapped so `__KATEX_PLAN_HTML` appends
  KaTeX core, copy-tex, the stylesheet (fonts inlined as `data:` URIs) and the
  renderer, and adds `font-src data:` to the panel's CSP. The panel CSP is
  `default-src 'none'` with no `font-src`, so without that every KaTeX font is
  blocked.

The runtimes are real functions in `plan-patch.js`, serialized with
`Function.prototype.toString()`, so they are unit-tested directly and shipped
as the same code. Both are self-contained: no closures over the module, no
`require`.

Because this is another extension's host code, `extension.js` never writes what
it has not checked: the original is backed up to `extension.js.katex-bak`, the
patched source must compile (`vm.Script`, parse only), and the write is
atomic (temp file + rename). Every failure path leaves Claude Code's file
untouched; the plan panel then behaves exactly as it does unpatched. A stale
patch is refreshed only from a backup that is itself unpatched.

Only the plan panel patch touches `extension.js`. The chat patch still modifies
nothing but the webview bundle (an isolated browser context).

## User macros — `macro-ingest.js`

Shared by both sides and therefore at the repo root, not in `src/webview/`:
`.vscodeignore` excludes `src/**`, and `extension.js` requires this module at
runtime. `src/webview/entry.js` bundles it for the webview; `extension.js` requires it
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

## The math pipeline — `src/webview/entry.js`

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
`src/webview/katex-global-shim.js`.)

After upgrading Acorn, run `npm run build:parser` and copy its MIT license to
`vendor/acorn.LICENSE`. The parser ships in the VSIX without runtime dependencies.

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

The same goes for the plan patch and `extension.js` of that same directory.
`plan-patch.test.js` checks both anchors against *every* Claude Code installed
on the machine (skipped where none is), which is the cheapest way to notice a
reshaped host bundle early.

## Setup

`npm install` first (Node 18+) — it provides `jest`, `esbuild` (for the bundle
build), and `playwright`.

## Testing

### Desktop VS Code regression tests (no account)

`npm run test:vscode` installs the candidate VSIX and the official Claude Code
extension in a temporary desktop VS Code profile. `@vscode/test-electron`
downloads Microsoft's stable Electron build; Playwright drives that real app.
The existing installed app can be selected with `VSCODE_EXECUTABLE`.

The test-only adapter in `test/vscode/chat-probe.js` structurally finds the
original upstream chat Markdown component, JSX/root factories, error boundary,
and native feature-gate getter. It supplies deterministic fixture messages to
that component inside Claude's real webview, including the exact #24 crash,
long tables/math, streamed prefixes, tall inline formulas, and lists. Unknown
adapter layouts fail instead of silently dropping coverage. No replacement
Markdown renderer or minified function names are used. The adapter and a small
VS Code API driver are excluded from the packaged extension.

Native fallback, exclusive pipeline ownership, source controls, trusted copying,
real VS Code themes and original-byte restoration on disable are checked too.
Reports record the tested upstream, VS Code and extension versions plus the
VSIX path/hash; captures are explicitly labelled deterministic fixtures.
These are full chat-renderer tests, **not authenticated Claude replies**. Keep
the separate live-response test and manual visual verification for releases.

CI runs desktop tests on pinned pre-native 2.1.299, first-native 2.1.301 and latest
Claude Code (scheduled runs: latest only), with source and published VSIX probes.
The downloader pins the version resolved from Open VSX's platform metadata and
verifies its checksum, avoiding a stale gallery search selecting an older build.

### Container suite

The existing three test levels run inside one reproducible Docker image — no
hand-maintained remote VS Code, no machine-specific setup. This is the canonical
way to test, and the way a contributor verifies a fix. Full details:
[`docker/README.md`](docker/README.md).

```sh
docker build -t claude-code-katex-tests .

docker run --rm claude-code-katex-tests            # L1 + L2 (no secrets) — the everyday check
docker run --rm claude-code-katex-tests smoke      # L3 patch check (no secrets)
docker run --rm claude-code-katex-tests plan-toggle # plan opt-in lifecycle (no secrets)
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" \
  claude-code-katex-tests all                      # L1 + L2 + L3 (real end-to-end)
```

`docker/entrypoint.sh` dispatches the levels; the Playwright base image tag is
pinned to the repo's `@playwright/test` version (keep them in lockstep).

### Level 1 — unit tests (no browser, no network, no auth)

`jest` — patch lifecycle (apply / refresh / remove), the `V2_INJECT_RE`
injection, the macro payload (`extension.macros.test.js`: path resolution,
size caps, embedding round-trips, in-place rewrite, hash invalidation),
macro ingestion (`macro-ingest.test.js`, run against **`vendor/katex.min.js`** —
the build that ships, not the newer npm devDependency), and the plan approval
view (`plan-patch.test.js` for the anchors and the math-through-Markdown
transform, `extension.plan.test.js` for the on-disk lifecycle: backup, the
compile gate, refresh, restore). In the container:
`docker run --rm img 1`. Locally: `node_modules/.bin/jest` (call the binary
directly; `npm test` can hit path issues).

### Level 2 — rendering harness (browser + network, no auth)

`test/harness/rendering.html` renders the real shipping bundle
(`vendor/remark-math-bundle.js`) through Claude Code's actual plugin chain
(`react-markdown` → `remark-math` → `rehype-katex`) and records a PASS/FAIL per
case on `window.__RESULTS` (`window.__DONE` flags completion). It pulls React
from a CDN, so it needs network. In the container (`docker run --rm img 2`),
`docker/run-harness.js` serves the repo, drives the page headless, and gates on
the results. Add a case to `rendering.html` for every rendering bug you fix.

`test/harness/macros.html` is the same harness with a user macro payload set
before the bundle loads. Keep `rendering.html` macro-free: it doubles as the guard
that configuring no macros changes nothing.

`test/harness/plan-preview.html` drives the *other* renderer, the plan
approval view: **real marked** from a CDN, then `plan-patch.js`'s host runtime,
then Claude Code's own sanitizer allowlist (copied verbatim into the page),
then the injected panel renderer. Real marked, not a stand-in: the design
exists because CommonMark destroys `\[` and `\\`, and only the real parser
proves the math never reaches it.

`run-harness.js` drives all three pages (`HARNESS_URLS`, comma-separated; the
older single-page `HARNESS_URL` still works and expands to all three).

### Level 3 — real end-to-end (browser + network + Claude auth)

The truest check: the **real** extension patching the **real** Claude Code in
code-server, asserting KaTeX renders in the live webview.

- `docker run --rm img smoke` — token-free. Installs the extension-under-test,
  launches code-server, and confirms the extension patched Claude Code's webview
  on activation (greps the patch marker, and that a configured macro payload
  reached it). Also checks the plan-preview patch reached Claude Code's host
  bundle, that the patched host bundle still parses (`node --check`), and that
  the backup beside it is pristine. Gates CI without any secret.
- `docker run --rm img macros` — token-free too, and stronger: attaches to the
  real Claude Code webview, reads `__KATEX_MACRO_REPORT` from the page, and
  renders with the resolved macros through the webview's own KaTeX. It also
  drives the source toggle's rehype decoration, packaged CSS and keyboard
  handler in that live frame. The webview bundle loads whether or not anyone
  is signed in, so no auth is needed. Kept out of `smoke` because it depends on
  the view-focus command and `smoke` must stay CI-robust.
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
  `src/webview/entry.js`. `plan-patch.js` needs no build step: it ships as source and its
  runtimes are serialized at patch time.
- Run levels 1–2 before committing; run level 3 for rendering changes.
- Add a `test/harness/rendering.html` regression case for any bug you fix.
- Keep commit messages in the existing style (`fix:`, `feat:`, `test:`,
  `docs:`, …).
