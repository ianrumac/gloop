#!/bin/bash
set -e

# Run-time harness script for gloop (https://github.com/ianrumac/gloop).
/setup-gloop.sh
source /tmp/gloop-env.sh

GLOOP_HOME="${GLOOP_HOME:-/opt/gloop}"
HARNESS_HOME=/opt/gloop-harness
WORKSPACE=/root/workspace

# Optional LiteLLM translation proxy (non-OpenRouter upstreams only).
PROXY_PID=""
if [ "${GLOOP_USE_PROXY:-0}" = "1" ]; then
  echo "Starting API translation proxy (litellm)..."
  litellm --config /tmp/litellm-config.yaml --port 4000 > /data/proxy.log 2>&1 &
  PROXY_PID=$!
  for i in $(seq 1 30); do
    if curl -sf http://localhost:4000/health/liveliness > /dev/null 2>&1; then
      echo "API proxy ready"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "API proxy not ready after 30s — check /data/proxy.log"
      echo "proxy_failed" > /data/.stop-reason
      exit 1
    fi
    sleep 1
  done
fi

# Workspace: personal info + gloop's per-directory state (.gloop/).
mkdir -p "$WORKSPACE/.gloop/tools"
if [ -d /my-info ]; then
  cp -r /my-info "$WORKSPACE/my-info"
  echo "Copied /my-info to $WORKSPACE/my-info"
fi
# Browser tools are loaded by gloop's Reload from <cwd>/.gloop/tools/*.ts.
cp "$HARNESS_HOME"/tools/*.ts "$WORKSPACE/.gloop/tools/"
# Harness notes land in gloop's memory, which is part of its system prompt.
cp "$HARNESS_HOME/memory.md" "$WORKSPACE/.gloop/memory.md"

# Wait for Chrome CDP to be ready.
echo "Waiting for Chrome CDP..."
for i in $(seq 1 30); do
  if [[ "$CLAWBENCH_BROWSER_CDP_URL" == ws://* || "$CLAWBENCH_BROWSER_CDP_URL" == wss://* ]]; then
    echo "Chrome CDP ready"
    break
  fi
  if curl -sf "${CLAWBENCH_BROWSER_CDP_URL%/}/json/version" > /dev/null 2>&1; then
    echo "Chrome CDP ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Chrome CDP not ready after 30s, aborting"
    echo "chrome_cdp_timeout" > /data/.stop-reason
    exit 1
  fi
  sleep 1
done

# Browser daemon: owns the Playwright-over-CDP session for the Browser* tools.
echo "Starting browser daemon..."
node "$HARNESS_HOME/daemon/server.ts" > /data/browser-daemon.log 2>&1 &
DAEMON_PID=$!
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:7979/health > /dev/null 2>&1; then
    echo "Browser daemon ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Browser daemon not ready after 30s — check /data/browser-daemon.log"
    echo "browser_daemon_failed" > /data/.stop-reason
    exit 1
  fi
  sleep 1
done

# Restrict PATH to safe read-only commands — mirrors the other CLI harnesses
# so gloop's Bash tool cannot bypass the browser with curl/python. bun stays
# on PATH because gloop spawns `bun` for `gloop --task` sub-agents.
SAFE_BIN=/tmp/safe-bin
mkdir -p "$SAFE_BIN"
for cmd in ls cat find file jq cut uniq head tail tr wc grep sort sh bash mkdir; do
  [ -x "$(command -v "$cmd" 2>/dev/null)" ] && ln -sf "$(command -v "$cmd")" "$SAFE_BIN/$cmd"
done
ln -sf "$(command -v bun)" "$SAFE_BIN/bun"
BUN_BIN="$(command -v bun)"

cd "$WORKSPACE"
echo "Starting gloop headless (model=${GLOOP_MODEL})..."
: > /data/usage.jsonl
# --task appends gloop's "call CompleteTask when done" suffix, which is what
# ends the headless turn. --output is the agent-messages artifact.
PATH="$SAFE_BIN" HOME=/root NO_COLOR=1 "$BUN_BIN" "$GLOOP_HOME/src/core/headless.ts" \
  --model "$GLOOP_MODEL" \
  --output /data/agent-messages.jsonl \
  --task "$INSTRUCTION" \
  > /data/agent.log 2>&1 &
AGENT_PID=$!
python3 /usage-emitter.py --harness gloop --input /data/agent-messages.jsonl --output /data/usage.jsonl --watch &
USAGE_PID=$!
sleep 3

# Watchdog: detect agent no action for 300s
IDLE_THRESHOLD=300
MAX_WAIT=${TIME_LIMIT_S:-1800}
ELAPSED=0
LAST_SIZE=0
IDLE=0
STOP_REASON=""

while kill -0 $AGENT_PID 2>/dev/null && [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
  sleep 5
  ELAPSED=$((ELAPSED + 5))

  # Check if server requested stop (eval interceptor matched)
  if [ -f /data/.stop-requested ]; then
    echo "Stop requested by server (eval matched), killing agent."
    STOP_REASON="eval_matched"
    break
  fi

  CURRENT_SIZE=$(wc -c < /data/actions.jsonl 2>/dev/null || echo 0)

  if [ "$CURRENT_SIZE" -gt 0 ] && [ "$CURRENT_SIZE" -eq "$LAST_SIZE" ]; then
    IDLE=$((IDLE + 5))
    if [ "$IDLE" -ge "$IDLE_THRESHOLD" ]; then
      echo "Agent idle for ${IDLE_THRESHOLD}s, assuming done."
      STOP_REASON="agent_idle"
      break
    fi
  else
    IDLE=0
  fi
  LAST_SIZE=$CURRENT_SIZE
done

# Determine stop reason if not set (loop exited without breaking)
if [ -z "$STOP_REASON" ]; then
  if ! kill -0 $AGENT_PID 2>/dev/null; then
    STOP_REASON="agent_exited"
  else
    echo "Time limit (${MAX_WAIT}s) exceeded, killing agent."
    STOP_REASON="time_limit_exceeded"
  fi
fi

echo "$STOP_REASON" > /data/.stop-reason

# Kill gloop (and any sub-agents), the usage watcher, the daemon and the proxy.
kill $AGENT_PID 2>/dev/null || true
kill $USAGE_PID 2>/dev/null || true
kill $DAEMON_PID 2>/dev/null || true
pkill -f "daemon/server.ts" 2>/dev/null || true
[ -n "$PROXY_PID" ] && kill $PROXY_PID 2>/dev/null || true
pkill -f "src/core/headless.ts" 2>/dev/null || true
pkill -f "litellm" 2>/dev/null || true
sleep 2
python3 /usage-emitter.py --harness gloop --input /data/agent-messages.jsonl --output /data/usage.jsonl || true

# Keep the agent transcript and daemon log for debugging; they are small.
[ -f /data/agent.log ] && cp /data/agent.log /data/gloop-stdout.txt
[ -f /data/browser-daemon.log ] && cp /data/browser-daemon.log /data/gloop-browser-daemon.txt

curl -sf -X POST http://localhost:7878/api/stop || true

# Clean up internal marker (created by /api/stop)
rm -f /data/.stop-requested

# Grace period: keep recording for 15s after agent is killed to capture end result
echo "Agent finished, recording grace period (15s)..."
sleep 15

# Stop recording
echo "Stopping recording..."
curl -sf -X POST http://localhost:7878/api/stop-recording || true
sleep 2
rm -f /data/*.log
echo "Done."
