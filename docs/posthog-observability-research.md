# PostHog observability fit

Research date: 2026-09-04. Sources are current repository behavior and
first-party PostHog documentation only.

## Decision

PostHog can materially improve the review system as a **secondary, lossy
analytics surface**: review-funnel conversion, queue/execution/publication
latency, terminal failure categories, exception trends, and (later) aggregate
model usage. It must not become a control-plane or evidence dependency.

The smallest useful proof is three personless lifecycle events emitted by Core
after existing durable transitions: `review scheduled`, `review claimed`, and
`review finished`. Use the official Cloudflare Workers recipe, keep the sender
behind a narrow lifecycle-log boundary, and make every PostHog error a no-op.
Do not install the OpenCode plugin, export existing logs, add flags, or
instrument traces in this proof.

Compte rendu supports multiple independent installations. PostHog credentials
and routing therefore belong to each rendered deployment, never to source
defaults or a shared compiled artifact. A deployment that enables the proof
provides its own `POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST`, and non-sensitive
deployment alias as rendered instance configuration. PostHog documents the
project API key as intended for event ingestion and safe to expose in
client-side applications; it is not a secret. It still stays out of source so
independent installations can choose different projects without rebuilding.
A PostHog personal API key is sensitive and is neither needed nor allowed for
this capture-only integration. Separate installations may deliberately use
separate PostHog projects/keys, or share a project while remaining
distinguishable by the configured deployment alias
([project API key](https://posthog.com/docs/product-analytics/installation.md#2-initialize-posthog)).

This follows the product's existing boundaries: D1 is the sole durable queue
and product state, private R2 stores the bounded named-field evidence bundle,
the Runner retains local raw recovery evidence, and GitHub is the visible
publication surface ([design](design.md#deployment-shape), [minimal
persistence](design.md#minimal-persistence), [clean break](design.md#clean-break)).
The existing `OperationalLogEvent` contract is not the analytics input: it
lacks claim timing and trigger data, while its Runner variant can contain
command and `stderr`. Keep lifecycle analytics on its own closed contract and
never forward operational events wholesale
([contract](../packages/contracts/src/index.ts)).

## Runtime and product fit

| Capability                       | Official support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Fit here                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers event capture | `posthog-node` has a dedicated `workerd` export and does not itself require `nodejs_compat`. PostHog recommends one client per request, `flushAt: 1`, `flushInterval: 0`, and `captureImmediate()` plus `ctx.waitUntil()` because an isolate can terminate before asynchronous batches are sent. ([Workers guide](https://posthog.com/docs/libraries/cloudflare-workers.md))                                                                                                                                                            | Good for Core's derived lifecycle events. Delivery is observability-only and can still be absent; never wait for it before acknowledging a webhook or callback.                                                                                                                                                                                                                                      |
| Node Runner event capture        | The official Node SDK supports Node 20+, queues and batches asynchronously, and requires `shutdown()` to flush on exit; short-lived/serverless contexts should send immediately. ([Node guide](https://posthog.com/docs/libraries/node.md))                                                                                                                                                                                                                                                                                             | Supported by the Runner's Node runtime, but unnecessary for the first proof because Core already observes claim and terminal callback facts. Add Runner-side metrics only for a demonstrated blind spot.                                                                                                                                                                                             |
| Product analytics                | Server SDKs capture named events and properties. Setting `$process_person_profile: false` produces events without person profiles. ([capture](https://posthog.com/docs/product-analytics/capture-events.md), [Node anonymous events](https://posthog.com/docs/libraries/node.md#person-profiles-and-properties))                                                                                                                                                                                                                        | Best initial value: scheduled-to-published funnel, queue wait, end-to-end latency, and failure breakdowns without repository data.                                                                                                                                                                                                                                                                   |
| Error tracking                   | Node can autocapture uncaught exceptions/unhandled rejections or call `captureException`. Exceptions include type, message and stack frames; Workers can call `captureException`, but full stack processing requires filesystem/Node runtime APIs according to the Node error guide. ([Node error setup](https://posthog.com/docs/error-tracking/installation/node.md), [exception data](https://posthog.com/docs/error-tracking/capture.md), [Workers guide](https://posthog.com/docs/libraries/cloudflare-workers.md#error-tracking)) | Potentially useful for SDK/runtime defects, but not the first proof. Raw exception messages/stacks can contain URLs, paths, repository text, responses, or credentials. If adopted, manually create sanitized error classes/codes and suppress everything else before send; keep raw diagnostics only in the existing protected evidence/log paths.                                                  |
| Logs                             | PostHog accepts OpenTelemetry structured logs and supports search, attributes, trace context, alerts, patterns, and correlation with analytics. The official Node setup uses OTLP HTTP. ([Logs start](https://posthog.com/docs/logs/start-here.md), [Node logs](https://posthog.com/docs/logs/installation/nodejs.md))                                                                                                                                                                                                                  | Useful later for wide, sanitized request/run outcomes. Do not forward console output, Runner `stderr`, request/response bodies, OpenCode output, or current raw evidence. The official Workers page does not document a Workers-specific OTel Logs setup, so prove runtime compatibility separately before considering it.                                                                           |
| Distributed traces               | PostHog accepts standard OpenTelemetry spans and provides search and waterfalls. The feature is explicitly beta and its endpoint may change; the documented Node exporter uses OTLP HTTP/protobuf. ([tracing start](https://posthog.com/docs/distributed-tracing/start-here.md), [Node tracing](https://posthog.com/docs/distributed-tracing/installation/nodejs.md))                                                                                                                                                                   | Could later correlate ingress → Core → Runner callback latency, but adds SDKs and context propagation for a three-process path. It is disproportionate to the first proof and does not trace the private Sandbox automatically.                                                                                                                                                                      |
| Feature flags                    | Workers can await remote evaluation. Node supports boolean/multivariate flags. For stateless edge workers, PostHog recommends a KV split read/write cache pattern for local evaluation. ([Workers usage](https://posthog.com/docs/libraries/cloudflare-workers.md#usage), [Node flags](https://posthog.com/docs/feature-flags/installation/nodejs.md), [distributed evaluation](https://posthog.com/docs/feature-flags/local-evaluation/distributed-environments.md))                                                                   | Suitable only for reversible, non-critical telemetry sampling or a later presentation behavior. Never gate authorization, revision freshness, credential handling, output validation, publication, callback acceptance, or Sandbox cleanup on PostHog availability or a flag value.                                                                                                                  |
| AI observability                 | Standard `$ai_generation` events can carry trace ID, model/provider, token counts, latency, cost, stop reason and error metadata. The official OpenCode plugin additionally captures prompts, LLM input/output and tool input/output by default; privacy mode redacts that content while retaining token/cost/latency/model metadata. ([manual capture](https://posthog.com/docs/ai-observability/installation/manual-capture.md), [OpenCode plugin](https://posthog.com/docs/ai-observability/installation/opencode.md))               | Aggregate model latency/token/cost can be valuable later. Do **not** install the plugin in the review Sandbox: it adds a PostHog token and egress destination and, unless perfectly configured, captures exactly the prompts/tool/session material this project forbids exporting. If needed later, Core or the trusted Runner should construct a metadata-only event from already-validated fields. |

## What PostHog must not replace

- **D1 queue and state.** PostHog capture is an asynchronous analytics write,
  not the atomic claim/deduplication/revision state machine. A missing event
  must not change a run's product outcome.
- **R2 and local evidence.** PostHog is not the durable source for
  `manifest.json`, JSONL, stderr, the validated review, session list/export, or
  evidence hashes. Logs are short-retained and AI content is deliberately
  trimmed; PostHog also tells customers to omit data that cannot reach a third
  party ([data storage controls](https://posthog.com/docs/privacy/data-storage.md)).
- **GitHub publication truth.** Only the current-head check plus the visible
  GitHub `COMMENT` review/check/comment proves delivery to the intended
  revision. A `review finished` analytics event is a derived observation, not
  publication evidence.
- **Security and cleanup enforcement.** PostHog must not decide webhook
  validity, maintainer permission, credential scope, callback authenticity,
  output validity, head freshness, or whether the Sandbox was destroyed.

## Minimal proof of concept

Instrument **Core only** for one deployment and one PostHog project:

1. Create a narrow PostHog lifecycle sink containing only the three events
   below. Instantiate a per-request Workers
   client with immediate flushing and register the send with `waitUntil()`.
   Read the project key and host only from that deployment's bindings; never
   hard-code an installation's value in TypeScript or shared defaults. Do not
   introduce or request a personal API key.
2. Emit only after the corresponding D1 transition is confirmed: schedule,
   atomic Runner claim, and terminal state/publication attempt. Catch and drop
   initialization, timeout, capture, and shutdown errors. PostHog must add no
   new `4xx`/`5xx`, retry, or state transition.
3. Set each event's `distinctId` to that review's existing sanitized opaque
   `run_id`, so PostHog correlates funnel steps within one review rather than
   joining unrelated reviews through a shared system identity. Set
   `$process_person_profile: false` on every event, disable stored client IP
   data in the PostHog project, and do not call `identify`, `groupIdentify`,
   feature-flag evaluation, exception autocapture, or session replay.
4. Validate one dashboard only: counts/funnel for scheduled → claimed →
   completed/published; p50/p95 `queue_wait_ms` and `total_duration_ms`; and
   failure count by `failure_phase`/`failure_reason`. Compare the sampled run
   IDs against D1 and the visible GitHub review. A dashboard discrepancy is an
   observability defect, never a product-state correction.

Telemetry enablement must be explicit per deployment. `disabled` means no
client is constructed. `enabled` without the required secret/host emits a
bounded local configuration diagnostic and skips capture without changing the
review outcome; it must not silently report telemetry as healthy. Capture and
transport errors follow the same local diagnostic/no-product-impact rule.

### Event and property allowlist

Reject unknown application event names, properties, free-form values, and
strings over a small fixed bound before calling the SDK. `total_duration_ms`
runs from durable scheduling through the Core terminal/publication boundary;
it is not truncated at Runner cleanup.

| Event              | Allowed properties                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review scheduled` | `schema_version` (integer), `environment` (`production`/`staging`), `deployment` (configured bounded opaque alias), `run_id` (existing sanitized opaque ID), `trigger` (`automatic`/`manual`)                                                                                                                                                                                                                                                                                                                    |
| `review claimed`   | common fields above plus `queue_wait_ms` (non-negative integer)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `review finished`  | common fields above plus `outcome` (`completed`/`failed`/`superseded`), `published` (boolean), `total_duration_ms` (non-negative integer), `queue_wait_ms` (non-negative integer or absent), `cleanup_status` (`destroyed`/`failed`/`unknown`), `evidence_status` (`complete`/`incomplete`/`unknown`), `failure_phase` (`checkout`/`sandbox`/`agent`/`output_validation`/`evidence`/`callback`/`publication`/`cleanup`/`unknown`, only when failed), `failure_reason` (a closed code enum, never exception text) |

The official `posthog-node` transport adds only its standard envelope fields
(`timestamp` and `uuid`) and SDK properties (`$lib`, `$lib_version`,
`$is_server`, and `$geoip_disable`) after this application allowlist. These are
explicitly allowed transport metadata, not repository or review data. The wire
test asserts the complete scheduled-event envelope so an SDK upgrade cannot
silently widen it.

Explicitly forbidden are repository owner/name/URL/visibility/content, file
paths or diffs, PR/comment/delivery/installation/repository IDs, base/head SHA,
GitHub login/email, prompt or review Markdown, LLM input/output, tool calls or
arguments, JSONL/session/export/log/stderr/stack text, request/response bodies
or headers, IP/geolocation, and any credential, token, key, cookie, or secret.
Do not derive failure text by truncating it; map known internal reasons to the
closed enum and use `unknown` otherwise.

## Privacy, retention, and cost boundaries

- PostHog says storage-side controls apply **after data reaches PostHog Cloud**;
  data that cannot reach a third party must be omitted at collection. It offers
  pre-storage transformations, event dropping, IP anonymization, a project
  setting that discards stored client IPs, deletion tools, and an EU Cloud
  hosted in Frankfurt ([storage controls](https://posthog.com/docs/privacy/data-storage.md),
  [GDPR guide](https://posthog.com/docs/privacy/gdpr-compliance.md)). These are
  defense in depth, not a substitute for the client allowlist.
- Log PII scrubbing is opt-in, best-effort, non-retroactive, and explicitly
  misses multiple sensitive classes; PostHog recommends not sending PII in the
  first place ([Log scrubbing](https://posthog.com/docs/logs/pii-scrubbing.md)).
- Current Cloud pricing documents one-year retention on Free and seven years
  on pay-as-you-go. AI events' large input/output/tool properties are retained
  for 30 days while trimmed metadata persists. Logs retain 14 days by default;
  a paid add-on extends newly ingested logs to 30 days
  ([pricing](https://posthog.com/pricing.md), [AI retention](https://posthog.com/docs/ai-observability/data-retention.md),
  [Logs pricing](https://posthog.com/docs/logs/pricing.md)).
- Pricing-relevant free monthly tiers at the research date are: 1,000,000
  Product Analytics events; 1,000,000 feature-flag requests; 100,000 exception
  events; 100,000 AI Observability events; and 10 GB of logs. Above those tiers
  the official page lists usage-based rates and supports billing limits
  ([pricing](https://posthog.com/pricing.md)). Distributed tracing is beta and
  the official pricing page currently gives no separate trace unit/rate, so do
  not assume it is free or stable.

## Go/no-go criterion

Proceed beyond the proof only if it answers a recurring operational question
faster than D1 plus Cloudflare logs, while zero forbidden fields appear in a
captured-event audit and disabling/blocking PostHog has no observable product
effect. Otherwise keep the current system and remove the PoC; PostHog is a
convenience layer, not part of the review system's correctness argument.
