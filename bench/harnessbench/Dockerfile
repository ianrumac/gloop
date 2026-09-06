# HarnessBench / gloop — Bun runtime + gloop checkout + Playwright-over-CDP
# browser tools on top of clawbench-base.
#
# The files next to this Dockerfile are assembled by gloop's
# `bench/install.sh --harnessbench <HarnessBench checkout>` from
# bench/clawbench/gloop/ (single source of truth).
FROM oven/bun:1.3.11 AS bun-runtime
FROM node:24-slim AS node-runtime

FROM ghcr.io/reacher-z/clawbench-base:latest

ARG GLOOP_REPO=https://github.com/ianrumac/gloop.git
ARG GLOOP_REF=main

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx
RUN pip install --no-cache-dir --retries 5 --timeout 120 'litellm[proxy]==1.83.9'

COPY setup.sh /opt/harness/setup.sh
RUN chmod +x /opt/harness/setup.sh && GLOOP_REPO="$GLOOP_REPO" GLOOP_REF="$GLOOP_REF" /opt/harness/setup.sh

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY harness /opt/gloop-harness
RUN cd /opt/gloop-harness && bun install --production && rm -rf /root/.bun/install/cache

COPY configure.sh /setup-gloop.sh
COPY run.sh       /run-harness.sh
COPY usage-emitter.py /usage-emitter.py
RUN chmod +x /setup-gloop.sh /run-harness.sh /usage-emitter.py \
    && mkdir -p /opt/harness && ln -sf /run-harness.sh /opt/harness/run.sh

ENTRYPOINT ["/opt/harness/run.sh"]
