# syntax=docker/dockerfile:1
# OpenShell review image: Ubuntu base with a pinned OpenCode release binary and
# a pinned GitHub CLI. Unlike the sbx template, this uses a plain Ubuntu base
# and runs as UID 1000 with /workspace as the fixed sandbox path for the
# checkout, configuration, and evidence trees.
FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git bash tar gzip unzip && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.source="https://github.com/ariga39/compte-rendu"

USER root

# Install one official OpenCode release binary with its release-asset digest.
RUN curl -fL https://github.com/anomalyco/opencode/releases/download/v1.18.25/opencode-linux-x64.tar.gz -o /tmp/opencode.tar.gz \
    && echo "58a3729a6f3432dd6d2917fcc4a949788891a035818646ad480e12c947f56e78  /tmp/opencode.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode \
    && chmod 0755 /usr/local/bin/opencode \
    && rm /tmp/opencode.tar.gz

# /usr/local/bin precedes the base image's apt-installed /usr/bin/gh.
RUN curl -fL https://github.com/cli/cli/releases/download/v2.98.0/gh_2.98.0_linux_amd64.tar.gz -o /tmp/gh.tar.gz \
    && echo "3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 /tmp/gh_2.98.0_linux_amd64/bin/gh /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz /tmp/gh_2.98.0_linux_amd64

RUN test "$(opencode --version)" = "1.18.25" \
    && gh version | grep -F "gh version 2.98.0"

RUN mkdir -p /workspace && chmod 0777 /workspace
WORKDIR /workspace
USER 1000
