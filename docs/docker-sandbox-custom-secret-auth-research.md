# Docker Sandbox GitHub authentication decision for issue #99

Research date: 2026-09-01. Scope: Docker Sandboxes 0.39.0, its official CLI
help, current Docker documentation, release notes, and reports in Docker's
official `sbx-releases` tracker. No credential value or private infrastructure
detail was inspected or recorded.

## Decision

Use Docker's sandbox-scoped built-in `github` service. It has passed a real
Runner E2E in which OpenCode used authenticated `gh` and paginated GraphQL
queries to read the PR thread and all four commits before reviewing the exact
merge-base-to-head diff. Docker explicitly documents that this service gives
an agent access to the `gh` CLI inside the Sandbox, and that `gh` then works
without additional in-Sandbox configuration. The built-in service maps
`GH_TOKEN` and `GITHUB_TOKEN` to Docker's proxy-managed GitHub credential and
covers `api.github.com`, `github.com`, `raw.githubusercontent.com`,
`gist.github.com`, and the documented GitHub Copilot domains.

Docker does not document a separate installation-token mode. It accepts the
stdout of the configured host command as the GitHub credential; it does not
distinguish whether that value came from `gh auth token`, a GitHub App token
minting command, or a file. Therefore a valid installation token can be the
command result. The actual token remains on the host: the Sandbox sees a
sentinel, and the host-side proxy substitutes the credential only on matching
outbound requests. OpenCode can consequently run authenticated `gh` commands,
but neither OpenCode nor `gh` should be expected to read the real token value.

Sources:

- [Docker: GitHub token](https://docs.docker.com/ai/sandboxes/configuration/credentials/#github-token)
- [Docker: Authenticate command-line tools — GitHub CLI](https://docs.docker.com/ai/sandboxes/workflows/authentication/#github-cli)
- [Docker: Built-in services](https://docs.docker.com/ai/sandboxes/configuration/credentials/#built-in-services)
- [Docker: How credential injection works](https://docs.docker.com/ai/sandboxes/configuration/credentials/#how-credential-injection-works)

## Configuration and refresh semantics

For each Job, the Runner writes the short-lived installation token to a
temporary host-side file, then registers the built-in service at Sandbox scope:

```console
sbx secret set github \
  --sandbox SANDBOX_NAME \
  --command 'cat TOKEN_FILE' \
  --refresh on-demand
```

This is the documented dynamic-secret mechanism. `--command` is executed by
the host shell, its trimmed stdout becomes the secret, and the command text is
stored and replayed by the daemon. Registration verifies the source by default.
The locally installed official 0.39.0 CLI help states the same behavior and
accepts `--command`, `--refresh`, and `--sandbox` together.

`--refresh on-demand` has one narrow meaning: Docker reruns the host command
for every credential use instead of caching its result for the default 55
minutes. It does **not** mint or renew a GitHub App installation token. With
`cat TOKEN_FILE`, it only rereads that file; the file must still contain a
currently valid token. If future jobs can outlive their token, the command must
mint or retrieve a current token, or the host must update the file. The present
fresh-Job design instead requires the initially minted token to cover the Job.

After registration, create a fresh Sandbox, allow the required GitHub egress,
run the `installation/repositories` preflight, and invoke OpenCode only after
that preflight succeeds. Terminal cleanup removes the Sandbox, service
registration, network policy, and host-side token file. Each Job gets a fresh
Sandbox.

Sources:

- [Docker: Use a dynamic secret source](https://docs.docker.com/ai/sandboxes/configuration/credentials/#use-a-dynamic-secret-source)
- [Docker: Authenticate command-line tools — GitHub CLI](https://docs.docker.com/ai/sandboxes/workflows/authentication/#github-cli)
- Official `sbx` 0.39.0 CLI help: `sbx secret set github --help`

## Version and collision limits

- Dynamic service-secret sources (`--command` or `--ref`) and refresh controls
  were added in Docker Sandboxes 0.39.0. This design therefore requires 0.39.0
  or newer; it is not a compatibility path for the NUC's former 0.38.0 client.
- Docker 0.38.0 release notes say sandbox-scoped GitHub credentials added after
  Sandbox creation began working without recreation. Docker's tracker still
  contains reports for older/current-at-report versions where adding or
  replacing a credential on an existing Sandbox left a missing or stale
  sentinel. Issue #477 specifically reports replacement failure on 0.38.0;
  it is not evidence that 0.39.0 has the same bug. Registering before a fresh
  Sandbox avoids depending on in-place update behavior.
- Docker tracker issue #348 demonstrates a custom secret failing when it uses a
  built-in service environment-variable name. Its actual reproduction uses
  `OPENAI_API_KEY` on 0.35.0, not `GH_TOKEN`; it supports a general collision
  warning but is **not** an exact GitHub reproduction. Consequently this design
  must not layer `set-custom --env GH_TOKEN` over the built-in `github` service.
- Since 0.37.1, SSH does not forward host credential variables such as
  `GH_TOKEN` unless explicitly configured. This route does not rely on SSH
  environment forwarding; it relies on the built-in service and proxy.

Sources:

- [Docker Sandboxes 0.39.0 release notes — Secrets](https://docs.docker.com/ai/sandboxes/release-notes/#0390)
- [Docker Sandboxes 0.38.0 release notes — Secrets and credentials](https://docs.docker.com/ai/sandboxes/release-notes/#0380)
- [Docker Sandboxes 0.37.1 release notes](https://docs.docker.com/ai/sandboxes/release-notes/#0371)
- [Docker tracker #25: missing GitHub sentinel on an existing Sandbox](https://github.com/docker/sbx-releases/issues/25)
- [Docker tracker #477: stale sandbox-scoped GitHub credential on 0.38.0](https://github.com/docker/sbx-releases/issues/477)
- [Docker tracker #348: custom secret using a built-in variable name](https://github.com/docker/sbx-releases/issues/348)

## Runtime result

The official integration is both documented and proven in the product's real
Runner E2E. The Sandbox authenticated `gh` with the installation token, and
OpenCode used it to inspect the PR and repository context required by the
review. The run's later output-format failure was independent of GitHub
authentication.

Keep this integration unless a future run produces a concrete authentication
regression. If that happens, retain the exact runtime evidence and reassess the
built-in service; do not return to custom-secret collision tuning.
