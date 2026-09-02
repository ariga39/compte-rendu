# Current-architecture security FMEA

Audit, 2026-09-02. This is a practical failure-mode analysis of the current D1
pull/claim implementation, not a penetration test or a claim that the
underlying platforms are vulnerability-free. Ratings describe residual risk
after the controls visible in source and the read-only deployment observations
listed below.

## Scope and architecture

In scope is the current D1 pull/claim and callback/R2 architecture:

```text
GitHub
  -> public ingress Worker
       -> private Core Worker service binding
            -> D1 state
            -> private R2 evidence
            -> Workers VPC Service / Tunnel
                 -> loopback-only self-hosted Runner (targeted old-head DELETE)
                      -> fresh Docker Sandbox microVM / OpenCode
                           -> opencode.ai and GitHub API

Runner
  -> authenticated HTTPS claim and callback to public ingress
       -> Core -> atomic D1 claim / R2 / D1 / GitHub COMMENT review

Core -> private VPC -> Runner DELETE only when canceling a reachable old-head Job
```

The retired Cloudflare Container, Durable Object execution, and Workflow paths
are out of scope except where retained migration history or old documentation
could mislead an operator. The source of truth for current behavior is the
current ingress, Core, Runner, contracts, D1 migrations, and deployment
configuration [R1-R10]. In particular, the older Docker threat model's
conclusions that OpenCode is unrestricted and live GitHub access is optional
do not describe current `main`: current Runner code uses a deny-by-default
OpenCode policy and provisions a repository-scoped GitHub service for every
Job [R6, R10].

### Assets

- Credentials: GitHub App private key, webhook secret, Tunnel connector token,
  one static Runner claim/callback bearer token, private Runner admission
  bearer, model credential, and
  short-lived per-Job GitHub read tokens.
- Confidential data: private repository/history and PR context, model prompts,
  OpenCode JSONL/session/database/log evidence, and review bodies before
  publication.
- Integrity: installation admission, maintainer authorization, immutable
  base/head/merge-base identity, D1 run state, evidence correlation, and
  exactly-once publication to the current head.
- Availability and abuse/cost: the public Worker, single Runner host, disk,
  CPU/RAM, Docker Sandbox capacity, GitHub API quota, and model quota.

### Trust boundaries and assumptions

1. Internet input, PR content, repository files/history, GitHub discussion,
   model behavior, and agent output are untrusted. A PR author is assumed able
   to prompt-inject the reviewer.
2. GitHub's HMAC authenticates a delivery as coming through the configured
   webhook; it does not by itself authorize model spend. Installation
   allowlisting and product policy are separate controls [G1, R2].
3. The Cloudflare account, deployed Worker code/configuration, service binding,
   D1, and R2 are trusted. Core is not publicly routed, while ingress is the
   public authentication boundary [C1, R3, R9].
4. The Tunnel connector credential, Runner host, Runner process, `sbx` daemon,
   and host secret resolvers are trusted. The Runner's HTTP listener is
   loopback-only and Core reaches it through Workers VPC [R6, R9]. Workers VPC
   is nevertheless a beta service [C2].
5. The Docker microVM, explicit mounts, effective network policy, credential
   proxy, and terminal destruction are the outer boundary for the untrusted
   agent. Public-Internet egress is not treated as a repository-confidentiality
   boundary; isolation from the Runner host, home/LAN services, and raw
   credentials still is. OpenCode permissions are useful product controls, not
   a replacement for the outer boundary [D1-D6, O1].
6. `opencode.ai` is an intended recipient of the target repository and PR
   evidence. Cloudflare and the Runner-host administrator can access retained
   evidence. Those are product/data-governance decisions, not cryptographic
   exclusions.

### Read-only deployment observations

No credential values or private infrastructure identifiers were retained for
this draft.

- **L1:** On 2026-09-01, `sbx policy ls --wide --include-inactive --type
network` showed active local `all` allow rules covering broad groups of AI,
  package, source-code, container, cloud, OS-package, and certificate hosts.
  This contradicts the intended two-destination effective boundary. Docker
  documents that without organization governance, local and kit network rules
  determine access; allows are additive and unmatched traffic alone is denied
  [D3, D4].
- **L2:** The Runner service environment contained `SSH_AUTH_SOCK` (but not
  `SSH_AGENT_PID`). Current code deletes both variables from every environment
  passed to an `sbx` subprocess [R6], and a local Node spawn check confirmed
  that assigning `undefined` omits the variable. This is therefore ambient
  capability and blast radius in the trusted Runner process, not evidence that
  the current Sandbox receives the socket. Docker documents why preserving the
  stripping matters: it forwards the agent when `SSH_AUTH_SOCK` is set [D6].
- **L3:** The Runner runs as the ordinary host user, its examined systemd
  hardening controls were unset, and evidence/configuration modes were
  `0700`/`0600`. No active Sandbox or GitHub Actions Runner process/service was
  found during this snapshot. Co-locating an Actions Runner later would change
  the host trust boundary and must be reassessed; it is not treated here as an
  observed current condition.
- **L4:** A repository-wide fixed-pattern credential scan found no static key
  or token material. Its only private-key marker was test code that generates
  an ephemeral Web Crypto key at runtime. This is a useful negative check, not
  a proof that every possible secret format is absent.
- **L5:** The deployed Runner user service is enabled, active, configured with
  `Restart=on-failure` after five seconds, and the user has systemd lingering
  enabled. This supports process recovery after a crash and service startup
  after reboot; no destructive restart test was performed during the audit.

### Owner risk decision: public egress and autonomous review

The owner accepts sending repository and PR data to an LLM and does not treat a
repository as confidential merely because it is temporarily private for
internal iteration. Private repositories are currently expected to accept PRs
only from the owner, which materially lowers ordinary PR-author prompt-injection
likelihood. A repository with genuine confidentiality requirements must be
considered separately before it is allowlisted.

Accordingly, access to public documentation and package/dependency hosts is an
accepted capability, not a security failure. The product does not need an MCP
proxy merely to mediate documentation access. Allowing dependency installation,
tests, and repository programs inside the disposable microVM is also an
accepted future product-policy change; current `main` still denies those tools.
The boundaries retained are: no Runner-host/LAN access, no sensitive host
mounts or SSH agent, proxy-only credentials, repository-scoped GitHub read
authority, no GitHub write authority in the Sandbox, finite resources, and
terminal destruction.

Local raw evidence retention is intentionally left unbounded for now because
the host has ample space and retained sessions are valuable for debugging. A
disk problem can be reconsidered from observed usage rather than anticipated
growth. Likewise, a Runner crash or power loss does not need to resume the old
Agent session or automatically reconcile every orphan in v1; the required
outcome is that the service restarts and accepts new work. The one-repository,
read-only GitHub token may live until its one-hour expiry; immediate revocation
is a useful bonus, not a release gate.

Work serialization should use the existing D1 run state as a durable queue.
Cloudflare Queues is not accepted for this path: avoiding another comparatively
immature managed runtime is more valuable than its unused throughput features.
Redis, including a hosted Cloudflare-compatible service, would also add an
independent state system without solving a current scale problem. The
always-on Runner can claim one eligible D1 run when idle; D1 remains the sole
authority for queued, claimed, superseded, and terminal product state.

## Rating method

Higher is worse. `Detection` rates the chance that the failure escapes current
controls until after impact; it is not a measure of monitoring-team skill.

| Score | Severity (S)                                                                                                  | Occurrence (O)                                            | Detection difficulty (D)                            |
| ----- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| 1     | Negligible; no durable product or sensitive-data effect                                                       | Exceptional; requires multiple independent failures       | Almost certainly blocked or detected before impact  |
| 2     | One retry, small metadata exposure, or brief degradation                                                      | Uncommon but credible over the service lifetime           | Usually detected quickly by an existing check       |
| 3     | One review/run lost, bounded quota waste, or recoverable outage                                               | Plausible during ordinary faults or adversarial input     | May require operator correlation after the event    |
| 4     | Private-repository disclosure, unauthorized review, or sustained service loss                                 | Likely over time or reachable through one realistic fault | Weak signal; manual investigation normally required |
| 5     | Host/account compromise, broad confidential-data loss, destructive authority, or effectively unbounded impact | Present/observed or expected frequently                   | No reliable current signal before or after impact   |

`RPN = S x O x D` (maximum 125). RPN helps order work but does not override a
severity-5 trust-boundary failure. Dimensions are **C** confidentiality, **I**
integrity, **A** availability, and **$** abuse/cost.

Confidentiality scores assume a repository whose owner actually considers its
contents sensitive. Under the owner decision above, F06, F10, F13, and F19 all
have materially lower confidentiality impact for ordinary current use.
“Priority” below means a bounded product correction, not a requirement to
build a general security platform.

## FMEA

| ID  | Dimensions | Failure mode and effect                                                                                                                                                                                                                                                                                    | Current controls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Residual S/O/D | RPN | Evidence               | Treatment                                                                 |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------: | --: | ---------------------- | ------------------------------------------------------------------------- |
| F01 | I, A, $    | An Internet caller forges, mutates, replays, or oversizes a GitHub event, causing unauthorized work or ingress load. Theft of the webhook secret remains the bypass.                                                                                                                                       | HMAC-SHA256 over the raw body through Web Crypto, 256 KiB bound, schema/action checks, installation allowlist, Bot-event filter, D1 delivery deduplication, and SHA-bound maintainer checks for manual reviews. GitHub recommends HMAC-SHA256 and constant-time comparison [G1].                                                                                                                                                                                                                     |          4/1/2 |   8 | R2, R4, R7, G1         | Monitor                                                                   |
| F02 | A, $       | Legitimate signed events across many PRs/heads build more queued work than the single host or model budget can sustain. A newer head supersedes D1 state but does not abort an already running old Job until the reachable Runner confirms cleanup.                                                        | Only allowlisted installations enter Core; Bot-authored automatic events are ignored; D1 is the sole durable queue; the single Runner process claims at most one Job while idle and each Job has one 30-minute attempt. A fresh Runner process may claim later unclaimed work even if an abandoned scheduled row retains a Job id; there is intentionally no global active-row gate or orphan reconciler.                                                                                            |          4/3/3 |  36 | R1, R4, R6, R7         | P1 implemented; monitor backlog; Accepted A8                              |
| F03 | C, I       | A future blanket network allow also exposes Runner-host, link-local, metadata, or home/LAN services through Docker's host-side proxy. Public documentation, source, model, and package destinations are intentionally allowed and are not themselves a failure mode.                                       | Docker denies unmatched destinations and L1's observed defaults enumerate public hostname groups rather than a universal wildcard. The Runner adds two exact Job rules. There is no current admission assertion that representative private/link-local destinations remain denied.                                                                                                                                                                                                                   |          5/1/3 |  15 | R6, L1, D1-D4          | Accepted A6; monitor N6                                                   |
| F04 | C, I       | Compromise of the trusted Runner process inherits the ordinary user's SSH-agent signing capability, increasing host-account blast radius. A regression that stops stripping the variables from `sbx` children would additionally forward that capability into the Sandbox.                                 | Every current `sbx` subprocess environment explicitly omits `SSH_AUTH_SOCK` and `SSH_AGENT_PID`, and a spawn check confirmed the omission. L2 found the ambient socket only in the Runner service itself. Docker documents that forwarded agents permit signing requests without exposing key bytes [D6].                                                                                                                                                                                            |          5/1/4 |  20 | R6, L2, D6             | Low-cost H1                                                               |
| F05 | C, A, $    | Runner process crash, host reboot, or kill occurs outside `finally`, leaving a Sandbox, credential proxy registration, network rules, token file, or checkout behind and leaving Core's run scheduled.                                                                                                     | Normal/abort paths archive, remove exact network-rule IDs, remove the Sandbox and secret registrations, delete temporary roots, and fail closed on cleanup uncertainty. Jobs and cleanup ownership exist only in in-memory maps; there is no startup reconciliation or lease. The deployed systemd service is enabled, restarts after five seconds, and starts through user lingering [L5]. A restarted process can still claim a later unclaimed D1 row; Docker state persists until `sbx rm` [D3]. |          3/2/2 |  12 | R6, L5, D3             | Accepted A8                                                               |
| F06 | C, A, $    | Raw JSONL/stderr, session exports, copied DB/state/log trees, checkouts, and terminal Job entries consume host disk or memory; retained evidence accumulates indefinitely. The in-memory 8 MiB capture limit does not stop the file streams, which continue writing full stdout/stderr.                    | Sandbox CPU/RAM and agent time are bounded; callback is capped at 32 MiB; evidence directories/files are `0700`/`0600`; R2 `reviews/` objects have a documented 90-day lifecycle. The host currently has ample storage and durable local evidence is an intentional debugging requirement.                                                                                                                                                                                                           |          3/2/2 |  12 | R6-R8, R9, C5          | Accepted A7; monitor N7                                                   |
| F07 | A, $       | Full-history host-side clone/fetch of an allowed but very large repository consumes disk/I/O before the microVM boundary.                                                                                                                                                                                  | HTTPS clone URL is derived from GitHub and schema-constrained; hooks, recursive submodules, tags, and LFS smudge are disabled; commands share the Job deadline, and the current host has ample free storage.                                                                                                                                                                                                                                                                                         |          3/1/3 |   9 | R3, R5, R6             | Monitor N7                                                                |
| F08 | I, A       | Core atomically claims publication, then crashes before calling GitHub. Later callbacks see the claim, return a completed disposition, but do not publish or transition the D1 run; the run can remain permanently scheduled.                                                                              | Marker lookup occurs before the claim; marker recovery handles a review that reached GitHub; D1's atomic claim prevents concurrent duplicate reviews. There is no claim lease/expiry or recovery for the pre-publication crash window.                                                                                                                                                                                                                                                               |          3/2/4 |  24 | R4, R8                 | Reliability R1                                                            |
| F09 | A          | Both Runner callback attempts fail, or Core rejects a transiently unavailable callback, so valid local evidence never reaches R2/publication and D1 remains scheduled.                                                                                                                                     | HTTPS callback uses a bearer token, 30-second request timeout, one immediate identical retry, correlated schema/evidence validation, and durable local evidence. There is no later retry or automatic reconciliation.                                                                                                                                                                                                                                                                                |          3/2/3 |  18 | R3, R6, R7             | Reliability R1                                                            |
| F10 | C          | A per-Job GitHub installation token remains usable after terminal cleanup and can be recovered from a host/process compromise until GitHub expiry.                                                                                                                                                         | Core requests exactly one repository and exactly four read permissions and validates GitHub's returned repository, permission set, and future expiry. Runner uses the proxy sentinel, a mode-0600 token file, and deletes the file/service; GitHub tokens expire after one hour. The provider implements revocation, but current scheduling/cleanup never invokes it [G2, G3].                                                                                                                       |          3/1/3 |   9 | R3, R5, R6, G2, G3     | Accepted A9; optional H2                                                  |
| F11 | C, I, A, $ | A static Runner claim/callback bearer, private Runner admission bearer, or Tunnel connector credential is stolen. A claim/callback-token holder who also learns an active Job identity can forge a self-consistent result/evidence bundle; a malicious Tunnel replica can receive private Runner requests. | The one callback token is required at public ingress for both `/runner-claim` and `/runner-callback`; the separate private Runner admission bearer remains inside Core/VPC. Runner is loopback-only behind private VPC, Core correlates immutable Job/run/attempt and recomputes every evidence hash, and successful evidence must agree internally. Tokens are not per-Job, expiring, audience-bound, or independently attested; the Tunnel token authorizes connector replicas.                    |          5/1/4 |  20 | R3, R6-R9, C2, C3      | Monitor N2                                                                |
| F12 | I, $       | Prompt injection or model error yields a misleading, mention-spamming, or otherwise harmful Markdown review that Core publishes automatically. Any Sandbox process can also exercise proxy credentials at their matched hosts and spend the bounded quota.                                                 | Exact revisions and merge base are verified; OpenCode has last-match deny-by-default tool rules, static-review guidance, one validated `submit_review`, terminal-stop and size checks; GitHub token is read-only; Core rechecks current head and publishes only `COMMENT`. The 8 MiB structure check is not semantic moderation, and Docker documents that a proxy placeholder grants use of the host credential at its matched host [D5, O1].                                                       |          3/3/2 |  18 | R1, R4, R6, R7, D5, O1 | Accepted A2; monitor N4                                                   |
| F13 | C          | Raw review evidence discloses private code/context to a Cloudflare/R2 administrator, Runner-host administrator, or a party that later obtains those privileges. Callback traffic is not application-layer encrypted.                                                                                       | R2 is private unless explicitly exposed, automatically encrypts objects/metadata at rest with AES-256-GCM, and receives HTTPS traffic; local modes are `0700`/`0600`; `auth.json` and symlinks are removed; R2 lifecycle expires `reviews/` objects after 90 days [C4-C6]. Cloudflare-managed keys and trusted host access remain in the boundary.                                                                                                                                                   |          4/2/4 |  32 | R3, R6, R9, C4-C6      | Accepted A3                                                               |
| F14 | C, I, A    | R2 `put` succeeds but D1 metadata recording fails, leaving an unindexed evidence object; or D1 metadata points to an object later unavailable.                                                                                                                                                             | Core writes evidence before publication and does not publish success unless metadata is recorded. Object key is deterministic by run, size/hash are stored, diagnostics correlate D1 and R2, and R2 lifecycle eventually deletes an orphan. There is no transactional D1/R2 write or orphan inventory.                                                                                                                                                                                               |          2/2/4 |  16 | R3, R4, R8, C5         | Monitor N3                                                                |
| F15 | A          | Workers VPC beta regression, Tunnel/connector outage, home/host outage, or single Runner failure prevents reachable-Runner cancellation or callback completion.                                                                                                                                            | No public Runner fallback exists; claim and callback bearer auth remains required; D1 retains scheduled work for a later idle Runner, while operator diagnostics correlate sources. The service is one connector/host and Workers VPC is explicitly beta [C2].                                                                                                                                                                                                                                       |          3/3/2 |  18 | R1, R3, R9, C2         | Monitor N1                                                                |
| F16 | C, I, A    | Compromised Sandbox/agent/template/OpenCode/`gh`/Docker dependency crosses the VM boundary or falsifies the review/evidence.                                                                                                                                                                               | Docker documents a separate-kernel microVM, isolated Docker daemon, clone-mode read-only host source, proxied credentials, and policy-controlled TCP [D1, D2]. The template pins the base image digest and verifies release-archive hashes; versions are fixed. No VM or supply-chain mechanism eliminates zero-day or signing-key compromise.                                                                                                                                                       |          5/1/4 |  20 | R6, D1, D2             | Monitor N5; Accepted A4                                                   |
| F17 | I, A       | Operators rely on the existing Docker threat model and configure or audit the wrong controls because it describes unrestricted OpenCode, arbitrary execution, and optional GitHub access rather than current static-only permissions and mandatory GitHub service.                                         | Current design, installation manual, code, and this FMEA describe the D1 pull/claim and callback/R2 path. The stale document is still present and labels its conclusions as the product decision.                                                                                                                                                                                                                                                                                                    |          3/5/2 |  30 | R1, R6, R9, R10        | Priority P2                                                               |
| F18 | C, I       | GitHub App private key or Cloudflare account access is compromised, allowing read access and PR/issue writes across every selected repository in the installation.                                                                                                                                         | The key is a per-Worker encrypted secret; App installations should select repositories; ingress also allowlists installations; agent tokens are downgraded to repository read; the Sandbox never receives the private key or write token. Core's publication adapter necessarily mints App installation tokens with installed write permissions.                                                                                                                                                     |          5/1/4 |  20 | R3, R5, R9, C3, G2, G4 | Monitor N2                                                                |
| F19 | C          | A private repository is allowlisted without its owner understanding that source/history, PR discussion, and derived evidence go to the model provider and are retained on the host/R2. This is an authorization/governance failure even when the technical path works as designed.                         | Installation is repository-selected, ingress has an explicit numeric installation allowlist, and project design states private repositories are automatically eligible. There is no separate per-repository data-transfer acknowledgement in runtime state.                                                                                                                                                                                                                                          |          5/2/5 |  50 | R1, R2, R9             | Accepted A1 only with explicit owner decision; otherwise do not allowlist |
| F20 | A          | Missing/malformed installation allowlist or required Worker secrets disables processing.                                                                                                                                                                                                                   | Ingress schema requires a non-empty positive-ID array and fails closed with `503`; required secrets are declared in Worker configs and deployment instructions call for verification.                                                                                                                                                                                                                                                                                                                |          2/2/1 |   4 | R2, R9, C3             | Accepted A5                                                               |

## Prioritized actions

### Product priorities

1. **P1 — implemented: serialize work through the existing D1 state.** The D1
   run row is the durable queue item; Cloudflare Queues and Redis are not part
   of this path. An idle Runner calls one authenticated claim endpoint. Behind
   that small interface, Core atomically claims the oldest eligible run, skips
   superseded state, and only then mints the short-lived one-repository read
   token. D1 stores immutable run identity and state, never the token,
   repository contents, or raw Agent output. Runner executes at most one
   claimed Job and asks for the next only after terminal cleanup.

   The implementation uses latest-head-wins semantics for one PR. A newer head
   marks an older queued head superseded. If the older head is already running,
   Core uses the existing
   authenticated Runner DELETE; the new head remains queued until cleanup is
   confirmed. Existing current-head publication checks still reject a stale
   result. Keep the queue module deep: conceptually its interface is only
   `claimNextJob()` plus the existing terminal callback; atomic
   selection, idempotency, supersession, token minting, and state transitions
   stay behind it. Do not turn this into a generic scheduler.

2. **P2 — retire or rewrite the stale threat model.** Preserve historical
   decisions as history, but clearly mark the current static-only OpenCode,
   mandatory scoped GitHub service, callback/R2 path, and effective outer
   boundaries. Do not let two documents make opposite claims about the active
   security policy.

### Low-cost hardening

- **H1 — remove ambient SSH capability from the trusted service.** Unset
  `SSH_AUTH_SOCK`/`SSH_AGENT_PID` in the systemd service and preserve the
  current stripping for every `sbx` subprocess. A dedicated service identity
  is worthwhile if another untrusted workload is later placed on this host;
  the audit did not find one running now.
- **H2 — revoke the repository read token on every terminal path.** GitHub
  supports immediate installation-token revocation [G3]. The current one-hour,
  one-repository, read-only token already has a small blast radius, so this is
  bounded hygiene rather than a reason to stop public-repository reviews.

### Reliability follow-up, not a security gate

- **R1 — recover lost publication/callback success.** A small operator command
  that reconciles the marker and resubmits already retained evidence for the
  same immutable run is sufficient for v1. Do not add a second queue, generic
  outbox, or model retry merely to close these rare crash windows.

### Monitor

- **N1 — private-path availability:** alert on VPC/Tunnel health, callback
  delivery failures, scheduled-run age, Runner reachability, and beta API
  changes. Reassess a second connector/host only after measured availability
  requires it.
- **N2 — credential hygiene:** rotate static Runner/callback/Tunnel credentials
  on a finite schedule and immediately on exposure; alert on unexpected Tunnel
  replicas, installation changes, Worker secret/version changes, and App-key
  changes. Avoid logging bearer headers or callback bodies.
- **N3 — persistence correlation:** inventory `reviews/` R2 keys against D1,
  verify the 90-day lifecycle remains installed, and report orphan/missing or
  hash-mismatched objects without deleting them automatically.
- **N4 — output and abuse quality:** track review-size distribution, denied
  OpenCode actions, GitHub/model API usage, superseded work, and complaints
  about mentions, links, disclosure, or misleading reviews. Keep `COMMENT` as
  the maximum publication event.
- **N5 — dependency and isolation posture:** keep Docker Sandboxes, OpenCode,
  the template base, GitHub CLI, host kernel/KVM, `cloudflared`, and Worker
  compatibility dates reviewed and patched. Rebuild and re-probe the pinned
  image when any boundary component changes.
- **N6 — internal-network boundary:** when broadening documentation or package
  access, verify that loopback, RFC1918, link-local, cloud metadata, and other
  host/LAN destinations remain unreachable. Public HTTPS access itself is an
  accepted capability; do not maintain a per-site allowlist without a concrete
  need.
- **N7 — storage trend only:** occasionally inspect free space and evidence
  growth. Add retention, quotas, or stream truncation only when measured usage
  makes them useful.

### Accepted for v1, under the stated boundary

- **A1 — intended model disclosure:** the repository owner explicitly accepts
  that the selected repository/PR context is sent to `opencode.ai`. If this is
  not accepted for a repository, it must not be in an allowed installation.
- **A2 — model quality residual:** even after prompt, permission, revision, and
  output checks, an autonomous model can publish an incorrect or unhelpful
  body-only `COMMENT`. It cannot approve, request changes, push, merge, or use
  the Sandbox token for GitHub writes.
- **A3 — trusted storage administrators:** Cloudflare/R2 and Runner-host
  administrators can access retained raw evidence. R2 encryption and local
  file modes protect against different threats; they do not exclude those
  administrators.
- **A4 — platform escape residual:** a Docker/hypervisor/kernel zero-day can
  cross the documented microVM boundary. Patch management and minimal mounts,
  credentials, and egress reduce exposure but cannot prove this risk absent.
- **A5 — fail-closed configuration outage:** malformed admission configuration
  or missing required secrets returns failure instead of running. Availability
  loss is preferred to unauthorized review execution.
- **A6 — public Internet and autonomous in-VM work:** the reviewer may consult
  public documentation and package/source hosts and may later be allowed to
  install dependencies or run repository programs inside its disposable
  microVM. This accepts public-data exfiltration, dependency-script execution,
  modified in-VM state, and bounded quota waste. It does not grant host/LAN
  access, raw credentials, or GitHub publication authority.
- **A7 — local evidence retention:** keep raw local evidence indefinitely for
  now. Available storage is sufficient and post-run debugging value outweighs
  an unproven retention problem.
- **A8 — crash recovery boundary:** an in-flight review may be lost on Runner
  crash or power loss. v1 does not resume that session or guarantee automatic
  orphan cleanup; it must restart cleanly enough to accept later queued work.
- **A9 — read-token expiry:** deletion of the proxy registration and token file
  plus GitHub's one-hour expiry are sufficient for the single-repository,
  read-only token. Immediate revocation remains optional hardening.

## Evidence and primary sources

### Repository evidence

- **R1:** [Current design](design.md)
- **R2:** [Ingress Worker](../apps/ingress/src/index.ts)
- **R3:** [Core Worker wiring and callback evidence validation](../apps/core/src/core-worker.ts)
- **R4:** [Review authorization, state, and publication coordinator](../apps/core/src/index.ts)
- **R5:** [GitHub App token provider](../apps/core/src/github-app-token.ts) and [GitHub publication adapter](../apps/core/src/github-review-adapter.ts)
- **R6:** [Runner implementation](../apps/runner/src/runner.ts), [server listener](../apps/runner/src/server.ts), and [Sandbox template](../apps/runner/sandbox-template/Dockerfile)
- **R7:** [Shared contracts and size limits](../packages/contracts/src/index.ts)
- **R8:** [D1 state store](../apps/core/src/review-state-store.ts) and [migrations](../apps/core/migrations/0001_review_state.sql)
- **R9:** [Installation and operations manual](installation.md), [Core config](../apps/core/wrangler.jsonc), and [ingress config](../apps/ingress/wrangler.jsonc)
- **R10:** [Earlier Docker Sandbox threat model](docker-sandbox-security-threat-model.md) (historical conclusions; not authoritative for current Runner behavior)

### External primary sources

- **G1:** GitHub, [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- **G2:** GitHub, [Authenticating as a GitHub App installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- **G3:** GitHub REST, [Revoke an installation access token](https://docs.github.com/en/rest/apps/installations?apiVersion=2022-11-28#revoke-an-installation-access-token)
- **G4:** GitHub, [Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
- **C1:** Cloudflare, [Workers service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- **C2:** Cloudflare, [Workers VPC overview](https://developers.cloudflare.com/workers-vpc/)
- **C3:** Cloudflare, [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- **C4:** Cloudflare, [R2 data security](https://developers.cloudflare.com/r2/reference/data-security/)
- **C5:** Cloudflare, [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- **C6:** Cloudflare, [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- **D1:** Docker, [Sandboxes security model](https://docs.docker.com/ai/sandboxes/security/)
- **D2:** Docker, [Sandboxes isolation layers and clone mode](https://docs.docker.com/ai/sandboxes/security/isolation/)
- **D3:** Docker, [Sandboxes default security posture](https://docs.docker.com/ai/sandboxes/security/defaults/)
- **D4:** Docker, [Governance policy concepts and precedence](https://docs.docker.com/ai/sandboxes/governance/concepts/)
- **D5:** Docker, [Sandbox credentials and custom-secret proxy](https://docs.docker.com/ai/sandboxes/configuration/credentials/#custom-secrets)
- **D6:** Docker, [Sandbox SSH-agent forwarding](https://docs.docker.com/ai/sandboxes/configuration/credentials/#ssh-agent)
- **O1:** OpenCode, [Permissions and last-match wildcard evaluation](https://opencode.ai/docs/permissions/) and [the pinned 1.18.25 source revision](https://github.com/anomalyco/opencode/tree/cb7d8b2f5e44876ef98b661dc10590c915af3a9f)

Primary-source pages were checked on 2026-09-01. Platform statements are used
as documented properties and trust assumptions, not as proof that an
implementation vulnerability cannot exist.
