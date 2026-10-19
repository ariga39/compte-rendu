# Review model configuration

Multi-model execution is available through the sbx/OpenCode Runner and external
LLM service. Deploy migration `0012_review_configuration.sql` and the compatible
Core and Runner before enabling a non-null selection. Missing routes or incomplete
reviewer evidence fail the job without a vote; no legacy reviewer is substituted.
See [installation](installation.md#multi-model-review-configuration) for rollout.

## Ownership

Each Core instance stores its active selection and revision in D1. The LLM service
owns the configured routes, upstream endpoints, protocols and credentials. A
selection contains only route IDs: it cannot install a provider, supply a URL,
change agent permissions or contain a key. The same route ID must continue to mean
the same upstream model while queued or executing jobs reference it.

The initial intended reviewers are DeepSeek V4.1 Flash and Step 5 Preview, with
DeepSeek V4.1 Flash for synthesis. They are configuration choices, not program
constants. The examples below assume the operator has configured the corresponding
`deepseek-review` and `step-review` routes on that instance's LLM service.

## Operator API

The ingress forwards `/api/review-configuration` to Core. Core requires a dedicated
`REVIEW_CONFIGURATION_TOKEN` bearer secret for both reads and writes. Missing or
incorrect credentials receive 401. Runner, callback and GitHub webhook credentials
do not grant access. Leave the secret unset to disable this interface.

Configure the secret with the existing instance-specific Core Wrangler config:

```sh
wrangler secret put REVIEW_CONFIGURATION_TOKEN --config <CORE_WRANGLER_CONFIG>
```

Enter the secret at the prompt. For command-line HTTP clients, load the header from
a private client configuration file rather than putting the secret in arguments.
No dashboard editor or browser login is included in this slice. The public
dashboard remains read-only; a future editor must authenticate the operator and
use this same validation/update operation behind its authenticated server boundary.

`GET /api/review-configuration` returns:

```json
{ "revision": 0, "selection": null }
```

`PUT /api/review-configuration` accepts the revision just read and the whole new
selection:

```json
{
  "revision": 0,
  "selection": {
    "reviewers": ["deepseek-review", "step-review"],
    "synthesis": "deepseek-review"
  }
}
```

A successful write returns 200 with the incremented revision. A stale revision
returns 409; reload before deciding whether to retry. Invalid data returns 400 and
does not change the active selection. At least one reviewer route (distinct when there are several) and
one synthesis route are required. With one reviewer, that reviewer returns the
final result directly; the synthesis route is used only when combining multiple
reviewers. Synthesis may reuse a reviewer model. Unknown
fields are rejected. Requests are limited to 16 KiB, matching the LLM grant-control
payload budget rather than an inference or review-output limit. Responses are
`Cache-Control: no-store`.

Use `selection: null` with the current revision to use the Runner-configured
default model for newly admitted jobs. It uses the same review prompt and final
output contract as an explicit one-model or multi-model selection. This does not modify already admitted jobs.
Saving a syntactically valid route ID does not prove upstream availability; the
execution adapter must validate support when preparing the job's grant.

## Admission snapshots

Migration `0012_review_configuration.sql` initializes the selection to null and
adds a snapshot column to review runs. Creation of a review run reads the active
selection inside the same database statement that creates the run. Its revision
and selection are frozen before the job is queued. Runner claim responses carry
that snapshot as `reviewConfiguration`.

Changing the selection needs no Core or Runner restart. Previously queued and
running jobs retain their snapshots; new jobs use the new revision. Updating a
selection does not create a job, restart a review or bypass the existing same-PR
guard. A new explicit retry uses the configuration active at its own admission.
Historical runs are not backfilled or relabeled. Runs admitted with legacy
single-review behavior continue without a multi-model snapshot.

Deploy the migration before upgraded Core code, and upgrade Runner to understand
the snapshot before enabling any selection. A selected job runs independent
reviewer sessions and one editorial synthesis inside a single Sandbox. It retains
its frozen configuration and participant evidence, and publishes only after
validation, grant revocation and confirmed Sandbox cleanup.
