# syntax=docker/dockerfile:1
FROM docker.io/docker/sandbox-templates:opencode-docker-0.5.0@sha256:d23d51e1eaa7c23db723b3cd547fc998829b5c147579c512c7222efd30761fdd

LABEL org.opencontainers.image.source="https://github.com/ariga39/compte-rendu"

USER root

# Remove the moving npm-installed OpenCode from the base, then install one
# official release binary with its release-asset digest.
RUN npm uninstall --global opencode-ai \
    && curl -fL https://github.com/anomalyco/opencode/releases/download/v1.18.25/opencode-linux-x64.tar.gz -o /tmp/opencode.tar.gz \
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

USER agent
