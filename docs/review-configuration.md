# Review model configuration

Multi-model execution is available through the sbx or microsandbox runtime with
OpenCode and the managed inference relay. Missing grant routes or an invalid final
result fail without a vote; no fallback reviewer is substituted. Child-session
evidence is best effort, not an extra publication gate. See
[installation](installation.md#review-model-configuration) for the current
deployment procedure.

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

Keep the existing immutable route mappings for grant issuance. Route mapping
and profile remain immutable; provider or operator model metadata, including
context and output limits, refreshes normally and affects the next grant.
Already-issued grants keep their frozen mapping.
Store each source’s complete selectable membership in one D1 row, including
a valid empty list. A shared refresh timestamp orders the atomic batch. Derive the source key from normalized provider
slug, credential alias, discovery mode, prefix and configured URL where applicable.
Reordering configuration must not change identity. Explicitly configured aliases
can be resolved from configuration separately from discovered membership, so a
failed network request cannot keep a deleted alias in the picker.

Use the existing scheduled refresh. Publish new mappings and replace the source's
members in one guarded D1 transaction. Reject an older completion, a conflicting
route mapping, or a change that would exceed 1,000 distinct selectable routes.
Keep the previous snapshot on rejection. Historical mappings do not consume that
budget. If another source frees capacity later in the same refresh, a rejected source can use it on the following refresh. Restrict reads to currently configured sources and remove obsolete
memberships during refresh. Changing a source URL or prefix creates a new source with no prior list. A changed source configuration requires deployment;
changes to a provider's advertised models take effect on refresh.

Accept a complete list according to the configured endpoint's listing contract.
For a single-page source, reject a continuation signal (for example a next link,
a next cursor or a true has-more flag), invalid entries, and malformed or
oversized responses. A paginated provider must be read through its final page
before publishing any replacement. The relay follows explicit next-page URLs on the same HTTPS origin and path. Cursor-only continuations preserve the previous snapshot. A bare first page without continuation
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

Keep existing route mappings while discovery memberships are populated from a
complete refresh. If a source cannot refresh, expose its discovery failure, and
never fill its list with unverified mappings. On a healthy refresh the picker should
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
{ "revision": 0, "selection": null, "concurrency": null }
```

`PUT /api/review-configuration` accepts the revision just read, the whole new
selection, and an optional desired Runner concurrency:

```json
{
  "revision": 0,
  "selection": {
    "reviewers": ["review-provider/deepseek-v4.1-flash", "review-provider/glm-5.3-flash"],
    "synthesis": "review-provider/deepseek-v4.1-flash"
  },
  "concurrency": 3
}
```

`concurrency` is any positive safe integer. Omit `selection` to change only
concurrency: Core keeps the
installed roster and frozen effort snapshot as-is and does not require the
inference relay to be reachable. Omit `concurrency` to preserve the stored
value during an ordinary selection update. Send `null` to clear the deployment
override so every Runner returns to its `RUNNER_CONCURRENCY` startup fallback.
The value is independent of `selection`, so it can be set while the instance
default is active. It does not modify a frozen job configuration or an effort
snapshot.

A successful write returns 200 with the incremented revision. A stale revision
returns 409; reload before deciding whether to retry. Invalid data returns 400 and
does not change the active selection. At least one reviewer route (distinct when there are several) and
one synthesis route are required. With one reviewer, that reviewer returns the
final result directly; the synthesis route is used only when combining multiple
reviewers. Synthesis may reuse a reviewer model. Unknown
fields are rejected. Requests are limited to 16 KiB, matching the LLM grant-control
payload budget rather than an inference or review-output limit. Responses are
`Cache-Control: no-store`.

Runner claim 200/204 responses carry the stored concurrency in
`x-compte-rendu-concurrency`. An explicit clear sends `default`; a transient
read failure omits the header. A full Runner discovers changes with an
authenticated `HEAD /runner-claim`, which returns the header with an empty body
and never claims. `POST` remains the only claiming method.

Use `selection: null` with the current revision to select the installation default.
For the managed relay, set the application Worker's `RELAY_DEFAULT_MODEL_ROUTE`
to a catalog route. Core freezes that route as a single-reviewer selection when
it inserts each new run. The operator API continues to show the configured
selection as null. It uses the same review prompt and final
output contract as an explicit one-model or multi-model selection. This does not modify already admitted jobs.
Saving a syntactically valid route ID does not prove upstream availability; the
execution adapter must validate support when preparing the job's grant.

## Dashboard sign-in and model settings

Use **Sign in with GitHub** in the dashboard header. Signing in from a job
returns you to that job. The header shows the account and offers **Sign out**.
Anyone can browse public pages, and signing in does not grant editing rights.

Configure each application Worker with its own
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
Public pages render independently of GitHub. After the page loads, the header
reads the viewer and permissions from the private, uncached `/api/session` endpoint.
The editor at `/settings` lists this instance's inference catalog and uses the same
revision check and admission snapshots as the operator API.

## Admission snapshots

Without an explicit saved selection, the deployment uses its installation
default. Creation of a review run reads the active selection inside the same
database statement that creates the run. Its revision and selection are frozen before the job is queued.
Runner claim responses carry that snapshot as `reviewConfiguration`.

Changing the selection needs no Core or Runner restart. For a new model on an
already configured provider, select its discovered native `provider/model` ID using the
[restart-free model change procedure](llm-service.md#change-a-review-model-without-restarting)
before saving the selection. Previously queued and
running jobs retain their snapshots; new jobs use the new revision. Updating a
selection does not create a job, restart a review or bypass the existing same-PR
guard. A new explicit retry uses the configuration active at its own admission.
Historical runs are not backfilled or relabeled. A one-reviewer selection runs
directly. A larger selection uses independent
reviewers and one synthesis inside a single Sandbox. It retains
its frozen configuration and participant evidence, and publishes only after
validation, grant revocation and confirmed Sandbox cleanup.

## Thinking effort

Core stores an internal effort snapshot and per-route reset generations. The
public selection may include an `efforts` object that maps a selected route ID to
an operator-facing effort name:

```json
{
  "reviewers": ["review-provider/deepseek-v4.1-flash"],
  "synthesis": "review-provider/deepseek-v4.1-flash",
  "efforts": { "review-provider/deepseek-v4.1-flash": "high" }
}
```

The value is only a name. Requests never carry upstream thinking fields. Core
resolves the name against the relay catalog (`efforts[route][] = {name, controls}`)
and rejects an unknown route, an unknown name or any extra field. The relay
catalog is trusted input; the browser cannot invent `reasoning_effort`,
`thinking`, `reasoning`, budgets or aliases. This menu applies to both Chat and
Responses routes; Responses routes select a `reasoning.effort` name through the
same settings control and freeze it the same way. A route without a name keeps
the client's existing request behaviour. Removing a name returns that route to
the default.

Saving writes the public selection and an internal frozen snapshot. It freezes
only the routes that this selection actually executes: the single reviewer, or
all reviewers plus synthesis when there is more than one reviewer. A different
configured synthesis route is not frozen or granted for a single-reviewer job.
Each execution route gets one generation and, when chosen, the name and trusted
controls from the catalog. Default generation-0 entries without an explicit
effort are omitted because they carry no instruction; a nonzero generation is
kept for reset semantics. Admission copies the snapshot into the run's
`reviewConfiguration` in the same D1 statement that creates the run. Changing or
removing a catalog option later does not rewrite an existing save or queued job.
Editor-facing settings show a missing saved name as unavailable and require a
replacement before the next save.

`POST /runner-llm/issue-v2` receives the frozen `{routeId, generation, name,
controls}` entries for the routes the job actually uses, and the relay validates
them against its trusted history. Entries for routes outside the grant, including
an unused synthesis route in an older snapshot, are not forwarded. The thawed job
snapshot and `multi-review.json` retain the frozen selection, including efforts.

### Fallback state and explicit reset

The relay may switch a route to the upstream default after a verified parameter
rejection. That shared state is keyed by the instance-local route ID and is not
copied into grants or per-job rows. Settings read it with the relay
`effortStates()` control call and show **Fallback · using upstream default**, the
first switch time and the controlled reason next to the selected route.

An explicit reset advances only that route's Core generation. `POST
/review-configuration/efforts/reset` (dedicated operator token) and the
dashboard's same-origin, editor-authorized `POST /api/model-settings/effort-reset`
accept `{revision, route}`. The reset uses the ordinary configuration revision:
a stale revision returns 409 and does not advance the generation. It applies
only to runs admitted after the reset; already queued, claimed or running jobs
keep the generation frozen at their admission. Ordinary configuration saves
never reset a route.

Core keeps the advanced generation on a later ordinary save, even when that save
omits effort names. Otherwise a post-reset save could freeze generation 0 again
and reactivate the older relay marker. Settings hide a relay state whose
generation is older than the Core snapshot, so a successful reset removes the
live fallback badge while historical job summaries remain unchanged.

### Public detail and authorized request details

The public detail response keeps the admission snapshot separate from token
usage:

```json
{
  "efforts": {
    "selection": [
      { "route": "review-provider/deepseek-v4.1-flash", "name": "high", "generation": 0 }
    ],
    "summary": [
      {
        "route": "review-provider/deepseek-v4.1-flash",
        "selected": "high",
        "generation": 0,
        "outcomes": [
          { "kind": "switched", "reason": "upstream rejected reasoning_effort", "requests": 1 }
        ]
      }
    ]
  }
}
```

While a run is active only `selection` is meaningful; `summary` is `null` until
the terminal callback's usage snapshot is stored. A route that was configured but
never called has no execution outcome. The page does not claim to know the
upstream's internal thinking strength.

The current editor may load bounded per-request ledger records with `GET
/api/jobs/:runId/effort-details` (optional `cursor` and `route`). The endpoint
requires the same editor authorization as settings and reads the relay
`effortDetails()` control call; it never exposes prompts, raw upstream bodies,
credentials, signatures or reasoning content. `route` filters the retained rows
to one reviewer route, so an operator can jump directly to a specific model
across pages instead of paging through other requests. An invalid route is a
`400`, not a "no longer retained" `404`.

Each request returns its ledger `status` (`pending`, `complete` or
`incomplete`), the configured effort, at most two attempts with the sent and
reported allowlisted controls, and `complete`, `rejected` or `incomplete` per
attempt. `nextCursor` supports further retained pages. A missing grant or an
expired ledger returns a controlled "no longer retained" response.

The UI keeps these dimensions separate. A completed request with no retained
attempt row shows a neutral "attempt detail not recorded"; it is not a crash and
not a running request. A `pending` row with no attempt row says only that no
completion or attempt record was retained: a failed request can still carry
`pending` because partial saving does not change the status column. An
unrecognised or absent sent control is shown as "no allowlisted effort
recorded", never asserted to be the upstream default. A missing or unrecognised
upstream report is "no recognized effort recorded": a null report does not prove
the provider omitted the field, because a value outside the allowlist is also
dropped to null. Historical rows are read as-is; the ledger is not backfilled.
