# Reproducible test environment for the Claude Code LaTeX extension.
#
# One image runs all three test levels (see docker/entrypoint.sh):
#   L1  jest unit tests                         — no browser, no network, no auth
#   L2  rendering harness via Playwright        — browser + network (CDN), no auth
#   L3  real end-to-end: code-server + the real Claude Code extension, patched by
#       the real extension-under-test, driven through its webview              — needs Claude auth
#
# Auth is NEVER baked in. L3 reads CLAUDE_CODE_OAUTH_TOKEN (from `claude
# setup-token`, a subscription token — not a metered API key) at runtime, or a
# mounted ~/.claude/.credentials.json. See docker/README.md.

# glibc base (Debian/Ubuntu jammy) with Node 20 + a Chromium that matches the
# repo's @playwright/test. Keep this tag in lockstep with package.json's
# Playwright version so the bundled browser is found at /ms-playwright.
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

ENV DEBIAN_FRONTEND=noninteractive

# System deps:
#   ripgrep        — Claude Code's agent shells out to `rg`
#   python3        — serves the Level-2 rendering harness over http
#   curl/ca-certs  — fetch the code-server installer
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep python3 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Browser-drivable VS Code. code-server defaults to the Open VSX registry, so the
# official Anthropic extension installs with no registry reconfiguration.
RUN curl -fsSL https://code-server.dev/install.sh | sh

# The official Claude Code extension, from Open VSX. On arm64/amd64 this selects
# the matching linux build (which bundles its own `claude` binary — no separate
# CLI install needed). Baked into the image so the container starts ready to patch.
RUN code-server --install-extension anthropic.claude-code

# vsce, to package the extension-under-test into a .vsix for the L3 install — the
# same artifact a real user installs.
RUN npm install -g @vscode/vsce@^3.0.0

# Disable Workspace Trust. Opening a folder leaves it "untrusted" (Restricted
# Mode), and VS Code will NOT activate extensions that don't opt into untrusted
# workspaces — Claude Code declares capabilities.untrustedWorkspaces.supported =
# false, so without this neither it nor our extension activates and no patch is
# applied. A throwaway test container has no reason to gate on trust.
# Also pin the Claude Code version for the test: disable extension auto-update,
# otherwise code-server pulls a newer Claude Code from Open VSX mid-run — a fresh,
# unpatched webview swapping in while the test drives it (non-deterministic, and
# it races our re-patch). Rebuild without cache to refresh the pinned version.
RUN mkdir -p /root/.local/share/code-server/User \
 && printf '%s\n' '{' \
    '  "security.workspace.trust.enabled": false,' \
    '  "extensions.autoUpdate": false,' \
    '  "extensions.autoCheckUpdates": false,' \
    '  "telemetry.telemetryLevel": "off"' \
    '}' > /root/.local/share/code-server/User/settings.json

# Extension-under-test + its dev tooling (jest, esbuild, @playwright/test, katex…).
# Copy lockfiles first so `npm ci` is cached across source-only changes.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Source. .dockerignore keeps the host's (macOS) node_modules out so it can't
# clobber the linux modules installed by `npm ci` above.
COPY . .

# Always test the current entry.js, not a possibly-stale committed bundle.
RUN npm run build:bundle

# Ports: code-server (L3) and the static harness server (L2) are distinct so the
# two levels never collide.
ENV CODE_PORT=8080 \
    HARNESS_PORT=8088 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN chmod +x docker/entrypoint.sh
ENTRYPOINT ["docker/entrypoint.sh"]
# Default: the levels that need no secrets. Pass "all" + a token to include L3.
CMD ["ci"]
