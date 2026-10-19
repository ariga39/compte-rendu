# Docker sbx versus NVIDIA OpenShell for static PR review

> Archived research or implementation history. Its observations and recommendations
> describe the versions and decisions recorded below, not the current product contract.
> Use the [current documentation](../README.md) for supported behavior and operations.

Research date: 2026-10-16. Official sources and current Runner code inspected;
no installation, production change or comparative performance test performed.

## Decision

OpenShell's Docker backend merits a bounded trial for this workload. Its useful
differences are avoiding per-review VMs, an open implementation, a structured
management API, and policy enforcement outside the agent. They do not establish
better uptime or lower total cost yet. The documented unrecoverable pending-driver
operation after a gateway crash is especially relevant to unattended service use.

Matching sbx's microVM boundary is **not** a requirement. Our review is static:
trusted pinned OpenCode/git/gh read untrusted repository content; repository
programs, dependency installation and tests are denied. Hardened containers are
a legitimate choice. Preserve external credentials, controlled egress, immutable
revision identity, bounded resources, retained evidence and confirmed destruction.

## Compare the right versions

- Deployed/project baseline: sbx **0.39.0** was the pre-upgrade Runner target;
  issue #157 upgrades the Runner to **0.48.0** (`docs/installation.md`).
- Docker's current stable release is **0.48.0**, dated 2026-10-13.
  The earlier alternatives survey was not a full current-sbx feature audit.
- OpenShell reference: versioned **0.1.4** documentation. Do not silently borrow
  features from development builds or the 0.1.5 prerelease.

[Docker release notes](https://docs.docker.com/ai/sandboxes/release-notes/),
[OpenShell support matrix](https://docs.nvidia.com/openshell/v0.1.4/about/support-matrix).

## Practical comparison

| Area                | Current sbx integration                                                    | OpenShell Docker candidate                                           | Assessment                                                      |
| ------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| Runtime             | Fresh microVM, private Docker environment                                  | Workload container plus separate supervisor container                | Removes KVM/guest overhead; host runtime and supervisor remain  |
| Host setup          | sbx login, daemon, KVM permissions, filesystem tooling                     | Docker Engine 28+, gateway, SQLite, kernel capability probes         | Different dependencies, not dependency-free                     |
| Agent compatibility | OpenCode 1.18.25 and gh 2.98.0 proven in real reviews                      | Standard OCI image; same tools can be packaged                       | Actual Bun, TLS/SSE and gh compatibility untested               |
| Resources           | Fixed 4 CPUs/8 GiB per job in Runner code                                  | Docker CPU/memory limits and PID limits                              | Potentially better density; no measured ratio                   |
| Credentials         | Per-job model placeholder and GitHub service, host commands resolve values | Attached provider objects, endpoint-bound substitution by supervisor | Same desired property, different lifecycle and storage          |
| Network             | Global deny-all plus per-job model/GitHub destinations                     | Default-deny mediated egress; binary and application rules           | GraphQL query/mutation distinction can help; not a prerequisite |
| Integration         | Existing process adapter invokes sbx CLI                                   | CLI or typed SDK with streaming exec and deletion waiting            | SDK is useful but migration is more than executable renaming    |
| Files/evidence      | Clone workspace; exec export then cp data/session files                    | Upload/download and exec; keep sandbox until archive completes       | Requires file-transfer and archive adaptation                   |
| Lifecycle           | Runner controls timeout, abort, archive, cleanup and callback              | Gateway supplies phases and canonical-process status                 | Runner must still own product outcome and cleanup confirmation  |
| Openness            | Vendor-distributed sbx product; public docs/release issue tracker          | Apache-2.0 source, self-hosted gateway                               | Easier to inspect/patch OpenShell; not a reliability guarantee  |
| Money               | Local sbx is free including commercial use                                 | Open-source local deployment                                         | Hosting, maintenance and model costs dominate this comparison   |

Sources: [Docker architecture](https://docs.docker.com/ai/sandboxes/architecture/),
[Docker pricing/login FAQ](https://docs.docker.com/ai/sandboxes/faq/),
[OpenShell architecture](https://docs.nvidia.com/openshell/v0.1.4/about/architecture),
[OpenShell runtimes](https://docs.nvidia.com/openshell/v0.1.4/how-it-works/sandboxes/runtimes),
[OpenShell providers](https://docs.nvidia.com/openshell/v0.1.4/how-it-works/providers/overview),
[network rules](https://docs.nvidia.com/openshell/v0.1.4/how-it-works/policies/network-rules).

The project baseline is visible in `apps/runner/src/runner.ts`,
`apps/runner/sandbox-template/Dockerfile` and `docs/installation.md`.
A configured 8 GiB VM size does not establish 8 GiB of actual host-resident memory.
Measure whole-host and per-job memory, including supervisors and caches, under
identical review concurrency. A remote-model-bound review might gain density
without becoming noticeably faster end to end.

## Stability: separate observable state from recovery

| Failure                                                                     | What is established                                                                                     | Consequence                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| sbx daemon disappears                                                       | Current detached launch does not make it the systemd MainPID; historical exit cause was not established | Foreground service supervision can improve evidence without replacing sbx          |
| Guest becomes unresponsive                                                  | Current Docker release notes describe improved detection/recovery                                       | Do not attribute all old-version limitations to current sbx                        |
| OpenShell gateway restarts with existing healthy supervisors                | Sandboxes can temporarily return to Provisioning while supervisors reconnect                            | Reconnection is documented, not a guarantee that an in-flight exec stream survives |
| OpenShell supervisor disconnects                                            | Workload freezes; only the same supervisor process can resume it                                        | Replacement supervisor is not transparent continuation of the old process          |
| OpenShell gateway crashes before a create/start driver response is recorded | Pending operation can persist indefinitely; no resolving API currently exists                           | Retry, stop/delete and automatic cleanup can remain blocked                        |
| Delete returns accepted                                                     | OpenShell explicitly allows asynchronous cleanup                                                        | Wait for deletion of the exact sandbox identity before releasing same-PR exclusion |

The pending-operation limitation is documented in
[Sandbox Lifecycle](https://docs.nvidia.com/openshell/v0.1.4/how-it-works/sandboxes/overview#sandbox-lifecycle).
The supervisor rule is in [Architecture](https://docs.nvidia.com/openshell/v0.1.4/about/architecture).
sbx supports [foreground daemon start](https://docs.docker.com/reference/cli/sbx/daemon/start/).
Neither this comparison nor release notes prove why the historical daemon exited.

Docker 0.45–0.48 also change CLI cleanup behavior, credential revocation and
secret-command working directories. The #157 upgrade adapted the Runner only
where the real 0.48 CLI demonstrated an incompatibility: `policy ls SANDBOX`
now errors once the sandbox is gone, so cleanup inspects policy globally and
filters by exact `sandbox_id`, and `policy rm network` now requires `--force`
for unattended removal. Upgrading sbx is a separate, smaller candidate
change that still needs compatibility checks against our pinned CLI calls. It is
not something this research performed, nor proof the incident is fixed upstream.

### Built-in agent kits provision their own egress

During verification we found a mismatch that is shipped kit behavior, not a
0.48 regression. Selecting the built-in `opencode` agent as the launcher makes
its agent kit declare a `permissions.network.allow` list (AI providers, package
registries such as `registry.npmjs.org:443`, code hosts, Ubuntu archives and
more) and apply it to the sandbox's **scoped** policy, on top of the global
preset. The deny-all preset is not an explicit deny rule, so the kit allowances
survive; `sbx policy check network` without `--sandbox` evaluates only the
global policy and can therefore report denied while the sandbox can still
connect. `sbx policy log` attributes these as `domain-allowed` with proxy
`forward-bypass` (forward-bypass means no credential was injected, not that
policy was bypassed). Docker documents the layering under local policy and kit
policies.

The Runner now launches the built-in `shell` agent against the same pinned
custom template and runs `opencode`/`gh` with `sbx exec`. The `shell` kit has
no default network allow entry, so the review sandbox's only egress is the
Runner's explicit per-job model-host and `api.github.com:443` rules — conditional
on the host asserting a `deny-all` default with no other global or
organization-governance allow rules active. The primary's shell probe confirmed:
default-deny scoped policy, `npm` denied, a scoped npm allow succeeding, and
removal requiring `--force`.

Sources: [kit layering and local presets](https://docs.docker.com/ai/sandboxes/governance/access-controls/local).

## What migration actually changes

1. Build a small agent OCI image with pinned OpenCode, gh, Git and trust roots.
   Reuse the tools and skill contract, not assumptions about Docker's sbx base
   image/entrypoint or nested Docker.
2. Create a retained sandbox, transfer the exact verified checkout and isolated
   configuration, run the existing noninteractive review command, and capture
   separate byte-exact stdout/stderr and exit status. Preserve the same-session
   reminder behavior. Disable TTY/login-shell interference in automation.
3. Supply a model provider and a distinct per-job GitHub read-token provider.
   Avoid implicit discovery of host credentials and broad provider-generated
   egress. Delete the job-owned provider after sandbox teardown; deleting a
   sandbox must not be assumed to delete a reusable provider object.
4. Export session JSON and copy DB/state/logs while the sandbox remains usable;
   validate the result and manifest, then destroy it and confirm deletion. Do
   not use automatic ephemeral deletion before this archive finishes.
5. Keep existing Core/D1 claims, concurrency accounting, abort/failure causes,
   same-PR exclusion, callback and publication semantics. A platform restart
   policy must not silently create a second agent execution for a failed review.

OpenShell upload cannot currently be combined with a trailing canonical command:
uploads finish after that command starts. Its documented automation alternative
is scratch sandbox, upload, then exec. Canonical main-process completion is then
not our review-exec completion; Runner must retain its existing result handling.
Host bind mounts also require additional operator opt-ins, so copying a bounded
checkout is a better initial integration path than replicating every old mount.

[Exec/files/lifecycle](https://docs.nvidia.com/openshell/v0.1.4/how-it-works/sandboxes/overview),
[mount restrictions](https://docs.nvidia.com/openshell/v0.1.4/how-it-works/sandboxes/runtimes).

The TypeScript SDK offers streaming exec and `waitDeleted` with an expected
sandbox ID. It requires Node 20.3+ and is distributed through GitHub Packages
with `read:packages` authentication. CLI integration is also possible; select
after a trial, rather than adding an abstraction solely because two backends exist.
[SDK](https://docs.nvidia.com/openshell/v0.1.4/sdk/typescript).

## Logging is not the evidence archive

OpenShell exposes structured policy/runtime diagnostics, but `openshell logs`
does not contain the review exec output. Its gateway buffer holds up to 2,000
lines per sandbox in memory and is lost on restart; supervisor log files use
temporary storage for Docker/Podman. Collection can drop records. Keep streaming
review stdout/stderr to durable Runner files and explicitly export the OpenCode
session and database. Persist platform diagnostics separately when needed; they
cannot substitute for the complete product evidence.

[OpenShell log storage and limits](https://docs.nvidia.com/openshell/v0.1.4/observability/accessing-logs).

## Smallest useful trial

- Run the same fixed review inputs at equal concurrency with the existing model,
  agent versions and permissions. Retain and inspect useful final review output.
- Measure cold/warm readiness, full duration, peak total memory, CPU, disk and
  cleanup time; include the platform's idle cost.
- Verify placeholder-only workload credentials, denied unapproved egress, and
  distinct per-job GitHub identities under concurrent runs.
- Kill the gateway during provisioning, restart it during execution, and kill a
  supervisor. Record exact process exit/signal, observable terminal state,
  remaining resources and a supported recovery procedure.
- Require byte-complete evidence and confirmed cleanup on success, agent failure,
  timeout and cancellation. No deployment recommendation from a PONG alone.

Proceed to migration only if resource or maintenance benefits are material and
failure recovery is acceptable. The known pending-operation case should be
resolved or have a verified supported recovery procedure before unattended use.
