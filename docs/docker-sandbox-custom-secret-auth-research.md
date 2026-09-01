# Docker Sandbox GitHub authentication decision for issue #99

Research date: 2026-09-01. Scope: Docker Sandboxes 0.39.0 and the current
official documentation. No credential value or private infrastructure detail
was inspected or recorded.

## Decision

Issue #99 uses Docker's sandbox-scoped built-in `github` service. It does not
use Docker custom-secret authentication for `GH_TOKEN`.

For each Job, the Runner writes the short-lived GitHub installation token to a
temporary host-side file and registers the built-in service with a host-side
command that reads that file and `--refresh on-demand`:

```console
sbx secret set github \
  --sandbox SANDBOX_NAME \
  --command 'cat TOKEN_FILE' \
  --refresh on-demand
```

The Runner then creates a fresh Sandbox, allows only the required
`api.github.com` egress, runs the `installation/repositories` GitHub CLI
preflight, and invokes OpenCode only after that preflight succeeds. Terminal
cleanup removes the Sandbox, service registration, network policy, and
host-side token file. A retry, if ever permitted by the surrounding policy,
must use another fresh Sandbox.

If a fresh E2E using this built-in service still fails authentication, stop
issue #99 at that boundary. Record the concrete failure and reassess the
built-in-service integration; do not add a custom-secret workaround or tune
the collision ordering.

## Decisive collision explanation

Docker assigns `GH_TOKEN` and `GITHUB_TOKEN` to its built-in `github` service.
The service supplies a proxy-managed sentinel inside the Sandbox. A custom
secret that also claims `GH_TOKEN` can therefore lose an environment-variable
collision: the Sandbox sends the built-in sentinel rather than the custom
placeholder. A custom rule matches its configured placeholder, so it cannot
replace that different sentinel. The request consequently remains
unauthenticated by the intended repository token.

Docker tracks this exact behavior in its still-open collision issue. The issue
reports that `set-custom` does not install the requested environment value when
`--env` names a built-in service variable, while a control custom variable
works. This is the reason the selected product path avoids custom-secret
`GH_TOKEN` handling entirely.

Sources:

- [Docker: built-in services](https://docs.docker.com/ai/sandboxes/configuration/credentials/#built-in-services)
- [Docker: Authenticate command-line tools — GitHub CLI](https://docs.docker.com/ai/sandboxes/workflows/authentication/#github-cli)
- [Docker: Manage credentials — GitHub token](https://docs.docker.com/ai/sandboxes/configuration/credentials/#github-token)
- [Docker: How credential injection works](https://docs.docker.com/ai/sandboxes/configuration/credentials/#how-credential-injection-works)
- [Docker Sandboxes 0.39.0 release notes — Secrets](https://docs.docker.com/ai/sandboxes/release-notes/#0390)
- [Docker Sandboxes issue #348: custom secrets and built-in variables](https://github.com/docker/sbx-releases/issues/348)

## Lifecycle caveat

Docker documents sandbox-scoped secrets as taking effect immediately, but its
public issue tracker records stale environment/sentinel behavior after secret
updates and restarts. In particular, issues [#25](https://github.com/docker/sbx-releases/issues/25)
and [#477](https://github.com/docker/sbx-releases/issues/477) distinguish
enabling a secret from updating the already-running Sandbox environment.

The clean-break Job lifecycle avoids that uncertainty: registration is
sandbox-scoped, the Sandbox is newly created for the Job, the token command can
refresh on demand during that Job, and all temporary state is removed at
terminal cleanup. No in-place credential rotation is part of issue #99.

Sources:

- [Docker: Manage credentials — sandbox-scoped secrets](https://docs.docker.com/ai/sandboxes/configuration/credentials/)
- [Docker Sandboxes issue #25: GitHub sentinel on existing Sandboxes](https://github.com/docker/sbx-releases/issues/25)
- [Docker Sandboxes issue #477: stale sandbox-scoped GitHub credential](https://github.com/docker/sbx-releases/issues/477)
