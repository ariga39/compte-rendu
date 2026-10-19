# External LLM service design

Decision date: 2026-10-18. **Standalone service and sbx Runner integration
implemented; production rollout pending.** See [service setup and current scope](llm-service.md).
This service precedes multi-model review. Earlier provider probes establish only
narrow protocol compatibility, not production acceptance.

## Boundary and deployment

Run a persistent, independent systemd service on the Runner host, outside every
job Sandbox and outside the Runner process and its service cgroup. The proposed
package is `apps/llm-service` (a Node service, not a third Worker). Use
`@earendil-works/pi-ai` for upstream provider integration. OpenCode and Codex remain
agent runtimes: they own conversations and tools, not upstream credentials.

| Component     | Responsibility                                                                |
| ------------- | ----------------------------------------------------------------------------- |
| Core          | Durable job state, revision freshness and GitHub publication                  |
| Runner        | Claim, grant issuance/revocation, deadline, Sandbox wiring and cleanup        |
| Agent runtime | Tool execution, review sessions and structured output                         |
| LLM service   | Authorized model routing, upstream credentials, inference streaming and usage |

The service has no checkout, Sandbox CLI, review orchestration or publication
responsibility. It accepts model input, never executes requested tools. There is
no general workflow engine, billing system or credential administration UI.

Deploy each production instance with its own service configuration, credential
store, control socket and grant state. The binary may be shared; credentials,
model routes and usage attribution are not implicitly shared between instances.
Restarting Runner must not restart the inference service or its OAuth owner.

## Client protocols and routes

Initial routes cover the existing DeepSeek provider and ChatGPT subscription
access, without requiring a billed OpenAI API key. A configured route fixes the
upstream provider, model, credential and client protocol. Sandbox callers select
only an allowed route; they cannot supply an upstream URL, credential, provider
header or an unrestricted model override. Strip downstream authorization before
constructing upstream authentication. Reject unsupported protocol options rather
than silently dropping them or changing models.

Provider identity is explicit configuration, separate from the endpoint URL.
`opencode-go` uses pi-ai's native OpenCode Go provider even behind a custom
`baseUrl`; `openai-codex` uses its native subscription provider; explicitly
`openai-compatible` routes use a pi-ai custom provider. The authenticated grant's
job ID supplies `sessionId`, never a caller-provided routing header. Provider
adaptation must not be bypassed by calling the low-level API stream directly.

Prefer native protocol paths: Responses for the subscription route, and OpenAI-compatible
Chat Completions for DeepSeek/OpenCode.
The earlier Responses relay proved a narrow Codex/OpenCode subscription path,
not arbitrary cross-provider Responses translation. Pi's normalized streaming API
is not itself an HTTP server. Implement only the required protocol surfaces and
verify tool calls/results, reasoning, finish/error semantics and usage against the
pinned clients. Do not require every agent to support every model in the first slice.

For the initial single-review integration, Runner snapshots its startup model
route when admitting the job and passes that fixed route to grant issuance.
For the later multi-model feature, Core will carry the admission-time frozen
reviewer/synthesis route set in job input; Runner passes it to issuance without
rebuilding it from mutable configuration.

The allowlist comes from the frozen job model configuration: the single-review
route initially, and every reviewer plus synthesis route for multi-model jobs.
Agent input cannot add routes. Route definitions are stable for a live grant. Configuration changes apply to new
grants; credential refresh may change the upstream secret without changing the
route. Service failure never silently falls back to direct sandbox credentials.

## Job grants: four review budgets, no renewal

Use an opaque, cryptographically random bearer token per executing job. The
service generates it on an authenticated Runner control request and stores its
hash plus instance/job identity, allowed routes, issuance/expiry times and active
state. Return the secret once; never log it, put it in command arguments, commit
it or include it in exported sessions or public dashboard payloads.

Issue after the Runner owns the claim and before agent execution, not when the PR
is admitted to Core's queue. A grant expires `4 × REVIEW_ATTEMPT_BUDGET_MS` after
issuance (currently two hours); there is no renewal endpoint or sliding expiry. The execution deadline must fit
inside that lifetime, leaving the existing budget for export and cleanup. Reject
an incompatible job budget before starting model work: require the absolute
execution/finalization deadline to be no later than grant expiry. The existing
30-minute agent budget fits; queue wait is excluded because issuance follows claim. Four hours is a possible
later policy change, not an automatic extension or an option required now.

All reviewers and synthesis within one job share this token and its route allowlist.
It authorizes inference only, not GitHub, grant administration or another job.
It is a bearer capability, not proof of which child session made a request. The
service attributes usage to the bound job; child identity comes from runtime evidence.

Runner delivers it through the existing runtime credential mechanism, with
session/export redaction verified in acceptance. The Sandbox may know the job
token; upstream API keys, subscription access tokens and refresh tokens remain
exclusively on the service host. A stolen job token is usable only within its
granted routes/lifetime and reachable inference endpoint; it is not an upstream key.

Issue at most once per instance/job; duplicate issuance is rejected. If issuance
is ambiguous, fail the job and revoke by job identity, without needing the lost
token. Do not retry issuance or model execution within that job. Retain the grant
record, including its revoked state, until expiry so revocation cannot enable
reissuance. A later explicitly triggered review gets a fresh job identity, token
and Sandbox; it is not an automatic retry.

## Control, networking and trust

Expose grant creation and idempotent revocation only through a host Unix socket
with permissions for the owning Runner/service users. The Sandbox-facing HTTP
listener exposes inference only. A job token cannot invoke control operations.
Repository text, agent tool arguments and inference request bodies cannot change
the allowlist or request a new grant.

Do not assume that Sandbox localhost is the Runner host. Before rollout, prove
an actual sbx and OpenShell path to the service using their supported networking.
Bind to the narrow reachable host interface, restrict ingress to the intended
Sandbox path, and use authenticated TLS or an equivalently protected runtime
transport for bearer tokens. Do not introduce a public internet listener merely
to solve host reachability. Keep unrelated egress closed under the existing policy.
The exact address/certificate/runtime wiring is a rollout probe deliverable,
not an already verified recipe in this document.

### Migration from current credential wiring

Current implementation sections in `design.md` describe direct provider access;
they are not the new service contract. For service-enabled jobs, agent base URLs
and model egress point only to the service. sbx custom-secret injection carries
the job token instead of resolving an upstream model key. Remove direct upstream
model allowances and resolver wiring for those jobs; preserve GitHub access.

OpenShell currently uses a pre-provisioned gateway model provider (credentials
are gateway-side, not baked into the Sandbox). That shared provider cannot express
a distinct job token. Integrating the service requires a job-owned model provider
pointing to it with the job grant, using existing ownership-safe provider cleanup.
Prove credential injection, multiple route selection and cleanup in the OpenShell
probe before enabling that adapter; no fallback to the shared upstream provider.
Deliver sbx first, then OpenShell, without claiming both are accepted early.

## Completion, cancellation and restarts

Runner revokes the grant as soon as model work ends, including success, failure,
cancellation or supersession, and any post-issuance setup/budget rejection before
model work starts. It does not wait for Sandbox destruction or token
expiry. Core signals cancellation through the existing Runner lifecycle; the LLM
service does not query GitHub or Core on every model call. Supersession revocation
therefore follows cancellation delivery, not an instantaneous database transaction.
Core's final revision check remains the publication authority.

Revocation atomically prevents new requests and aborts active upstream streams for
the grant. Expiry does the same, even for a stream opened just before expiry.
Client disconnect before a protocol terminal event aborts its upstream request;
a disconnect after successful logical completion is normal teardown, even before
HTTP EOF, and must not relabel success as cancellation. Backpressure must bound buffering.
Do not retry a partially emitted stream automatically or turn an upstream failure
into successful completion. Cancellation cannot undo tokens already generated or
charges already incurred upstream.

Runner attempts revocation in its finalization path independently of evidence
export and Sandbox destruction. A failed acknowledgement is recorded and retried
within the remaining finalization budget; it must not prevent Sandbox cleanup.
Unconfirmed revocation is a failed job with no review vote, not a claim that access
was removed. The fixed expiry remains the upper bound if control is unreachable.
Grant revocation is separate from the existing confirmed Sandbox cleanup state.

Keep grants in memory initially. Service restart invalidates all grants and closes
streams; it does not reconstruct or reissue them. Affected jobs fail terminally through the
existing Runner finalization path; there is no automatic fresh attempt. Planned
maintenance must pause new claims and direct admission while allowing admitted
jobs and callbacks to finish before service restart. That pause mechanism is an
integration requirement, not a currently implemented concurrency setting; zero
concurrency is invalid and must not be used to drain. An unexpected crash still
fails in-flight jobs. Only an explicit new review trigger creates replacement jobs. Runner restart does not
renew grants; existing orphan Sandbox recovery/cleanup still applies and must revoke the
orphan job grant by identity as well. An unrevoked
grant after a Runner crash expires at its original deadline. This is an explicit
availability tradeoff, avoiding a persistent grant database for the first slice.

## Upstream credentials and operations

Store DeepSeek API keys in the same host-only credential boundary; they never
enter agent configuration or a Sandbox credential provider.

Give the service a dedicated subscription login and exclusive refresh ownership.
Serialize refresh per upstream account and atomically persist refreshed credentials
in a host-only store. Do not copy a developer's changing auth cache into jobs or
run multiple refresh owners against the same credential state. This upstream OAuth
refresh is distinct from the deliberately non-renewable job token.

Provider throttling and subscription availability remain real limits. Propagate
bounded, sanitized failures; record job/route, timings, outcome and available usage
without request bodies, raw sessions or credential headers in routine service logs.
Keep existing private review evidence separate. Use finite request/connect timeouts
within the job expiry and bounded input/buffering limits matched to actual client
payloads; do not inherit an unrelated claim-body limit as an inference limit.
No generic quota platform or new production concurrency value is selected here.

## Delivery and acceptance

Use behavior TDD through Runner and the HTTP/control boundary, with Effect 4
runtime conventions. Deliver the external service for single-review jobs first;
multi-model orchestration is a later consumer, not part of this implementation.

1. Establish the minimal service and one route, authenticated job grant and expiry.
   Verify allowed requests and rejection of wrong/expired/revoked tokens, forbidden
   routes and control access from the inference interface. Verify duplicate issuance
   is rejected and ambiguous/control-failed issuance terminates the job, attempts
   identity-based revocation and never silently reissues.
2. Integrate both required upstreams and pinned clients. Exercise actual repository
   review/tool turns, structured result validation and inspectable useful output,
   not only PONG. Prove dedicated subscription login, refresh and persistence.
3. Prove Sandbox networking/credential paths incrementally: sbx acceptance before
   its rollout, OpenShell acceptance before enabling that adapter. Inspect retained artifacts for
   leaked grant/upstream credentials, preserve existing GitHub/tool permissions,
   and show separately configured production instances (as defined above) cannot
   access each other's routes or credentials.
4. Exercise timeout, midstream error, disconnect, expiry, cancellation, supersession,
   failed revocation, Runner crash and service restart. Confirm upstream abort
   attempts, no false completion, independent Sandbox cleanup and no failed vote.
5. Measure streaming compatibility, resource use and provider throttling with the
   existing job capacity before switching production. Roll back routing only for
   new jobs; never silently swap protocol/provider inside an executing job.

Acceptance must include live protocol/network/refresh probes plus targeted failure
fixtures. Existing loopback PoCs did not establish these operational properties.

## LiteLLM backend adoption

Model protocol adaptation and upstream credentials move to a pinned, loopback-only
LiteLLM Proxy. The Node HTTP/control service retains job grants, route authorization,
trusted job session headers, cancellation and sanitized diagnostics. It forwards
native request payloads instead of converting them into pi-ai Context. LiteLLM
configuration owns upstream model names/base URLs/keys; Node routes name its aliases.
No PostgreSQL, LiteLLM virtual-key migration or usage database is required for this
slice. Existing Runner route IDs and socket contracts remain unchanged.

This supersedes the pi-ai-specific refresh implementation above. LiteLLM 1.106.0
subscription refresh uses non-atomic file writes without a refresh lock; it does
not inherit our former serialized/atomic credential guarantees. Subscription
routes are optional and require separate activation validation. The deployment
in this slice keeps the existing API-key DeepSeek and Step routes.
