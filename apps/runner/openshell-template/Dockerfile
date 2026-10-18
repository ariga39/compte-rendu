# syntax=docker/dockerfile:1
# OpenShell review image: Ubuntu base with a pinned OpenCode release binary and
# a pinned GitHub CLI. Unlike the sbx template, this uses a plain Ubuntu base
# and runs as UID 1000 with /workspace as the fixed sandbox path for the
# checkout, configuration, and evidence trees.
FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git bash tar gzip unzip && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.source="https://github.com/ariga39/compte-rendu"

USER root

# Install the pinned OpenCode 2 npm target package with its tarball digest.
RUN curl -fL https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.32.tgz -o /tmp/opencode.tgz \
    && echo "64a1f4b381c2d2efc18c8d76b2ce399141778b421b54c98b94be8e80803606dc  /tmp/opencode.tgz" | sha256sum -c - \
    && tar -xzf /tmp/opencode.tgz -C /tmp \
    && install -m 0755 /tmp/package/bin/opencode /usr/local/bin/opencode \
    && rm -rf /tmp/opencode.tgz /tmp/package

# /usr/local/bin precedes the base image's apt-installed /usr/bin/gh.
RUN curl -fL https://github.com/cli/cli/releases/download/v2.98.0/gh_2.98.0_linux_amd64.tar.gz -o /tmp/gh.tar.gz \
    && echo "3b8ac6b30336802fc1a858d7c084e11cdf24ac1a761ca90b68022d7d729208de  /tmp/gh.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 /tmp/gh_2.98.0_linux_amd64/bin/gh /usr/local/bin/gh \
    && rm -rf /tmp/gh.tar.gz /tmp/gh_2.98.0_linux_amd64

RUN test "$(opencode --version)" = "opencode v2.0.32" \
    && gh version | grep -F "gh version 2.98.0"

RUN mkdir -p /workspace && chmod 0777 /workspace
WORKDIR /workspace
USER 1000
