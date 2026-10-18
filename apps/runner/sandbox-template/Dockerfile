# syntax=docker/dockerfile:1
FROM docker.io/docker/sandbox-templates:opencode-docker-0.5.0@sha256:d23d51e1eaa7c23db723b3cd547fc998829b5c147579c512c7222efd30761fdd

LABEL org.opencontainers.image.source="https://github.com/ariga39/compte-rendu"

USER root

# Remove the moving npm-installed OpenCode from the base, then install the
# pinned OpenCode 2 npm target package with its tarball digest.
RUN npm uninstall --global opencode-ai \
    && curl -fL https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.0.32.tgz -o /tmp/opencode.tgz \
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

USER agent
