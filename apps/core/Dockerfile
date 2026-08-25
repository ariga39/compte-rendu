FROM docker.io/cloudflare/sandbox:0.13.0-next.751.1

USER root

# The CLI belongs to the Sandbox image, never to the Worker bundle.
RUN npm install --global --no-audit --no-fund opencode-ai@1.18.22 \
  && opencode --version

ENV OPENCODE_DISABLE_PROJECT_CONFIG=1
ENV HOME=/tmp/compte-rendu-opencode-home
ENV XDG_CONFIG_HOME=/tmp/compte-rendu-opencode-xdg
ENV XDG_DATA_HOME=/tmp/compte-rendu-opencode-data
WORKDIR /workspace
RUN mkdir -p /workspace/compte-rendu-review "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME/opencode"
