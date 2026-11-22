# Managed inference relay

The application Worker authorizes a Runner grant against the claimed job, attempt and frozen review selection. The inference Worker accepts that grant at the endpoint selected by the frozen route profile, forwards streaming requests to the configured Cloudflare AI Gateway BYOK provider, and records usage in the installation’s relay D1 database. Provision both Workers and the catalog using the [installation guide](installation.md#configure-the-managed-inference-relay).

### Remote relay transport

Set the following variables on an sbx or OpenSandbox Runner:

```dotenv
RUNNER_LLM_RELAY=1
RUNNER_LLM_RELAY_GENERATION=<RELAY_BACKEND_GENERATION>
RUNNER_CALLBACK_URL=https://<INGRESS_HOST>/runner-callback
RUNNER_CALLBACK_TOKEN=<static-runner-callback-token>
REVIEW_MODEL_CONFIG={"id":"opencode-go/deepseek-review","baseUrl":"https://<INFERENCE_FQDN>/v1","definition":{"name":"DeepSeek review"}}
```

Use the HTTPS callback origin and its Runner bearer for grant control. The inference hostname must be a separate HTTPS FQDN on port 443 with base path `/v1`. The Sandbox receives a job-scoped credential through the runtime’s secret injection mechanism. Supplier credentials and the Gateway Run token stay in Cloudflare. OpenShell uses its own provider integration.

The Runner calls `/runner-llm/issue` with the run ID, job ID, attempt and routes. The profile-aware endpoint is `/runner-llm/issue-v2`; it returns only the grant token, expiry and one client descriptor per frozen route: `{ routeId, profile, limit? }` where `profile` is `chat`, `responses`, `messages` or `gemini`. The descriptor omits the upstream model, provider slug, credential alias and URL. v1 remains a Chat Completions-only contract and keeps its historical response shape. Grants expire after four review budgets (currently six hours); Sandbox resource lifetime stays pinned separately at two hours. The Runner records the issuer origin and backend generation before issuance and revokes by job ID on completion or cancellation. Keep the generation stable for the corresponding relay D1 database. An unreachable issuer or unrecognized marker blocks further admission until recovery. See [maintenance drain](operations.md#drain-before-maintenance).

### Upgrading an installation with the former local service

Use the previous Runner to finish any queued jobs without frozen selections, drain running work and resolve every pending grant against its original issuer. Check that the instance’s `llm-grant-pending` directory has no entries. Remove `RUNNER_LLM_SERVICE_SOCKET` from the effective Runner environment before starting the new binary. A legacy marker requires the previous software and its issuing service for recovery. Keep rollback binaries, configuration and credentials together; never rewrite markers to point at a different issuer.

Managed grant v1 supports Chat Completions only. Use grant v2 for every roster containing a non-Chat route, including Responses and Messages. Check the [inference protocols](#inference-protocols) available in your deployed release. Installations using the former ChatGPT subscription backend need a provider credential supported by Gateway BYOK before migrating.

### Change a review model without restarting

Read the authenticated catalog after a successful refresh, then update the [review configuration](review-configuration.md) using its current revision. Each queued job keeps its admission snapshot. The relay freezes route mappings when issuing the job’s grant.

## Per-job model and token usage

Runner retrieves usage from `/runner-llm/usage` after revocation and includes it in the callback. Core persists the summary for dashboard reads. Relay D1 groups requests by route and observed model, including incomplete requests. The summary includes up to 32 groups and indicates truncation.

Reported counters include input, uncached input, cache reads and writes, output and reasoning. Reasoning is included in output. Each counter records how many requests reported it. Missing usage is displayed as unknown and does not invalidate the review.

## OpenCode recovery and terminal state

OpenCode 2 can recover a `provider.invalid-output` stream error while its CLI
still exits with code 1. Runner accepts that observed case only when the exact
session export proves successful completion and its final assistant JSON passes
the shared decision/Markdown contract. Each recoverable error must have the
observed HTTP 200 shape and belong to the same session. If final JSON needs a
correction, recovery eligibility is checked for each invocation: an earlier
known error cannot excuse a generic failure in the correction round. Unknown
errors, other nonzero exits, timeout, truncation, identity mismatch and incomplete
required evidence fail without publication. See [final output](review-decisions-design.md#final-output-and-publication).

Other structured OpenCode provider errors are recorded as model-request
failures (`upstream`, phase `agent`), with an HTTP status when the event reports
400–599. Core persists that status and the dashboard displays it separately from
invalid review output (`invalid_output`, phase `output_validation`). Raw provider
messages are not included in the public failure record. Existing historical
classifications are unchanged. Apply migration `0014_failure_http_status.sql`
before deploying Core/dashboard, then update Runner after
draining active jobs. The nullable column preserves compatibility with older
callbacks while the rollout completes.

The original CLI exit code and error events remain in the evidence. A sanitized
`Runner accepted recovered OpenCode session` log records the job/session identity
when reconciliation succeeds. CLI exit or client disconnection alone never proves
that a server-managed session has stopped; the exported terminal state is required.
Grant revocation and confirmed Sandbox destruction still run before final success.

### Reading AI Gateway analytics

For a catalog using Gateway discovery, the application’s minute cron sends a
`GET /models` through the Gateway. These requests can appear with an empty model
and zero tokens. Filter Analytics by the reviewer’s upstream model ID to see its
inference traffic. A streaming response that includes usage can populate the
input and output token counts. The review dashboard shows usage attributed to
the individual job.

The relay sends `cf-aig-skip-cache: true`, so a Gateway response-cache miss is
expected. Provider input-cache reads are accounted for separately in the
reported token usage. A zero Gateway cost can coexist with subscription
allowance consumption. Consult the provider’s billing data for that amount.

### Runner grant version

`RUNNER_LLM_GRANT_VERSION` defaults to `1`. Enable `2` only after Core and the
inference Worker serve versioned grants. In v2 the Runner requests
`/runner-llm/issue-v2` and configures each selected model from the returned
route descriptor. The descriptor selects a bundled adapter and can specify
context and output limits. All models use the existing sandbox inference
hostname and job credential. Issuance is attempted once. An unavailable v2
endpoint or a descriptor set that differs from the frozen selection fails the
job and triggers grant cleanup.

### Inference protocols

Chat routes use `POST /v1/chat/completions`. Responses routes use
`POST /v1/responses` with foreground streaming, local function tools and
`store: false`. The relay accepts inline tool results and encrypted reasoning
replay. It rejects hosted tools, remote references and cross-protocol calls.
Only `response.completed` with a completed response and a durable usage update
ends the stream successfully. Incomplete or failed turns keep partial usage.
Responses terminal events are capped at 4 MiB; larger events fail the turn.

Messages routes use `POST /v1/messages` with streaming, local function tools and
signed thinking/tool continuations. The relay accepts inline tool results and
rejects hosted tools, remote media, file ids and server-state references. Only a
complete `message_stop` ends the turn successfully; `max_tokens` and `pause_turn`
keep partial usage and fail the stream. A protocol refusal may finish the
transport turn but is never accepted as a review result.

Gemini routes use
`POST /v1beta/models/<handle>:streamGenerateContent?alt=sse`, where the handle is
`r-` plus the unpadded base64url route ID. Set the pinned Google provider's
baseURL to `<relay>/v1beta`; a bare relay origin produces `/models/...` and is
intentionally not accepted. The relay maps the handle to the frozen upstream
model, accepts local function calls with thought signatures and function
responses, and rejects hosted tools, file or inline media, cached server content
and cross-protocol calls. Usage counts thoughts in output and reports them
separately as reasoning.

### Managed relay model catalog

Set the inference Worker's `RELAY_CATALOG_SOURCES` variable to a JSON array.
Every source names a Gateway destination in `providerSlug` and its BYOK credential alias.
Use `native:openai` for Cloudflare’s built-in OpenAI provider. Bare names continue
to select custom providers, so `openai` and `custom-openai` both select
`/custom-openai`. Use a new route ID when changing an existing route’s destination.
For a provider account hosted directly by Anthropic or Google AI Studio, use
`native:anthropic` or `native:google-ai-studio` with a BYOK alias for that
provider. Their bundled adapters use the native `messages` or `gemini` profile.
Deploy the corresponding inference endpoint before enabling its routes in a
roster. Catalog discovery and grant issuance can succeed before the deployed
Worker serves that protocol.
Gateway discovery follows Anthropic’s `after_id` cursor or Google's
`pageToken` cursor. Declare verified routes in `models` when the list supplies
IDs without tool capability metadata, or use explicit aliases. The Gemini
route uses the Google Generative Language v1beta endpoint.

Choose discovery according to how that provider exposes its model list.

- For a public list, set `url` to its credential-free HTTPS endpoint and
  `prefix` to the prefix for discovered review routes. Public lists use the
  generic catalog envelope (`data` with model IDs or capability metadata), even
  when inference uses a native Gateway destination. Use Gateway discovery to
  read the vendor's native list and cursor format.
- For a protected list, set `"discovery": "gateway"` and `prefix`. The relay
  calls the provider's `/models` endpoint through Gateway using its BYOK alias.
  Confirm this endpoint lists the selected models before cutover.
- For fixed routes, provide a nonempty `aliases` map from review route ID to
  upstream model ID. A source with only aliases makes no discovery request.
  A discovery source can also declare aliases for the same upstream.

Custom and OpenAI destinations default to Chat Completions. Anthropic and
Google AI Studio default to their native protocols as described above. Set
`profile` to a default profile or `profiles` to the distinct profiles a rich
catalog may publish (`chat`, `responses`, `messages`, `gemini`). For custom and OpenAI destinations, ID-only entries and aliases use the default.
The list independently filters rich entries, which prefer the default when it is eligible. Rich entries
are filtered from their advertised `api` operations; models that advertise no
configured protocol are omitted. `models` is an explicit allowlist keyed by
review route ID. Use it for ID-only endpoints that list unrelated models: only
named routes become visible, and each entry declares its trusted profile and
optional `limit`:

```json
{
  "discovery": "gateway",
  "prefix": "openai-platform/",
  "providerSlug": "native:openai",
  "credentialAlias": "review",
  "models": {
    "openai-platform/gpt-6.2-sol": {
      "profile": "responses"
    }
  }
}
```

For an ID-only listing, a non-chat profile is never inferred from the source
default. Responses, Messages and Gemini routes require an explicit `models`
entry; a qualified source may still expose a chat default without one. An
explicit `capabilities.tools.supported: false` always omits that model, even for
a legacy unqualified source. Malformed rich capability metadata fails the source
refresh and keeps the previous snapshot.

The route mapping, profile and configured limit are immutable once published.
Changing any of them for an existing route is a mapping conflict and keeps the
previous snapshot; use a new route ID. Limit equality is semantic, so object key
order does not create a conflict. Sources without `models` keep their existing
unqualified discovery behaviour.

For example, this configuration discovers models on one authenticated upstream
and preserves a historical route served by another upstream.

```json
[
  {
    "discovery": "gateway",
    "prefix": "review-provider/",
    "providerSlug": "custom-review",
    "credentialAlias": "default"
  },
  {
    "aliases": { "deepseek-review": "deepseek-v4.1-flash" },
    "providerSlug": "custom-legacy",
    "credentialAlias": "default"
  }
]
```

The application Worker's minute cron refreshes the private relay catalog.
Read `GET /api/review-configuration/catalog` on the application origin with
the review configuration operator bearer to see route IDs and refresh status.
The catalog returns the latest complete list per discovery source. A valid
empty list withdraws that source's candidates; a failed refresh preserves its
last complete list. Existing reviews can still resolve their frozen route IDs.
Apply the relay D1 migrations before deploying the inference Worker. Verify a
successful scheduled refresh and the expected model IDs on this endpoint before
rolling out the dashboard. See [model selection](review-configuration.md#selectable-model-catalog).
