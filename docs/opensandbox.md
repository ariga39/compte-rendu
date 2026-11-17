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

The maximum sandbox lifetime must accommodate four `REVIEW_ATTEMPT_BUDGET_MS`
intervals (currently two hours). The Runner still enforces its review deadline
and explicit destruction; the server TTL is not a substitute for cleanup.

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
This is a lifecycle smoke test, not proof of a complete model review.

## Private inference endpoint

Credential Vault injects secrets only on ports 80 and 443 and requires FQDN
bindings. The existing loopback high-port Node LLM service therefore needs a
private standard-port reverse proxy. Give each instance its own private DNS
name resolving to an address reachable from the Docker bridge. Keep the Node
service's control Unix socket and inference listener unchanged.

For example, an existing nginx can serve this scoped private listener:

```nginx
server {
    listen <DOCKER_BRIDGE_GATEWAY>:80;
    server_name <PRIVATE_LLM_FQDN>;
    client_max_body_size 0;
    location /v1/ {
        proxy_pass http://127.0.0.1:<INSTANCE_LLM_PORT>;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 2h;
        proxy_send_timeout 2h;
    }
}
```

The authenticated Node service retains its request-size and route limits. The
proxy does not contain provider keys or job grants. Bind it only to the private
interface; do not replace an existing public listener. Use ordinary working DNS
for the private name, not an agent-visible hosts-file workaround. Vault handles
HTTPS certificate interception and supplies its CA trust to sandbox processes;
do not disable certificate verification.

## Runner configuration

Configure the [host LLM service](llm-service.md) first, then set:

```dotenv
RUNNER_SANDBOX_RUNTIME=opensandbox
OPENSANDBOX_ENDPOINT=http://127.0.0.1:8080
OPENSANDBOX_API_KEY_FILE=<PRIVATE_CONTROL_KEY_FILE>
OPENSANDBOX_IMAGE=<LOCAL_REVIEW_IMAGE>
RUNNER_SANDBOX_CLI=/usr/bin/docker
RUNNER_LLM_SERVICE_SOCKET=<INSTANCE_CONTROL_SOCKET>
```

Keep the existing `REVIEW_MODEL_CONFIG` model definition and change its
`baseUrl` to `http://<PRIVATE_LLM_FQDN>/v1` (or HTTPS on 443). Direct-provider
secret resolver mode is not supported by this backend. Both single-model and
multi-model jobs use the same host service and per-job grants. Agents see only
placeholders; the host writes the real model grant and read-only repository
token to the sidecar Vault.

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

The existing `/maintenance/recover-cleanup` endpoint currently supports sbx
only. OpenSandbox recovery after a failed cleanup requires operational resource
inspection; automatic recovery reporting is not implemented in this slice.
[Issue #233](https://github.com/ariga39/compte-rendu/issues/233) tracks recovery
and full Runner-to-Core acceptance required before production cutover.
A live control-plane restart was tested, but that does not prove recovery from
every intermediate create/delete crash point.

See [native probe evidence](archive/opensandbox-native-probe.md) for the tested
versions and the distinction between verified behavior and remaining checks.
