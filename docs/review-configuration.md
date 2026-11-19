# Review model configuration

Multi-model execution is available through the sbx or OpenSandbox runtime with OpenCode and the managed
inference relay. Deploy migration `0012_review_configuration.sql` and the compatible
Core and Runner before enabling a non-null selection. Missing grant routes or an
invalid final result fail without a vote; no fallback reviewer is substituted.
Child-session evidence is best effort, not an extra publication gate.
See [installation](installation.md#multi-model-review-configuration) for rollout.

## Ownership

Each Core instance stores its active selection and revision in D1. The inference Worker owns the route catalog. AI Gateway owns upstream endpoints and BYOK credentials. A
selection contains only route IDs: it cannot install a provider, supply a URL,
change agent permissions or contain a key. The same route ID must continue to mean
the same upstream model while queued or executing jobs reference it.

## Selectable model catalog

An editor choosing a reviewer needs to know which models this installation's
configured providers advertise. Free-text entry would require the editor to know both the
upstream model ID and the installation's route prefix; it would still leave the
relay needing a trusted mapping before it can issue a grant.

Both production installations have a discovery source. Use those lists to
populate Settings. Fetching them in the settings request would put provider
latency and outages on every edit. The existing scheduled refresh already pays
the discovery cost and can serve a last-known list when a provider is down.
A public provider list can differ from the models an individual credential can
invoke. Describe the list as provider-advertised; a successful authenticated
inference remains the evidence that a model worked for a particular request.

### Refresh and storage

Keep the existing immutable route mappings for grant issuance. Store each source’s complete selectable membership in one D1 row, including
a valid empty list. A shared refresh timestamp orders the atomic batch. Derive the source key from normalized provider
slug, credential alias, discovery mode, prefix and configured URL where applicable.
Reordering configuration must not change identity. Explicitly configured aliases
can be resolved from configuration separately from discovered membership, so a
failed network request cannot keep a deleted alias in the picker.

Use the existing scheduled refresh. Publish new mappings and replace the source's
members in one guarded D1 transaction. Reject an older completion, a conflicting
route mapping, or a change that would exceed 1,000 distinct selectable routes.
Keep the previous snapshot on rejection. Historical mappings do not consume that
budget. Restrict reads to currently configured sources and remove obsolete
memberships during refresh. A changed source configuration requires deployment;
changes to a provider's advertised models take effect on refresh.

Accept a complete list according to the configured endpoint's listing contract.
For a single-page source, reject a continuation signal (for example a next link,
a next cursor or a true has-more flag), invalid entries, and malformed or
oversized responses. A paginated provider must be read through its final page
before publishing any replacement. A bare first page without continuation
metadata cannot establish completeness unless the endpoint contract says it can.
A valid complete empty list withdraws that source's candidates. An interrupted
or invalid response retains its last successful list. Show a refresh warning
when serving cached choices after failure. An initial failed refresh has no
choices to contribute.

### Selection and execution

Read candidates from the active membership in Settings and the catalog API.
Validate explicit selections against that list at save time in both Settings and
the operator API. Show a saved reviewer or synthesis model that has disappeared
as unavailable and let the editor replace it. If an alias duplicates a discovered
route to the identical provider, credential and model, present the discovered
route for new choices and retain the old ID on existing configurations and jobs.

Keep the saved selection until an editor changes it. Removing a model from the
picker does not prove that requests using its ID will fail. An existing selection
(including the installation default) can therefore still run. No catalog read is
needed at webhook admission. Core freezes the selected revision when queueing;
the relay resolves those IDs when issuing a grant. Upstream refusals follow the
existing job failure path. Configuration revisions order editor writes only;
the scheduled refresh time orders catalog updates independently.

On migration, keep existing route mappings and start discovery memberships
empty. Populate from an initial complete refresh before switching picker reads.
If a source cannot refresh, expose its discovery failure, and never fill its
list with unverified historical mappings. On a healthy refresh the picker should
go from A and B to B and C without intervention, while a job queued with A can
still resolve its original route. Also verify source removal, complete empty
lists, partial and overlapping refreshes, and a saved synthesis model withdrawn
between opening and saving the form.

## Operator API

The public SvelteKit Worker routes `/api/review-configuration` to its Core module,
which requires a dedicated
`REVIEW_CONFIGURATION_TOKEN` bearer secret for both reads and writes. Missing or
incorrect credentials receive 401. Runner, callback and GitHub webhook credentials
do not grant access. Leave the secret unset to disable this interface.

Configure the secret with the instance-specific public Worker Wrangler config:

```sh
wrangler secret put REVIEW_CONFIGURATION_TOKEN --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc
```

Enter the secret at the prompt. For command-line HTTP clients, load the header from
a private client configuration file rather than putting the secret in arguments.
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
    "reviewers": ["review-provider/deepseek-v4.1-flash", "review-provider/glm-5.3-flash"],
    "synthesis": "review-provider/deepseek-v4.1-flash"
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

Use `selection: null` with the current revision to select the installation default.
For the managed relay, set the application Worker's `RELAY_DEFAULT_MODEL_ROUTE`
to a catalog route. Core freezes that route as a single-reviewer selection when
it inserts each new run. The operator API continues to show the configured
selection as null. It uses the same review prompt and final
output contract as an explicit one-model or multi-model selection. This does not modify already admitted jobs.
Saving a syntactically valid route ID does not prove upstream availability; the
execution adapter must validate support when preparing the job's grant.

## GitHub dashboard editor

The Settings link opens `/settings`. Configure each application Worker with its own
GitHub App client ID in `DASHBOARD_GITHUB_CLIENT_ID`, its canonical HTTPS origin
in `DASHBOARD_ORIGIN`, and a JSON array of numeric GitHub user IDs in
`DASHBOARD_MODEL_EDITOR_IDS` (default `[]`). Register
`https://<dashboard-host>/auth/github/callback` as a callback on the existing
GitHub App. Store that App's client secret as the Worker secret
`DASHBOARD_GITHUB_CLIENT_SECRET`. Rotating it also invalidates browser sessions.
The user authorization flow uses PKCE. GitHub chooses the permissions of an
App user token from the App registration and the authorizing user.

The editor calls GitHub's authenticated-user endpoint on each settings read
and save. The numeric UID allowlist is the sole editor authorization rule.
These GitHub App user tokens can omit private profile fields, so editing does
not require a GitHub account 2FA status.
The public task dashboard needs no
session. The editor lists this instance's inference catalog and uses the same
revision check and admission snapshots as the operator API.

## Admission snapshots

Migration `0012_review_configuration.sql` initializes the selection to null and
adds a snapshot column to review runs. Creation of a review run reads the active
selection inside the same database statement that creates the run. Its revision
and selection are frozen before the job is queued. Runner claim responses carry
that snapshot as `reviewConfiguration`.

Changing the selection needs no Core or Runner restart. For a new model on an
already configured provider, select its discovered native `provider/model` ID using the
[restart-free model change procedure](llm-service.md#change-a-review-model-without-restarting)
before saving the selection. Previously queued and
running jobs retain their snapshots; new jobs use the new revision. Updating a
selection does not create a job, restart a review or bypass the existing same-PR
guard. A new explicit retry uses the configuration active at its own admission.
Historical runs are not backfilled or relabeled. Finish legacy jobs without a frozen selection before enabling the managed relay.

Deploy the migration before upgraded Core code, and upgrade Runner to understand
the snapshot before enabling any selection. A one-reviewer selection runs directly. A larger selection uses independent
reviewers and one synthesis inside a single Sandbox. It retains
its frozen configuration and participant evidence, and publishes only after
validation, grant revocation and confirmed Sandbox cleanup.
