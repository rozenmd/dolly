FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools
FROM node:24-bookworm-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 curl && rm -rf /var/lib/apt/lists/* \
    && corepack enable && mkdir -p /workspace /run/sandbox && chown node:node /workspace /run/sandbox && chmod 700 /run/sandbox
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
