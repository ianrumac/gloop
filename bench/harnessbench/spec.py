"""gloop (self-modifying CLI agent) harness spec for HarnessBench.

Upstream: https://github.com/ianrumac/gloop
"""

from __future__ import annotations

from harnessbench.harnesses._schema import HarnessSpec


spec = HarnessSpec(
    name="gloop",
    description=(
        "gloop, a self-modifying Bun/TypeScript CLI agent; drives Chrome via "
        "Playwright-over-CDP tools loaded from .gloop/tools."
    ),
    runtime="node",
    dockerfile="Dockerfile",
    setup_script="setup.sh",
    run_script="run.sh",
    container_isolation="dedicated",
    requires_credentials=(),
    upstream_url="https://github.com/ianrumac/gloop",
    upstream_license="MIT",
)
