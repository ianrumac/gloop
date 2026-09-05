#!/usr/bin/env bash
# install.sh — register the gloop harness with an installed ClawBench
# (clawbench-eval, which is what `harness-bench` / `clawbench-run` execute),
# and optionally lay the HarnessBench-style adapter into a HarnessBench
# checkout.
#
#   bench/install.sh                       # register into the clawbench-eval on PATH/venv
#   bench/install.sh --python .venv/bin/python
#   bench/install.sh --ref <branch|tag|sha> # gloop revision baked into the image (default: main)
#   bench/install.sh --harnessbench ~/src/HarnessBench
#
# Re-running is safe: files are overwritten and the registry entry replaced.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/clawbench/gloop"
PYTHON="${PYTHON:-python3}"
GLOOP_REF="main"
HB_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --python) PYTHON="$2"; shift 2 ;;
    --ref) GLOOP_REF="$2"; shift 2 ;;
    --harnessbench) HB_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Resolve a branch/tag to its commit SHA so Docker's layer cache cannot serve
# a stale clone when the branch moves (the clone layer's cache key is the
# literal GLOOP_REF value). Falls back to the ref as given if lookup fails.
GLOOP_REPO="${GLOOP_REPO:-https://github.com/ianrumac/gloop.git}"
if ! [[ "$GLOOP_REF" =~ ^[0-9a-f]{40}$ ]]; then
  RESOLVED="$(git ls-remote "$GLOOP_REPO" "$GLOOP_REF" "refs/heads/$GLOOP_REF" "refs/tags/$GLOOP_REF" 2>/dev/null | head -1 | cut -f1)"
  if [ -n "$RESOLVED" ]; then
    echo "gloop ref $GLOOP_REF -> $RESOLVED"
    GLOOP_REF="$RESOLVED"
  else
    echo "warning: could not resolve '$GLOOP_REF' on $GLOOP_REPO; baking it in verbatim (Docker may reuse a cached clone)" >&2
  fi
fi

stamp_ref() {
  # ClawBench builds without --build-arg, so bake the requested ref into the
  # Dockerfile default.
  sed -i.bak "s|^ARG GLOOP_REF=.*|ARG GLOOP_REF=${GLOOP_REF}|" "$1" && rm -f "$1.bak"
}

# ---------------------------------------------------------------- ClawBench
HARNESS_ROOT="$("$PYTHON" -c 'from clawbench.utils.paths import HARNESS_ROOT; print(HARNESS_ROOT)' 2>/dev/null || true)"
if [ -z "$HARNESS_ROOT" ]; then
  echo "clawbench-eval is not importable with $PYTHON — install it first:" >&2
  echo "  uv tool install harness-bench   # or: pip install clawbench-eval" >&2
  echo "then re-run with --python <that interpreter>." >&2
  exit 1
fi

echo "ClawBench harness root: $HARNESS_ROOT"
rm -rf "$HARNESS_ROOT/gloop"
cp -R "$SRC" "$HARNESS_ROOT/gloop"
rm -rf "$HARNESS_ROOT/gloop/harness/node_modules" "$HARNESS_ROOT/gloop/harness/bun.lock"
stamp_ref "$HARNESS_ROOT/gloop/Dockerfile.gloop"

REGISTRY="$HARNESS_ROOT/harnesses.yaml"
"$PYTHON" - "$REGISTRY" "$HERE/clawbench/harnesses.yaml.gloop" <<'PYEOF'
import sys
from pathlib import Path

registry, snippet = Path(sys.argv[1]), Path(sys.argv[2])
text = registry.read_text()
new_entry = snippet.read_text().rstrip("\n") + "\n"

lines = text.splitlines(keepends=True)
out, skipping = [], False
for line in lines:
    if line.startswith("  - name: gloop"):
        skipping = True
        continue
    if skipping and (line.startswith("  - ") or (line.strip() and not line.startswith(" "))):
        skipping = False
    if not skipping:
        out.append(line)
text = "".join(out)
if not text.endswith("\n"):
    text += "\n"
registry.write_text(text + new_entry)
print(f"registered 'gloop' in {registry}")
PYEOF

"$PYTHON" - <<'PYEOF'
from clawbench.runner.run_support.harness_registry import load_harness_registry
reg = load_harness_registry()
assert "gloop" in reg.harnesses, reg.harnesses
print("registry OK:", ", ".join(reg.harnesses))
PYEOF

# -------------------------------------------------------------- HarnessBench
if [ -n "$HB_DIR" ]; then
  DEST="$HB_DIR/src/harnessbench/harnesses/gloop"
  [ -d "$HB_DIR/src/harnessbench/harnesses" ] || { echo "not a HarnessBench checkout: $HB_DIR" >&2; exit 1; }
  rm -rf "$DEST" && mkdir -p "$DEST"
  cp "$HERE/harnessbench/spec.py" "$HERE/harnessbench/__init__.py" "$HERE/harnessbench/Dockerfile" "$DEST/"
  cp "$SRC/install-gloop.sh" "$DEST/setup.sh"
  cp "$SRC/setup-gloop.sh"   "$DEST/configure.sh"
  cp "$SRC/run-gloop.sh"     "$DEST/run.sh"
  cp "$SRC/usage-emitter.py" "$DEST/usage-emitter.py"
  cp -R "$SRC/harness"       "$DEST/harness"
  rm -rf "$DEST/harness/node_modules" "$DEST/harness/bun.lock"
  chmod +x "$DEST"/*.sh
  stamp_ref "$DEST/Dockerfile"

  PYPROJECT="$HB_DIR/pyproject.toml"
  if ! grep -q '^hb-gloop' "$PYPROJECT"; then
    sed -i.bak 's|^hb-coze-studio = "harnessbench.harnesses.coze_studio.spec:spec"|&\nhb-gloop       = "harnessbench.harnesses.gloop.spec:spec"|' "$PYPROJECT" && rm -f "$PYPROJECT.bak"
  fi
  MATRIX="$HB_DIR/src/harnessbench/matrix.py"
  if ! grep -q 'gloop' "$MATRIX"; then
    "$PYTHON" - "$MATRIX" <<'PYEOF'
import re, sys
from pathlib import Path
p = Path(sys.argv[1]); s = p.read_text()
s = s.replace("        coze_studio,\n        hermes,", "        coze_studio,\n        gloop,\n        hermes,", 1)
s = s.replace("for mod in (openclaw, hermes, claw_code, stagehand, browser_use, coze_studio):",
              "for mod in (openclaw, hermes, claw_code, stagehand, browser_use, coze_studio, gloop):", 1)
p.write_text(s)
PYEOF
  fi
  echo "HarnessBench adapter written to $DEST (pyproject entry point + matrix registration added)"
fi

echo
echo "Next:"
echo "  clawbench-run <test-case-dir> <model> --harness gloop        # ClawBench pipeline"
[ -n "$HB_DIR" ] && echo "  (cd $HB_DIR && uv run harness-bench harnesses | grep gloop)"
