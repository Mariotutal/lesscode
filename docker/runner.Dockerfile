# Pin this base to an approved digest in hosted deployments.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /workspace
