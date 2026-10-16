# Agent sandbox alternatives to Docker Sandboxes (sbx 0.39)

Research date: 2026-10-16. Scope: official documentation and repositories only.
No production changes or package installs were performed. This note compares
Google-led Agent Substrate, Kubernetes Agent Sandbox, NVIDIA OpenShell and
OpenSandbox, with a brief self-host suitability read of E2B and Daytona.
Documentation support is not evidence of compatibility or performance on our workload.

Version note (corrected 2026-10-16): the deployed baseline was Docker Sandboxes
`sbx` 0.39, and the project now targets `sbx` **0.48.0** (released 2026-10-13)
after issue #157. Where this note contrasts "sbx 0.39" capabilities it means the
pre-upgrade baseline, not the current stable release.

Question this note answers: is there a newer agent-sandbox runtime with a
simpler, more stable lifecycle and better resource density than Docker Sandboxes
`sbx` 0.39, with isolation proportionate to this review workload? Facts are labelled; inferences are marked
**Inference** and tied to the fact that supports them.

## Recommendation for this project

**Inference:** OpenShell is the first candidate for a bounded single-host trial;
Agent Substrate is the more interesting longer-term option for multiplexing many
mostly-idle agents. Neither is established as more reliable than sbx by this
research. OpenSandbox is a second practical candidate, especially if an API/SDK
and Kubernetes deployment are desired. E2B and Daytona add more platform than
this small review service presently needs.

Hardware-backed isolation is not an acceptance requirement merely because sbx
currently provides it. This service runs a trusted, pinned reviewer against
untrusted repository content with static-only tool permissions; it does not
intentionally execute repository programs, install dependencies or run tests.
Prompt injection and tool/runtime vulnerabilities remain relevant, but that does
not establish that a microVM is necessary. Evaluate a hardened container first:
non-root, restricted capabilities/syscalls, no host Docker socket or sensitive
mounts, bounded resources, outside-workload credentials and enforced egress.
Choose gVisor or a microVM only where the remaining host-kernel exposure or a
broader future execution policy justifies its compatibility and operating cost.
OpenShell's container driver is therefore a valid primary candidate, not a
fallback rejected for differing from sbx. gVisor is a separate userspace-kernel isolation design, not ordinary
runc and not hardware virtualization. Its default systrap platform needs no KVM;
that fact alone does not prove Bun/OpenCode compatibility or lower memory use.
See [gVisor platforms](https://gvisor.dev/docs/architecture_guide/platforms/).

A meaningful trial uses the same OpenCode/gh versions, immutable PR revisions,
model route and review contract. Measure host/cgroup memory and CPU at equal
concurrency, startup latency and full completion time. Verify real credentials
stay outside the workload, unapproved egress is denied, all raw evidence survives
before deletion, and killing the supervisor/backend yields an observable failure
with confirmed cleanup. An accepted delete request is insufficient. Preserve the
Core ownership, same-PR exclusion and publication rules across any backend change.

No candidate was installed or benchmarked here. Published density/startup numbers
are not measurements of this review service. Replacing a runtime also cannot
retroactively establish why an old daemon exited; process supervision and exit
records are required whichever backend is selected.

## Google-led Agent Substrate

The newer Google-led project is [Agent Substrate](https://github.com/agent-substrate/substrate).
Google describes its relationship to Agent Sandbox in its
[May 2026 announcement](https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate).
Repository snapshot: `5d7a89070fabee769656d23877353b29c98777b8`.

- Runs on Kubernetes, mapping logical stateful actors onto a pool of workers.
  Supports gVisor or Kata/Cloud Hypervisor microVMs; plain Linux containers are
  not supported. The microVM path still requires KVM.
- Snapshots and suspends idle actors, then resumes them on available workers.
  Density claims concern multiplexing idle actors, not a proportional increase
  in actively executing reviews. The current OpenCode streaming invocation has
  not been tested for safe suspension/resumption.
- Trusted egress gateway injects credentials outside the sandbox. The built-in
  provider can resolve Kubernetes Secrets under namespace policy. HTTP/HTTPS
  egress is mediated; the documented protocol table currently blocks WebSockets,
  generic CONNECT and other TCP. Our HTTPS model/GitHub path needs a real test.
- Adds API/controller/node/worker components, routers/egress, PostgreSQL and
  snapshot object storage. The local quickstart includes PostgreSQL and RustFS.
  This is materially more infrastructure than a single sbx daemon.
- Explicitly pre-1.0 without backwards-compatibility guarantees. The security
  status table still lists authorization/quotas and telemetry gaps; do not read
  architecture goals as fully implemented guarantees.
- Worker eviction requires harness participation: on SIGTERM the actor must
  request suspension; Substrate does not automatically do that for it. The
  documented grace period can also be shortened by the node termination budget.

Sources at the inspected revision:

- [README](https://github.com/agent-substrate/substrate/blob/5d7a89070fabee769656d23877353b29c98777b8/README.md)
- [Security status](https://github.com/agent-substrate/substrate/blob/5d7a89070fabee769656d23877353b29c98777b8/docs/security.md)
- [Credential injection](https://github.com/agent-substrate/substrate/blob/5d7a89070fabee769656d23877353b29c98777b8/docs/egress-credential-injection.md)
- [Egress protocols](https://github.com/agent-substrate/substrate/blob/5d7a89070fabee769656d23877353b29c98777b8/docs/egress-traffic.md)
- [API and eviction contract](https://github.com/agent-substrate/substrate/blob/5d7a89070fabee769656d23877353b29c98777b8/docs/api-guide.md)

**Inference:** promising for a future large population of persistent agents;
the deployment and harness work are hard to justify solely to replace a few
short-lived review sandboxes on one host.

## Kubernetes SIG Apps Agent Sandbox

[Agent Sandbox](https://github.com/kubernetes-sigs/agent-sandbox) is the other
Google-associated project the user may remember. Snapshot:
`7fd162d9d5c33fd0c8af9fbb15c6453ccf5ddd58`.

- A Kubernetes controller and CRDs: Sandbox, SandboxTemplate, SandboxClaim and
  SandboxWarmPool. It manages Pod lifecycle, stable identity/storage and pools.
- It is an orchestration layer, not an isolation runtime. Configure a gVisor or
  Kata RuntimeClass to obtain those boundaries; a plain Pod is not a microVM.
- Template-managed NetworkPolicy permits public Internet egress while blocking
  private/metadata networks by default. That is broader than this project's
  narrow model/GitHub allowlist. A credential gateway and stricter egress policy
  still need integration.
- Template defaults disable service-account-token mounting; bare Sandboxes need
  operator enforcement. The router's default AllowAll authorizer also needs
  deliberate deployment configuration.

Sources: [README](https://github.com/kubernetes-sigs/agent-sandbox/blob/7fd162d9d5c33fd0c8af9fbb15c6453ccf5ddd58/README.md),
[threat model](https://github.com/kubernetes-sigs/agent-sandbox/blob/7fd162d9d5c33fd0c8af9fbb15c6453ccf5ddd58/docs/security/threat_model.md).

**Inference:** useful if Kubernetes is already the intended operating model;
less complete as a direct replacement for sbx's agent-specific credential proxy.
Kubernetes reconciliation does not replace our terminal callback, evidence,
confirmed destruction or exactly-once publication requirements.

## Method and version pins

- Primary sources only: vendor documentation sites, repository `main` at the
  date, release notes, Atom release feeds.
- Versions pinned at time of writing:
  - OpenShell docs `v0.1.4` (default); stable `v0.1.4` (2026-10-13);
    `v0.1.5-pre.3` (2026-10-15); rolling `dev`.
  - OpenSandbox `release-1.1.1` (2026-10-09) and `release-1.2.0-rc.1`
    (2026-10-15); Kubernetes chart support v1.21–v1.34.
  - E2B `e2b-dev/runtime` `main`; Daytona `v0.190.0`.

## Comparison at a glance (observed facts)

| Dimension                     | Docker `sbx` 0.39 (baseline)         | NVIDIA OpenShell                                                      | OpenSandbox                                                                |
| ----------------------------- | ------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Default isolation             | KVM microVM per sandbox              | **Container** (Docker/Podman), not a VM                               | **Container** (`runc`), not a VM                                           |
| Strongest isolation available | microVM (KVM)                        | MicroVM driver (libkrun; KVM on Linux)                                | gVisor, Kata (QEMU/CLH/FC); Fast Sandbox Firecracker                       |
| KVM required?                 | Yes                                  | **No** for Docker/Podman; Yes only for MicroVM                        | **No** for runc/gVisor; **Yes** for Kata/Firecracker                       |
| Credential model              | Host-side proxy substitutes sentinel | Placeholder in sandbox; supervisor/proxy injects at approved endpoint | Fake/empty value in sandbox; egress sidecar MITM injects header            |
| Network allowlist             | Supported                            | Default-deny; L7 per host/method/path through proxy                   | Default-deny; FQDN/IP/CIDR via egress sidecar (DNS + nftables)             |
| Control plane                 | Detached `sbx` daemon                | Gateway (systemd user service; SQLite or PostgreSQL)                  | Lifecycle server + controller + ingress gateway (K8s)                      |
| Typical deploy                | Single host                          | Single host (Docker/Podman) or K8s                                    | Local Docker (Python) or Kubernetes                                        |
| Evidence APIs                 | Sandbox logs                         | CLI/TUI logs; OCSF JSONL; Prometheus; OTLP (pre)                      | Diagnostic logs/events API; OTel metrics; node-agent collection (maturing) |
| Maturity                      | Shipping product                     | **0.1.x**, weekly stable cadence                                      | **1.1.x stable**, 1.2.0-rc                                                 |
| License                       | Proprietary product                  | Apache-2.0                                                            | Apache-2.0                                                                 |

**Inference.** OpenShell's container driver and OpenSandbox's runc path remove
the KVM dependency on Linux. That can simplify deployment and may improve
resource density; measure the actual benefit. They expose a different isolation
boundary, which must be assessed against the workload rather than automatically
classified as unacceptable. gVisor adds a userspace kernel and is distinct from
ordinary runc containers. Hardware isolation remains an optional choice.

---

## NVIDIA OpenShell

Repository `github.com/NVIDIA/OpenShell`, Apache-2.0. Docs default `v0.1.4`;
stable tags ship weekly, with `v0.1.5-pre.3` in qualification on 2026-10-15.

### Runtime isolation (observed)

- OpenShell uses "overlapping controls rather than a single sandbox primitive":
  Landlock filesystem restriction, non-root process identity, seccomp (including
  seccomp user-notification for network mediation), a network namespace that
  forces egress through a local CONNECT proxy, and an L7 policy proxy that
  checks destination, calling binary, TLS/L7 rules, SSRF, and endpoint-bound
  credential injection (`architecture/sandbox.md`, docs `/about/architecture`).
- Four compute drivers, one per gateway: **Docker**, **Podman**,
  **Kubernetes**, **MicroVM** (`how-it-works/sandboxes/runtimes`).
  - Docker/Podman: supervisor in its own container; workload container has
    networking turned off; traffic over an authenticated Unix socket.
  - Kubernetes: supervisor pod; NetworkPolicy allows only the supervisor
    service; requires the `kubernetes-sigs/agent-sandbox` controller.
  - MicroVM: `libkrun`-based; guest has no network interface; vsock; requires
    KVM on Linux or Hypervisor.framework on macOS.
- Host kernel requirements are strict: Landlock LSM ABI 3+ (Linux 6.2+), nested
  seccomp user-notification filters and `SECCOMP_IOCTL_NOTIF_ADDFD` with
  `SECCOMP_ADDFD_FLAG_SEND`, task-memory read, and `SO_BINDTODEVICE` socket
  binding. Launch fails closed if a probe fails (`about/support-matrix`).
- The Kubernetes driver can opt into a stronger runtime class, e.g.
  `runtimeClassName: kata-containers`, via `--driver-config-json` or policy.

### KVM need (observed)

- Docker, Podman, and Kubernetes drivers do **not** require KVM. Only the
  MicroVM driver does ("Host virtualization … KVM on Linux"), and it is
  **never auto-detected** (`runtimes`, `about/support-matrix`).
- Default install auto-detects Kubernetes, then Podman, then Docker.

### Credentials (observed)

- The agent never sees real credential values. The supervisor replaces each
  provider credential with an opaque placeholder in the agent environment; the
  proxy resolves it only for requests that pass both the network policy and the
  credential endpoint binding, else fails closed with HTTP 403
  (`credential_endpoint_mismatch`) (`how-it-works/providers/overview`).
- A `--from-existing` / `--credential` flow stores secrets gateway-side;
  refresh supports OAuth2 client-credentials/refresh tokens, Google service
  account JWTs, and AWS STS (`provider refresh`).
- There is an operator-only `GetProviderCredentials` RPC that **does** export
  real values outside sandbox enforcement; docs warn to keep it out of logs and
  note ordinary users and OIDC admins cannot call it.

### Network allowlist (observed)

- Default-deny egress. The mediated supervisor channel is the workload's only
  allowed egress path; the outer fence denies everything else including DNS and
  private addresses. Network rules evaluate destination, binary identity, TLS/L7
  rules, SSRF, and method/path. Network policy is hot-reloadable; filesystem and
  process policy are locked at creation.
- A policy prover does formal verification of proposed rule changes before they
  are applied.

### Deployment dependencies (observed)

- Supported hosts: Linux (Debian/Ubuntu) x86_64/arm64, macOS Apple Silicon;
  Windows/WSL2 experimental. CLI is a static musl binary; gateway needs
  glibc 2.28+.
- Docker Engine/Desktop 28.0+, or Podman 5.x (rootless, cgroups v2), or
  Kubernetes 1.29+ with Helm 3 and the Agent Sandbox controller.
- Local gateway runs as a systemd **user** service at `127.0.0.1:17670`
  (linger to survive logout); SQLite by default, PostgreSQL for Kubernetes HA.

### Lifecycle and evidence (observed)

- Operations: `sandbox create|connect|exec|upload|download|stop|start|delete`,
  `--no-keep` ephemeral runs, restart policies, templates, labels, service
  exposure, port forwards. Phases include `Provisioning`, `Ready`,
  `Completed`, `Error`; image-prep deadline defaults to 1800 s and admission
  repair to 300 s. Delete is asynchronous ("deletion accepted").
- Supervisor loss freezes the agent; the documented reconnect path requires
  the same supervisor process, not a replacement supervisor. Supervision therefore
  still needs failure/cleanup testing; it is not transparent crash recovery.
- Evidence: `openshell logs` / TUI shorthand; OCSF JSON export to stderr and to
  `/var/log/openshell-ocsf.*.jsonl`; gateway JSONL sink; OCSF v1.8.0 native with
  downgrade to 1.1/1.3 for SIEMs; Prometheus gateway metrics; OTLP OCSF export
  added in `v0.1.5-pre.1`. Docs state collection is **best-effort**, not a
  complete audit history.
- Marked-Experimental surfaces exist (e.g. driver config, middlewares), and
  stable-interface compatibility is defined by RFC 0014.

---

## OpenSandbox (Alibaba / `opensandbox-group/OpenSandbox`)

Repository moved from `alibaba/OpenSandbox` to `opensandbox-group/OpenSandbox`;
Apache-2.0; ~11.8k stars; created 2025-12-17. Stable `release-1.1.1`
(2026-10-09); `release-1.2.0-rc.1` (2026-10-15). Listed in the CNCF Landscape;
OpenSSF Best Practices badge.

### Runtime isolation (observed)

- The lifecycle server (`opensandbox-server`) targets a **Docker or Kubernetes**
  runtime; the default OCI runtime is `runc`, i.e. process-level cgroup
  isolation — a container, not a VM (`server/configuration.md`,
  `docs/guides/secure-container.md`).
- `[secure_runtime]` is an **opt-in, server-level** profile; all sandboxes on
  that server use it. Options: `gvisor` (`runsc`), `kata` (QEMU), `firecracker`
  (Kata + Firecracker, Kubernetes-only). Docker mode supports gVisor and Kata;
  Firecracker is Kubernetes-only. The server validates the runtime at startup
  and refuses to start if unavailable.
- Fast Sandbox is a separate backend: Firecracker microVMs in pre-warmed
  "Fastlet" pods, selected by template, on **KVM-capable nodes**.
- **Important interaction:** the egress sidecar is incompatible with gVisor
  (gVisor's netstack lacks the `nat` table; the DNS redirect fails). The server
  rejects `secure_runtime.type = "gvisor"` together with `network_policy`. Docs
  direct users to Kata for network isolation. So gVisor gives stronger-than-runc
  isolation but **cannot** carry the allowlisted-egress + Credential Vault path.

### KVM need (observed)

- `runc` and gVisor: no KVM. Kata (QEMU/CLH/Firecracker) and Fast Sandbox:
  hardware virtualization/KVM required.

### Credentials (observed)

- Credential Vault is implemented by the **egress sidecar**, which terminates
  TLS (mitmproxy) and injects auth headers; the sandbox sees fake/empty values.
  Requires `[egress].mode = "dns+nft"`, a `networkPolicy` with
  `defaultAction="deny"`, and `credentialProxy.enabled`. Auth types: bearer,
  basic, apiKey, customHeaders, passthrough + scoped substitutions. Readback is
  sanitized; values are write-only and redacted.
- Vault entries are **in-memory in the sidecar**: a Kubernetes pause deletes the
  Pod, so the fresh sidecar starts empty and credentials must be re-injected on
  resume. Fast-sandbox adds a per-sandbox `emptyDir` vault file.
- Also incompatible with a transparent service-mesh sidecar (Istio/Envoy) in the
  same pod.

### Network allowlist (observed)

- Egress sidecar shares the sandbox network namespace; every outbound packet
  passes it. Layer 1 DNS proxy (denied domains → NXDOMAIN); Layer 2 nftables
  default-deny with DNS-learned leased addresses. Rules allow by domain,
  wildcard, IP, or CIDR; operators can set `deny.always`/`allow.always` floors
  and a reachable-ports cap. Startup is fail-closed: if enforcement cannot be
  installed the sidecar exits rather than passing traffic.
- Docker `networkPolicy` requires `network_mode = "bridge"`; it is rejected for
  `none`/`pasta`/`slirp4netns`.

### Deployment dependencies (observed)

- Local: Docker + Python 3.10+ (`uvx opensandbox-server init-config`).
- Kubernetes 1.21.1+: CRDs + RBAC (`base`), controller, **ingress gateway
  (required on K8s; pods are ClusterIP-only)**, lifecycle server, optional
  node agent, optional fast-sandbox. Charts install from a `release-X.Y.Z`
  checkout; standalone chart packages are not published.
- SQLite default; PostgreSQL supported; **single-active server** is the default
  (general multi-replica HA is on the roadmap, not shipped).

### Lifecycle and evidence APIs (observed)

- Lifecycle REST `/v1`: create/list/get/delete, `pause`/`resume`,
  `snapshots`, `templates`, `renew-expiration`, `PATCH metadata`, endpoint
  resolution, and `GET/PUT/PATCH/DELETE .../networkpolicy`. States:
  `Pending → Running → Pausing → Paused → Stopping → Terminated`, plus `Failed`.
- **Diagnostic API**: `diagnostics/context`, `diagnostics/logs`,
  `diagnostics/events` return inline content or a download URL. The spec
  explicitly says it is **not** a structured audit/observability model; SDKs do
  not download URLs.
- execd API inside each sandbox: command/code execution (SSE streaming), file
  ops, metrics. Egress API exposes `/policy` and `/credential-vault`.
- Observability is maturing: OTel metrics across components; node-agent
  stdout/stderr collection (at-least-once) is "implementing"; eBPF audit is
  experimental; a structured agent in-sandbox audit trail is "planned".
- Snapshots/pause/resume are implemented/maturing (OSEP-0008); lifecycle API
  stability is an ongoing goal with **no stable v1 commitment**.

---

## E2B (brief self-host read)

- Repository `e2b-dev/runtime`, Apache-2.0. One **Firecracker microVM per
  sandbox**, in its own cgroup/network namespace, per-sandbox nftables egress
  firewall with SNI/Host allow/deny lists. Requires Linux with **KVM**.
- Self-host options: **E2B Embed** runs the whole stack on a single Linux host
  (Docker Compose, or Terraform on GCP/AWS/Azure, or one Kubernetes node); it
  bundles the control plane, orchestrator, template builder, dashboard, and
  telemetry, and depends on PostgreSQL, Redis, ClickHouse, and object storage.
  Same SDK/API as E2B Cloud; no license key. Embed is "one machine by design."
- Credentials: secrets are metadata-only on the control plane; workload identity
  issues short-lived tokens; a self-run SOCKS5 proxy and short-lived OIDC
  identity tokens are **private beta**, and the proxy fails closed.
- Evidence: OpenTelemetry throughout; sandbox lifecycle events, host stats, and
  metrics in ClickHouse; signed lifecycle webhooks (best-effort delivery).
- **Inference:** hardware-backed isolation, at the cost of a KVM host, a
  multi-service backend (Postgres/Redis/ClickHouse/object storage), and an Embed
  package explicitly designed to occupy one machine. Coexistence with other host services needs a resource and networking check.

## Daytona (brief self-host read)

- Repository `daytonaio/daytona`, **AGPL-3.0** (a copyleft consideration for
  embedding), `v0.190.0`.
- Sandbox classes: **Container** (default; isolated container with dedicated
  namespaces and resource limits, "code runs as root inside the sandbox") and
  **VM** (Linux VM / Windows with its own kernel; pause/resume, fork, hot
  snapshots; needs hardware virtualization). The runner chart bootstraps
  **Docker + Sysbox** on each node via `nsenter` in a privileged DaemonSet.
- Self-host: Docker Compose (API, proxy, runner, SSH gateway, PostgreSQL, Redis,
  Dex OIDC); a domain deployment adds wildcard DNS and Caddy. BYOC uses the
  `daytona-region` Helm chart. Self-hosted deployments are community-supported.
- Credentials: `Secrets` keep values out of the sandbox — a placeholder is
  substituted by the outbound proxy only for the secret's allowed hosts.
- Network: per-sandbox outbound firewall (block-all, IPv4 CIDR allow list up to
  10 entries, domain allow list up to 100 entries, or outbound proxy); inbound
  via authenticated preview URLs and SSH tokens.
- **Inference:** operationally close to the existing Docker model (containers +
  Sysbox, no KVM for the container class), but the AGPL license and the
  privileged node-bootstrapping runner are material for a delivery-focused
  product. VM isolation again needs hardware virtualization.

---

## What this implies for a single Linux Runner host

Observed constraints to weigh, not a recommendation:

- OpenShell's default Docker/Podman path and
  OpenSandbox's local Docker path coexist with Docker but each adds a gateway or
  lifecycle server plus a per-sandbox supervisor/sidecar — more moving parts than
  a bare `docker run`, though recorded lifecycle state is the point.
- OpenShell's Kubernetes driver and OpenSandbox both want a cluster; OpenSandbox
  on K8s also **requires** an ingress gateway and is single-active-server today.
  An existing cluster does not establish runtime or network-policy compatibility.
- No-KVM container isolation (OpenShell Docker, OpenSandbox runc, Daytona
  Container/Sysbox) is a legitimate choice for evaluation; matching the sbx
  hardware boundary is not a requirement. gVisor is the only middle ground that avoids KVM, and in
  OpenSandbox it **cannot** be combined with the allowlisted-egress/Credential
  Vault path — so this gVisor configuration cannot supply the built-in proxy credential
  injection path. The runc configuration can, with a different isolation boundary.
- Both candidates have real, queryable evidence surfaces: OpenShell has the most
  audit-oriented export (OCSF JSONL + OTLP + Prometheus); OpenSandbox's
  diagnostic API is explicitly best-effort and not a structured audit model.
- Maturity differs: OpenShell is `0.1.x` with a weekly stable cadence; OpenSandbox
  is `1.1.x` stable but its lifecycle API is still pre-v1 and its HA is partial.

## Open questions worth verifying before any decision

- Does OpenShell's Docker driver on this kernel satisfy the Landlock ABI 3+ and
  seccomp addfd probes? (Kernel version must be checked; failures are fail-closed.)
- Does OpenSandbox's Credential Vault + egress sidecar run acceptably alongside
  the existing Docker network configuration (`network_mode`), and under which
  container runtime?
- For each candidate, what exactly is retrievable as raw evidence before
  destroy, and is it complete by construction or best-effort?
- Licensing: Apache-2.0 (OpenShell, OpenSandbox, E2B) vs AGPL-3.0 (Daytona).

## Sources (release tags pinned; documentation URLs are rolling)

NVIDIA OpenShell:

- https://docs.nvidia.com/openshell/latest/llms.txt (docs index, v0.1.4)
- https://docs.nvidia.com/openshell/about/architecture.md
- https://docs.nvidia.com/openshell/how-it-works/sandboxes/runtimes.md
- https://docs.nvidia.com/openshell/about/support-matrix.md
- https://docs.nvidia.com/openshell/about/installation.md
- https://docs.nvidia.com/openshell/how-it-works/providers/overview.md
- https://docs.nvidia.com/openshell/how-it-works/sandboxes/overview.md
- https://docs.nvidia.com/openshell/observability/ocsf-json-export.md
- https://docs.nvidia.com/openshell/extensibility/isolation-backends.md
- https://github.com/NVIDIA/OpenShell/blob/main/architecture/sandbox.md
- https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.4 (2026-10-13)
- https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.5-pre.3 (2026-10-15)

OpenSandbox:

- https://github.com/opensandbox-group/OpenSandbox (README, `main`)
- https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/secure-container.md
- https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/credential-vault.md
- https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/network/egress.md
- https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/deployment/index.md
- https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/getting-started/configuration.md
- https://github.com/opensandbox-group/OpenSandbox/blob/main/server/configuration.md
- https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/api/index.md
- https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/architecture/fast-sandbox/index.md
- https://github.com/opensandbox-group/OpenSandbox/blob/main/ROADMAP.md
- https://github.com/opensandbox-group/OpenSandbox/releases/tag/release-1.1.1 (2026-10-09)
- https://github.com/opensandbox-group/OpenSandbox/releases/tag/release-1.2.0-rc.1 (2026-10-15)

E2B:

- https://github.com/e2b-dev/runtime (README, `main`)
- https://github.com/e2b-dev/runtime/blob/main/embed/README.md
- https://e2b.dev/enterprise
- https://e2b.dev/open-source

Daytona:

- https://github.com/daytonaio/daytona (README, v0.190.0)
- https://www.daytona.io/docs/en/isolation.md
- https://www.daytona.io/docs/en/network-limits.md
- https://www.daytona.io/docs/en/oss-deployment (via docs search result)
- https://github.com/daytonaio/helm-charts/tree/main/runner
