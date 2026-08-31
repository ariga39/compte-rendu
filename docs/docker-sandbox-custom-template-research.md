# Docker Sandboxes OpenCode custom template research

Research date: 2026-08-31. Scope: Docker Sandboxes `sbx` 0.39.0 and an
x86-64 Linux NUC. Sources are Docker, OpenCode, GitHub CLI, their official
registries, and the installed `sbx` binary only.

## Decision

Build a normal OCI image from a Dockerfile, based on the official versioned
OpenCode-with-Docker template **and its digest**. Pin the OpenCode and `gh`
release binaries and their SHA256 values in that Dockerfile. For the current
no-registry deployment, tag the result as
`ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0`, transfer it with
`docker image save`, import it with `sbx template load`, and configure the
Runner to pass that exact tag to `sbx create --template`.

If the image is later published to a registry, replace the local tag in the
Runner with the published digest. Do not claim a registry digest for an image
that exists only in the local Sandbox image store.

Do not keep compatibility code merely because an old NUC cache happened to
contain an old OpenCode CLI. The runtime version should be an explicit deploy
input. Also do not make `sbx template save` snapshots the normal build path:
they are useful for experiments and offline transfer, but a reviewed
Dockerfile is the reproducible source of truth.

## What `sbx create opencode` uses

The installed executable identifies itself as:

```text
sbx version: v0.39.0 def8cb0523a77e757bdd6ef52b459fe374f3783e
```

Its embedded built-in OpenCode kit contains:

```yaml
schemaVersion: '2'
kind: sandbox
name: opencode
sandbox:
  image: 'docker/sandbox-templates:opencode-docker'
  entrypoint: [opencode]
```

This is also consistent with Docker's current template documentation: built-in
agents default to the `-docker` template variants, while the OpenCode agent
guide identifies the base family as `docker/sandbox-templates:opencode`.
Therefore, for **sbx 0.39.0**, the exact default selected by `sbx create
opencode` is the mutable Docker Hub tag
`docker/sandbox-templates:opencode-docker`, not the non-Docker variant and not
an image bundled into the `sbx` executable.

The image comes from Docker's official Docker Hub namespace. On 2026-08-31 the
official repository exposed these relevant tags:

| Tag                     | OCI index digest                                                          |
| ----------------------- | ------------------------------------------------------------------------- |
| `opencode-docker`       | `sha256:d23d51e1eaa7c23db723b3cd547fc998829b5c147579c512c7222efd30761fdd` |
| `opencode-docker-0.5.0` | `sha256:d23d51e1eaa7c23db723b3cd547fc998829b5c147579c512c7222efd30761fdd` |

The index contains `linux/amd64` and `linux/arm64`; the amd64 manifest digest
is `sha256:d3959838f164030c7e192f51748277e3d6aa05b10cfbb519917b621cca5e9ab4`.
The unversioned tag can move. Even the versioned tag is safest when coupled to
the recorded index digest.

The official registry image config shows `User: agent`,
`Entrypoint: ["tini", "--"]`, `Cmd: ["opencode"]`, and the label
`com.docker.sandboxes.start-docker=true`. Its build history installs `gh` with
an unversioned `apt-get install gh` and OpenCode with unversioned `npm install
-g opencode-ai`. An image digest freezes the result of that particular build,
but rebuilding equivalent instructions later does not freeze tool versions.

Sources:

- [Docker templates documentation at the reorganization commit](https://github.com/docker/docs/blob/7c47be0029a20cc2cbc69ff45cff40f616b4e97d/content/manuals/ai/sandboxes/customize/templates.md)
- [Docker OpenCode guide at the same commit](https://github.com/docker/docs/blob/7c47be0029a20cc2cbc69ff45cff40f616b4e97d/content/manuals/ai/sandboxes/agents/opencode.md)
- [Docker Hub official repository API](https://hub.docker.com/v2/repositories/docker/sandbox-templates/)
- [Docker Hub OpenCode tag API](https://hub.docker.com/v2/repositories/docker/sandbox-templates/tags/opencode-docker)
- [Docker Sandboxes 0.39.0 release](https://github.com/docker/sbx-releases/releases/tag/v0.39.0)

The implementation import path embedded in the executable is
`github.com/docker/sandboxes`, but that repository was not publicly readable
during this research. The public release repository distributes the CLI; the
published image and Docker docs are the public first-party sources for the
template itself.

## `--template` accepts ordinary OCI images

It is **not** restricted to snapshots created by the sandbox runtime.
`sbx create --help` calls the value a “Container image”. Docker's official
workflow is:

1. Write a normal Dockerfile extending an agent base variant.
2. `docker build ... --push` it to an OCI registry.
3. Pass that image reference to `sbx run`/`sbx create --template`.

Docker also explicitly documents a no-registry route: `docker image save` the
ordinary locally built image, `sbx template load` the tar, and then use the
same image tag with `--template`. The sandbox runtime does not share the host
Docker daemon's image store, so merely running `docker build` locally is not
enough; either push/pull through a registry or perform the save/load step.

Docker further warns that `sbx` does not add `docker.io` automatically. Use a
fully qualified remote reference.

Source: [Build a custom template](https://github.com/docker/docs/blob/7c47be0029a20cc2cbc69ff45cff40f616b4e97d/content/manuals/ai/sandboxes/customize/templates.md#build-a-custom-template).

## Required OpenCode image contract

For a custom **template** used with the built-in `opencode` agent, extend the
OpenCode variant rather than starting from an arbitrary Ubuntu image. A custom
template customizes an existing agent environment; it does not define a new
agent runtime. The `opencode` agent name still selects the built-in kit,
including its `entrypoint: [opencode]`, credential mappings, network defaults,
startup hooks, and `AGENTS.md` integration.

The resulting image must therefore preserve at least:

- a non-root `agent` user at UID 1000, home `/home/agent`, and passwordless
  sudo;
- the sandbox proxy environment forwarding supplied by the base;
- `opencode` on `PATH` for the built-in entrypoint;
- `gh` on `PATH` for this product's PR-context reads;
- the base's `tini` entrypoint and, for the `-docker` flavor, its Docker-engine
  setup and `com.docker.sandboxes.start-docker=true` label.

Extending the official digest preserves those contracts. A from-scratch image
or a different agent variant is a kit-authoring task, not a template swap.
Docker's from-scratch kit requirements independently name the UID 1000
`agent`, `/home/agent`, passwordless sudo, and proxy forwarding requirements.

Sources:

- [Template limitation and base images](https://github.com/docker/docs/blob/7c47be0029a20cc2cbc69ff45cff40f616b4e97d/content/manuals/ai/sandboxes/customize/templates.md#custom-templates)
- [Official agent-image requirements](https://github.com/docker/docs/blob/d21845af25bf289a48ce290a7a594d5e2a89aa19/content/manuals/ai/sandboxes/customize/build-an-agent.md#choose-a-base-image)
- Installed `sbx` 0.39.0 embedded OpenCode kit and official image OCI config,
  inspected with `strings` and `docker buildx imagetools inspect`.

## Reproducible pinned image for the NUC

The following amd64-only Dockerfile is deliberately small. The selected
versions were current stable releases at the research date: OpenCode 1.18.25
and GitHub CLI 2.98.0. Both archives, paths, SHA256 values, and version commands
were downloaded and executed successfully during this research.

```dockerfile
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
```

The base image's `ENTRYPOINT ["tini", "--"]` and `CMD ["opencode"]` are
inherited. The built-in OpenCode kit also explicitly starts `opencode`, so no
custom wrapper or alternate agent entrypoint is needed.

Why direct release archives instead of `@latest` or apt:

- OpenCode's official README advertises `npm i -g opencode-ai@latest`, but the
  published `opencode-ai` 1.18.25 wrapper points every platform optional
  dependency to exactly 1.18.25. An exact npm version would be acceptable; the
  official release archive plus its GitHub-published SHA256 is simpler to
  audit and removes npm resolution from the final layer.
- GitHub CLI officially publishes precompiled amd64 releases. Installing the
  exact archive and checking the release asset digest avoids an apt repository
  moving to a newer `gh` during rebuild.

Sources:

- [OpenCode v1.18.25 release](https://github.com/anomalyco/opencode/releases/tag/v1.18.25)
- [OpenCode v1.18.25 official installation README](https://github.com/anomalyco/opencode/blob/v1.18.25/README.md#installation)
- [OpenCode `opencode-ai` 1.18.25 npm metadata](https://registry.npmjs.org/opencode-ai/1.18.25)
- [GitHub CLI v2.98.0 release](https://github.com/cli/cli/releases/tag/v2.98.0)
- [GitHub CLI v2.98.0 official Linux installation documentation](https://github.com/cli/cli/blob/v2.98.0/docs/install_linux.md#precompiled-binaries)

### Build, publish, and pin

Docker's documented custom-template build path requires Docker Desktop. Build
on the existing development/build host (or another explicitly validated
BuildKit builder), not inside the production Sandbox and not as a Runner Job.
From the Dockerfile directory, replace the repository placeholder with the
actual controlled registry repository:

```console
docker buildx build \
  --platform linux/amd64 \
  --tag ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0 \
  --push .

docker buildx imagetools inspect \
  ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0
```

Record the returned top-level OCI index digest in deployment configuration.
Run a clean probe on the NUC using the full registry and digest:

```console
sbx create \
  --name petit-chiba-template-probe \
  --template ghcr.io/ariga39/petit-chiba-opencode@sha256:IMAGE_INDEX_DIGEST \
  --cpus 4 \
  --memory 8g \
  opencode /path/to/non-sensitive-probe-workspace

sbx exec petit-chiba-template-probe opencode --version
sbx exec petit-chiba-template-probe gh version
sbx rm --force petit-chiba-template-probe
```

After that probe, the production Runner should use the exact same digest in
every `sbx create ... --template` call. Retagging or rebuilding does not change
the deployed runtime until that digest is deliberately updated.

For a private non-Docker-Hub registry, Docker documents registering pull
credentials with `sbx secret set --registry`. Do not embed registry or model
credentials in the image.

## `sbx template save/load`

There are two distinct uses of `load`:

1. `docker image save IMAGE -o image.tar` followed by `sbx template load
image.tar` imports an ordinary locally built image into the sandbox
   runtime's separate image store.
2. `sbx template save SANDBOX TAG --output snapshot.tar` captures a stopped
   sandbox filesystem and exports it; `sbx template load snapshot.tar` imports
   that snapshot on another host.

An unexported `sbx template save SANDBOX TAG` stays only in that host's sandbox
runtime image store. `sbx template ls` and `sbx template rm` manage these local
templates. In 0.39.0, `template load` was specifically fixed to fail when an
import does not complete.

Snapshots capture installed packages, files, and configuration changes, but
Docker warns that they may also capture filesystem-resident secrets. Agent
configuration files are recreated at sandbox creation and do not reliably
persist from a saved snapshot. Those properties make snapshots poor release
artifacts for this service. Use them for a disposable experiment or an offline
transfer, not as a substitute for the pinned Dockerfile.

Verified offline path, when a registry pull is undesirable:

```console
docker buildx build \
  --platform linux/amd64 \
  --load \
  --tag ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0 .

docker image save \
  ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0 \
  -o petit-chiba-opencode.tar

sbx template load petit-chiba-opencode.tar
sbx create \
  --template ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0 \
  opencode /path/to/workspace
```

Source: [Saving, exporting, and importing templates](https://github.com/docker/docs/blob/7c47be0029a20cc2cbc69ff45cff40f616b4e97d/content/manuals/ai/sandboxes/customize/templates.md#saving-a-sandbox-as-a-template).

## Minimal production workflow

1. Keep the Dockerfile and both tool versions in version control. Review a
   version bump like any runtime dependency change.
2. Build once for `linux/amd64` on the documented Docker Desktop/build host,
   push to the controlled registry, and record the resulting OCI index digest.
   Never deploy by mutable tag alone; the NUC only needs to pull the artifact.
3. On the NUC, ensure registry pull credentials exist only in the host-side
   `sbx` secret store when needed. Keep the OpenCode Go key in the existing
   host-side custom-secret proxy; never bake it into this image or a snapshot.
4. Run one clean non-sensitive probe and verify `opencode --version`, `gh
version`, agent startup, and Sandbox destruction.
5. Change only the Runner template reference to the recorded digest. Existing
   repository checkout, scoped GitHub token, network policy, model secret,
   output validation, and cleanup behavior stay unchanged.
6. For upgrades, build a new immutable version/digest, probe it, deploy it,
   then retain the prior digest for immediate rollback. Clear or remove old
   cached templates only after the rollback window; `sbx reset` clears all
   cached images and is unnecessarily broad for routine deployment.

This turns the OpenCode and `gh` versions into an explicit runtime contract and
removes the justification for spending product code on incidental behavior of
an old cached CLI.
