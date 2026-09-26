# Cloud Agent development image for JaGate.
# Pins Node.js to the version required by package.json ("engines": ">=24.21.0 <25")
# and the project's own production Dockerfile / .nvmrc (24.21.0), and adds the
# toolchain needed to build the better-sqlite3 native addon when a prebuilt
# binary is unavailable.
FROM node:24.21.0-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        g++ \
        make \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# The base image already provides the non-root "node" user (uid 1000).
USER node
