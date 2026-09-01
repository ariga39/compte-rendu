# Compte rendu — v1 design

## Purpose

Compte rendu is a small GitHub App that reviews pull requests outside GitHub
Actions. Its first release proves one complete product path:

1. receive a GitHub pull-request event;
2. decide whether that exact PR revision may be reviewed;
3. submit an authenticated Runner Job to the self-hosted review runner;
4. publish the review's Markdown body to the same revision; and
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
- one concise human-readable Markdown review, guided by at most five
  high-confidence findings when present;
- D1 run history and delivery deduplication; and
- runner-owned Sandbox cleanup for each attempt.

Deferred:

- running repository tests or build scripts;
- an administration UI, billing, and cross-installation analytics;
- multiple model or agent adapters;
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
gets `confused` and does not start a Runner Job. An accepted run that ends in a
failure gets `-1`; a run superseded by a newer head gets `confused`. A
successful run adds no reaction beyond `eyes`, because its published
`COMMENT` review is the completion signal. Automatic jobs have no command
reaction. Feedback uses GitHub's issue-comment reaction endpoint; repeating a
same-app, same-content write is the replay-idempotency mechanism and does not
introduce feedback state.

### Review result

The agent submits one concise human-readable Markdown review through the
packaged `submit_review` custom tool. The Runner validates the JSONL transport,
requires exactly one completed submission plus a `step_finish` event with
reason `stop`, and accepts the tool's exact `state.input.markdown` value.
Terminal assistant prose remains raw evidence and is never a product result.
Malformed JSONL, explicit agent errors, oversized output, a missing or errored
submission, duplicate submissions, a missing terminal stop, or invalid review
Markdown fail closed.

Core accepts the submitted, size-bounded Markdown body beginning with
`## Review:` only after confirming that the run still targets the pull
request's current head SHA, then publishes it as a body-only `COMMENT` review
with no inline finding projection. Review guidance may suggest up to five
high-confidence actionable findings when present and a clear conclusion when
none are found; this is guidance for the human-readable review, not a JSON
schema. It never publishes `APPROVE` or `REQUEST_CHANGES` in v1.

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
  |- D1
  |- private R2 evidence bucket
  `- private Workers VPC Runner binding
         `- self-hosted runner → fresh Docker Sandbox/OpenCode
              `- public ingress callback → review-core
```

`review-ingress` verifies the webhook and converts it to a small internal
event. `review-core` owns policy, GitHub App authentication, Runner Job
admission, review publication, evidence metadata, and run records. It durably
claims a run and immediately submits one immutable Runner Job through the VPC
binding. The Runner owns execution and cleanup, then sends one authenticated
result callback through public ingress. Core stores the bounded named-field
evidence bundle in private R2 before confirming publication. There is no
Workflow.

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
Effect Schema validates webhook and OpenCode event contracts; Effect services
and scopes model true external seams and Sandbox cleanup. Small pure transformations
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
It constructs the D1 state store, production GitHub App adapter, and Runner
scheduler, then returns `202` only after the event is durably classified and
one Runner Job is admitted. Malformed input returns `400`; storage, binding,
or scheduling uncertainty returns `503`. Runner admission is one authenticated
`POST /jobs` through the VPC binding; the callback is accepted only through
the static-token ingress route.

### Review coordinator

```ts
handleReviewEvent(event: ReviewEvent): Promise<ReviewDisposition>
completeReview(input: { runId: string; output: unknown }): Promise<ReviewDisposition>
```

This is the main deep module. Behind the interface it deduplicates deliveries,
loads repository facts, applies policy, records approvals, starts or supersedes
runs, verifies the current head SHA, and publishes validated callback output.
`completeReview` accepts only the run identity and untrusted agent output;
repository, pull request, installation, and target SHA are loaded from durable
state. GitHub, D1, Runner, and clock adapters sit at internal seams.

Observable dispositions are deliberately few: rejected, ignored, awaiting
approval, scheduled, completed, or failed.

### Runner Job

```ts
submitJob(spec: ReviewRunSpec): Promise<void>
```

The Core-side implementation uses one authenticated private Runner Job HTTP
admission (`POST /jobs`). A job is one immutable review attempt; the Runner
reports terminal status through the public-ingress callback after validation
and Docker Sandbox cleanup. Core does not poll, retry, or manage Docker
lifecycle.
The shared review policy gives each Runner attempt a 30-minute agent timeout and
treats a failed Review Attempt as terminal: there is one attempt and no retry.
The Runner has one fixed finite execution ceiling for hang prevention. Callback
transport gives each request its own timeout and may make one immediate retry
of the same result; local evidence stays available when both deliveries fail.
If the fixed callback bundle exceeds the 32 MiB request bound, the Runner sends
one small terminal incomplete-evidence failure instead of truncating or
uploading that bundle.

The review Sandbox runs OpenCode non-interactively inside the microVM, without
per-call approval prompts. Its static-review policy allows the packaged skill,
the final-review submission tool, read/search, and narrowly bounded read-only
Git/GitHub commands. The reviewer has direct GitHub read capability through
Docker's sandbox-scoped built-in `github` service and `api.github.com` egress. After
fetching and verifying the immutable admitted base and head commits, the
Runner derives one valid merge base with `git merge-base`. Missing, invalid,
or unavailable merge-base history fails the Job before Sandbox/OpenCode. The
review prompt and packaged skill require querying the complete current
pull-request context, then reviewing `git diff --find-renames MERGE_BASE_SHA
HEAD_SHA`; the admitted base/head OIDs remain freshness and context facts.
GitHub responses and repository text are untrusted evidence, not
instructions. After the GitHub egress policy is allowed and before OpenCode
starts, the Runner performs an `installation/repositories` preflight through
the GitHub CLI. A failed preflight fails the Job and prevents agent
invocation.

Review safety is enforced outside OpenCode: the Sandbox is cloned without
shared host skills, host MCP settings, or SSH-agent access; network access is
limited to `opencode.ai` and `api.github.com`; CPU, memory, and deadline are
fixed; and the Sandbox, secret, network policy, and temporary credential
sources are destroyed during terminal cleanup. Exact base/head verification,
current-head publication checks, and one valid submitted Markdown body remain
required. Agent tool access does not grant publication authority.

## Fail-closed rules

Fail-closed is limited to decisions that could create an unauthorized review,
publish against the wrong revision, expose credentials, or leak a running
Sandbox:

- bad or unverifiable webhook: reject;
- unknown event or incomplete repository identity: ignore without a run;
- uncertain contributor policy or maintainer permission: do not run;
- duplicate delivery or already completed head SHA: do not create another run;
- runner admission or authentication failure: do not publish a result;
- checkout SHA or merge-base verification failure: stop before invoking the
  agent;
- invalid agent output: do not publish that output;
- current GitHub head SHA differs at publication time: mark superseded and do
  not publish;
- cleanup failure: mark the job failed until forced Sandbox cleanup succeeds.

Callback transport loss does not erase local evidence. It is handled only by
the Runner's one bounded immediate retry; there is no queue, outbox, cron, or
generic retry framework.

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
4. run the review agent with its scoped GitHub read capability;
5. destroy the Sandbox in the normal completion path; and
6. let the runner force destruction if the normal path is interrupted; and
7. send the terminal result callback, retaining local evidence if delivery is
   unavailable.

No run resumes inside an old Sandbox. A new PR head supersedes, rather than
mutates, an older run.

## Credentials

- Ingress receives only the webhook secret.
- The GitHub App private key is a core Worker secret and never enters D1,
  source control, logs, an agent prompt, or a Sandbox.
- Core mints one short-lived, repository-scoped read token with only the
  contents/issues/pull_requests/metadata read permissions. For each Job, the
  Runner writes that installation token to a temporary host-side file and
  registers a fresh sandbox-scoped built-in `github` service with a host-side
  command that reads the file and `--refresh on-demand`. The service exposes
  only Docker's proxy sentinel in the Sandbox and injects the current token
  for GitHub requests. The Runner uses that same token for full-history
  checkout. Checkout disables submodules, hooks, and LFS smudge; it then
  removes the credential and authenticated remote before the agent starts.
  The token file, service registration, network policy, Sandbox, and
  temporary source are removed during terminal cleanup, with expiry as the
  fallback.
- The model credential is resolved on the trusted runner host through Docker's
  custom-secret proxy and never enters the Worker request.
- Repository-provided OpenCode configuration and host skills/MCP/SSH settings
  are not loaded or shared in v1; the review agent uses only the static-review
  tool policy inside the isolated microVM.

The callback contains only named evidence fields for `manifest.json`,
`opencode.jsonl`, `opencode.stderr`, `validated-review.md`,
`opencode-session-list.json`, and one matching `opencode-export-SESSION.json`.
The complete local recovery tree may retain OpenCode DB/state/log artifacts;
those are never serialized into the callback bundle.

## Minimal persistence

D1 stores only queryable product state:

- GitHub delivery ID and processing result;
- installation and repository IDs;
- PR number, base SHA, head SHA, trigger, status, and timestamps;
- maintainer approval bound to repository, PR number, and head SHA; and
- review completion state needed for idempotency.
- evidence object key, status, size, SHA-256, and execution/submission/cleanup
  timestamps.

The originating manual comment id is carried in the immutable manual job
input needed by the Runner Job; it is not a separate feedback table.

The bounded named-field bundle itself is stored as one private R2 JSON object
per Job. D1 does not store its content. It does not store repository contents,
complete diffs, credentials, model transcripts, or finding fingerprints for
inline comments.

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
