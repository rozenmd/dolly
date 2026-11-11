FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools
FROM node:24-bookworm-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
