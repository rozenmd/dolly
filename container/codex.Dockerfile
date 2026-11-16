FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund @openai/codex@0.157.0 \
    && mkdir -p /workspace && chown node:node /workspace
COPY container/codex.mjs /usr/local/lib/dolly-codex.mjs
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["sleep", "infinity"]
