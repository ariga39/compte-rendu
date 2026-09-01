# Docker Sandbox custom-secret GitHub authentication research

Research date: 2026-09-01. Scope: Docker Sandboxes `sbx` 0.39.0,
Docker's current official documentation, the installed 0.39.0 CLI help, and
Docker's public first-party release/issue repository. No credential value or
private infrastructure detail was inspected or recorded.

## Decision

Do **not** use `sbx secret set-custom --env GH_TOKEN` for GitHub access.
`GH_TOKEN` is already owned by Docker's built-in `github` service, and Docker
has an open bug for custom secrets that reuse a built-in service environment
variable. This explains both the unexpected 40-byte value and the absence of
authenticated GitHub requests: the Sandbox saw the built-in GitHub sentinel,
not the custom placeholder, so the custom replacement rule had nothing to
replace.

Research also found a first-party custom-secret workaround: omit the custom
secret's `--env GH_TOKEN` binding and pass its placeholder explicitly through
`sbx create --env GH_TOKEN=PLACEHOLDER_VALUE`. That workaround is available,
but this product selects the documented sandbox-scoped built-in `github`
service instead. The built-in service owns the GitHub sentinel and header
injection, its dynamic command supports on-demand refresh, and the existing
network policy still limits actual egress to `api.github.com`.

Docker 0.39 does provide a narrow, documented repair. Register only the custom
host/placeholder mapping, then explicitly set that same placeholder at Sandbox
creation:

```console
sbx secret set-custom \
  --sandbox SANDBOX_NAME \
  --host api.github.com \
  --placeholder PLACEHOLDER_VALUE \
  --command 'HOST_COMMAND_THAT_PRINTS_THE_TOKEN'

sbx create \
  --name SANDBOX_NAME \
  --env GH_TOKEN=PLACEHOLDER_VALUE \
  ...
```

`sbx create --env` is a 0.39 feature, and the CLI states that it sets an
environment variable in the Sandbox. This avoids the broken custom-secret
environment side effect while retaining the exact `api.github.com` proxy
scope. Only the placeholder enters the VM. Docker's own maintainer example
demonstrates that the proxy changes
`Authorization: Bearer PLACEHOLDER_VALUE` into
`Authorization: Bearer <resolved value>`.

This documents an available workaround for a separate experiment; it is not
evidence that the current binary works and is not the product path for issue 99. The product uses the documented sandbox-scoped built-in `github` service
instead of adding another custom-secret retry or workaround.

Sources:

- [Docker maintainer's custom-header replacement example](https://github.com/docker/sbx-releases/issues/7#issuecomment-4289738203)
- [Docker Sandboxes 0.39.0 release](https://github.com/docker/sbx-releases/releases/tag/v0.39.0)
- Installed `sbx` 0.39.0 help: `sbx create --help`

## What the custom-secret command promises

For this shape of command, registered before Sandbox creation:

```console
sbx secret set-custom \
  --sandbox SANDBOX_NAME \
  --host api.github.com \
  --env GH_TOKEN \
  --placeholder PLACEHOLDER_VALUE \
  --command 'HOST_COMMAND_THAT_PRINTS_THE_TOKEN'
```

the documented contract is:

1. `GH_TOKEN` inside the Sandbox must be the exact literal
   `PLACEHOLDER_VALUE`. Random expansion happens only when the placeholder
   includes `{rand}`. The real command output must not appear in the Sandbox.
2. The host executes the command through its shell, trims standard output,
   and uses that result as the secret. Registration verifies the command by
   default. Dynamic custom secrets resolve on demand by default.
3. For a request to exactly `api.github.com`, if the placeholder occurs in a
   request header, the proxy replaces that substring with the resolved real
   value. Consequently, an Authorization header containing a scheme plus the
   placeholder should retain its scheme and send the real value in place of
   the placeholder.
4. No replacement is promised for another hostname unless another `--host`
   is registered. `api.github.com` does not cover `github.com` or
   `raw.githubusercontent.com`.

Docker's prose documentation goes further and says a custom placeholder found
“anywhere in the request” is replaced, while the 0.39 CLI help specifically
describes replacement in request headers. The narrower header behavior is all
that GitHub CLI authentication needs, so this wording difference does not
explain the failure.

Sources:

- [Docker: Manage credentials — Custom secrets](https://docs.docker.com/ai/sandboxes/configuration/credentials/#custom-secrets)
- [Pinned Docker CLI reference source for `sbx secret set-custom`](https://github.com/docker/docs/blob/e22ec2bc07a2451e16b638f34bedeb4d9ee4625b/data/sbx_cli/sbx_secret_set-custom.yaml)
- [Docker maintainer's all-header replacement demonstration](https://github.com/docker/sbx-releases/issues/7#issuecomment-4289738203)
- Installed `sbx` 0.39.0 help: `sbx secret set-custom --help`

## The 40-byte value is the built-in GitHub sentinel

Docker's built-in services table assigns both `GH_TOKEN` and `GITHUB_TOKEN` to
the `github` service. That service covers `api.github.com`, `github.com`,
`raw.githubusercontent.com`, `gist.github.com`, and GitHub Copilot hosts.
Docker's documented setup is an explicit `sbx secret set github`; it is not
automatic host credential sharing.

Docker's public issue tracker records the built-in GitHub environment value as
a 40-byte, `gho_`-shaped proxy-managed sentinel. The installed 0.39.0 binary
contains the same sentinel. Therefore an unexpected 40-byte `GH_TOKEN` is
positive evidence that the built-in OpenCode/GitHub credential wiring won the
environment-variable collision. It is not evidence that the real token entered
the Sandbox, and it is not the literal custom placeholder requested on the
command line.

That distinction matters to replacement. A custom-secret rule replaces its
own configured placeholder. If `gh` sends the different built-in sentinel,
the custom rule cannot match it. Without a configured built-in `github`
credential behind that sentinel, the request is not authenticated by the
intended repository token.

Sources:

- [Docker: built-in services](https://docs.docker.com/ai/sandboxes/configuration/credentials/#built-in-services)
- [docker/sbx-releases #231: built-in GitHub sentinel shape](https://github.com/docker/sbx-releases/issues/231)
- Installed `sbx` 0.39.0 binary strings, used only to confirm the public
  sentinel and its length; the Docker Sandboxes implementation repository is
  not publicly readable.

## Docker already tracks the exact collision

Docker's still-open issue
[#348](https://github.com/docker/sbx-releases/issues/348) reports that
`set-custom` does not install the requested environment value when `--env`
uses a built-in service variable. A control custom variable worked, while
`OPENAI_API_KEY` did not; making it global and recreating the Sandbox did not
fix it. `GH_TOKEN` is the same class of built-in variable according to
Docker's services table.

The issue was reported against 0.35.0 and remains open. The latest stable
release is 0.39.0, and its release notes add dynamic `--command` sources but
do not claim a fix for the built-in-variable collision. The installed binary
is exactly `v0.39.0 def8cb0523a77e757bdd6ef52b459fe374f3783e`.

This is a materially better explanation than either “the Worker did not send
a token” or “GitHub CLI ignored `GH_TOKEN`”: the Runner registered a dynamic
source, but Docker selected a different sentinel before `gh` made the request.

Sources:

- [docker/sbx-releases #348](https://github.com/docker/sbx-releases/issues/348)
- [Docker Sandboxes 0.39.0 release notes — Secrets](https://docs.docker.com/ai/sandboxes/release-notes/#0390)
- Installed CLI: `sbx version`

## Credential acquisition and precedence

Docker Sandboxes do not automatically copy a host's GitHub CLI login or
user-level agent configuration into a Sandbox. The official GitHub workflow
requires explicitly registering the `github` service. With `--command`, the
daemon runs the configured host command and injects the resolved value through
the proxy; the VM sees only a sentinel.

The documented precedence rules are limited:

- for the same service, a stored secret takes precedence when more than one
  source has a value;
- in a kit that declares both API-key and OAuth authentication, the API key
  takes precedence and OAuth is the fallback;
- a sandbox-scoped entry targets one Sandbox, while a global entry is copied
  into future Sandboxes.

Docker does **not** document precedence between a custom secret and a built-in
service when both claim the same environment variable and host. The open bug
shows that relying on this collision is unsafe. Do not attempt to tune the
ordering.

GitHub CLI independently documents that `GH_TOKEN`, then `GITHUB_TOKEN`, take
precedence over credentials previously stored by `gh auth`. Therefore an
explicit create-time `GH_TOKEN=PLACEHOLDER_VALUE` is sufficient for `gh`; no
GitHub login state needs to be mounted or copied into the Sandbox.

Sources:

- [Docker: How credential injection works](https://docs.docker.com/ai/sandboxes/configuration/credentials/#how-credential-injection-works)
- [Docker: Services declared by kits](https://docs.docker.com/ai/sandboxes/configuration/credentials/#services-declared-by-kits)
- [Docker OpenCode guide — Configuration](https://docs.docker.com/ai/sandboxes/agents/opencode/#configuration)
- [Docker: Authenticate command-line tools](https://docs.docker.com/ai/sandboxes/workflows/authentication/)
- [GitHub CLI: environment variables](https://cli.github.com/manual/gh_help_environment)

## Existing versus new Sandboxes

Docker documents global secrets as creation-time input: setting or changing a
global secret does not update an existing Sandbox, so it must be recreated.
Docker says a sandbox-scoped secret takes effect immediately, even for a
running Sandbox.

The public issue tracker shows that the immediate-update statement is not
fully reliable:

- [#25](https://github.com/docker/sbx-releases/issues/25) records missing
  GitHub sentinel environment values on an existing Sandbox. A Docker member
  clarified that setting a secret enabled injection but did not update the
  environment variable.
- [#477](https://github.com/docker/sbx-releases/issues/477), against 0.38.0,
  records a sandbox-scoped GitHub credential remaining stale after an update
  and restart; only deletion and recreation picked up the new token. A Docker
  member again distinguished the secret update from the sentinel environment
  side effect.

The product's clean-break lifecycle avoids this uncertain path: register the
sandbox-scoped built-in `github` service first, then create a brand-new
Sandbox, and never rotate or retrofit the credential in place. A retry must use
another fresh Sandbox.

## Why the built-in service is selected

Docker's documented built-in flow is:

```console
sbx secret set github \
  --sandbox SANDBOX_NAME \
  --command 'HOST_COMMAND_THAT_PRINTS_THE_TOKEN' \
  --refresh on-demand
```

The host-side command only has to print a current token; neither Docker nor the
Sandbox receives a GitHub App private key. The built-in service owns the
environment and request wiring, while the Runner's existing network policy
continues to restrict actual GitHub egress to `api.github.com`.

The create-time custom-secret workaround remains a documented fallback for a
separate experiment, not a product path. It retains the experimental custom
secret surface and its known collision history, so no further custom-secret
workaround is added here.

Sources:

- [Docker: Authenticate command-line tools — GitHub CLI](https://docs.docker.com/ai/sandboxes/workflows/authentication/#github-cli)
- [Docker: Manage credentials — GitHub token](https://docs.docker.com/ai/sandboxes/configuration/credentials/#github-token)
- [Docker Sandboxes 0.39.0 release notes — CLI](https://docs.docker.com/ai/sandboxes/release-notes/#0390)
- Installed `sbx` 0.39.0 help: `sbx create --help`

Custom secrets are explicitly experimental, and Docker warns that their
behavior, flags, and placeholder format may change without notice. Keeping the
failed implicit-environment path would therefore be building on both an
experimental API and a known open collision. There is a basis for the one
explicit create-time repair above, but no basis for a chain of further
custom-secret workarounds if it fails.
