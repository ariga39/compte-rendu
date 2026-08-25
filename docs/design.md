# Compte rendu — v1 design

## Purpose

Compte rendu is a small GitHub App that reviews pull requests outside GitHub
Actions. Its first release proves one complete product path:

1. receive a GitHub pull-request event;
2. decide whether that exact PR revision may be reviewed;
3. run a read-only review agent in a Cloudflare Sandbox;
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
- one generic OpenCode CLI review adapter;
- one review summary with at most five high-confidence findings;
- D1 run history and delivery deduplication; and
- a Lease Durable Object that guarantees eventual Sandbox cleanup.

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

The pnpm monorepo contains two Cloudflare Worker services:

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
  |- ReviewLease Durable Object
  `- Cloudflare Sandbox
```

`review-ingress` verifies the webhook and converts it to a small internal
event. `review-core` owns policy, GitHub App authentication, orchestration,
review publication, and run records. A Workflow carries one review run through
checkout, review, validation, and publication. A per-run Lease Durable Object
owns the cleanup deadline.

The repository layout is intentionally small:

```text
apps/
  ingress/
  core/
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

### Sandbox lease

```ts
runWithLease(spec: ReviewRunSpec): Promise<ReviewRunResult>
```

The interface promises that a Sandbox is registered before work begins and is
eventually destroyed after success, failure, or deadline expiry. Sandbox SDK
and clock/alarm adapters sit at internal seams. Callers do not manage lease
renewal or cleanup ordering.

## Fail-closed rules

Fail-closed is limited to decisions that could create an unauthorized review,
publish against the wrong revision, expose credentials, or leak a running
Container:

- bad or unverifiable webhook: reject;
- unknown event or incomplete repository identity: ignore without a run;
- uncertain contributor policy or maintainer permission: do not run;
- duplicate delivery or already completed head SHA: do not create another run;
- lease registration failure: do not create a Sandbox;
- checkout SHA mismatch: stop before invoking the agent;
- invalid agent output: do not publish that output;
- current GitHub head SHA differs at publication time: mark superseded and do
  not publish;
- cleanup failure: leave the Lease alarm armed and mark the run failed until
  cleanup succeeds.

Ordinary transient failures are retried by the Workflow within a small bounded
attempt count. They are not turned into elaborate recovery protocols.

## Clean break

Every run reaches one terminal product state:

```text
completed | failed | superseded | denied
```

The Sandbox lifecycle is independent of whether status persistence or review
publication succeeds:

1. create the Lease record and deadline;
2. create the Sandbox;
3. perform fixed checkout and remove the installation token;
4. run the read-only agent;
5. destroy the Sandbox in the normal completion path; and
6. let the Lease alarm retry destruction if the normal path is interrupted.

No run resumes inside an old Sandbox. A retry starts from the exact base/head
SHA pair in a fresh Sandbox. A new PR head supersedes, rather than mutates, an
older run.

## Credentials

- Ingress receives only the webhook secret.
- The GitHub App private key is a core Worker secret and never enters D1,
  source control, logs, an agent prompt, or a Sandbox.
- A short-lived installation token is exposed only to a fixed checkout step.
  Checkout disables submodules, hooks, and LFS smudge; it then removes the
  credential and authenticated remote before the agent starts.
- The agent receives only the model credential required for review.
- Repository-provided agent configuration, hooks, plugins, and MCP settings are
  not loaded in v1.

## Minimal persistence

D1 stores only queryable product state:

- GitHub delivery ID and processing result;
- installation and repository IDs;
- PR number, base SHA, head SHA, trigger, status, and timestamps;
- maintainer approval bound to repository, PR number, and head SHA; and
- published finding fingerprints needed for idempotency.

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
5. deliver leased Sandbox execution with fixed checkout and OpenCode output;
6. deliver current-SHA validation and GitHub review publication; and
7. deploy one repository and verify the complete path.

Each PR is merged when its main behaviour is correct and reviewed. Non-critical
improvements become follow-up issues rather than expanding the active PR.
Deferred scope is also recorded as issues and may continue after the v1 path is
working; "deferred" means non-blocking, not discarded.
