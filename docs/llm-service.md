# Managed inference relay

The application Worker authorizes a Runner grant against the claimed job, attempt and frozen review selection. The inference Worker accepts that grant at the endpoint selected by the frozen route profile, forwards streaming requests to the configured Cloudflare AI Gateway BYOK provider, and records usage in the installation’s relay D1 database. Provision both Workers and the catalog using the [installation guide](installation.md#configure-the-managed-inference-relay).

### Remote relay transport

Set the following variables on an sbx or microsandbox Runner:

```dotenv
RUNNER_LLM_RELAY=1
RUNNER_CALLBACK_URL=https://<INGRESS_HOST>/runner-callback
RUNNER_CALLBACK_TOKEN=<static-runner-callback-token>
REVIEW_MODEL_CONFIG={"id":"opencode-go/deepseek-review","baseUrl":"https://<INFERENCE_FQDN>/v1","definition":{"name":"DeepSeek review"}}
```

Managed inference is the Runner's only model credential path. `RUNNER_LLM_RELAY=1`
and an unset value are equivalent; direct-provider configuration such as
`MODEL_SECRET_COMMAND` or a model config without this relay `baseUrl` is
rejected at startup. An existing `RUNNER_LLM_RELAY_GENERATION` setting is
ignored; no issuer generation is required.

Use the HTTPS callback origin and its Runner bearer for grant control. The inference hostname must be a separate HTTPS FQDN on port 443 with base path `/v1`. The Sandbox receives a job-scoped credential through the runtime’s secret injection mechanism. Supplier credentials and the Gateway Run token stay in Cloudflare.

The Runner calls `/runner-llm/issue-v2` with the run ID, job ID, attempt and routes. It returns only the grant token, expiry and one client descriptor per frozen route: `{ routeId, profile, limit?, metadata? }` where `profile` is `chat` or `responses`. `metadata` carries only the OpenCode-supported model description, such as name, family, release date, capabilities and cost. The descriptor omits the upstream model, provider slug, credential alias and URL. This is the sole grant path; `/runner-llm/issue` is removed. Grants expire after four review budgets (currently six hours); Sandbox resource lifetime stays pinned separately at two hours. The Runner revokes by job ID on completion or cancellation with a bounded retry. An unconfirmed revocation fails only that review and never blocks later admissions; the fixed expiry bounds a lost response or crash. See [maintenance drain](operations.md#drain-before-maintenance).

### Change a review model without restarting

Read the authenticated catalog after a successful refresh, then update the [review configuration](review-configuration.md) using its current revision. Each queued job keeps its admission snapshot. The relay freezes route mappings when issuing the job’s grant.

## Per-job model and token usage

Runner retrieves usage from `/runner-llm/usage` after revocation and includes it in the callback. Core persists the summary for dashboard reads. Relay D1 groups requests by route and observed model, including incomplete requests. The summary includes up to 32 groups and indicates truncation.

Reported counters include input, uncached input, cache reads and writes, output and reasoning. Reasoning is included in output. Each counter records how many requests reported it. Missing usage is displayed as unknown and does not invalidate the review.

## OpenCode recovery and terminal state

OpenCode 2 can recover a `provider.invalid-output` stream error while its CLI
still exits with code 1. Runner accepts that observed case only when the exact
session export proves successful completion and its final assistant submission
passes the shared decision/Markdown contract. Each recoverable error must have
the observed HTTP 200 shape and belong to the same session. If the final
submission needs a correction, recovery eligibility is checked for each
invocation: an earlier
known error cannot excuse a generic failure in the correction round. Unknown
errors, other nonzero exits, timeout, truncation, identity mismatch and incomplete
required evidence fail without publication. See [final output](review-decisions-design.md#final-output-and-publication).

Other structured OpenCode provider errors are recorded as model-request
failures (`upstream`, phase `agent`), with an HTTP status when the event reports
400–599. Core persists that status and the dashboard displays it separately from
invalid review output (`invalid_output`, phase `output_validation`). Raw provider
messages are not included in the public failure record. Existing historical
classifications are unchanged. The persisted status is optional on older
callbacks.

The original CLI exit code and error events remain in the evidence. A sanitized
`Runner accepted recovered OpenCode session` log records the job/session identity
when reconciliation succeeds. CLI exit or client disconnection alone never proves
that a server-managed session has stopped; the exported terminal state is required.
Grant revocation and confirmed Sandbox destruction still run before final success.

### Reasoning effort injection and route fallback

Chat routes may declare a narrow, protocol-validated effort menu in the relay
catalog. The menu is a sparse source-level `efforts` map keyed by the actual
route ID; it is orthogonal to the optional `models` allowlist. Existing
`models` profile/limit allowlists keep their current behavior. For the initial
target models, on an otherwise unrestricted discovery source:

```json
{
  "discovery": "gateway",
  "prefix": "review-provider/",
  "providerSlug": "custom-review",
  "credentialAlias": "default",
  "efforts": {
    "review-provider/deepseek-v4.1-flash": [
      { "name": "high", "controls": { "reasoning_effort": "high" } }
    ],
    "review-provider/mimo-v2.6-flash": [
      { "name": "off", "controls": { "thinking": { "type": "disabled" } } }
    ]
  }
}
```

Routes without an entry (including newly discovered ones) keep an empty menu.
Declaring an effort on a route with an explicit non-Chat profile, or on a
discovery route whose effective profile resolves to non-Chat, rejects that
source refresh. With an existing `models` allowlist, only allowlisted routes
remain visible; `efforts` never re-enables a filtered route.

The menu is mutable only through a successful source publication. Changing,
removing or adding a same-name effort updates new grants; a failed refresh
keeps the previous menu and model snapshot, and already-admitted jobs keep their
frozen controls. Effort changes never alter alias/discovery visibility.

Only `reasoning_effort` (`minimal`, `low`, `medium`, `high`, `max`) or
`thinking.type: "disabled"` is accepted, exactly one per effort. The browser
submits route IDs and effort names only. Core resolves the trusted controls and
freezes `{routeId, generation, name, controls}` at admission. The grant sends that
frozen list to the relay. The relay validates snapshot entries by Chat protocol and granted
route only, never against the mutable current menu, so a later settings edit does
not invalidate an admitted job.

For a request with an explicit effort, the relay removes every competing
top-level Chat thinking control (including client `reasoning_effort`) and adds
only the frozen controls. With no selected effort, client controls pass through
unchanged.

A fallback is enabled only for the verified DeepSeek Chat deserializer rejection
([OpenCode Go field report](https://github.com/anomalyco/models.dev/issues/3962),
[sanitized 400 envelope](https://github.com/bytedance/deer-flow/issues/4514)).
It requires status 400, a DeepSeek Chat route, `error.type` and `error.code` both
`invalid_request_error`, `error.param: null`, and a message whose
`reasoning_effort: unknown variant \`<value>\``names exactly the value injected
for this request. The relay makes one second attempt with all supported Chat
thinking switches, efforts, budgets and aliases removed, after rechecking the
same pending request, grant revocation/expiry and cancellation. Generic 400s,
other fields, rate limits, auth errors, transport errors, timeouts and started
streams never retry. MiMo`thinking` injection is supported, but it has no
automatic recovery until a verified rejection sample exists.

Fallback state is one row per route in relay D1. A grant generation at or below
the tripped generation uses the upstream default; a newer generation (an explicit
Core reset) tries the configured effort again. The switch is committed atomically
with that request's completion, only when completion still owns the pending row
and the grant is valid. The relay logs one structured event only when the
watermark actually advances. It does not write state per frame or per normal
request, and admission reads the state in the same statement that records the
request.

`effortStates()` returns the current route markers for settings.
`effortDetails({jobId, cursor})` returns at most 20 authorized per-request
attempt observations with keyset pagination. The terminal `ModelUsageSummary`
carries a small per-route outcome summary aggregated across the whole job; it
never embeds per-request attempts.

For performance acceptance, compare the same streaming upstream, route count and
concurrency across three groups: no selected effort, explicit effort, and shared
fallback. Measure D1 round trips, rows read and rows written per request, first
byte p50/p95, upstream-terminator-to-client-terminator p95, and the extra upstream
round trip plus D1 cost of the first fallback. Normal admission and completion
must not add D1 round trips; fallback state is read by the same admission
statement and written only by an actual switch.

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

`RUNNER_LLM_GRANT_VERSION` must be unset or `2`; the Runner always requests
`/runner-llm/issue-v2` and configures each selected model from the returned
route descriptor. An explicit value of `1` or anything other than `2` fails
startup so a half-upgraded unit cannot issue legacy grants. The descriptor
selects a bundled adapter and can specify context and output limits plus the
OpenCode-supported model description. All models use the existing sandbox
inference hostname and job credential. Issuance is attempted once. An unavailable v2
endpoint or a descriptor set that differs from the frozen selection fails the
job and triggers grant cleanup. A failed issuance records a fixed `grant`
Runner diagnostic. An invalid body on a successful response, including a
descriptor-set mismatch, is `invalid-response`; HTTP, timeout and transport
failures keep their own reasons. The diagnostic never includes the response
body, descriptors or grant token.

### Inference protocols

Chat routes use `POST /v1/chat/completions`. A single raw SSE frame, including
its event/data lines and separators, is limited to 4 MiB before parsing; a
larger frame fails the turn. After the finish marker, at most 32 frames and
64 KiB of terminal tail are held until `[DONE]`; either excess fails the turn.
The complete stream has no cumulative byte cap.

Responses routes use
`POST /v1/responses` with foreground streaming, local function tools and
`store: false`. The relay accepts inline tool results and encrypted reasoning
replay. It rejects hosted tools, remote references and cross-protocol calls.
Only `response.completed` with a completed response and a durable usage update
ends the stream successfully. Incomplete or failed turns keep partial usage.
Responses terminal events are capped at 4 MiB; larger events fail the turn.

Both protocols validate only the security boundary: the grant-bound model and
route, local function tools and tool selection, request size, and accepted
content shapes. Message content accepts only local text and refusal parts;
Responses input items are limited to local message text/refusal, function calls,
function results and encrypted reasoning. Any image or other media part,
including an inline `data:` URL, is rejected. Hosted tools, remote media or file
references, prior provider-stored audio references and server-side state are also
rejected. Other optional provider fields, including output settings such as Chat
`modalities` and `audio`, are forwarded unchanged; bounding inputs does not
narrow output configuration. The relay still forces the frozen model,
`store: false` and `stream: true`.

The former Messages (`POST /v1/messages`) and Gemini
(`POST /v1beta/models/<handle>:streamGenerateContent`) wire protocols are
retired. Those endpoints return 404, and the corresponding native
`messages`/`gemini` profiles and `native:anthropic`/`native:google-ai-studio`
destinations are removed. This is a deliberate breaking change. Models from
those providers remain usable through an OpenAI-compatible Chat or Responses
provider.

### Managed relay model catalog

Set the inference Worker's `RELAY_CATALOG_SOURCES` variable to a JSON array.
Every source names a Gateway destination in `providerSlug` and its BYOK credential alias.
Use `native:openai` for Cloudflare’s built-in OpenAI provider. Bare names continue
to select custom providers, so `openai` and `custom-openai` both select
`/custom-openai`. Use a new route ID when changing an existing route’s destination.
Direct native Anthropic and Google AI Studio destinations are not supported by
this release; models from those providers remain usable through an
OpenAI-compatible Chat or Responses provider.
Gateway discovery reads the generic catalog envelope and pagination used by the
destination. Declare verified routes in `models` when the list supplies IDs
without tool capability metadata, or use explicit aliases.

Choose discovery according to how that provider exposes its model list.

- For a public list, set `url` to its credential-free HTTPS endpoint and
  `prefix` to the prefix for discovered review routes. Public lists use the
  generic catalog envelope (`data` with model IDs or capability metadata), even
  when inference uses a native Gateway destination.
- For a protected list, set `"discovery": "gateway"` and `prefix`. The relay
  calls the provider's `/models` endpoint through Gateway using its BYOK alias.
  Confirm this endpoint lists the selected models before cutover.
- For fixed routes, provide a nonempty `aliases` map from review route ID to
  upstream model ID. A source with only aliases makes no discovery request.
  A discovery source can also declare aliases for the same upstream.

Chat is the legacy default only for an entry that has neither a source-level
`profile`/`profiles` value nor an explicit `profile` under `models`; advertised
protocol metadata does not filter those entries. Set `profile` to a default
profile or `profiles` to the distinct profiles the source may publish (`chat`,
`responses`) to negotiate protocols. Only a negotiating source filters rich
entries by their advertised `api` operations and publishes only configured
protocols; an entry that advertises none of them is omitted. Rich entries prefer
the default when it is eligible. Aliases use an explicit `models` profile
override when present, otherwise the source default. Without a model override,
an ID-only entry can use only a Chat default because discovery cannot verify
a non-Chat operation. `models` is an explicit allowlist keyed by review
route ID. Use it for ID-only endpoints that list unrelated models: only
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
default. Responses routes require an explicit `models`
entry; a qualified source may still expose a chat default without one. An
explicit `capabilities.tools.supported: false` always omits that model, even for
a legacy unqualified source. Malformed rich capability metadata fails the source
refresh and keeps the previous snapshot. For a negotiating source, rich entries
that advertise only retired Messages or Gemini operations are omitted instead of
defaulting to Chat; a legacy Chat source does not use advertised protocols to
filter.

The route mapping and profile are immutable once published. The rest of the
model description, including context and output limits, is ordinary refreshable
metadata whether it came from an operator override or the provider. A normal
refresh updates it, and the next grant uses the new value; an already-issued
grant keeps its frozen route mapping. Changing only a limit needs no new route
ID or manual override.

Runner treats a route ID in `provider/model` form as the OpenCode logical model
identity: the first path segment is the provider ID, the remainder is the short
model ID, and the full authorized route ID is still sent as the wire `modelID`.
This keeps same-named models from different prefixes separately selectable while
their requests continue through the job relay. Provider configuration uses that
same first segment as `canonical`; it does not inherit a native provider endpoint
or credential. Unqualified route IDs keep the historical `compte-rendu/<route>`
identity.

Discovery retains each provider's complete model entry. The v2 grant maps only
the OpenCode-supported model information at the client boundary: display name,
family, release date, tool/media capabilities, reasoning variants and per-token
cost, including cache read and write pricing. Provider transport fields such as
`api.base_url`, its SDK package and credential routing are not copied; Runner
still uses the trusted profile adapter, relay endpoint and route ID.

For example, this configuration discovers models on one authenticated upstream
and preserves a historical route served by another upstream.

```json
[
  {
    "discovery": "gateway",
    "prefix": "opencode-go/",
    "providerSlug": "custom-opencode-go",
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
Add `?models=1` to the same authorized request to include the complete retained
upstream record for each visible route. That detail is opt-in so the ordinary
settings list does not carry every provider object. Apply the relay D1 migrations
before deploying the inference Worker. Verify a successful scheduled refresh and
the expected model IDs on this endpoint before enabling model settings. See
[model selection](review-configuration.md#selectable-model-catalog).
