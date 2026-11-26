# Dolly's Claude Code container: only the bridge (src/server.ts) and the Claude Agent SDK with its
# bundled Claude Code. It never runs the agent's commands and never sees the owner's token.
FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/claude-bridge
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
ENV HOME=/home/node NODE_ENV=production PORT=8080
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "src/server.ts"]
