#!/usr/bin/env bash
# Dispatches the three test levels inside the container. See Dockerfile / docker/README.md.
#
#   docker run --rm img            # "ci"  -> L1 + L2 (no secrets needed)
#   docker run --rm img 1          # L1 only (jest)
#   docker run --rm img 2          # L2 only (rendering harness)
#   docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN=... img 3     # L3 only (real e2e)
#   docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN=... img all   # L1 + L2 + L3
#   docker run --rm -it img shell  # drop into a shell for debugging
set -euo pipefail
cd /app

CODE_PORT="${CODE_PORT:-8080}"
HARNESS_PORT="${HARNESS_PORT:-8088}"

log()  { printf '\n\033[1;36m[entrypoint]\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31m[entrypoint] %s\033[0m\n' "$*" >&2; exit 1; }

level1() {
  log "Level 1 — unit tests (jest)"
  node_modules/.bin/jest
}

level2() {
  log "Level 2 — rendering harness (browser)"
  npm run build:bundle

  # Canonical L2: the v2 torture harness renders the real shipping bundle through
  # Claude Code's actual react-markdown -> remark-math -> rehype-katex chain.
  # (The legacy test-ui/*.spec.js suite tests the removed v1 DOM post-processor
  # and is intentionally NOT run here — see docker/README.md.)
  log "Torture harness (v2-spike/test.html, 26 cases)"
  python3 -m http.server "$HARNESS_PORT" --directory /app >/tmp/harness.log 2>&1 &
  local srv=$!
  trap 'kill "$srv" 2>/dev/null || true' RETURN
  # give the static server a moment
  for _ in $(seq 1 20); do
    curl -sf "http://127.0.0.1:${HARNESS_PORT}/v2-spike/test.html" -o /dev/null && break
    sleep 0.25
  done
  HARNESS_URL="http://127.0.0.1:${HARNESS_PORT}/v2-spike/test.html" node docker/run-harness.js
}

# Packages the extension-under-test, installs it into code-server (Claude Code is
# already baked into the image), and launches code-server. Sets CS_PID for the
# caller to clean up. Auth-independent.
start_code_server() {
  log "Packaging the extension-under-test (vsce)"
  vsce package --no-dependencies -o /tmp/ext.vsix
  log "Installing it into code-server (Claude Code is already baked in)"
  code-server --install-extension /tmp/ext.vsix --force

  mkdir -p /workspace
  log "Launching code-server on :${CODE_PORT}"
  code-server --bind-addr "0.0.0.0:${CODE_PORT}" --auth none --disable-telemetry /workspace \
    >/tmp/code-server.log 2>&1 &
  CS_PID=$!
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:${CODE_PORT}/healthz" -o /dev/null && break
    curl -sf "http://127.0.0.1:${CODE_PORT}/" -o /dev/null && break
    sleep 0.5
  done
}

# Resolves the installed Claude Code webview bundle path inside code-server.
cc_webview() {
  ls -d "${HOME}"/.local/share/code-server/extensions/anthropic.claude-code-*/webview/index.js 2>/dev/null \
    | sort -V | tail -1
}

# Token-free: proves the real extension patches the real Claude Code in real
# code-server. No Claude auth or network egress to Anthropic required, so it can
# gate CI. The full Level 3 adds the live-render assertion on top.
smoke() {
  log "L3 smoke — patch applies in real code-server (no auth needed)"
  start_code_server
  trap 'kill "$CS_PID" 2>/dev/null || true' RETURN

  CODE_URL="http://127.0.0.1:${CODE_PORT}/?folder=/workspace" node docker/open-workbench.js

  local webview; webview="$(cc_webview)"
  [ -n "$webview" ] || fail "Claude Code webview bundle not found under code-server extensions."
  log "Checking patch marker in: $webview"
  if grep -q 'KaTeX LaTeX Rendering Patch' "$webview"; then
    log "✅ Patch applied — the extension patched Claude Code's webview on activation."
  else
    fail "Patch marker absent — the extension did not patch Claude Code's webview."
  fi
}

level3() {
  log "Level 3 — real end-to-end (code-server + real Claude Code)"

  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ ! -f "${HOME}/.claude/.credentials.json" ]; then
    fail "No Claude Code auth available.
  Provide ONE of:
    -e CLAUDE_CODE_OAUTH_TOKEN=...   (run 'claude setup-token' on the host — a
                                      subscription token, NOT a metered API key)
    -v \$HOME/.claude:/root/.claude   (reuse an existing host login; on macOS the
                                      login lives in Keychain, so prefer the token)"
  fi

  start_code_server
  trap 'kill "$CS_PID" 2>/dev/null || true' RETURN

  CODE_URL="http://127.0.0.1:${CODE_PORT}/?folder=/workspace" node docker/e2e.js
}

case "${1:-ci}" in
  1|l1|level1)   level1 ;;
  2|l2|level2)   level2 ;;
  3|l3|level3)   level3 ;;
  smoke)         smoke ;;
  ci)            level1; level2 ;;
  all)           level1; level2; level3 ;;
  shell|bash)    exec bash ;;
  *)             fail "Unknown command: ${1}. Use one of: 1 2 3 smoke ci all shell" ;;
esac

log "Done."
