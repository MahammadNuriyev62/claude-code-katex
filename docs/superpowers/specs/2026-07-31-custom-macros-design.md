# Custom KaTeX macros — design

Issue: [#15 — Support for Custom Macros](https://github.com/MahammadNuriyev62/claude-code-katex/issues/15)
Date: 2026-07-31
Status: approved, pending implementation plan

## Problem

Users who keep LaTeX macros in a file separate from their prose (`macros.tex`,
a paper preamble) see those macros as red `katex-error` spans in Claude Code
chat. KaTeX supports user macros through its `macros` option; the extension
currently passes only its own three cross-referencing macros.

## What this actually is

The feature is KaTeX's `macros` option — about three lines at the existing
merge point in `v2-spike/entry.js` (`rehypeKatexWithCrossrefs`). Everything
else in this document is *delivery* (the webview is a sandboxed browser
context that cannot read the filesystem) and *robustness*. Keeping that
proportion in mind is the point: the renderer change is trivial, so all the
design risk lives in how the macro text reaches the webview and in what
happens when it is wrong.

## Goals

- Point the extension at one or more existing `.tex` files and have their
  macros render.
- Define a handful of macros inline in `settings.json` without creating a file.
- Tolerate real-world preamble files: comments, `\usepackage`, and commands
  KaTeX does not implement.
- **Never** degrade what works today. A failure anywhere in the macro path
  leaves math rendering and Claude Code's markdown exactly as they are now.

## Non-goals

- Being a LaTeX engine. Only macro *definitions* are ingested; packages,
  environments, counters, and document structure are out of scope.
- Live reload on file save. Refresh is explicit (see "Refresh model").
- Per-conversation or per-file macro scoping. Macros are global to the webview.

## User-facing surface

### Settings

```jsonc
{
  // Files whose macro definitions are loaded, in order. Supports ~,
  // ${workspaceFolder}, and ${userHome}. Relative paths resolve against the
  // first workspace folder.
  "claudeCodeKatex.macroFiles": ["${workspaceFolder}/macros.tex", "~/tex/mymacros.tex"],

  // Macros in KaTeX's own object form. Applied after the files, so these win.
  "claudeCodeKatex.macros": { "\\RR": "\\mathbb{R}", "\\vv": "\\mathbf{#1}" }
}
```

Both default to empty. Precedence, lowest to highest: `macroFiles` in array
order → `macros` → the extension's cross-reference macros (`\label`, `\eqref`,
`\ref`). The cross-reference macros win last so a user macro cannot break
issue #14 behavior; a collision is logged once.

A relative path or `${workspaceFolder}` with no workspace open resolves to
nothing: the entry is skipped with a warning, like any other unreadable path.

`macroFiles` keeps default (`window`) scope, so a repo can ship macros in
`.vscode/settings.json`. Claude Code declares
`capabilities.untrustedWorkspaces.supported = false`, so neither it nor this
extension activates in an untrusted workspace — a repo can only name a path
after the user has trusted it, which matches VS Code's own model. Size caps
and the loaded-files report in the status popup keep it visible.

### Command

`claude-code-katex.reloadMacros` — "Claude Code LaTeX: Reload Macros". Also
offered as a button in the existing status popup when the patch is active.

Behavior, in order:

| Condition | Result |
| --- | --- |
| Claude Code extension not found | error message, nothing written |
| Webview not patched | info: "not active", nothing written |
| Payload hash equals the stamped hash | info: "Macros unchanged (N loaded)", **nothing written** |
| Payload empty *and* no block present | treated as equal — the absence of a block is the canonical form of an empty payload |
| Patched file has the payload markers | in-place rewrite of the marked region, reload webview |
| Patched file has no markers (older patch) | full restore + re-apply with the payload, reload webview |

The status popup gains a line: `Macros: 38 loaded from 2 files (2 skipped)`.

## Architecture

```
settings.json ──┐
                ├─► extension.js: resolve paths, read files, cap sizes,
macros.tex ─────┘        build payload  ──► hash ──► embed in patched
                                                     webview/index.js
                                                            │
                                            (bundle load, once)
                                                            ▼
                              macro-ingest.js: KaTeX preamble ingestion
                                                            │
                                                            ▼
                          entry.js rehypeKatexWithCrossrefs: macros option
```

The webview has no filesystem access and no runtime channel from the
extension, so the payload must be on disk before the bundle loads. It is
embedded in the prepended patch region, after `katex.min.js` (ingestion needs
`window.katex`) and before `remark-math-bundle.js` (which consumes it at load).

### Payload block

```js
/* katex-macros-begin */
/* katex-macros-hash: a3f19c2e5b71 */
window.__KATEX_USER_PREAMBLE = "...";
window.__KATEX_USER_MACROS = { ... };
/* katex-macros-end */
```

- The hash lives **inside** the block, so one delimited region is the single
  thing that changes when macros change. The top-level
  `katex-ext-version` stamp is untouched and keeps its current meaning.
- **When no macros are configured, no block is emitted at all.** The patched
  bundle is then byte-identical to what ships today, so users who never use
  this feature carry zero new risk. This is asserted by a test.
- The preamble is embedded with `JSON.stringify`, then every `/` is escaped as
  `\/` and U+2028/U+2029 are escaped. `\/` is an identity escape in a JS string
  literal, and it makes the sequence `*/` **impossible** inside the payload —
  without it, a macro file containing `*/` would truncate the in-place
  replacement and corrupt the patched bundle.

### Ingestion — `v2-spike/macro-ingest.js`

A pure module: no DOM, no `vscode`, KaTeX passed in as an argument. Bundled
into `entry.js` for the webview and `require`d by `extension.js` (the vendored
`vendor/katex.min.js` is UMD and loads in Node — verified, v0.16.40) to produce
the report shown in VS Code. One implementation, two callers, fully unit
testable in jest against the exact KaTeX build that ships.

```js
ingestMacros(katex, preambleText, inlineMacros, limits)
  -> { macros, loaded, skipped: [{ snippet, reason }], truncated }
```

Algorithm:

1. Strip `%` comments (respecting `\%`, i.e. an odd run of preceding
   backslashes escapes it).
2. Rewrite `\DeclareMathOperator{\name}{body}` → `\newcommand{\name}{\operatorname{body}}`
   (starred form → `\operatorname*`), with balanced-brace argument reading.
   KaTeX has no `\DeclareMathOperator`; this is the one polyfill.
3. **Fast path:** render the whole text once with
   `{ macros, globalGroup: true, throwOnError: true }`, discarding the HTML.
   `globalGroup` makes KaTeX write every definition into the passed object.
   A clean file never touches our own scanner.
4. **Fallback, only if step 3 throws:** reset to an empty object and split the
   text at brace-depth-0 definition starts (`\newcommand`, `\renewcommand`,
   `\providecommand`, `\def`, `\gdef`, `\edef`, `\xdef`, `\let`, and starred
   variants; escaped braces ignored). Text before the first definition is
   dropped, which is how `\usepackage`/`\documentclass` preamble junk gets
   discarded. Each chunk is applied to a **scratch copy** and merged only on
   success, so a definition that fails partway cannot leave a half-defined
   macro. Failures are collected into `skipped`.
5. Apply `inlineMacros` over the result.

`throwOnError: true` is essential here: with `false`, KaTeX renders a parse
error in red *without throwing*, and broken macros would be silently counted
as loaded. Rendering keeps today's lenient settings; only ingestion is strict.

### entry.js integration

Ingestion runs **once at bundle load**, inside try/catch, producing a template
object. `rehypeKatexWithCrossrefs` shallow-copies that template per
instantiation, preserving the existing protection against `\gdef` in chat
content leaking across renders. There is no per-render macro work.

## Failure modes

Every row is a test case.

| Failure | Behavior |
| --- | --- |
| No macros configured | no payload block; patch byte-identical to today |
| File missing / a directory / unreadable | skipped, warning, other files still load |
| File over 256 KB, or total over 512 KB | skipped/truncated, reported, ingestion continues |
| File not valid UTF-8, or has a BOM | BOM stripped; undecodable bytes replaced, never throws |
| Preamble contains `*/`, `</script>`, quotes, backslashes, U+2028 | round-trips exactly; block cannot be truncated |
| `\usepackage`, `\documentclass`, prose | dropped by the chunk splitter |
| One malformed definition | that definition skipped; neighbours load |
| `\newenvironment` and other unsupported definitions | skipped with a reason in the report |
| `window.katex` missing at bundle load | ingestion skipped entirely; math renders as today |
| Ingestion throws for any reason | caught; macros = `{}`; math renders as today |
| Payload JS is corrupt/garbage | caught by the existing `__KATEX_V2_LOADED` guard; Claude Code markdown unaffected |
| User macro named `\label` / `\ref` / `\eqref` | cross-reference macros win; collision logged once |
| Macro file that defines 5000 macros | chunk cap applies, reported as truncated |
| `Reload Macros` with unchanged content | no disk write at all (hash comparison) |
| `Reload Macros` on an unmarked (older) patch | falls back to a full re-apply |

## Limits

| Limit | Value |
| --- | --- |
| Bytes per file | 256 KB |
| Total payload bytes | 512 KB |
| Definition chunks | 2000 |

Exceeding a limit is reported, never fatal.

## Testing

Rigor here is the explicit requirement, so the ingestion logic is deliberately
placed in a pure Node-testable module rather than only in the browser bundle.

### Level 1 — jest

New `macro-ingest.test.js`, run against **`vendor/katex.min.js`** (the build
that ships, not the newer npm devDependency):

- a clean file of `\newcommand` / `\def` / `\let` definitions, with and without
  arguments, and the macros then actually rendering;
- `\usepackage` mid-file: the fast path throws, the fallback recovers every
  definition around it;
- `\DeclareMathOperator` and `\DeclareMathOperator*` polyfill, including a
  body containing nested braces;
- comment stripping, including `\%` and a `%` inside a macro body;
- unbalanced braces, an empty file, whitespace-only, and a file with no
  definitions at all;
- a definition that fails partway leaves no partial macro (scratch-copy
  atomicity);
- inline macros override file macros; cross-reference macros override both;
- limits: oversize file, chunk cap, both reported as truncated;
- ingestion never throws — a fuzz-ish set of malformed inputs asserts a
  `{ macros: {} }` result instead of an exception.

Additions to `extension.test.js`:

- **no macros configured ⇒ patched output is byte-identical to the current
  patch** (guards the 99% path). Implemented as a jest snapshot written and
  committed *before* the feature code, against the current `applyPatch`, so the
  golden is generated pre-change and must stay green afterwards;
- payload embedding round-trip for `*/`, `</script>`, quotes, backslashes,
  newlines, U+2028;
- in-place marker rewrite: changes only the marked region, is idempotent, and
  leaves the version stamp and the rest of the bundle untouched;
- missing markers ⇒ full re-apply path;
- hash stability (same content ⇒ same hash ⇒ no write) and sensitivity (any
  change ⇒ different hash);
- path resolution: `~`, `${workspaceFolder}`, `${userHome}`, relative, missing
  file, directory, no workspace open;
- `Reload Macros` command across all five rows of its behavior table.

### Level 2 — rendering harness

`v2-spike/test.html` stays **preamble-free**, which is itself the regression
guard that the feature changes nothing when unconfigured. A new
`v2-spike/test-macros.html` sets `window.__KATEX_USER_PREAMBLE` /
`window.__KATEX_USER_MACROS` *before* loading the shipping bundle (ingestion is
load-time) and adds cases:

- a file-defined macro renders, with and without arguments;
- a `\DeclareMathOperator` macro renders as an operator;
- a malformed definition does not stop its neighbours from rendering;
- a user macro cannot clobber `\label` / `\eqref` / `\ref` resolution;
- a deliberately poisoned preamble (garbage, unbalanced braces, a `*/`) still
  leaves every formula and all surrounding markdown rendering.

`docker/run-harness.js` is generalized to drive both pages and aggregate their
results; the trusted-path Ctrl+C copy check stays attached to `test.html`.

### Level 3 — end-to-end

- **smoke (token-free):** write `claudeCodeKatex.macros` into the code-server
  user settings before launch, then assert the patched `webview/index.js`
  contains a well-formed payload block and a hash stamp. Gates CI with no
  secret.
- **full:** configure a macro file, prompt Claude to echo math using that
  macro, and assert `.katex` renders with zero `.katex-error`.

## Compatibility

- Existing patches without a payload block are recognized and upgraded through
  the normal `ensurePatched` refresh (the version stamp changes with the
  release), or by `Reload Macros`' no-markers fallback.
- Uninstall/disable paths are unchanged — `removePatch` restores `.katex-bak`,
  which never contains a payload block.
- Shipping requires a bundle rebuild (`npm run build:bundle`) since
  `macro-ingest.js` is bundled into `entry.js`.

## Deferred

- File watching / auto-reload on save (explicitly rejected: manual command).
- `\newenvironment` support.
- Macro definitions scoped per workspace folder in multi-root setups (the
  first folder wins for `${workspaceFolder}`).
