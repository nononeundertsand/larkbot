FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    grep \
    python3 \
    python-is-python3 \
    ripgrep \
    wget \
  && rm -rf /var/lib/apt/lists/*

USER 1000:1000
WORKDIR /workspace

ENV HOME=/tmp \
    TMPDIR=/tmp \
    TMP=/tmp \
    TEMP=/tmp \
    CI=1 \
    NO_COLOR=1 \
    GIT_TERMINAL_PROMPT=0 \
    GIT_OPTIONAL_LOCKS=0
