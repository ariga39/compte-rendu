# OpenSandbox adapter feasibility — 2026-11-17

Status: research and adapter design input only. Nothing was installed, deployed,
started, committed or run against production. This note is scoped to selecting
and implementing an OpenSandbox adapter on one Linux host. It does not re-survey
Incus/Microsandbox beyond the concrete differences needed for the decision.

Pinned source: `opensandbox-group/OpenSandbox` tag `release-1.2.1`
(commit `db708c218771a8d311356f0e96552c15df6e097a`, release BOM dated 2026-11-13).
Prior findings checked: `docs/archive/sandbox-replacement-2026-11-research.md`.

## Short answer

**The CLI-first path is viable for lifecycle, read-only host staging, file
download and GitHub Credential Vault. It is not viable, as shipped, for the
current `exec` seam's exact foreground exit status or cancellation.**

**The high-port host LLM is the concrete integration blocker.** OpenSandbox's
built-in egress requires Docker `network_mode = "bridge"`. A bridge sandbox
cannot reach the host's `127.0.0.1:<high-port>`, and OpenSandbox does not add
`host.docker.internal` or any host alias to sandbox containers. Credential Vault
also only applies to ports 80/443; extra intercepted ports are not credentialed.
The native egress upstream-proxy option is a chain to an HTTP CONNECT proxy, not
a host-endpoint mapping, and does not remove this blocker. Some host network
change is therefore unavoidable if built-in egress is retained.

The smallest change is to bind the Node LLM on the Docker bridge gateway (or run
it as a container on that bridge) and allow that CIDR plus high port in the
sandbox network policy. That resolves reachability only; it does **not** make
the high-port LLM eligible for Credential Vault, which still matches 80/443
only. That is a host bind/container placement change, not a custom credential
broker. If binding the LLM beyond loopback is unacceptable, OpenSandbox Docker
with built-in egress is not a feasible target without a different host-network
design. A supported reverse-proxy configuration that puts the LLM behind a
standard 443 endpoint could make Vault matching eligible, but that is an
unproven option, not established by the pinned docs and not custom code; do not
assume it works with the LLM's protocol or streaming behavior.

## Facts with citations

### Deployment and auth

- Server is a Python package: `pip install opensandbox-server`; requires Python
  3.10+, Docker Engine 20.10+ for the Docker runtime, on Linux/macOS/WSL2.
  Docker 29.9.1 with `runc` satisfies the documented minimum.
  [installation.md#L15-L30](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/getting-started/installation.md#L15-L30)
- CLI/SDK are separate packages: `pip install opensandbox-cli` and
  `npm install @alibaba-group/opensandbox` (Node 20+ for the JS example). The
  release pins `opensandbox-cli==1.2.1` and `opensandbox==1.2.1`.
  [installation.md#L36-L92](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/getting-started/installation.md#L36-L92),
  [1.2.1.yaml#L87-L100](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/releases/1.2.1.yaml#L87-L100)
- Server config is TOML at `~/.sandbox.toml` (or `SANDBOX_CONFIG_PATH`);
  `opensandbox-server init-config ~/.sandbox.toml --example docker` generates
  the Docker skeleton. Docker runtime needs `[runtime].type = "docker"`,
  `execd_image`, `[egress].image`, and `[docker].network_mode`.
  [configuration.md#L12-L50](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/getting-started/configuration.md#L12-L50)
- Auth is own-key only: set `[server].api_key`; clients send
  `OPEN-SANDBOX-API-KEY`. Empty key means no auth and requires explicit
  `OPENSANDBOX_INSECURE_SERVER=YES` in non-interactive use.
  [configuration.md#L57-L67](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/configuration.md#L57-L67)
- Release images are `docker.io/opensandbox/server`,
  `docker.io/opensandbox/execd` and `docker.io/opensandbox/egress`, all tagged
  `release-1.2.1` with published digests.
  [1.2.1.yaml#L20-L45](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/releases/1.2.1.yaml#L20-L45)
- Docker runtime default network is `host`, but the egress sidecar and
  `networkPolicy` require `bridge`. The sidecar is only attached when the create
  request contains a `networkPolicy`; omitting it starts allow-all behavior.
  [configuration.md#L114](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/getting-started/configuration.md#L114)
  (network policy requirement),
  [configuration.md#L205](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/configuration.md#L205)
  (sidecar only with policy),
  [lifecycle.yml#L2367-L2368](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/specs/sandbox-lifecycle.yml#L2367-L2368)
  (omitted/empty policy = allow-all).
- `host_ip` only rewrites returned bridge-mode endpoint URLs; it is not a
  sandbox `/etc/hosts` entry or an outbound host mapping.
  [configuration.md#L114-L125](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/configuration.md#L114-L125)
- No `ExtraHosts`/host alias is set on sandbox containers. The Docker Compose
  example adds `host.docker.internal:host-gateway` only to the server and SDK
  client services, not to sandboxes.
  [container_ops.py#L415-L506](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/container_ops.py#L415-L506),
  [docker-compose.example.yaml#L56-L74](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/docker-compose.example.yaml#L56-L74)

### Image requirements

- The server injects `execd` and `bootstrap.sh` into the sandbox at
  `/opt/opensandbox`, then starts the container with
  `/opt/opensandbox/bootstrap.sh` as entrypoint and the requested entrypoint as
  command. The sandbox image does not need a baked-in execd, but it needs a
  writable Linux rootfs at `/opt/opensandbox`, `/bin/sh`, and ordinary shell
  tools used by bootstrap (`sed`, `ps` or `/proc`, `rm`, `mkdir`, `touch`,
  `sleep`, `kill`, `command -v`). No broader base-image contract is documented.
  [runtime.py#L34-L45](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/runtime.py#L34-L45),
  [runtime.py#L393-L400](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/runtime.py#L393-L400),
  [container_ops.py#L478-L506](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/container_ops.py#L478-L506),
  [bootstrap.sh#L1-L20](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/components/execd/bootstrap.sh#L1-L20),
  [bootstrap.sh#L695-L716](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/components/execd/bootstrap.sh#L695-L716)
- `execd_image` must match the release (`opensandbox/execd:release-1.2.1`).
  The server pulls that image into a temporary container to extract the binary
  and bootstrap script; this is new host work but not a custom image build.
  [runtime.py#L52-L140](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/runtime.py#L52-L140)

### Commands, streaming, cancellation, exit status

- The execd contract has foreground SSE, background status/log polling,
  `DELETE /command` interrupt, and `execution_complete` with `exit_code: 0` on
  success. Non-zero exits carry `error.exit_code`; a stream ending before a
  terminal event does not establish success.
  [execd.md#L38-L61](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/architecture/data-plane/execd.md#L38-L61)
- The CLI foreground path streams stdout/stderr, but its local exit status is
  only 0 or 1: any `execution.error` calls `sys.exit(1)`, and incomplete
  completion also exits 1. It does not propagate the remote numeric exit code.
  [command.py#L86-L142](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/cli/src/opensandbox_cli/commands/command.py#L86-L142)
- Foreground `command run` never prints an execution id. `command interrupt`
  needs an execution id. There is no local SIGINT handler that calls the remote
  interrupt. Background mode returns an execution id, and status/logs/interrupt
  are separate commands.
  [command.py#L96-L121](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/cli/src/opensandbox_cli/commands/command.py#L96-L121),
  [command.py#L256-L272](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/cli/src/opensandbox_cli/commands/command.py#L256-L272)
- CLI supports literal argv (`--argv`) and a per-command workdir; argv requires
  an execd that accepts argv requests.
  [cli/index.md#L242-L284](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/cli/index.md#L242-L284)
- Consequence for the adapter: CLI foreground can serve setup/preflight commands
  where zero/non-zero is sufficient, but not the agent command if the product
  needs the exact exit code or cancellation. The CLI-native alternative is
  background start + `command status` (exact `exit_code`) + `command logs` +
  `command interrupt`; this changes streaming to polling and needs a probe.

### Upload, download, staging, env, workdir

- `osb file upload` and `file download` exist. For regular files, download is
  staged locally and replaces the destination only after the whole download
  succeeds; interrupt/failure preserves the old file.
  [cli/index.md#L296-L312](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/cli/index.md#L296-L312)
- A single-host read-only host volume can stage checkout/config without upload.
  Volumes support `host.path`, `mountPath`, `readOnly`; `storage.allowed_host_paths`
  must contain the path (or a parent), and an empty allowlist rejects all host
  bind mounts.
  [lifecycle.yml#L2988-L3029](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/specs/sandbox-lifecycle.yml#L2988-L3029),
  [configuration.md#L249](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/configuration.md#L249),
  [sandbox.py#L143](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/cli/src/opensandbox_cli/commands/sandbox.py#L143)
- Env is set at create (`--env`) or via `commands.set_env`; workdir is
  per-command (`-w`) or per-session. There is no adapter-specific upload needed
  for checkout/config if host volumes are used.
  [sandbox.py#L127](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/cli/src/opensandbox_cli/commands/sandbox.py#L127),
  [javascript.md#L250-L310](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/sdks/javascript.md#L250-L310)
- Evidence write-out can use `file download`; directories need an in-sandbox
  archive first (for example a tar produced by `command run`) because the file
  API downloads files, not directory trees.

### Credential Vault, GitHub TLS, and the high-port limit

- Vault requires a sandbox `networkPolicy`, `credentialProxy.enabled`, egress
  `mode = "dns+nft"`, and the egress image. Real values are written to the
  sidecar and are write-only; reads return sanitized metadata.
  [credential-vault.md#L10-L45](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/credential-vault.md#L10-L45),
  [credential-vault.md#L584](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/credential-vault.md#L584)
- Binding matches scheme, host, port, method and path, then injects
  `bearer`/`basic`/`apiKey`/`customHeaders`, or performs exact literal
  substitutions on path/query/header/body with `passthrough`.
  [credential-vault.md#L44](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/credential-vault.md#L44),
  [credential-vault.md#L87-L151](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/credential-vault.md#L87-L151),
  [credential-vault.md#L537-L549](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/credential-vault.md#L537-L549)
- TLS interception is transparent on 80/443; the sidecar exports a CA and
  bootstrap installs it into system/NSS/JDK trust stores best effort.
  `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE` point at
  stable files that are refreshed on rotation.
  [egress.md#L86-L88](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/architecture/network/egress.md#L86-L88)
- **The limit:** ports 80/443 are always intercepted and Vault binding applies
  only to them. Extra ports can be intercepted, but are decrypted/logged and
  **not credentialed**.
  [egress.md#L107](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/architecture/network/egress.md#L107),
  [egress-upstream-proxy.md#L89-L90](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/egress-upstream-proxy.md#L89-L90)
- Therefore GitHub over 443 can use a native Vault binding. A host LLM on a
  high loopback port cannot use Vault substitution. Putting the real
  short-lived job grant in the sandbox environment is **explicitly forbidden by
  the existing design**, so it is not a workable Vault substitute; do not carry
  that claim forward. The real upstream key still stays in the host
  LLM/LiteLLM service.
- Binding or moving the LLM to a reachable high port does not change this
  Vault-port requirement. A supported reverse-proxy configuration that presents
  the LLM on standard port 443 is an **unproven option**, not custom code; it
  would need a probe to establish Vault eligibility and protocol/streaming
  compatibility.
- `[egress.upstream_proxy]` is an administrator-wide HTTP/HTTPS CONNECT proxy
  chain for intercepted traffic; it requires `dns+nft` and transparent
  interception, has no per-request/per-sandbox override, and is not a mapping
  from a sandbox to `127.0.0.1:<port>`. It cannot stand in for the LLM endpoint
  and would add the custom proxy it was meant to avoid.
  [egress-upstream-proxy.md#L10-L22](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/egress-upstream-proxy.md#L10-L22),
  [egress-upstream-proxy.md#L83-L105](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/egress-upstream-proxy.md#L83-L105)

### Host-loopback / high-port LLM: concrete options

Built-in egress and host loopback are mutually exclusive in the current Docker
runtime:

- **`network_mode = "host"`** gives host loopback, but the server explicitly
  rejects `networkPolicy` in host mode. No built-in deny-all egress.
  [networking.py#L177-L188](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/networking.py#L177-L188)
- **`network_mode = "bridge"`** gives built-in egress, but the sandbox cannot
  reach host `127.0.0.1`; no sandbox `ExtraHosts` is configured. Reaching the
  host requires the LLM to listen on the bridge gateway (or be a container on
  that bridge), plus a policy rule for that CIDR/port.
- **User-defined Docker network** is also rejected for `networkPolicy`; only
  `bridge` is accepted. So a dedicated bridge with a separate gateway is not a
  native option for policy-bearing sandboxes.
  [configuration.md#L114](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/getting-started/configuration.md#L114)
- The shipped `example.config.toml` comment says an empty
  `allowed_host_paths` allows all host paths. That comment is stale: the
  validator treats an empty list as "nothing allowed" because the configured
  list is passed as a non-null allowlist. Use explicit prefixes.
  [configuration.md#L249](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/configuration.md#L249),
  [validators.py#L381-L397](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/validators.py#L381-L397)

Smallest acceptable host change: bind the Node LLM to the Docker bridge gateway
address on its high port (or attach it to the default bridge and address it by
container IP/name), then allow `target=<gateway-ip>, ports=[<port>]` in the
sandbox network policy. This keeps the built-in egress and avoids a custom
credential broker or TLS terminator, but it **only solves reachability**. It
does not satisfy Vault's 80/443 binding requirement, and the real job grant must
not be placed in sandbox env. A supported standard-port (443) reverse-proxy
configuration in front of the LLM is an unproven option, not custom code, and is
not assumed to work. Binding the LLM on a high port also exposes it to other
bridge workloads, so the LLM service's existing grant authorization remains the
access control and host firewall scope should be checked. This is a design
option, not a proven deployment.

### Metadata, ownership, ambiguous create

- Every sandbox gets a server-generated UUID; there is no client-supplied name
  or idempotency key. The create schema has metadata/env/etc., but no
  create-once token. A timed-out create followed by a retry can create a second
  sandbox.
  [sandbox_service.py#L56-L58](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/sandbox_service.py#L56-L58),
  [docker_service.py#L615-L622](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/docker_service.py#L615-L622)
- Create metadata becomes Docker labels, including the reserved
  `opensandbox.io/id`; user metadata keys are valid filter keys. List supports
  `metadata` filters, so an owner/job marker can be used for discovery.
  [container_ops.py#L287-L318](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/container_ops.py#L287-L318),
  [lifecycle.yml#L599-L625](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/specs/sandbox-lifecycle.yml#L599-L625)
- Docker metadata patch is persisted to a server-side file, not the container
  label. Set ownership/identity metadata at create, not only by patch, or it is
  lost if the server metadata directory is lost.
  [docker_service.py#L1480-L1501](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/docker_service.py#L1480-L1501)
- Recommended adapter marker set: `cr-job`, `cr-attempt`, `cr-owner` (random
  per attempt). On ambiguity, list by `cr-owner` and destroy only exact
  matching resources; do not infer identity from a name. There is no atomic
  unique constraint, so reconciliation must tolerate duplicates.

### Delete, confirmed destruction, server crash

- Docker delete removes the main container synchronously (`kill`, then
  `remove(force=True)`), then runs sidecar/volume cleanup. The sidecar cleanup is
  explicitly best-effort and swallows failures; managed-volume cleanup logs and
  does not propagate errors.
  [docker_service.py#L1188-L1234](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/docker_service.py#L1188-L1234),
  [networking.py#L456-L488](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/networking.py#L456-L488),
  [volumes.py#L482-L506](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/volumes.py#L482-L506)
- The API says deletion is accepted and runtime cleanup may continue; it returns
  204 while a Kubernetes `Stopping` state may remain. Do not treat 204/404 as
  proof that every host resource is gone.
  [lifecycle.yml#L988-L992](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/specs/sandbox-lifecycle.yml#L988-L992),
  [server.md#L42-L43](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/architecture/control-plane/server.md#L42-L43)
- Startup recovery restores expiration timers for existing containers, expires
  overdue ones, and removes orphan egress sidecars with no matching main
  container. It skips containers with no expiration label; manual-cleanup
  containers are restored without a timer. There is no generic orphan-volume
  sweep or create/delete journal reconciliation.
  [docker_service.py#L458-L545](https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/server/opensandbox_server/services/docker/docker_service.py#L458-L545)
- A crash after container creation but before the response leaves a
  timer-bearing orphan if the create used a TTL; startup will eventually expire
  it. A crash during delete can leave the main container removed but the egress
  sidecar (`label opensandbox.io/egress-sidecar-for=<id>`) or runtime volume
  (`opensandbox-runtime-<id>`) behind. A lifecycle 404 cannot distinguish that
  from full reclamation.
- To confirm destruction honestly, inspect the Docker host after the API path:
  main container `sandbox-<id>` absent, no container with
  `opensandbox.io/egress-sidecar-for=<id>`, and no
  `opensandbox-runtime-<id>` volume. This is read-only resource verification,
  not a new credential/network broker. It is the only defensible confirmation
  found in the pinned source.

## CLI-first adapter fit

| Seam                  | CLI fit                                                                                                                       | Decision                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| create / list / get   | Good. `--file` supports metadata, env, entrypoint, resources, networkPolicy, credentialProxy, volumes. List filters metadata. | Use CLI.                                                                 |
| kill                  | CLI returns `deletion_requested`, not confirmed destruction.                                                                  | CLI + GET poll + host resource check.                                    |
| stage checkout/config | Good via read-only host volume; requires `storage.allowed_host_paths`.                                                        | Use host volume, no upload.                                              |
| env/workdir           | Good: create env, command `-w`, session workdir.                                                                              | Use CLI.                                                                 |
| exec / streaming      | Foreground streams but loses exact exit code and has no execution id/cancel.                                                  | Use background CLI for agent command, or do not claim exact exit/cancel. |
| cancel                | Foreground has no id; background + `command interrupt` works with the id.                                                     | Background path only.                                                    |
| copyOut               | `file download` is atomic for regular files; directories need tar first.                                                      | Use CLI.                                                                 |
| GitHub credential     | Vault + 443 + MITM CA is native.                                                                                              | Use CLI/SDK vault, probe git auth.                                       |
| host LLM              | Not solvable by CLI; it is a network-topology issue.                                                                          | Host bind/container change required.                                     |

The adapter can keep the existing `SandboxCommand` process port and build `osb`
argv instead of adding an HTTP transport. The agent path should be
`osb command run --background -o json`, then parse the execution id from JSON,
poll `osb command status -o json` for `exit_code`, and use `osb command logs`
for output; abort uses `osb command interrupt <id>`. This is a semantic change
from live streaming and needs a behavior probe. If the product requires exact
exit status only for setup commands, foreground `osb command run` is acceptable
there because those paths only compare to zero.

## Prior-note verification

| Prior claim                                                          | Current pinned evidence                                                                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Own API key; empty means insecure                                    | Confirmed.                                                                                                                                                               |
| Egress sidecar only with `networkPolicy`; dns/dns+nft                | Confirmed; omit policy = allow-all.                                                                                                                                      |
| Credential Vault placeholder/broker, secrets outside sandbox         | Confirmed for 80/443; **not** for extra high ports.                                                                                                                      |
| TLS interception only 80/443 by default; extra ports bounded         | Confirmed.                                                                                                                                                               |
| Docker delete 204 while cleanup may continue                         | Refined: Docker removes the main container synchronously; sidecar/volume cleanup is best-effort and errors are swallowed. 204 is not full proof.                         |
| Create/delete crash reconciliation not evidenced                     | Refined: startup restores TTL and expires overdue containers, cleans orphan sidecars; no generic create/delete journal, no orphan volume sweep, no manual-cleanup timer. |
| Expiry-restoration fail-closed startup                               | Confirmed by 1.2.1 release notes and restore code.                                                                                                                       |
| gVisor cannot use egress/Vault; Kata is the supported secure runtime | Confirmed.                                                                                                                                                               |
| Docker default is plain shared-kernel container                      | Confirmed.                                                                                                                                                               |

## Concrete contrast (only blockers)

| Candidate                | Concrete blocker for this product                                                                                                                                                | Relative position                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenSandbox Docker 1.2.1 | Built-in egress requires bridge; host high-port loopback is unreachable; Vault does not credential high ports; delete confirmation needs host inspection; no create idempotency. | Smallest host change is binding the LLM on the bridge gateway, which fixes reachability only; Vault still requires 80/443. Container boundary only. |
| Incus VM                 | No built-in credential broker and no FQDN ACL; requires a host-side credential gateway and FQDN proxy for GitHub egress.                                                         | Avoids the OpenSandbox high-port/Vault coupling but adds the custom plumbing this project wants to avoid. VM boundary.                              |
| Microsandbox             | Beta with documented breaking changes; host-side secret substitution exists.                                                                                                     | Maturity risk; not a production recommendation.                                                                                                     |

OpenSandbox is not uniquely blocked; it is blocked in a different place. If the
decision is "no host bind/network change at all", OpenSandbox Docker with
built-in egress does not fit. If one bridge-gateway bind is acceptable, it has
the least custom credential plumbing for GitHub because Vault handles 443
natively. Incus does not remove the credential/FQDN work. Microsandbox remains a
proof candidate, not a production choice.

## Remaining proof (do not treat as facts)

1. Run `osb command run --background` against a test sandbox; verify exact
   `exit_code`, log cursor behavior, stdout/stderr fidelity, and that
   `interrupt` stops the process. Verify what happens on local SIGINT/kill of
   the CLI foreground process (does the remote command continue?).
2. Create a sandbox with a read-only host checkout/config volume and a
   `networkPolicy`; verify `allowed_host_paths`, mount visibility, and that no
   upload is needed. Verify evidence tar + `file download` atomicity.
3. Bind a test LLM on the Docker bridge gateway and allow its IP+port in
   `dns+nft`; verify a sandbox can reach it while all other egress is denied.
   Confirm this is reachability only and Vault still cannot credential the high
   port. Separately probe whether a supported 443 reverse-proxy path is viable;
   that is unproven, not custom code. If the LLM must stay on `127.0.0.1`,
   confirm the option set is exhausted.
4. GitHub Vault: create a binding for `github.com`/`api.github.com` on 443,
   run the actual git/OpenCode path, and verify certificate trust and auth
   injection. Check whether the client sends its own auth header and whether
   Vault overwrites/conflicts.
5. Ambiguous create: kill the server during create with a TTL, restart, list by
   owner metadata, and confirm eventual expiry. Kill during delete and inspect
   for orphan sidecar/volume; confirm the API 404 alone is insufficient.
6. Image compatibility: run the actual custom sandbox image with injected
   execd/bootstrap; verify `/bin/sh`, writable `/opt/opensandbox`, arch/libc,
   and that the requested entrypoint is preserved. Verify read-only volume
   paths are visible to the Docker daemon (server container vs host).
7. Server restart with a manual/no-TTL sandbox: confirm it is restored without
   a timer and is therefore not automatically cleaned. Do not use no-TTL for
   unreconciled creates.

## Environment note

The task states local Docker 29.9.1 with `runc` and no local KVM, and a separate
`sumire` host with KVM+K3s but no Docker engine CLI. This research shell reports
Docker 29.9.1/runc on host `kuroshio` and also shows `/dev/kvm`; that is a probe
environment discrepancy, not evidence about the target host. Docker runtime
does not require KVM; Kata would. No Docker/K3s state was mutated.
