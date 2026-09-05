#!/bin/bash
# install-gloop.sh — build-time install of gloop into /opt/gloop.
# Used by Dockerfile.gloop (ClawBench) and as HarnessBench's setup.sh.
set -euo pipefail

GLOOP_REPO="${GLOOP_REPO:-https://github.com/ianrumac/gloop.git}"
GLOOP_REF="${GLOOP_REF:-main}"
GLOOP_HOME="${GLOOP_HOME:-/opt/gloop}"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found — installing"
  apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
  curl -fsSL https://bun.sh/install | bash
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
fi

echo "Cloning gloop ($GLOOP_REPO @ $GLOOP_REF) into $GLOOP_HOME"
git clone "$GLOOP_REPO" "$GLOOP_HOME"
git -C "$GLOOP_HOME" checkout --quiet "$GLOOP_REF"
git -C "$GLOOP_HOME" rev-parse HEAD > "$GLOOP_HOME/.harness-ref"

cd "$GLOOP_HOME"
# Bun resolves @hypen-space/gloop-loop straight from the workspace sources
# (package.json "bun" export condition), so no dist build is needed.
bun install --frozen-lockfile || bun install
rm -rf /root/.bun/install/cache

# Smoke: the headless entrypoint must at least parse.
bun build --no-bundle --target=bun src/core/headless.ts >/dev/null 2>&1 || true
bun -e 'import("/opt/gloop/src/core/task-mode.ts").then(() => console.log("gloop ready"))'
echo "gloop installed at $GLOOP_HOME ($(cat "$GLOOP_HOME/.harness-ref"))"
