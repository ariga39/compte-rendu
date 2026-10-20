# Public review dashboard

The dashboard is public and read-only. It shows persisted review runs, their
lifecycle and history. Every page/API read uses D1 only: it never contacts Runner
or GitHub, inspects live processes or queues metadata work. Core refreshes
repository metadata independently. End-user instructions live in
[Help Markdown](../apps/dashboard/src/lib/content/help.md).

## Pages and language

| Page             | Behavior                                                                         |
| ---------------- | -------------------------------------------------------------------------------- |
| `/`              | Queued/in-progress counts, last-24-hour published/failed counts and current work |
| `/history`       | Newest-admitted-first history, status/date filters and cursor pagination         |
| `/jobs/<run-id>` | Shareable detail, recorded revision, decision and lifecycle                      |
| `/help`          | Markdown documentation, not a refreshable data page                              |

A task is one admitted Core run, not a webhook or a PR. Retries have separate
runs/URLs; ignored events do not appear. One multi-model review still has one task.

UI labels are Queued, In progress, Published, Failed and Superseded. Published
means Core recorded publication, not a successful model exit. Decision is separate:
Approve, Request changes or Comment; unknown historical decisions show an em dash.
The decision records the original review, not current GitHub merge eligibility.
Resource cleanup is in technical details, not a primary count or filter.

Counts come from an aggregate query. Published/failed last-24-hour counts use the
admission timestamp, not a guessed terminal time. Current work lists claimed runs
first, then queued work oldest first. History lists newest first. A page has 25
items. Filters use receipt dates and the same status predicates as the table;
changing filters discards the scoped cursor. Older pages retain their cursor on
refresh. Cursors contain time/run identity and filter scope, not repository data.
Counts and lists are separate requests, not an atomic cross-endpoint snapshot
([#197](https://github.com/ariga39/compte-rendu/issues/197)).

Public identity shows the repository/PR link, recorded source/target branches and
base/head commits. Missing historical branch names say Not recorded. Anonymous
rows expose none of those facts. Identity can be anonymous because it is private,
unverified or expired; the label does not assert which.

Detail distinguishes queue wait, total duration and recorded milestones. Stage
age is not a heartbeat or model execution duration. Missing/inconsistent timing
endpoints do not produce invented durations. A long-unchanged stage does not mark
a task failed. An uncertain publication may already have posted a review.

## Interface and navigation

The single SvelteKit Worker renders overview, history and detail HTML from the
same DB-backed public projection used by the JSON API. Known-private and unknown
repository identities remain anonymous in HTML as well as JSON. Responses use
`Cache-Control: no-store`. TanStack Query prefetch/dehydrate/hydrate transfers
the initial cache without a duplicate task fetch; browser navigation and refresh
continue through Query. See [SSR implementation](single-worker-ssr.md). Carbon Svelte supplies components and spacing;
IBM Plex Mono is served locally for all text. Tables have named columns, readable
cell spacing, text status labels, keyboard focus and horizontal overflow on narrow
screens. Loading, empty, stale, failure and missing-task states remain distinct.

The header contains navigation, last successful refresh and Refresh now; the
footer links the project and build commit. Branding comes from Core's Check name.
Help explains mechanics without adding implementation narration to data pages.

Selecting a row opens details beside the list on desktop. Narrow screens use a
modal full-screen drawer with previous/next controls. Shallow browser history
preserves filters and scroll; Back/Close/Escape closes the drawer, and modified
clicks/Open full page preserve the permanent job link. Header refresh targets the
open detail; mobile drawers provide their own refresh control.

Focus returns to the selected row when the drawer closes. If a refresh removes
that row, focus returns to the list heading instead. Close, Back and Escape share
this restoration path and retain the saved list scroll position.

## Database lifecycle and progress

Product status remains `scheduled | completed | failed | superseded`. Separate
facts describe assignment, execution stage, Core processing, decision and cleanup.
Core owns product state; Runner observations do not overwrite it.

| Recorded data                                  | Meaning                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `created_at`, `claimed_at`, `terminal_at`      | Admission, first assignment and first product terminal time |
| Progress sequence/stage/receipt/milestones     | Latest accepted snapshot for the exact run/job/attempt      |
| `result_received_at`, `publication_started_at` | Core processing transitions                                 |
| Failure phase/reason                           | Bounded categories, never raw exception text                |
| Cleanup                                        | Pending, destroyed or failed; historical null means unknown |
| Branch and visibility snapshots                | Admission-time facts, not later inferred history            |

Stage labels map `checkout` → Fetching code, `sandbox` → Preparing environment,
`agent` → Reviewing, `evidence` → Saving run records, `cleanup` → Finishing up.
Core processing takes precedence over an older execution report. The historical
`submissionCompletedAt` field means **Result checks started**: Runner writes it
after archival, before determining a valid result. `cleanupCompletedAt` is also
written on cleanup failure; only `destroyed` proves successful cleanup.

Authenticated `/runner-progress` carries strict bounded identity, attempt,
sequence, stage and cumulative milestone data. Runner sends on stage transitions,
coalesces pending reports, allows one in flight and applies a two-second timeout.
A reporting failure does not block execution/cleanup or terminal callback.
Terminal callbacks include cumulative progress to recover missed reports.

Core conditionally accepts only advancing sequence/stage with matching ownership
and unchanged earlier milestones. Duplicate/stale snapshots are no-ops. Live
progress cannot revive terminal work, publish a result or confirm destruction.
Terminal callbacks may still fill missing lifecycle evidence and confirm cleanup.
Historical absent timestamps/stages are not backfilled from archives.

## Refresh mechanism

TanStack Svelte Query owns browser requests, cancellation and ephemeral caching:

| State                            | Automatic delay                                   |
| -------------------------------- | ------------------------------------------------- |
| Active work or pending cleanup   | 15 seconds                                        |
| Settled detail or no active work | 60 seconds                                        |
| Consecutive failures             | 30, 60, 120, up to 300 seconds                    |
| Hidden/offline                   | Pause, then refresh on focus/visibility/reconnect |

Requests use up to 10% positive jitter, a 15-second timeout and one in-flight
request per query. Success resets backoff; longer valid Retry-After is respected,
including manual/focus refresh. Settled pages still poll because cleanup and
identity can change. Navigation cancels obsolete work; stale responses cannot
replace the current task. Unobserved query cache is removed (`gcTime: 0`).

Failures preserve non-identifying operational data but clear repository identity.
Show freshness/error state, not fabricated zero counts. No response is persisted
in localStorage/IndexedDB or cached by a CDN; APIs use `Cache-Control: no-store`.
No websocket, SSE dashboard transport or generic refresh service is needed.

## Repository metadata and disclosure

Shared metadata is keyed by installation and repository ID. Admission records
source visibility and ensures a missing metadata row exists as unknown; it does
not wait for a dashboard-only GitHub request or overwrite existing fresh metadata.
Authoritative repository reads and the scheduled refresh update verified names.
Renames follow stable repository ID rather than a historical name reused elsewhere.

Disclosure requires both eligible run provenance (public source snapshot or
verified legacy-public eligibility) and unexpired verified-public metadata.
Known-private source snapshots never become public merely because visibility later
changes. Otherwise the server returns an opaque anonymous run without repository/
installation ID, PR number/link, branches, SHAs, title, actor or evidence identifiers.
No grouping pseudonym links anonymous runs to each other.

Core Cron runs once per minute. The current defaults are a global batch of eight,
three concurrent lookups and a two-second lookup timeout. Successful checks target
a two-minute interval; errors defer a row rather than leave it oldest forever.
Per-row revision/claim checks prevent older refreshes overwriting newer invalidation.
403/429 responses stop new dispatch and persist cooldown; 404/private observations
invalidate identity. A signed private/access-removal webhook also invalidates;
a public webhook can request refresh but cannot renew disclosure by itself.

Identity expires five minutes after verification start. Failed refreshes never
extend that limit. A visibility change can remain visible until observation or
expiry; already disclosed information cannot be retracted. Browser expiry uses
server-relative lifetime and elapsed time, including offline/hidden-tab resume,
so browser clock skew cannot extend it. Normal browsing makes zero GitHub calls.

Fixed refresh bounds are not inventory-aware quota or invocation-budget control.
Backlog observability and validation of that capacity bound are tracked in
[#196](https://github.com/ariga39/compte-rendu/issues/196). Deployments must measure
whether their repository inventory and GitHub quota fit the cadence. Keep private inventory and measurements outside public documentation.

## History and Check links

Legacy public-identity enrichment is a separate, verified operator migration,
not an on-read lookup. It must preserve known-private snapshots, record legacy
eligibility separately and leave unresolved repositories anonymous. It must not
invent historical stages, timestamps or outcomes. The original deployment
performed this one-time enrichment; the repository has no supported enrichment CLI.

When `DASHBOARD_ORIGIN` is configured, each product-created Check uses its own
`/jobs/<run-id>` in `details_url`, including recovered Checks and retry runs.
Other Apps' or Actions' status links are not changed. The Check name comes from
`GITHUB_CHECK_NAME`, defaulting to `Compte-rendu review`.

## Interfaces and verification

Public reads are `/api/dashboard-config`, `/api/dashboard`, `/api/jobs` and
`/api/jobs/:runId`. A scoped cursor mismatch is 400, a missing run is 404 and a
failed DB read is 503. They neither fetch external state nor expose raw evidence.
The separate configuration API is authenticated and is not a dashboard editor.

Tests exercise public Worker HTTP with fresh instances sharing D1, authenticated
progress/terminal callbacks, the store query seam and TypeScript Playwright
against the built frontend. They cover privacy/expiry, pagination, ownership,
terminal races, polling, drawers and failure presentation. See
[installation](installation.md#public-dashboard) for assets, Cron and deployment
requirements. Runtime sources are `apps/core/src/dashboard.ts`,
`review-state-store.ts`, `apps/dashboard/src/lib/` and the shared contracts.

### Model usage

Detail pages and drawers show the persisted per-job model/token summary after
Timing. Model names omit the provider prefix for display only; persisted and API
identifiers remain unchanged. Token and request counts are collapsed by default
and expand on click or keyboard activation. Counts
come from the grant service through Runner's terminal callback, not from live
Runner/provider reads. Route and reported model are distinct. Missing fields say
Not reported; known subtotals identify how many requests reported them. Input/cache
and output/reasoning are overlapping totals, not additive costs. Cache read shows
its share of input total only when both counts cover all requests and input total
is positive. Anonymous reviews
retain these aggregate statistics without gaining repository/branch identity.
