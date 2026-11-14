FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools
FROM docker.io/oven/bun:1.4.4 AS bun-tools
FROM node:24-trixie-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=bun-tools /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 curl util-linux procps tini zstd && rm -rf /var/lib/apt/lists/* \
    && corepack enable && mkdir -p /workspace /run/sandbox && chown node:node /workspace /run/sandbox && chmod 700 /run/sandbox
COPY container/checkout.sh /usr/local/lib/dolly-checkout.sh
COPY container/setup.py /usr/local/lib/dolly-setup.py
COPY container/dependency_cache.py /usr/local/lib/dependency_cache.py
COPY container/package_manager.py /usr/local/lib/package_manager.py
COPY container/exec.py /usr/local/lib/dolly-exec.py
COPY container/preview.py /usr/local/lib/dolly-preview.py
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["sleep", "infinity"]
