FROM golang:1.27-bookworm AS artifact-fs-build
RUN GOBIN=/out go install github.com/cloudflare/artifact-fs/cmd/artifact-fs@2b87a48691ef4ae82d391b7bbe4976c06c7fadf7
FROM docker.io/cloudflare/sandbox:1.0.3 AS sandbox-tools
FROM node:24-trixie-slim
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 curl fuse3 util-linux && rm -rf /var/lib/apt/lists/* \
    && python3 -c 'import tarfile; assert hasattr(tarfile, "data_filter"), "Python tar extraction filters are required"' \
    && corepack enable && mkdir -p /workspace /run/sandbox && chown node:node /workspace /run/sandbox && chmod 700 /run/sandbox
COPY --from=artifact-fs-build /out/artifact-fs /usr/local/bin/artifact-fs
COPY --chmod=0755 container/mount.sh /usr/local/bin/pi-hard-mount
COPY container/checkpoint.py /usr/local/lib/pi-hard-checkpoint.py
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
