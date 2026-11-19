# Managed inference relay

The application Worker authorizes a Runner grant against the claimed job, attempt and frozen review selection. The inference Worker accepts that grant at `POST /v1/chat/completions`, forwards streaming requests to the configured Cloudflare AI Gateway BYOK provider, and records usage in the installation’s relay D1 database. Provision both Workers and the catalog using the [installation guide](installation.md#configure-the-managed-inference-relay).

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

The Runner calls `/runner-llm/issue` with the run ID, job ID, attempt and routes. Grants expire after four review budgets (currently four hours); Sandbox resource lifetime stays pinned separately at two hours. The Runner records the issuer origin and backend generation before issuance and revokes by job ID on completion or cancellation. Keep the generation stable for the corresponding relay D1 database. An unreachable issuer or unrecognized marker blocks further admission until recovery. See [maintenance drain](operations.md#drain-before-maintenance).

### Upgrading an installation with the former local service

Use the previous Runner to finish any queued jobs without frozen selections, drain running work and resolve every pending grant against its original issuer. Check that the instance’s `llm-grant-pending` directory has no entries. Remove `RUNNER_LLM_SERVICE_SOCKET` from the effective Runner environment before starting the new binary. A legacy marker requires the previous software and its issuing service for recovery. Keep rollback binaries, configuration and credentials together; never rewrite markers to point at a different issuer.

The managed endpoint supports streaming Chat Completions. Installations that depend on the retired host service’s Responses API or ChatGPT subscription backend must retain their previous release until they have a replacement.

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

### Managed relay model catalog

Set the inference Worker's `RELAY_CATALOG_SOURCES` variable to a JSON array.
Every source names a Gateway custom provider and its BYOK credential alias.
Choose discovery according to how that provider exposes its model list.

- For a public list, set `url` to its credential-free HTTPS endpoint and
  `prefix` to the prefix for discovered review routes.
- For a protected list, set `"discovery": "gateway"` and `prefix`. The relay
  calls the provider's `/models` endpoint through Gateway using its BYOK alias.
  Confirm this endpoint lists the selected models before cutover.
- For fixed routes, provide a nonempty `aliases` map from review route ID to
  upstream model ID. A source with only aliases makes no discovery request.
  A discovery source can also declare aliases for the same upstream.

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
