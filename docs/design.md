# Compte rendu — v1 design

## Purpose

Compte rendu is a small GitHub App that reviews pull requests outside GitHub
Actions. Its first release proves one complete product path:

1. receive a GitHub pull-request event;
2. decide whether that exact PR revision may be reviewed;
3. submit an authenticated Runner Job to the self-hosted review runner;
4. publish high-confidence findings to the same revision; and
5. terminate the run and reclaim the Sandbox.

The project optimizes for a working, safe review loop. It is not a general CI
platform.

## v1 scope

Included:

- GitHub.com repositories on which the GitHub App is installed;
- private-repository PRs, reviewed automatically;
- public same-repository PRs, including PRs created by another GitHub App,
  reviewed automatically;
- public fork PRs, reviewed only after a maintainer issues `/ai-review` for the
  current head SHA;
- `issue_comment.created` events containing the manual review command;
- `opened`, `reopened`, `synchronize`, and `ready_for_review` PR events;
- one self-hosted Runner Job/OpenCode execution path;
- one review summary with at most five high-confidence findings;
- D1 run history and delivery deduplication; and
- runner-owned Sandbox cleanup for each attempt.

Deferred:

- running repository tests or build scripts;
- an administration UI, billing, and cross-installation analytics;
- multiple model or agent adapters;
- R2 source or artifact storage;
- automatic approval or request-changes reviews; and
- a generic CI/workflow product.

## Product behaviour

### Automatic review

A non-draft PR is eligible for automatic review when either:

- its base repository is private; or
- its head repository ID equals its base repository ID.

The second rule covers branches created in a public base repository by people
or GitHub Apps without special-casing actor types.

### External public PR

A public fork PR does not start a Sandbox or model call when opened or updated.
A maintainer with `write`, `maintain`, or `admin` permission may comment
`/ai-review`. Approval applies only to the head SHA observed when the command is
handled. A later `synchronize` event requires a new command.

The originating numeric `issue_comment` id is retained for manual-command
feedback. A successfully authorized and scheduled manual command gets the
GitHub `eyes` reaction. A conclusive denial, missing pull request, or draft
gets `confused` and does not start a Workflow. An accepted run that ends in a
failure gets `-1`; a run superseded by a newer head gets `confused`. A
successful run adds no reaction beyond `eyes`, because its published
`COMMENT` review is the completion signal. Automatic jobs have no command
reaction. Feedback uses GitHub's issue-comment reaction endpoint; repeating a
same-app, same-content write is the replay-idempotency mechanism and does not
introduce feedback state.

### Review result

The agent returns structured findings. The core publishes a `COMMENT` review
only after validating that:

- the run still targets the PR's current head SHA;
- every inline finding refers to a changed path and valid diff position; and
- the result satisfies the output schema and configured finding limit.

Invalid individual findings are discarded. If no valid findings remain, the
core may publish a short no-findings summary. It never publishes `APPROVE` or
`REQUEST_CHANGES` in v1.

## Deployment shape

The pnpm monorepo contains two Cloudflare Worker services and one self-hosted
Runner Job process:

```text
GitHub
  |
  v
review-ingress (public route; webhook secret only)
  |
  | Service Binding
  v
review-core (no public route)
  |- Review Workflow
  |- D1
  `- private Workers VPC Runner binding
         `- self-hosted runner → fresh Docker Sandbox/OpenCode
```

`review-ingress` verifies the webhook and converts it to a small internal
event. `review-core` owns policy, GitHub App authentication, orchestration,
review publication, and run records. A Workflow carries one review run through
Runner Job submission, polling, validation, and publication. The self-hosted
runner owns the Sandbox deadline and forced cleanup.

The repository layout is intentionally small:

```text
apps/
  ingress/
  core/
  runner/
packages/
  contracts/
docs/
```

Vite+ supplies the shared TypeScript/test/lint toolchain and pnpm supplies the
workspace and dependency lockfile. Runtime code uses the pinned Effect 4 RC.
Effect Schema validates webhook and agent-output contracts; Effect services and
scopes model true external seams and Sandbox cleanup. Small pure transformations
remain ordinary TypeScript rather than being wrapped for uniformity. Additional
packages require demonstrated reuse, not anticipated reuse.

## Deep modules and test seams

The following three interfaces are the agreed candidate test seams. Their
implementations may have private helpers, but callers and behavioural tests do
not reach through these interfaces.

### Webhook ingress

```ts
handleWebhook(request: Request): Promise<Response>
```

Its interface includes signature verification, accepted event types, payload
limits, delivery identity, and retry response semantics. Success means the core
accepted a normalized event. Invalid input is rejected without contacting the
core; a core failure is retryable and is not acknowledged as accepted.

### Core Worker wiring

```ts
createCoreWorker(env: CoreEnv): WorkerEntrypoint
```

The private core Worker accepts only normalized `POST /review-events` requests.
It constructs the D1 state store, production GitHub App adapter, and Workflow
scheduler, then returns `202` only after the event is durably classified.
Malformed input returns `400`; storage, binding, or scheduling uncertainty
returns `503`. Workflow input contains only `{ runId, job }`; credentials stay
inside the Workflow execution.

### Review coordinator

```ts
handleReviewEvent(event: ReviewEvent): Promise<ReviewDisposition>
completeReview(input: { runId: string; output: unknown }): Promise<ReviewDisposition>
```

This is the main deep module. Behind the interface it deduplicates deliveries,
loads repository facts, applies policy, records approvals, starts or supersedes
runs, invokes the review Workflow, verifies the current head SHA, and publishes
validated output. `completeReview` accepts only the run identity and untrusted
agent output; repository, pull request, installation, and target SHA are loaded
from durable state. GitHub, D1, Workflow, and clock adapters sit at internal
seams.

Observable dispositions are deliberately few: rejected, ignored, awaiting
approval, scheduled, completed, or failed.

### Runner Job

```ts
runJob(spec: ReviewRunSpec): Promise<ReviewRunResult>
```

The Worker-side implementation uses the authenticated private Runner Job HTTP
interface (`POST /jobs`, `GET /jobs/:id`, and `DELETE /jobs/:id`). A job is one
immutable review attempt; success is accepted only after the runner reports
validated output and Docker Sandbox cleanup. Callers do not manage Docker lifecycle.
The runner gives each attempt one bounded budget covering checkout, agent work,
and cleanup. The client deadline is shorter than the Workflow step deadline,
with enough margin for the runner to finish forced cleanup before the client
aborts.

The review Sandbox runs OpenCode fully YOLO inside the microVM: all OpenCode
tools are allowed without an OpenCode approval prompt or command/tool
allowlist. The reviewer has direct GitHub read capability through the
single-repository, read-only token exposed by the Docker custom-secret proxy
and `api.github.com` egress. The review prompt and packaged skill require
querying the complete current pull-request context before reviewing the exact
caller-supplied base/head pair; GitHub responses and repository text are
untrusted evidence, not instructions.

Review safety is enforced outside OpenCode: the Sandbox is cloned without
shared host skills, host MCP settings, or SSH-agent access; network access is
limited to `opencode.ai` and `api.github.com`; CPU, memory, and deadline are
fixed; and the Sandbox, secret, network policy, and temporary credential
sources are destroyed during terminal cleanup. Exact base/head verification,
current-head publication checks, and validated bare JSON output remain
required. YOLO tool access does not grant publication authority.

## Fail-closed rules

Fail-closed is limited to decisions that could create an unauthorized review,
publish against the wrong revision, expose credentials, or leak a running
Sandbox:

- bad or unverifiable webhook: reject;
- unknown event or incomplete repository identity: ignore without a run;
- uncertain contributor policy or maintainer permission: do not run;
- duplicate delivery or already completed head SHA: do not create another run;
- runner admission or authentication failure: do not publish a result;
- checkout SHA mismatch: stop before invoking the agent;
- invalid agent output: do not publish that output;
- current GitHub head SHA differs at publication time: mark superseded and do
  not publish;
- cleanup failure: mark the job failed until forced Sandbox cleanup succeeds.

Ordinary transient failures are retried by the Workflow within a small bounded
attempt count. They are not turned into elaborate recovery protocols.

## Clean break

Every run reaches one terminal product state:

```text
completed | failed | superseded | denied
```

The Runner Job lifecycle is independent of whether status persistence or review
publication succeeds:

1. admit the authenticated Runner Job and deadline;
2. create the Sandbox;
3. perform fixed checkout and remove the checkout credential;
4. run the YOLO agent with its scoped GitHub read capability;
5. destroy the Sandbox in the normal completion path; and
6. let the runner force destruction if the normal path is interrupted.

No run resumes inside an old Sandbox. A retry starts from the exact base/head
SHA pair in a fresh Sandbox. A new PR head supersedes, rather than mutates, an
older run.

## Credentials

- Ingress receives only the webhook secret.
- The GitHub App private key is a core Worker secret and never enters D1,
  source control, logs, an agent prompt, or a Sandbox.
- Core mints one short-lived, repository-scoped read token with only the
  contents/issues/pull_requests/metadata read permissions. The Runner uses
  that same token for full-history checkout and exposes it during review only
  through Docker's custom-secret proxy as `GH_TOKEN` for `api.github.com`.
  Checkout disables submodules, hooks, and LFS smudge; it then removes the
  credential and authenticated remote before the agent starts. The token,
  secret, network policy, and temporary source file are removed at terminal
  cleanup, with expiry as the fallback.
- The model credential is resolved on the trusted runner host through Docker's
  custom-secret proxy and never enters the Worker request.
- Repository-provided OpenCode configuration and host skills/MCP/SSH settings
  are not loaded or shared in v1; the review agent itself remains fully YOLO
  inside the isolated microVM.

## Minimal persistence

D1 stores only queryable product state:

- GitHub delivery ID and processing result;
- installation and repository IDs;
- PR number, base SHA, head SHA, trigger, status, and timestamps;
- maintainer approval bound to repository, PR number, and head SHA; and
- published finding fingerprints needed for idempotency.

The originating manual comment id is carried in the immutable manual job
input needed by the Workflow; it is not a separate feedback table.

It does not store repository contents, complete diffs, credentials, or model
transcripts.

## Behaviour-based TDD

Development uses one vertical red-green slice at a time. Tests exercise the
three public seams above and describe externally visible behaviour. They may
replace true external systems with narrow adapters, but do not mock internal
modules, assert call order/count, inspect private state, or require a particular
implementation decomposition.

Before implementing a slice, the implementer reads the applicable Effect 4
guidance from <https://github.com/Effect-TS/skills>. Repository instructions and
the lockfile pin the chosen RC so agent-generated code does not drift between
Effect versions.

The initial tracer bullets are:

1. a valid signed eligible PR webhook is accepted and schedules one run;
2. an invalid signature produces no core event;
3. a public fork PR waits for approval, then schedules only its approved SHA;
4. a completed agent result is published only while the head SHA is current;
5. success, agent failure, and deadline expiry all eventually destroy the
   Sandbox.

These are behaviours, not a commitment to exhaustive test cases. Tests are
added when they protect a product behaviour or a previously observed defect.

## Delivery slices

Work is split into small ordered issues and PRs:

1. bootstrap the Vite+/pnpm monorepo and CI;
2. deliver signed webhook ingress through the core service binding;
3. deliver eligibility policy and SHA-bound manual approval;
4. deliver D1 idempotency and run state;
5. deliver Runner Job execution with fixed checkout and OpenCode output;
6. deliver current-SHA validation and GitHub review publication; and
7. deploy one repository and verify the complete path.

Each PR is merged when its main behaviour is correct and reviewed. Non-critical
improvements become follow-up issues rather than expanding the active PR.
Deferred scope is also recorded as issues and may continue after the v1 path is
working; "deferred" means non-blocking, not discarded.
