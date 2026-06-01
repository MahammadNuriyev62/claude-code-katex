# Containerized test environment

One image runs all three test levels reproducibly — no host setup beyond Docker,
and no dependence on any cloud workspace. This is the replacement for testing
against a hand-maintained remote VS Code.

| Level | What it exercises | Browser | Network | Claude auth |
|------:|-------------------|:-------:|:-------:|:-----------:|
| **1** | `jest` unit tests — patch lifecycle + injection regex | – | – | – |
| **2** | The math pipeline through Claude Code's real react-markdown → remark-math → rehype-katex chain (committed Playwright specs + the 26-case torture harness) | ✓ | ✓ (CDN) | – |
| **3** | The **real** extension patching the **real** Claude Code in code-server, asserting KaTeX renders in the live webview | ✓ | ✓ | ✓ |

## Build

```sh
docker build -t claude-code-katex-tests .
```

## Run

```sh
# Levels 1 + 2 — no secrets needed. This is the everyday check.
docker run --rm claude-code-katex-tests           # == "ci"
docker run --rm claude-code-katex-tests 1         # jest only
docker run --rm claude-code-katex-tests 2         # rendering harness only

# Level 3 — real end-to-end. Needs Claude auth (see below).
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" \
  claude-code-katex-tests 3

# Everything:
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" \
  claude-code-katex-tests all

# Debug shell:
docker run --rm -it claude-code-katex-tests shell
```

Or via compose:

```sh
docker compose run --rm tests                                   # L1 + L2
CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" \
  docker compose run --rm tests all                             # + L3
```

L3 screenshots land in `/app/test-results/` inside the container — mount a volume
(`-v "$PWD/test-results:/app/test-results"`) to pull them out.

## Level-3 auth — uses your subscription, not metered API

`claude setup-token` (run once on the host) prints a long-lived **OAuth token tied
to your Claude subscription**. It is *not* an `ANTHROPIC_API_KEY`, so L3 runs draw
against your existing plan exactly like normal interactive Claude Code usage —
**no per-token API charges.** Requires a paid plan (Pro/Max/Team/Enterprise).

Pass it at runtime only — never bake it into the image:

```sh
CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_OAUTH_TOKEN" ... 3
```

Alternative (Linux hosts, where the login is a file): mount the existing login
read… actually mount it writable so token refresh can persist:

```sh
docker run --rm -v "$HOME/.claude:/root/.claude" claude-code-katex-tests 3
```

> On **macOS** the Claude Code login lives in the Keychain, not in
> `~/.claude/.credentials.json`, so there's no file to mount — use the
> `setup-token` env var instead.

The only real limit on L3 is your plan's **rate/usage allowance** (heavy runs
consume it like normal usage); it never becomes a metered charge.

## How L3 works

1. The image bakes in code-server + the official `anthropic.claude-code`
   extension (from Open VSX, matching the container arch).
2. At run time the entrypoint packages the extension-under-test with `vsce` and
   installs the `.vsix` — the same artifact a user installs.
3. code-server launches; our extension activates (`onStartupFinished`) and
   patches Claude Code's webview bundle on disk.
4. Playwright (`docker/e2e.js`) opens code-server headless, opens a Claude Code
   tab, sends a prompt that asks Claude to echo a fixed block of LaTeX (so the
   test measures the **renderer**, not the model), waits for the reply to settle,
   and asserts `.katex` elements rendered with **zero** `.katex-error`.

## Notes / gotchas

- The Playwright base image tag is pinned to the repo's `@playwright/test`
  version (`1.58.2`). Bump both together.
- Built on a glibc base (Ubuntu jammy) so the Open VSX `linux-*` Claude Code
  binary runs; do not switch to Alpine without selecting the `alpine-*` build.
- L3 needs outbound HTTPS to Anthropic — don't run it behind an egress firewall
  that blocks the API.
- **Extension auto-update is disabled** in the baked settings so the test pins
  the Claude Code version it was built with (otherwise code-server pulls a newer
  build from Open VSX mid-run). To test against the latest Claude Code, rebuild
  with `docker build --no-cache` (or bust the `--install-extension` layer).
- **L3 UI selectors are version-sensitive.** `docker/e2e.js` targets Claude Code
  2.1.x: it focuses the view with the command `Claude Code: Focus on Claude Code
  View` (the chat webview iframe only attaches once focused — do not click the
  activity-bar item, which toggles it shut), types into the composer
  `div[contenteditable][aria-label="Message input"]`, clicks `[class*="sendButton"]`,
  and counts `.katex` in the webview's `#root` (messages carry no `data-testid`).
  If a future Claude Code reshapes this, `smoke` (which only checks the on-disk
  patch) still passes while `3` can't drive the chat — re-probe the webview DOM
  and update these selectors.
