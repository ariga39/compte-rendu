# Sandbox replacement research — 2026-11-17

The [November 22 native trials](sandbox-replacement-rollout-research.md) update the comparison below with observations on egress, token rotation and cancellation.

Status: research only. No candidate below was installed, deployed, or tested for this
note. The repo's existing files `docs/agent-sandbox-alternatives-research.md` and
`docs/sbx-openshell-comparison.md` are historical; their OpenShell-first conclusion
predates the current v0.1.8 evidence and must not be used as the current decision.

Scope: a small, single Linux host with two Runner instances, each configured
concurrency 6. The aggregate configured ceiling is 12, not a measured host total.
KVM and K3s are already available. Required properties: local list/lifecycle/delete without a vendor account;
isolation for untrusted PRs; egress control; host-owned secrets; retained evidence
before a destroy is confirmed. VM isolation is **not** treated as a user requirement.
Earlier internal notes said "VM"; that was not a user decision.

## Bottom line

**Conditional top-two shortlist for the next proof step (not a deployment decision,
and not a proven operational ranking):**

1. **OpenSandbox release-1.2.1 + Kata (VM, KVM) or Docker (plain container, if
   acceptable).** OpenSandbox supplies own-API-key lifecycle, built-in egress,
   Credential Vault, and a documented fail-closed Docker expiry-restoration property.
   Kata supplies a VM boundary; plain Docker avoids VM overhead but keeps a shared
   host kernel. Delete/create crash reconciliation is not evidenced.
2. **Incus VM (v7.6.0).** Local named instances, local daemon auth, and a VM
   boundary. It has no built-in credential broker, and its ACLs are L3/L4
   (IP/CIDR/port), not FQDN. Its list/stop/export/delete surface is not evidence of
   crash-safe recovery; OpenShell has a comparable surface and a documented wedge.

Neither shortlisted candidate has demonstrated an operational recovery advantage over
the other. **OpenShell v0.1.8 is not on the shortlist**: the pinned docs still
document an indefinite `driver_operation_pending` state after an owning-gateway
crash, no API to resolve lost ownership, and blocked cleanup/retry/delete. That is a
documented disqualifier, not a comparative performance claim.

K3s + agent-sandbox is a deployment vehicle for gVisor or Kata, not a third isolator:
agent-sandbox supplies no isolation or credential broker. Microsandbox remains a beta
microVM fallback. Daytona/E2B were only lightly screened (see below), not assessed as
current products.

## Evidence matrix

| Candidate                               | Boundary                                                              | Lifecycle/list/delete                                                          | Auth for lifecycle                                                                | Registry pulls                                                  | Egress                                                                                    | Host-owned secrets                                             | Evidence before destroy                                                           | Known recovery limits                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| OpenSandbox release-1.2.1 local Docker  | Plain container (`runc`) by default; gVisor/Kata/Firecracker optional | REST/SDK/CLI create/list/delete; DELETE returns 204 while cleanup may continue | Own `OPEN-SANDBOX-API-KEY`; no vendor account                                     | Per-image `image.auth` username/password; separate from API key | Built-in per-sandbox egress sidecar; dns+nft; only injected when `networkPolicy` supplied | Built-in Credential Vault (egress sidecar), placeholder-based  | Copy diagnostics/logs/artifacts; snapshots optional and backend-dependent         | TTL expiry restoration fails startup if it cannot be restored; deletion/create crash reconciliation not evidenced                    |
| Incus v7.6.0                            | System container **or** VM; VM uses hardware virtualization/QEMU      | `incus list`, `start`, `stop`, `delete`; delete requires stopped               | Local Unix socket + group; remote TLS cert/trust token or OIDC; no vendor account | Image remotes/OCI registries; registry auth is separate         | Network ACLs, default reject; IP/CIDR/port, **not FQDN**; optional logged rules           | **None built in**; extra host-side gateway/proxy required      | Copy review logs/artifacts before delete; export available but not required       | Delete permanently removes instance **and all snapshots**; async operations; no documented crash reconciliation for in-flight delete |
| OpenShell v0.1.8 Docker                 | Plain container; workload `network=none`; optional libkrun MicroVM    | CLI/SDK list/stop/start/delete; delete is accepted before cleanup              | Own local mTLS or OIDC; no vendor login for stable                                | OCI images; private registry credentials separate               | Default-deny; per-binary/host/L7 rules; supervisor mediates                               | Built-in providers/credential broker with placeholders         | OCSF JSONL/supervisor logs are rotating/non-durable; external collection required | **Documented indefinite pending operation after owning-gateway crash; no resolving API; cleanup/retry/delete blocked**               |
| agent-sandbox v1.0.11 + gVisor          | Plain container under gVisor userspace kernel (**not a VM**)          | Kubernetes CRs; `kubectl` list/delete; TTL/shutdown delete                     | Kubernetes RBAC; no vendor account                                                | Image pull secrets; separate                                    | Managed NetworkPolicy default: public Internet only, internal/metadata blocked            | **None built in**; K8s Secrets or extra gateway                | Pod logs/events/PVC artifacts external; CR deletion is GC                         | No isolation itself; policy depends on CNI; gVisor is not a VM                                                                       |
| agent-sandbox v1.0.11 + Kata            | VM per pod (KVM)                                                      | Same Kubernetes lifecycle                                                      | Kubernetes RBAC                                                                   | Image pull secrets                                              | NetworkPolicy / CNI                                                                       | None built in                                                  | Pod logs/events/PVC artifacts external                                            | KVM required; VM memory overhead; no built-in credential broker                                                                      |
| Microsandbox v0.7.15                    | MicroVM (KVM)                                                         | `msb ls`, `start`, `stop`, `rm`; snapshots                                     | Local OS account/process; no vendor login documented                              | OCI/Docker images                                               | Host-controlled allow/deny; private/link-local/metadata blocked                           | Built-in host-side secret substitution; real value never in VM | Copy logs/artifacts; snapshot available but not required                          | Beta; less production evidence                                                                                                       |
| Daytona (older pinned self-host recipe) | Not assessed as a current product                                     | CLI list/delete; managed API key                                               | Vendor account/API key; self-host Dex/OIDC                                        | Registry service in compose                                     | Not assessed in depth                                                                     | Not verified                                                   | Not verified                                                                      | Only the older recipe was screened; current isolation/auth not assessed here                                                         |
| E2B infra 2026.30                       | Firecracker microVM (KVM)                                             | API create/list/kill/pause/resume                                              | Team API keys/JWT; own auth in self-host                                          | Template builds from Docker images                              | Per-slot nftables + SNI/Host firewall                                                     | Secrets store with egress-time resolution                      | Snapshot/pause paths exist                                                        | Self-host Terraform targets GCP/AWS, **not a general Linux host**                                                                    |

## Own auth vs vendor auth, and pulls vs lifecycle

These are separate questions and should not be conflated:

- **Own-auth, no vendor lifecycle account:** Incus, OpenSandbox, OpenShell, and
  agent-sandbox all authenticate their own control plane. Incus uses a local Unix
  socket/group and its own TLS trust or OIDC. OpenSandbox uses its own API key;
  empty key means no auth, and non-interactive use requires an explicit insecure
  acknowledgement. OpenShell uses generated local mTLS or its own OIDC. agent-sandbox
  uses Kubernetes RBAC. OpenShell prerelease artifacts may require GitHub CLI auth;
  stable package install and lifecycle do not require a vendor account.
- **Vendor account for lifecycle:** Docker `sbx` requires a signed-in Docker user
  (the pinned agent-sandbox `docker-sbx` example states this). The older screened
  Daytona recipe uses account/API-key or self-hosted Dex/OIDC auth. E2B cloud uses a
  team account; self-host authentication is your own.
- **Registry pull auth is not lifecycle auth:** OpenSandbox takes per-image
  `image.auth`; OpenShell/Kubernetes use registry credentials or image-pull secrets;
  Incus uses image remotes and registry credentials. None of these should be treated
  as proof that sandbox creation/deletion is authorised.

## OpenShell v0.1.8: the documentary blocker

Pinned source: `NVIDIA/OpenShell` tag `v0.1.8`, published 2026-11-10, file
`docs/how-it-works/sandboxes/overview.mdx`:

> "If the owning gateway crashes before recording the response, the flag and any
> protected upload can remain indefinitely; restart and age alone cannot establish
> that the operation finished. There is currently no API to resolve that lost
> ownership, so automatic cleanup completion, retry, and deletion remain blocked for
> that record." — lines 1180.

The same page says that while `driver_operation_pending` is true, explicit start,
stop, and deletion are blocked (line 1178), and that deletion can return before
cleanup completes (lines 1138–1140). The user-side auth correction is supported by
`docs/how-it-works/gateways/authentication.mdx`: package-managed local gateways
generate the mTLS bundle, and authentication can still expire/fail independently of
gateway reachability.

Consequence: a single crash at the wrong point can create an unremovable logical
sandbox record with no supported operator resolution. Recovery cost is potentially
unbounded (manual state surgery or host abandonment). That outweighs the benefit of
the existing OpenShell adapter and its otherwise strong container controls. This is
the reason it is not on the shortlist, not a claim that its controls are weak.

## OpenSandbox: what the expiry-restoration evidence does and does not prove

Evidence for a **narrow durable-expiry property**:

- `release-1.2.1` notes (2026-11-13) say startup fails when Docker expiration
  enforcement cannot be restored, except for concurrently removed containers
  (lines 18 and 126). This is an explicit fail-closed startup property, not an
  absence-of-documentation inference.
- The lifecycle spec defines sandbox `timeout`, automatic termination, and
  `Running/Paused → Stopping` on TTL expiry with reason `ttl_expiry`, then
  `Stopping → Terminated`.
- Configuration documents `max_sandbox_timeout_seconds` and absolute
  `renew-expiration`; the default store is SQLite.

What it does **not** prove:

- That a create or delete already in flight when the server/daemon crashes is
  reconciled to completion. The same spec says a DELETE returns 204 while runtime
  cleanup may continue.
- That orphan containers or partial runtime resources are discovered and removed.
- That the `Terminated` state is durable evidence of host resource reclamation.
- That deletion is safe to retry without fencing. Release notes separately mention
  "incomplete destruction stays fenced for retry" in the Go SDK.

So: **durable expiry intent restoration is evidenced; crash-safe deletion/
reconciliation is not.** The difference matters for the incident objective.

## Incus VM: fair alternative, with explicit gaps

Pinned `lxc/incus v7.6.0` (2026-10-30):

- `containers_and_vms.md`: VMs use hardware virtualization; containers share the host
  kernel. This is a real VM boundary; the docs do not explicitly spell out
  `/dev/kvm`, so verify the VM path on the actual host rather than inferring it.
- `instances_manage.md`: `incus list`, start, stop, delete; delete requires the
  instance stopped and **permanently deletes the instance and all its snapshots**.
- `instances_backup.md`: `incus snapshot create` and `incus export` are available,
  but copying review logs/artifacts is the required evidence step; a full
  VM/rootfs snapshot or export is optional, not assumed.
- `network_acls.md`: default reject, allow/drop rules by IP/CIDR/port and direction.
  Bridge ACLs only filter at the bridge/host boundary. There is **no FQDN rule**;
  FQDN allowlisting needs an extra host-side proxy.
- `security.md`: local socket access is effectively root-equivalent; untrusted users
  must not get it. Confined projects exist, but are not a substitute for per-review
  isolation.
- `authentication.md`: local Unix socket, or remote TLS client certificates/trust
  tokens, or OIDC. No vendor account.

What this establishes: a review is a named instance with a local lifecycle surface,
and logs/artifacts can be copied before the destructive step. What it does **not**
establish: that a crash during create/delete recovers cleanly, or that Incus has a
recovery advantage over OpenShell. OpenShell has a comparable list/stop/delete
surface and still documents an indefinite wedge, so surface similarity is not
evidence. Incus crash behavior remains unproven here.

## gVisor, Kata, and plain containers are different things

- **Plain container (`runc` / Docker):** shared host kernel; cgroups/namespaces/
  seccomp/Landlock as configured. OpenShell Docker, OpenSandbox Docker default, and
  similar product container modes are in this class unless a stronger runtime is selected.
- **gVisor:** a userspace application kernel with syscall interception; **not a VM**
  and does not require KVM by default. gVisor's own platform guide says `systrap` is
  the choice "on a machine without virtualization support"; KVM is an optional
  platform. It is stronger than plain `runc` but is not hardware virtualization.
- **Kata Containers:** a lightweight VM per pod/container, using a guest Linux
  kernel and hardware virtualization. Kata 4.3.1 documents KVM as the underlying
  interface and `/dev/kvm` as required. It is a VM boundary.
- **agent-sandbox:** an orchestrator only. Its own scope note says it delegates
  isolation to a `RuntimeClass`; its threat model says it does not implement
  isolation. Pairing it with gVisor gives gVisor isolation; pairing it with Kata
  gives VM isolation. Its managed NetworkPolicy defaults to ingress-from-router and
  egress-to-public-Internet, blocking RFC1918 and metadata endpoints; this is a
  policy object, not a credential gateway.

OpenSandbox's own compatibility notes say egress/Credential Vault does not work with
gVisor because its netstack lacks the required nftables features. OpenSandbox
therefore cannot simultaneously provide gVisor isolation and its built-in egress/
vault path; it directs users to Kata for that combination. That is a real trade-off,
not a footnote.

## Retained evidence and confirmed destroy

These are two separate prerequisites:

1. **Evidence retention:** copy the review logs/artifacts/exported files somewhere
   outside the candidate's control plane before deletion. A full VM/rootfs snapshot
   is **not** required for this note.
2. **Confirmed destroy:** the actual workload and its resources are confirmed
   reclaimed (container/VM/pod gone and host resources released), not merely the
   logical API object or CR missing.

- **OpenShell:** gateway keeps only a small in-memory log tail; OCSF JSONL and
  supervisor files rotate and are on tmpfs/emptyDir for container drivers; they are
  lost on stop/delete. Copy logs externally first. Confirming the sandbox name is
  absent is not proof that compute/resources were reclaimed.
- **OpenSandbox:** diagnostics are explicitly best-effort and are not a structured
  audit model. Copy diagnostics/logs/artifacts externally; snapshots are optional.
  A 204 delete response or a `Terminated` state is not proof of runtime cleanup.
- **Incus:** copy logs/artifacts before delete; snapshots/exports are optional.
  `delete` permanently removes the instance and its snapshots, so confirm the VM or
  container and its storage/resources are gone, not just absent from `incus list`.
- **agent-sandbox:** copy Pod logs/events and needed PVC artifacts externally; CR
  deletion and TTL cleanup are GC, not evidence retention or proof of pod/PVC
  reclamation.
- **Microsandbox:** copy logs/artifacts before `rm`; snapshots are optional. Confirm
  the microVM and host resources are gone.
- **Daytona/E2B:** not assessed deeply enough to claim an evidence or reclamation
  path.

## Light-screen notes

- **Daytona:** only an older pinned self-host Docker Compose recipe was screened. That
  recipe says it is "not safe to use in production" and includes a full stack (API,
  proxy, runner, Postgres, Redis, Dex, registry, MinIO). This is a property of the
  screened recipe, not a current Daytona assessment; current isolation/auth were not
  assessed and should not be ruled out from this note.
- **E2B infra 2026.30:** Firecracker microVMs, own team API keys, built-in egress
  firewall and secret path, but self-hosting is Terraform for GCP/AWS (AWS beta);
  "General linux machine" is explicitly unchecked. It is not a single-Linux-host
  option on the evidence.
- **Microsandbox v0.7.15:** genuinely local microVMs with KVM, host-side secret
  substitution, and egress policy; CLI has list/stop/start/rm. But the pinned README
  calls it beta with breaking changes and rough edges. Keep it as a proof candidate,
  not a production recommendation.

## Unresolved proof requirements (do not guess)

1. **OpenShell:** reproduce an owning-gateway crash with an in-flight create/start
   and identify any supported or scriptable recovery. Until then, treat the
   documented indefinite block as real.
2. **OpenSandbox:** crash the server during create and delete; determine whether
   expiry restoration is the only reconciliation or orphans are removed, whether
   `Terminated`/404 means resources were reclaimed, and whether diagnostics/logs can
   be captured before delete without relying on sandbox health.
3. **Incus VM:** verify the host VM path (hardware virtualization is documented;
   `/dev/kvm` is not named in the pinned page). Crash the daemon during create/delete
   and observe operation recovery/orphans; confirm bridge ACL behavior and the need
   for an FQDN proxy.
4. **Incus secrets:** design the extra host-side credential gateway; prove real
   secrets never enter the VM and substitution is restricted to allowed hosts.
5. **agent-sandbox + gVisor/Kata:** prove CNI enforcement of the managed
   NetworkPolicy, confirm gVisor cannot use OpenSandbox egress/vault, and confirm
   Kata's KVM/memory cost against the aggregate configured ceiling of 12 (two Runners
   × 6), not a measured host total. There is no built-in
   credential gateway.
6. **Microsandbox:** confirm non-beta status or accept beta risk; prove isolation,
   egress, and secret substitution under concurrent load. No candidate here was
   benchmarked or load-tested.

## Conditional recommendation

No candidate is recommended as a proven operational replacement, and these are not
deployment instructions.

- **If a container boundary is acceptable and integration cost dominates, put
  OpenSandbox Docker forward; use Kata with OpenSandbox when a VM boundary is
  required.** It has own API auth, built-in egress/vault, and a documented
  fail-closed expiry-restoration property. That is not a full crash-cleanup
  guarantee.
- **If a VM boundary is wanted and local inspectability matters, put Incus VM
  forward for proof.** Its list/stop/export/delete surface is convenient, but not
  evidence of crash-safe recovery; the extra credential gateway and FQDN proxy are
  real costs.
- **Use agent-sandbox on the existing K3s only if Kubernetes-native operation is
  itself valuable.** Pair it with gVisor for a non-VM strong boundary or Kata for a
  VM boundary; do not expect agent-sandbox to supply isolation or credentials.
- **Do not default to OpenShell** while its documented lost-operation block has no
  supported recovery. It may remain a candidate for a later trial after that proof.
- **Do not use the older Daytona recipe as a current-project conclusion.** E2B's
  documented self-host path still does not target a general Linux host. Microsandbox
  remains a beta microVM fallback.

VM is not mandatory; neither shortlist entry is presented as a proven advantage.

## Pinned sources

All accessed 2026-11-17. Prefer these tags over historical docs.

OpenShell:

- https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.8 (2026-11-10)
- https://github.com/NVIDIA/OpenShell/blob/v0.1.8/docs/how-it-works/sandboxes/overview.mdx (lines 1138–1140, 1178–1180)
- https://github.com/NVIDIA/OpenShell/blob/v0.1.8/docs/how-it-works/sandboxes/runtimes.mdx
- https://github.com/NVIDIA/OpenShell/blob/v0.1.8/docs/how-it-works/gateways/authentication.mdx
- https://github.com/NVIDIA/OpenShell/blob/v0.1.8/docs/how-it-works/providers/overview.mdx
- https://github.com/NVIDIA/OpenShell/blob/v0.1.8/docs/how-it-works/policies/default-policy.mdx
- https://github.com/NVIDIA/OpenShell/blob/v0.1.8/docs/observability/accessing-logs.mdx
- https://github.com/NVIDIA/OpenShell/blob/v0.1.8/docs/observability/ocsf-json-export.mdx

OpenSandbox:

- https://github.com/opensandbox-group/OpenSandbox/releases/tag/release-1.2.1 (2026-11-13)
- https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/releases/1.2.1.md (lines 18, 126)
- https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/specs/sandbox-lifecycle.yml (delete 204; TTL states)
- https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/getting-started/configuration.md
- https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/architecture/network/egress.md
- https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/credential-vault.md
- https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/guides/secure-container.md
- https://github.com/opensandbox-group/OpenSandbox/blob/release-1.2.1/docs/api/implementation-compatibility.md

Incus:

- https://github.com/lxc/incus/releases/tag/v7.6.0 (2026-10-30)
- https://github.com/lxc/incus/blob/v7.6.0/doc/explanation/containers_and_vms.md
- https://github.com/lxc/incus/blob/v7.6.0/doc/howto/instances_manage.md
- https://github.com/lxc/incus/blob/v7.6.0/doc/howto/instances_backup.md
- https://github.com/lxc/incus/blob/v7.6.0/doc/howto/network_acls.md
- https://github.com/lxc/incus/blob/v7.6.0/doc/explanation/security.md
- https://github.com/lxc/incus/blob/v7.6.0/doc/authentication.md

agent-sandbox / gVisor / Kata:

- https://github.com/kubernetes-sigs/agent-sandbox/releases/tag/v1.0.11 (2026-11-12)
- https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.11/README.md
- https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.11/docs/security/threat_model.md
- https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.11/docs/api.md
- https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.11/examples/quickstart/gvisor.md
- https://github.com/kubernetes-sigs/agent-sandbox/blob/v1.0.11/examples/quickstart/kata-containers.md
- https://github.com/google/gvisor/releases/tag/release-20261116.0 (2026-11-17)
- https://github.com/google/gvisor/blob/release-20261116.0/g3doc/architecture_guide/platforms.md
- https://github.com/kata-containers/kata-containers/releases/tag/4.3.1 (2026-10-21)
- https://github.com/kata-containers/kata-containers/blob/4.3.1/docs/design/virtualization.md
- https://github.com/kata-containers/kata-containers/blob/4.3.1/docs/installation.md

Light screens (Daytona items are the older pinned self-host recipe, not a current
project assessment):

- https://github.com/daytonaio/daytona/releases/tag/v0.190.0 (2026-06-23)
- https://github.com/daytonaio/daytona/blob/v0.190.0/README.md
- https://github.com/daytonaio/daytona/blob/v0.190.0/docker/README.md
- https://github.com/e2b-dev/infra/releases/tag/2026.30 (2026-09-10)
- https://github.com/e2b-dev/infra/blob/2026.30/README.md
- https://github.com/e2b-dev/infra/blob/2026.30/docs/ARCHITECTURE.md
- https://github.com/superradcompany/microsandbox/releases/tag/v0.7.15 (2026-11-12)
- https://github.com/superradcompany/microsandbox/blob/v0.7.15/README.md
- https://docs.microsandbox.dev/networking/overview (current docs; not version-pinned)
- https://docs.microsandbox.dev/security/secrets (current docs; not version-pinned)
