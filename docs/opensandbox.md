# OpenSandbox Runner

OpenSandbox is an optional local Docker Engine runtime. It does not require a
Docker vendor account for creating, inspecting or deleting sandboxes. Registry
credentials, if needed for private image pulls, are separate. This backend uses
ordinary Linux containers; it does not provide the sbx VM isolation boundary.

Use OpenSandbox server **1.2.1**, with `opensandbox/execd:release-1.2.1` and
the restricted egress image built below. Runner uses the pinned official JavaScript SDK;
`osb` is optional for operations. Keep the server, Docker Engine and Runner on
the same host. The Runner's Docker CLI must inspect the same daemon the server
uses, because cleanup checks workload containers, egress sidecars and runtime
volumes after the lifecycle API returns.

## Control plane

First build the pinned egress image with OpenSandbox's official operator port
floor. Domain rules alone allow every port at the resolved address; this floor
limits TCP to 80/443, including the credential proxy's upstream connections:

```sh
docker build -f apps/runner/opensandbox-template/egress.Dockerfile -t compte-rendu-egress:1.2.1 .
```

Do not substitute the unrestricted upstream image or mount an empty directory
over `/var/egress/rules`. During acceptance, verify a known listening nonstandard
port on the allowed inference host is inaccessible from a sandbox.

Install the official server in an isolated Python environment and supervise it
separately from Runner. Start from the official Docker configuration, then set:

```toml
[server]
host = "127.0.0.1"
port = 8080
api_key = "<GENERATED_CONTROL_KEY>"
max_sandbox_timeout_seconds = 7200

[runtime]
type = "docker"
execd_image = "opensandbox/execd:release-1.2.1"

[docker]
network_mode = "bridge"
publish_host = "127.0.0.1"
no_new_privileges = true

[egress]
image = "compte-rendu-egress:1.2.1"
mode = "dns+nft"

[storage]
allowed_host_paths = ["<RUNNER_TEMP_DIRECTORY>"]
```

Store the TOML and a separate file containing only the control API key with
mode `0600`. Keep the server bound to loopback. Set Runner's `TMPDIR` to the
allowed temporary directory so its checkout and configuration mounts stay
inside that directory. Sandbox mounts are read-only; model grant files and
checkout authentication helpers are not mounted. Retain the official default
capability restrictions. Do not enable gVisor for this configuration: the
built-in nft egress and credential proxy require compatible network operations.

The Sandbox resource lifetime is pinned explicitly to two hours. That covers the
90-minute review deadline plus teardown and does not scale with
`REVIEW_ATTEMPT_BUDGET_MS`. Relay grants retain their separate four-times
lifetime (currently six hours) and are revoked sooner on normal completion or
cancellation. The Runner still enforces its review and credential deadlines and
explicit destruction; the server TTL is not a substitute for cleanup. Keep
`max_sandbox_timeout_seconds = 7200` on the server.

## Review image

Reuse the plain Ubuntu review image (the directory name reflects its original
OpenShell use). It includes pinned OpenCode and GitHub CLI versions and does not
inherit a Docker sbx image:

```sh
docker build -f apps/runner/openshell-template/Dockerfile -t compte-rendu-review:2.0.32 .
```

The image runs as UID 1000. The Runner's staging files must be readable by that
UID; use the same host UID for Runner, or build the image with the Runner's UID.
Do not make credential files or the staging root world-readable to work around
an identity mismatch.

The optional native test uses the same server and image, creates its own staging
subdirectory, executes the pinned tools, exports evidence, and verifies Docker
cleanup. Set `CR_OPENSANDBOX_NATIVE_PROBE=1`, `CR_OPENSANDBOX_PROBE_STAGE` to the
server-allowed staging directory, `CR_OPENSANDBOX_PROBE_IMAGE` to the image above,
and `OPENSANDBOX_ENDPOINT` / `OPENSANDBOX_API_KEY_FILE`, then run
`pnpm exec vp test tests/opensandbox-live.test.ts`. Run it as the image UID.
Set `CR_OPENSANDBOX_GITHUB_TOKEN_FILE` to a short-lived repository-scoped
read-only token file to include `gh api installation/repositories` through Vault.
The token is read only by the host and is never put in the workload environment.
This is a lifecycle smoke test, not proof of a complete model review.

## Inference endpoint

Use the installation’s dedicated HTTPS inference hostname on port 443. The sidecar Vault supplies the job grant on the scoped inference requests and provides the CA trust used by the workload. Keep certificate verification enabled.

## Runner configuration

Configure the [managed relay environment](llm-service.md#remote-relay-transport) and set:

```dotenv
RUNNER_SANDBOX_RUNTIME=opensandbox
OPENSANDBOX_ENDPOINT=http://127.0.0.1:8080
OPENSANDBOX_API_KEY_FILE=<PRIVATE_CONTROL_KEY_FILE>
OPENSANDBOX_IMAGE=<LOCAL_REVIEW_IMAGE>
RUNNER_SANDBOX_CLI=/usr/bin/docker
```

The host writes the job grant and read-only repository token to the sidecar Vault. The workload uses placeholders.

Runner's systemd `ExecStart` must start only the Runner Node executable. Remove
an sbx-daemon launcher prefix when switching this instance. Preserve its other
environment, claim/callback credentials and maintenance settings. Drain before
changing runtime configuration, and resume only after the new instance passes
its local admission, execution and cleanup checks.

## Cleanup and evidence

The adapter uses an ownership nonce and server-returned identity. It rechecks
ownership before deletion and confirms Docker resources are absent. API success
alone cannot establish cleanup because OpenSandbox may suppress sidecar removal
errors. Uncertain cleanup remains failed and blocks replacement work; never
manually mark it destroyed based only on HTTP 204 or 404.

The authenticated `/maintenance/recover-cleanup` endpoint supports sbx,
microsandbox and OpenSandbox. For OpenSandbox it can confirm recovery after an
operator has removed the exact owned resources. It requires retained authoritative
sandbox identity, ownership nonce and confirmed host-file cleanup; it checks both
the lifecycle API and Docker before reporting recovery to Core. It never deletes
a workload. See [cleanup recovery](operations.md#recover-failed-cleanup) for
requirements and the request procedure. Unknown create identity and incomplete
host-file cleanup cannot be recovered through this endpoint.
A native OpenSandbox acceptance run reviewed a disposable pull request. Core
archived the evidence and published the review at the admitted commit. The run
also verified host-file cleanup and Docker resource absence. The recovery test
uses retained evidence to release a subsequent claim on the same pull request.
A live control-plane restart was tested,
but that does not prove recovery from every intermediate create/delete crash
point.

See [native probe evidence](archive/opensandbox-native-probe.md) for the tested
versions and the distinction between verified behavior and remaining checks.
