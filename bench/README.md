# Benchmarking gloop with ClawBench / HarnessBench

[HarnessBench](https://github.com/reacher-z/HarnessBench) compares agent
harnesses on the same everyday browser tasks with the base model held
constant. It is a thin front-end over its sister project
[ClawBench](https://github.com/reacher-z/ClawBench): the `clawbench-eval`
Python package owns the runnable pipeline (Docker image per harness, Chrome +
CDP recorder, request interceptor, LLM judge, leaderboard) and the 153-task
pool. This directory makes gloop one of those harnesses.

```
bench/
  install.sh                  registers the harness with an installed clawbench-eval
                              (and optionally lays the adapter into a HarnessBench checkout)
  clawbench/
    harnesses.yaml.gloop      registry entry appended to ClawBench's harnesses.yaml
    gloop/
      Dockerfile.gloop        clawbench-base + bun + gloop checkout + browser tools (+ LiteLLM)
      install-gloop.sh        build-time: clone gloop at GLOOP_REF into /opt/gloop
      setup-gloop.sh          run-time: turn ClawBench's BASE_URL/MODEL_NAME/API_KEY into gloop env
      run-gloop.sh            run-time: start gloop headless, watchdog, stop recording
      usage-emitter.py        ClawBench's stock usage emitter
      harness/
        daemon/server.ts      Node HTTP daemon owning the Playwright-over-CDP session
        daemon/actions.ts     the browser actions (navigate, snapshot, click, ...)
        lib/browser.ts        shared CDP session + page snapshot (used by the daemon)
        lib/client.ts         Bun-side client used by the tools
        tools/Browser*.ts     twelve gloop tools, loaded from .gloop/tools by gloop's Reload
        memory.md             harness notes seeded into gloop's memory (system prompt)
  harnessbench/               HarnessBench `spec.py` + Dockerfile (docs/adding-a-harness.md layout)
```

## How gloop drives the browser

gloop has no browser support of its own, so the harness gives it some the
gloop way: custom tools dropped into `.gloop/tools/`, which gloop's `Reload`
picks up before the first turn. The tools are thin clients of a small Node
browser daemon (`harness/daemon/`) that holds a `playwright-core` session
attached to the container's Chrome over CDP (Playwright's WebSocket client
does not connect from inside Bun, and the daemon also lets `gloop --task`
sub-agents share one browser). The ClawBench recorder (actions, screenshots,
request log, interception, MP4) therefore sees every action exactly as it
does for the other harnesses.

| Tool | What it does |
|------|--------------|
| `BrowserNavigate` | open a URL, or `back` / `forward` / `reload` |
| `BrowserSnapshot` | headings + every visible interactive element with a ref (`e12`, `f2e12` inside iframes), role, label, state |
| `BrowserClick` / `BrowserHover` | act on a ref; popups become the active tab |
| `BrowserType` | fill an input by ref, optional Enter / key-by-key typing |
| `BrowserSelect` | choose a `<select>` option by text or value |
| `BrowserPressKey` / `BrowserScroll` / `BrowserWait` | keyboard, scrolling, waiting for text |
| `BrowserGetText` | visible text of the page or one element |
| `BrowserTabs` | list / switch / new / close tabs |
| `BrowserExecuteJs` | escape hatch: evaluate JS in the page |

The agent's shell is restricted the same way as ClawBench's other CLI
harnesses (a `safe-bin` PATH), so it cannot bypass the browser with `curl`.
`harness/memory.md` is copied to `.gloop/memory.md`, which gloop folds into
its system prompt, telling it to use the `Browser*` tools, where `./my-info/`
lives, and to finish with `CompleteTask`.

Model routing: when `models.yaml` points at OpenRouter, gloop talks to it
directly. For any other `api_type` the container runs a LiteLLM proxy and
gloop is pointed at it through `OPENROUTER_BASE_URL`, mirroring the
`claude-code` / `pi` harnesses.

## Running it

Prerequisites: Python 3.11+, [uv](https://docs.astral.sh/uv/), Docker (or
Podman), and an OpenRouter key (or whichever API your `models.yaml` uses).

```bash
# 1. Install the pipeline (harness-bench pulls in clawbench-eval)
uv tool install harness-bench            # or: pip install clawbench-eval
PY="$(uv tool dir)/harness-bench/bin/python"

# 2. Register gloop with it (re-runnable; --ref pins the gloop revision baked into the image)
bench/install.sh --python "$PY" --ref main

# 3. Workspace: models + credentials
mkdir -p ~/clawbench-work/models && cd ~/clawbench-work
cat > models/models.yaml <<'YAML'
claude-sonnet-4-6:
  api_key: "sk-or-v1-..."                 # OpenRouter key
  base_url: https://openrouter.ai/api/v1
  api_type: openai-completions
deepseek-v4-pro:                          # default --judge model; or pass --no-judge
  api_key: "sk-or-v1-..."
  base_url: https://openrouter.ai/api/v1
  api_type: openai-completions
YAML

# 4. One task (test cases are bundled with clawbench-eval; first run builds the images, ~5-10 min)
clawbench-run test-cases/v1-lite/002-daily-life-food-doordash claude-sonnet-4-6 --harness gloop

# 5. HarnessBench-Lite: the 20 v1-lite cases
for c in $("$PY" -c 'from clawbench.utils.paths import bundled_path; import os; print(*sorted(os.listdir(bundled_path("test-cases","v1-lite"))))'); do
  clawbench-run "test-cases/v1-lite/$c" claude-sonnet-4-6 --harness gloop
done
# compare with another harness on the same model
clawbench-run test-cases/v1-lite/002-daily-life-food-doordash claude-sonnet-4-6 --harness claude-code
```

Results land in `./test-output/<model>/gloop-<case>-<model>-<timestamp>/`
with `run-meta.json` (pass/fail, stop reason, usage), `data/actions.jsonl`,
`data/requests.jsonl`, `data/interception.json`, `data/screenshots/`,
`data/recording.mp4`, `data/agent-messages.jsonl` (gloop's event log) and
`data/gloop-stdout.txt`. `clawbench-batch` / `clawbench-analyze` work on them
like on any other harness.

### Through the HarnessBench CLI

`harness-bench` (0.1.x) can list and matrix-expand harnesses, but its `run` /
`batch` still delegate to a `clawbench.run_case` API that clawbench-eval does
not export yet, so use `clawbench-run` above for actual runs. To register
gloop with a HarnessBench checkout anyway (spec, entry point, matrix):

```bash
git clone https://github.com/reacher-z/HarnessBench.git
bench/install.sh --python "$PY" --harnessbench ./HarnessBench
(cd HarnessBench && uv run harness-bench harnesses && uv run harness-bench matrix -h gloop -m claude-sonnet-4-6 -c 002-daily-life-food-doordash)
```

## Developing the harness

* `harness/` is a small Bun package: `cd bench/clawbench/gloop/harness && bun install && bun run typecheck`.
  Tools import the client by its in-container path `/opt/gloop-harness/lib/client.ts`;
  symlink the directory there to typecheck locally (`ln -s "$PWD" /opt/gloop-harness`).
* To benchmark a local branch, push it and pass `--ref <branch-or-sha>` to `install.sh`
  (ClawBench builds without `--build-arg`, so the ref is baked into the Dockerfile default).
* Smoke test without an LLM: run the built image directly with a scripted
  OpenAI-compatible server as `BASE_URL` (see `docker_run` in clawbench's
  `runner/run_support/docker.py` for the env it expects).

## Known gaps

* Token usage: gloop-loop does not surface token counts from streamed
  responses yet, so `usage.jsonl` rows carry zero tokens and cost is
  estimated as 0 for gloop runs.
* gloop's `Bash` tool stays available (with the restricted PATH). gloop also
  keeps its self-modification/`Reload` abilities in the container; that is the
  harness being measured.
