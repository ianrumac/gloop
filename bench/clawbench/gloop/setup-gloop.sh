#!/bin/bash
# setup-gloop.sh — run-time configuration for the gloop harness.
#
# All config comes from env vars set by the ClawBench driver (from
# models/models.yaml): BASE_URL, MODEL_NAME, API_TYPE, API_KEY(S).
#
# Two routes:
#   * OpenRouter base_url  -> gloop talks to OpenRouter directly (native).
#   * anything else        -> a local LiteLLM proxy translates gloop's
#                             OpenAI-compatible requests to the upstream API,
#                             exactly like the claude-code / pi harnesses.
set -e

if [ -z "$BASE_URL" ] || [ -z "$MODEL_NAME" ]; then
  echo "ERROR: BASE_URL and MODEL_NAME must be set"
  exit 1
fi
if [ -n "$TEMPERATURE" ]; then
  echo "WARN: gloop does not expose a temperature flag; TEMPERATURE='$TEMPERATURE' will be ignored."
fi
if [ -n "$MAX_TOKENS" ]; then
  echo "WARN: gloop does not expose a max-tokens flag; MAX_TOKENS='$MAX_TOKENS' will be ignored."
fi

python3 - <<'PYEOF'
import json
import os
import urllib.request
from pathlib import Path

import yaml

base_url = os.environ["BASE_URL"].rstrip("/")
model_name = os.environ["MODEL_NAME"]
api_type = os.environ.get("API_TYPE", "openai-completions")

keys_json = os.environ.get("API_KEYS", "")
single_key = os.environ.get("API_KEY", "")
key = ""
if keys_json:
    try:
        parsed = json.loads(keys_json)
        if parsed:
            key = parsed[0]
            if len(parsed) > 1:
                print(f"WARN: gloop does not rotate keys — using first of {len(parsed)}")
    except json.JSONDecodeError:
        pass
if not key and single_key:
    key = single_key
if not key:
    raise SystemExit("ERROR: no API key provided (API_KEYS or API_KEY)")

is_openrouter = "openrouter.ai" in base_url

# OpenRouter wants the canonical "vendor/model" id; models.yaml keys are
# often the short form (claude-sonnet-4-6). Resolve like the other harnesses.
resolved_model = model_name
if is_openrouter:
    try:
        req = urllib.request.Request(
            f"{base_url}/models", headers={"Authorization": f"Bearer {key}"}
        )
        resp = json.loads(urllib.request.urlopen(req, timeout=10).read())
        for m in resp.get("data", []):
            if m["id"] == model_name or m["id"].endswith(f"/{model_name}"):
                resolved_model = m["id"]
                break
    except Exception as e:  # noqa: BLE001
        print(f"WARN: could not resolve OpenRouter model id: {e}")

env_lines = []
if is_openrouter:
    env_lines += [
        f'export OPENROUTER_API_KEY="{key}"',
        f'export OPENROUTER_BASE_URL="{base_url}"',
        f'export GLOOP_MODEL="{resolved_model}"',
        'export GLOOP_USE_PROXY=0',
    ]
    print(f"gloop -> OpenRouter directly (model={resolved_model})")
else:
    litellm_params = {"api_key": key}
    if api_type == "anthropic-messages":
        litellm_params["model"] = f"anthropic/{model_name}"
        if not base_url.startswith("https://api.anthropic.com"):
            litellm_params["api_base"] = base_url
    elif api_type == "google-generative-ai":
        litellm_params["model"] = f"gemini/{model_name}"
        if not base_url.startswith("https://generativelanguage.googleapis.com"):
            litellm_params["api_base"] = base_url
    elif api_type in ("openai-completions", "openai-responses"):
        litellm_params["model"] = f"openai/{model_name}"
        litellm_params["api_base"] = base_url
    else:
        raise SystemExit(f"ERROR: unsupported api_type for gloop harness: {api_type}")

    proxy_config = {
        "model_list": [{"model_name": model_name, "litellm_params": litellm_params}],
        "litellm_settings": {"drop_params": True},
    }
    proxy_path = Path("/tmp/litellm-config.yaml")
    proxy_path.write_text(yaml.dump(proxy_config, default_flow_style=False))
    os.chmod(proxy_path, 0o600)
    env_lines += [
        'export OPENROUTER_API_KEY="sk-proxy-placeholder"',
        'export OPENROUTER_BASE_URL="http://localhost:4000"',
        f'export GLOOP_MODEL="{model_name}"',
        'export GLOOP_USE_PROXY=1',
    ]
    print(f"gloop -> LiteLLM proxy ({api_type} → {litellm_params['model']})")

env_path = Path("/tmp/gloop-env.sh")
env_path.write_text("\n".join(env_lines) + "\n")
os.chmod(env_path, 0o600)
PYEOF
