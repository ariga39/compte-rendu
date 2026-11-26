# Operations

Install first with the [installation guide](installation.md). Use the exact
instance configuration and preserve private evidence before maintenance.

## Correlated diagnosis

The one read-only root diagnosis command accepts a GitHub PR URL, delivery ID,
or run ID and emits one sanitized report assembled from GitHub, D1, and the
private R2 evidence bucket:

```sh
DIAGNOSTIC_D1_DATABASE=<INSTANCE_NAME>-review-state \
DIAGNOSTIC_R2_BUCKET=<INSTANCE_NAME>-review-evidence \
DIAGNOSTIC_WRANGLER_CONFIG=apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc \
corepack pnpm diagnose <PR_URL|DELIVERY_ID|RUN_ID>
```

The command invokes `gh` for GitHub and the workspace-pinned Wrangler through
`corepack pnpm --filter @compte-rendu/dashboard exec wrangler ... --config ...`
for the deployed D1 and R2 bindings. A relative config path is resolved from
the caller's working directory before Wrangler runs in the dashboard workspace.
There is no default database or bucket name: use the generated config and
resource names for the intended instance. Authenticate `gh` or provide
`GH_TOKEN` for repositories that require it.

Missing sources are reported without suppressing available sources. A complete
archive with one truncated or unreadable diagnostic artifact still shows every
readable manifest, session list and review material; the affected artifact is
marked truncated and no session metric is inferred from partial JSON. Historical
D1/R2 size and SHA correlation and manifest identity still gate the report.
Normal diagnosis never uses SSH; it mentions SSH only as a fallback for
Runner-host loss or cleanup recovery. Output contains sanitized identities,
states, timestamps, bounded stderr metadata, and artifact presence/size/hash—not
credentials, repository contents, review bodies, or raw model/session/tool
output.

## Publication and private diagnostics

Core publishes from the authenticated terminal callback. A slim `version: 2`
callback contains the validated structured result, exact run/job/attempt, stage,
timestamps and confirmed cleanup, plus only an evidence ID and status. Before
publication Core stores the small authoritative attempt-specific record
`reviews/<runId>/publications/<jobId>/<attempt>.json`; scheduled reconciliation uses
only that record for the D1-owned job and attempt. A successful callback requires
immutable base/head SHAs and the structured review result. The attempt key is
created once; a stale attempt or a duplicate callback cannot replace it. A
failed necessary record write keeps the callback retryable rather than claiming
publication that could never be recovered. Ingress authenticates and bounds the
forwarded callback but preserves Core's status code without its private body, so
an operator-visible 409 stale attempt is not retried as a transient 503. The same
status preservation applies to the single best-effort evidence upload.

Runner uploads readable private diagnostics separately to the authenticated
`POST /runner-evidence` route. Core bounds the request at 32 MiB, requires the
exact D1 run/job/attempt owner, and writes an immutable content-addressed archive
at `reviews/<runId>/diagnostics/<jobId>/<attempt>/<sha256>.json`. D1 records only the key
chosen for the current owner, so a late old-attempt upload writes its own key
and cannot replace a newer archive. This upload is best effort: missing, late,
malformed, oversized or failed archives are reported by Runner but never change
the review result or publication state. Terminal execution, submission and
cleanup timestamps come from the authoritative callback and are never updated by
the later upload. Historical `version: 1` inline archives remain readable by
`pnpm diagnose`; per-artifact hashes and truncation markers are retained metadata
rather than a read gate.

Publication and diagnostics share the `EVIDENCE_BUCKET` binding. Publication
depends on it to create and later reconcile the small publication record. A full
bucket outage therefore makes the terminal callback retryable instead of
silently claiming publication; a diagnostic-only upload failure does not affect
an already persisted result.
Both new object layouts stay under the existing managed `reviews/` prefix, so
the deployment's 90-day lifecycle rule covers them without another bucket
configuration.

## Operator cancellation

The per-instance numeric GitHub UID list in `DASHBOARD_MODEL_EDITOR_IDS` authorizes both model changes and review cancellation. The dashboard verifies the current account on every cancellation request.

An authorized same-origin `POST /api/jobs/:runId/cancel` accepts a queued review immediately (200). A claimed review returns 202 until Runner confirms cleanup. Repeating the request retrieves its current cancellation state. A 409 means publication or another terminal outcome already won. Cancelling never withdraws a published GitHub review.

The Worker ends the GitHub Check immediately and requests a stop using the recorded Runner job and attempt. A failed Check update is best effort and is not retried from a queue. The minute cron durably retries the Runner stop if the Worker or Runner was unavailable. A Runner 404 leaves cleanup unconfirmed. A known failed cleanup uses the verified maintenance procedure below and blocks the same PR until exact destruction is confirmed. Unknown pending cleanup does not qualify for that procedure; only an exact late original callback can update it, and any actual orphan is identified and removed through the backend age sweep. A later run is blocked while a cancelled claim is inside the 90-minute execution budget; after that budget an unknown pending cleanup stops blocking, while a known failed cleanup continues to block. Cleanup visibility and queue blocking are independent: cancelled pending cleanup remains visible until confirmed.

## Operations and troubleshooting

The code emits structured operational events without webhook payloads,
repository contents, diffs, model output, credentials, or session transcripts.
Use the Cloudflare Worker logs or `wrangler tail` only to correlate identifiers:

```sh
corepack pnpm dlx wrangler@4.124.0 tail <INSTANCE_NAME>-ingress
```

For scheduled `metadata_refresh` events, watch `dueAtStart` and
`oldestDueAgeMs` over successive invocations. Persistent growth means the refresh
cadence is not keeping up; public identity expires after five minutes even when
refresh fails. `skipped: cooldown` identifies persisted GitHub throttling.
`budgetExhausted: true` means the ten-second dispatch budget stopped new lookups;
`durationMs` includes database work and installation-token acquisition. These
fields are aggregates and contain no repository names or IDs. See the
[refresh bounds](public-dashboard-design.md#repository-metadata-and-disclosure).

Use the GitHub delivery page for `deliveryId` and then search logs for the
same value. A scheduled core event adds `runId`; a claimed Runner Job adds
its Job and `sandboxId`. The useful chain is:

```text
deliveryId → core scheduled → runId → D1 claim/jobId → Runner sandboxId → callback/R2/publication outcome
```

Identifier values are sanitized by the application before logging. Do not
work around that sanitization by logging request bodies, git URLs with
credentials, Sandbox files, OpenCode stdout/stderr, model prompts, or session
artifacts.

For a self-hosted Runner, read its systemd journal and the installation’s relay D1 request records. Use an explicit UTC time window and retain the job/run IDs:

```sh
journalctl --user -u <RUNNER_UNIT> --utc --since '<START UTC>' --until '<END UTC>'
```

Interpret the boundaries separately:

- Checkout command records carry the exit code and bounded, sanitized error
  output on failure. An exit code such as 128 alone does not identify a GitHub,
  authentication, DNS, TLS, disk, or network fault. Check cancellation, timeout,
  process errors, and output truncation before drawing a conclusion.
- Look up `inference_requests` by the Runner's job ID in the installation's relay D1 database. Compare route, model, status and reported tokens with the job's persisted usage. Gateway Analytics can confirm upstream model traffic; a failed stream alone cannot identify which hop interrupted it. See [usage and Gateway analytics](llm-service.md#reading-ai-gateway-analytics).
- A Runner restart can interrupt a review and lose its result. A claim keeps
  its original execution deadline. Once that deadline expires, later reviews of
  the same PR are eligible even if cleanup of the old VM is still pending.
  Request a fresh review through the usual GitHub trigger. The original run
  keeps its own outcome and cleanup status in the dashboard.
- Claim failures report whether polling continues or is halted. An ambiguous
  owned claim must remain halted; do not resume it by discarding the response
  or clearing database ownership without reconciling that exact job.
- Callback records distinguish an HTTP rejection, transport error, timeout,
  accepted delivery, and exhausted delivery attempts. A local terminal job is
  not proof that Core accepted its result. Preserve its local evidence if
  callback delivery failed; do not publish a second review manually.
- Cleanup is a separate outcome. A failed remove command can be followed by a
  confirmed exact-name absence; consult the final cleanup result, not an
  isolated exit code. Unknown or truncated inspection output does not prove
  destruction. A known failed cleanup blocks the next job for the same PR until
  destruction is confirmed and is never released by time; an unknown pending
  cleanup follows the 90-minute claim budget. Other PRs continue normally.

The dashboard remains a projection of Core's persisted state, not a live Runner
probe. D1 remains the product state and diagnostic source for lifecycle
transitions, command and transport failures, and cleanup outcomes. Preserve a
failed run's identifiers and local evidence before restarting services; a
restart cannot recreate error output that was never kept.

| Symptom                            | Check first                                                                                                    | Safe action                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub delivery is `400`           | `WEBHOOK_SECRET`, `X-Hub-Signature-256`, and the raw configured URL                                            | Re-enter the same high-entropy secret in GitHub and ingress, then redeliver. Do not disable signature checking.                                        |
| Core is `503` / scheduling failure | D1 migration, required core secrets, Runner VPC binding, and the GitHub App installation                       | Correct the missing binding/credential or installation permission, then redeliver. Do not create a second database.                                    |
| Run fails at checkout              | `runId`, `sandboxId`, and runner reason `checkout`                                                             | Check Contents read access and installation scope. Never put the installation token in a log or retry an old Sandbox manually.                         |
| Run fails at agent or cleanup      | Runner records for the same IDs                                                                                | Treat a cleanup failure as a failed run until forced Sandbox cleanup succeeds.                                                                         |
| No review is published             | Publication reason, current PR head SHA, and Pull requests write permission                                    | If the head changed, issue a new review command. If publication is uncertain, check the existing review marker before retrying.                        |
| `review_reset_failed`              | App identity, Pull requests write permission, protected-branch dismissal restrictions, and GitHub availability | Correct the cause and request `/ai-review`. Confirm this App’s prior votes are dismissed; never delete review history or reset another author’s vote.  |
| Public fork PR does nothing        | Comment body and commenter permission                                                                          | Use the exact `/ai-review` command from a maintainer with `write`, `maintain`, or `admin`; a new head needs a new command.                             |
| Bot-authored PR does nothing       | Pull request author type, numeric author ID, and `ALLOWED_BOT_AUTHOR_IDS`                                      | Automatic Bot PRs are ignored unless their positive numeric author ID is configured; use exact `/ai-review` from a maintainer when a review is useful. |

## Update and rollback

A compatible update, including documentation-only changes, may deploy without a
drain. A compatible change that touches one service does not require the full
sequence below. A breaking release uses the matching release sequence in a brief
maintenance window; mixed-version operation is not a default requirement.

For every deployment:

1. Run `corepack pnpm check`, `corepack pnpm test`, and
   `corepack pnpm build` against the immutable checkout being released.
2. Back up the existing gitignored instance configurations. Compare the Wrangler templates for the affected Workers
   between the deployed and target revisions, then merge the relevant changes into the
   retained instance files: new bindings/variables, migrations, compatibility
   settings, assets and Cron changes. Preserve instance account/resource IDs,
   `DASHBOARD_ORIGIN`, domains, allowlists, branding and deliberate overrides; reconcile changed
   defaults rather than blindly replacing them. Render only when instance files
   are absent, then restore those instance settings from the backup.
3. Review migration compatibility. Choose a backward-compatible migration where
   possible, or stage the change. A truly incompatible one-step migration requires
   quiescing Worker HTTP/webhooks and scheduled writers during the schema/code
   switch. Retire obsolete fields and tables only after the old Worker no longer
   uses them.

For compatible Worker changes, apply the required additive migrations, deploy the
affected Worker, and verify its behavior. A documentation-only change needs no
service restart. Drain a Runner before replacing its running process.

Use the following sequence for a breaking upgrade or rollback, per instance:

1. For an inference protocol change, pause admissions and let the current Runner
   finish every queued and running job. Check that the target application and
   relay support the reviewer, synthesis and default routes and their provider
   credentials. Restore a roster and default supported by the target before
   switching versions.
2. Request a [drain](#drain-before-maintenance) on all Runners attached to the
   Worker. Leave the old Runner and its matching callback receiver running.
   Let active jobs finish and [resolve failed cleanup](#recover-failed-cleanup),
   including blockers in Core that survived a Runner restart.
3. Verify each Runner reports `drained: true` and Core shows no unresolved
   cleanup blockers. Stop those Runner processes.
4. Follow the target release's installation guide for its configuration,
   bindings and database migrations. When switching the managed grant protocol,
   deploy and verify the target inference Worker first, then the matching
   application Worker. Keep HTTP and scheduled writers quiesced during an
   incompatible schema change.
5. Verify the target application's readiness before starting the matching
   Runner. On releases with authenticated `HEAD /runner-claim`, send that
   request with the Runner callback bearer and check the response specified by
   the target release. The current contract requires `204` and an
   `x-compte-rendu-concurrency` header containing a positive integer or
   `default`. For earlier releases, use their documented readiness check.
   A real `POST /runner-claim` can reserve work.
6. Start the matching Runner when its dependencies are ready. Its drain flag is
   in memory, so it can claim work as soon as its startup scan succeeds.

For either release path, back up the existing Runner artifact before replacement
and verify the installed artifact’s SHA256 against the tested build before
starting it. After startup, verify service health, desired concurrency and
Sandbox recovery status. Resume admissions if they were paused for the switch.
Verify the behavior affected by the release. For
publication changes, use the next controlled review to check the exact revision,
review output and visible GitHub publication.

If a bad release is receiving new runs from webhooks, stop webhook delivery.
For a compatible rollback, revert the affected Worker to its last known-good
deployment in the Cloudflare Workers deployment controls, using the matching
application build and compatible database schema. For a breaking rollback,
follow the breaking release procedure above with the prior release's matched
inference Worker, application Worker, schema and Runner. Do not delete D1 tables
or edit the applied migration ledger to undo a release. A schema rollback is a separate, reviewed migration or
an operator approved D1 recovery action.

## Drain before maintenance

Runner exposes authenticated maintenance endpoints on its private loopback HTTP
service. Use the existing `RUNNER_AUTH_TOKEN`; these routes are not forwarded by
the public dashboard Worker.

| Request                             | Effect                                                  |
| ----------------------------------- | ------------------------------------------------------- |
| `POST /maintenance/drain`           | Pause new claims while admitted jobs finish.            |
| `GET /maintenance`                  | Inspect current drain status.                           |
| `POST /maintenance/resume`          | Reopen admission and wake the claim loop.               |
| `POST /maintenance/recover-cleanup` | Confirm cleanup after exact Sandbox removal; see below. |

The drain, status and resume responses contain `draining`, `drained`, `activeJobs`, `claimInFlight`,
`claimPollingHalted` and `cleanupBlockedJobs`. A claim already sent when drain
begins keeps its reservation and can still start its job. Existing jobs finish
normally, including evidence archival, cleanup and bounded callback delivery.
Duplicate requests for an active job retain existing idempotency behavior; new jobs receive
503 while draining. Queued work stays in D1, so webhooks can continue arriving.
Changing concurrency does not bypass the pause.

On the Runner host, use a mode-0600 curl configuration file containing the
Authorization header, outside Sandbox mounts. Set `RUNNER_CURL_CONFIG` to that
file and `RUNNER_ORIGIN` to the instance's loopback address (for example,
`http://127.0.0.1:8080`). Keep credentials out of command arguments and shell
traces. Start the drain, then poll its status:

```sh
curl --fail --silent --show-error --config "$RUNNER_CURL_CONFIG" \
  --request POST "$RUNNER_ORIGIN/maintenance/drain"
curl --fail --silent --show-error --config "$RUNNER_CURL_CONFIG" \
  "$RUNNER_ORIGIN/maintenance"
```

Wait for `drained: true` before restarting. It requires maintenance mode, a
successful Sandbox age sweep, no active jobs or in-flight claim, no halted
claim loop and no terminal job with unconfirmed cleanup. Inspect a sweep
failure rather than forcing a restart to clear it. Resume only clears the
maintenance pause and may retry the Sandbox age sweep; it never clears a failed
cleanup or an ambiguous claim halt. If maintenance is cancelled,
send `POST /maintenance/resume` with the same curl configuration. Drain is
in-memory: a restarted Runner begins normal claiming automatically after its
startup age sweep. Starting a replacement is therefore a resume; start it only
when the Worker is ready.

The explicit cleanup recovery accepts only a retained failed-cleanup job for the
active sbx or microsandbox runtime where the request and evidence match the exact
job/run/attempt/evidence/SHAs, the backend confirmed its own host resources, and both the retained
manifest and callback still record failed cleanup. On success it makes a bounded
grant revocation for that job and sends one real slim `v2` `failed` callback with
cleanup `destroyed`. Core preserves the original failure and usage and unlocks the
same PR. Leftover `llm-grant-pending` files from an older Runner are ignored.

A terminal grant revocation failure after bounded retries fails that job without
a vote; admission and claims stay open, and later same-PR work is governed by the
confirmed cleanup state rather than grant state. Grants have a fixed lifetime of
four review budgets: the token stops authenticating at expiry, and no marker or
startup scan is required to bound it. Drain remains blocked only if Sandbox
destruction is unconfirmed.

Drained means local work and callback attempts finished, not that Core accepted
every callback. Check terminal callback failures and the dashboard before
replacement; unresolved delivery uses the recovery guidance below. If multiple
Runners share an sbx daemon/cgroup or inference service, drain each affected
Runner and check Sandbox inventory before restarting shared services.

Look up a completed review by run ID on the dashboard or through
`GET /api/jobs/:runId`. Core keeps the outcome and evidence reference in D1.
Keep the Runner evidence directory stable across restarts. The Runner uses the
reserved timestamped Sandbox name to find resources left by an interrupted job.
When a backend becomes reachable again, cleanup retries against that backend and
removes only a verified expired resource. Historical review
details remain available through Core even after the private Runner job endpoint
returns 404. Archived evidence has its own retention policy.

Back up artifacts/configuration before replacement. A compatible Core/contracts
addition that only prepares for a new Runner result shape may deploy the affected
Worker first without draining; once callback or result-shape acceptance changes,
use the breaking-release sequence above. Do not interrupt live jobs just to update
documentation or the dashboard. Relay grants survive Worker restarts in D1. Runner revocation is bounded per job and grants expire after six hours; startup does not replay pending revocations. Interrupted agent jobs cannot resume.

A hard crash can leave owned sbx resources. Runner names every Sandbox
`compte-rendu-<epoch>-<jobId>` and periodically sweeps exact names older than the
ninety-minute attempt budget plus a thirty-minute finalization margin. It removes
the exact VM, verifies absence, removes only editable orphan rules, and confirms
policy and secret absence. Create-time non-editable scoped rules are expected to
cascade from `sbx rm --force`; a surviving unremovable attachment keeps cleanup
failed. Inventory failures and truncation authorize no removal, and a live local
job is skipped. The sweep also runs at startup without delaying new claims.
Microsandbox uses the same age name, a strict `ls --format json` array, `created_at`
corroboration and absence in the original catalog. If two sweeps race, the loser's
nonzero `rm` is accepted only when final exact absence is confirmed in that same
catalog; a present VM or invalid inspection remains a failure. A same-name lookup in another
catalog reporting "not found" is never absence proof. An unresolved sweep keeps
drain pending; restore backend access for transient failures.

### Recover failed cleanup

Restoring backend access allows the Runner to retry orphan cleanup automatically. The probe resumes claims after a backend-wide sbx outage.

A run with `cleanup=failed` is recovered through the verified maintenance procedure below and keeps blocking the same PR until exact destruction is confirmed; elapsed time never unlocks it. Expired `cleanup=pending` does not qualify for that procedure; only an exact late original callback can update it, and an actual orphan is identified and removed through backend ownership rather than this recovery endpoint. Cancelled, superseded, and expired scheduling-timeout pending cleanup remains visible in cleanup attention until confirmed. An expired scheduling timeout with only pending cleanup blocks later reviews only while its durable claim is inside the 90-minute execution budget; after that budget, later reviews proceed automatically while the retained `pending` status remains visible as an orphan-cleanup risk. Cleanup visibility and queue blocking are independent. Restarting Runner does not clear that database ownership. While a blocker is inside the budget, or while a known failed cleanup remains unconfirmed, the queued task displays “Waiting for previous review cleanup”; an ordinary running review does not produce this warning.

After restoring Docker authentication, confirm the original job has stopped and
identify its exact Sandbox from the retained manifest
(`compte-rendu-<epoch>-<jobId>`).
Inspect it with `sbx inspect <sandboxName>` and, if it still exists, remove only
that Sandbox with `sbx rm --force <sandboxName>`. Verify its absence with another
inspect; authentication or transport failures are not proof of absence. Do not
remove other jobs' Sandboxes or use a bulk prune. The recovery endpoint does not
perform this removal for you.

For microsandbox, confirm absence in the original Runner catalog as described in
the [backend guide](microsandbox.md).

Then use the correct instance's authenticated Runner maintenance endpoint.
From the retained job evidence directory, extract the request from its manifest
and send it to the Runner:

```sh
jq '{evidenceId, jobId, runId, attempt, baseSha, headSha}' manifest.json > recovery-request.json
curl --fail-with-body --silent --show-error --config "$RUNNER_CURL_CONFIG" \
  --request POST --header 'content-type: application/json' \
  --data-binary @recovery-request.json \
  "$RUNNER_ORIGIN/maintenance/recover-cleanup"
```

This operation accepts retained failed sbx or microsandbox callbacks, including
jobs cancelled after their Core run was superseded, with valid callback evidence
and the backend's own host-resource confirmation (`hostCleanupConfirmed: true`
for sbx and microsandbox). It verifies the immutable identity and exact absence, removes
only its scoped sbx network policies and secrets, and revokes its LLM grant when
configured. It then sends one `v2` `failed` callback that keeps the original
failure, usage, lifecycle, evidence and timestamps and changes only cleanup to
`destroyed` plus the confirmation time. Core validates the current owner and any
present immutable SHAs, preserves the real failure and usage, and immediately
releases the same-PR queue. An existing Sandbox is never deleted by this recovery
operation. Authentication errors, truncated inventory or failed removal leave
cleanup unresolved.

Runner also pauses new claims when a failed sbx cleanup is followed by a failed
authenticated inventory probe, confirming a host-wide access outage. Other
healthy Runners can keep claiming. It retries the probe on its idle cadence and,
when access returns, immediately makes the same retained-evidence and
exact-absence recovery eligible for each affected in-memory job without holding
unrelated claims. The bounded retry also runs while drained. After a transient
verification or delivery failure, expensive cleanup work is retried at most once
every 30 seconds per pending job; unrelated claim polling continues. A Core 409
or another permanent 4xx response is a terminal delivery rejection: Runner does
not replay the original callback and sends no second recovery request. Only
408/429/5xx or timeout/network failures remain retryable. Other 4xx responses stop
automatic delivery with a bounded job/run/status diagnostic. When exact absence
fails because the exact retained Sandbox still exists, Runner re-runs the exact-name
reaper before the next attempt and skips every other resource.
An accepted callback reopens the same-PR queue. A single job cleanup failure that
does not fail the inventory probe leaves unrelated work claimable. A known failed
cleanup never becomes claimable through elapsed time; an unknown pending cleanup
still follows the original 90-minute claim budget when a restart loses a staged
claim.

Runner scratch cleanup is reported separately from Sandbox destruction. When a
Runner-created temporary directory cannot be removed after bounded `rm` retries,
the Runner writes one local host warning per exact directory on stderr/systemd
journal:

```json
{
  "phase": "runner",
  "outcome": "host-cleanup",
  "jobId": "<job ID>",
  "directory": "<exact Runner-created path>"
}
```

These paths stay local and are not added to Core callbacks, D1, R2 or the
injectable operational log. After the task is terminal and its Sandbox is already
confirmed destroyed, an operator with host access may remove only those exact
directories, for example `rm -rf -- '<exact path from the warning>'`. Do not glob,
prune by prefix or remove a directory still used by a live job. This scratch
failure does not block the same PR and needs no Sandbox recovery.

If both the real Sandbox destruction and the scratch removal fail, the terminal
state is `failed` with `sandbox.cleanup: failed`; the same PR remains blocked.
Scratch cleanup alone never proves Sandbox absence. Recovery succeeds only when
the configured backend can still prove its own exact VM absence and the
retained manifest records the backend's `hostCleanupConfirmed: true`. Runner
scratch failure must not turn that proof false, and unresolved backend proof must
not be replaced by a guessed or fabricated value. Historical
`hostCleanupConfirmed: false` remains rejected.

The original callback and manifest stay byte-for-byte unchanged. There is no
separate local recovery file or Core recovery report; Core's normal terminal
callback path owns the state change. The original terminal failure and job
identity are preserved, cleanup/result-arrival telemetry describes the real
callback, and confirmed destruction releases the queue block. A delayed original
`cleanup=failed` callback cannot reverse this confirmation or overwrite the first
confirmed cleanup time. HTTP 202 means Core accepted the callback. Retrying the
operation is safe; concurrent recovery of the same local job is rejected. Drain
cannot finish while a recovery operation is in progress.

HTTP 400 rejects invalid identity input; 401 rejects authentication; 409 rejects
active jobs, mismatched or unsupported evidence; 502 means cleanup or callback
delivery was not confirmed; 503 means callback configuration is unavailable.
Check the database-backed dashboard after recovery. Local files alone are not
proof that Core accepted the callback.

Older archives without the backend's own host-resource confirmation, missing
retained callbacks and retired-backend ownership recovery are unsupported.
Failure to remove a Runner scratch directory does not invalidate that backend
proof.
Do not add confirmation fields to historical evidence or fabricate callbacks.
Those cases require separately verified operator recovery; this endpoint is not
a general orphan-Sandbox sweep. Local host paths are deliberately not loaded from
an archive and recursively deleted.

### Retained terminal callback

When the evidence directory is available, Runner retains the exact bounded
terminal callback as `callback.json` there before attempting delivery. Like the
other evidence, this file is private (mode 0600); it contains the review result,
identities and an evidence reference but no callback credential or inline
diagnostics. Keep it outside Sandbox mounts and do not upload it to an issue.
Delivery still proceeds if retaining this extra recovery copy fails.

Diagnostics travel separately through `POST /runner-evidence`. Runner first
attempts the slim terminal callback, then uploads the readable evidence bundle
best-effort. The upload shares the 32 MiB contract budget: manifest, session list
and validated review are preserved first, and only an artifact that cannot fit is
truncated with `truncated: true`. A failed or partial upload does not affect the
callback result or the full local evidence directory.

Runner has no manual callback replay endpoint and no automatic replay queue. A
terminal callback that Core did not accept is not resent; the retained callback
and manifest remain local for diagnosis and for the verified failed-cleanup
confirmation above. A lost terminal callback requires a fresh review through the
usual GitHub trigger. Do not fabricate `callback.json`, edit retained evidence or
clear database ownership.

Core retains its existing callback ownership and revision checks. For an
interrupted publication, Core looks for the App-authored marker on the recorded
commit with the expected verdict. A matching review completes the run. A
transient lookup error leaves it pending. Once a publication claim has been
outstanding for a full review attempt budget, a successful lookup with no
matching review settles the run as `publication_uncertain`. Reconciliation never
issues another review POST for that claim. Inspect the GitHub PR before starting
a new review.

The application cron also reconciles up to four such publications per tick
using the D1 ownership and the exact attempt publication record
`reviews/<runId>/publications/<jobId>/<attempt>.json`. An absent or invalid
record leaves the run pending for investigation; diagnostic evidence is not a
publication source. Retained evidence is not deleted after acceptance. If
publication remains uncertain, inspect the callback and Core diagnostics before
starting a new review; do not edit the evidence or clear ownership.

Terminal Check updates are independent of publication and best effort. If GitHub
transiently rejects the final PATCH, the Check can remain at its earlier state;
there is no durable delivery queue. Late Check setup and later callbacks make a
fresh direct attempt from the persisted terminal status and decision. Those
attempts only update the recorded Check: they do not create another Check or post
another review, and a terminal Check is never moved back to an earlier state.
Manual cancellation sends its cancelled Check update immediately; only the Runner
stop is retried by the scheduled recovery pass.

## Uninstall and cleanup

This is destructive. Confirm the repository owner wants the run history and
that no review is in flight before proceeding.

1. Disable the GitHub App webhook.
2. Uninstall the GitHub App from every selected repository. Confirm no new
   deliveries arrive, then delete the App registration if it is no longer
   needed and revoke its private key.
3. Use the retained deployment-only configurations to delete the public Worker
   and the inference Worker. Do not use `--force`.

   ```sh
   corepack pnpm dlx wrangler@4.124.0 delete --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc
   corepack pnpm dlx wrangler@4.124.0 delete --config apps/inference-worker/wrangler.<INSTANCE_NAME>.jsonc
   ```

4. Verify the exact VPC Service ID, delete it, and verify that exact ID is
   absent from both `get` and `list`:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 vpc service get <VPC_SERVICE_ID>
   corepack pnpm dlx wrangler@4.124.0 vpc service list
   corepack pnpm dlx wrangler@4.124.0 vpc service delete <VPC_SERVICE_ID>
   corepack pnpm dlx wrangler@4.124.0 vpc service list
   corepack pnpm dlx wrangler@4.124.0 vpc service get <VPC_SERVICE_ID>  # expect not found
   ```

5. Stop and uninstall the persistent connector only after the VPC Service is
   gone:

   ```sh
   sudo systemctl disable --now cloudflared
   sudo cloudflared service uninstall
   ```

6. Verify the exact Tunnel ID, delete it, and verify that exact ID is absent
   from both `info` and `list`:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 tunnel info <TUNNEL_ID>
   corepack pnpm dlx wrangler@4.124.0 tunnel list
   corepack pnpm dlx wrangler@4.124.0 tunnel delete <TUNNEL_ID>
   corepack pnpm dlx wrangler@4.124.0 tunnel list
   corepack pnpm dlx wrangler@4.124.0 tunnel info <TUNNEL_ID>  # expect not found
   ```

7. Retain or export only the minimal D1 state required by the owner. If it is
   no longer needed, delete `<INSTANCE_NAME>-review-state` only after the
   Workers are gone and the retention decision is recorded:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 d1 delete <INSTANCE_NAME>-review-state
   ```

   D1 deletion is irreversible for this deployment's live state; stop and
   confirm the database name at the prompt. Do not delete a different
   database, and never use a broad wildcard or guessed identifier.

   The inference Worker uses the separate `<INSTANCE_NAME>-relay-grants`
   database. Delete it after the inference Worker is gone only when its grant
   history is no longer needed:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 d1 delete <INSTANCE_NAME>-relay-grants
   ```

8. Decide separately whether to retain the private
   `<INSTANCE_NAME>-review-evidence` R2 bucket. Leaving it in place is valid:
   the deployment's 90-day `reviews/` lifecycle rule continues expiring
   retained objects after the Workers are gone, so ordinary uninstall does
   not require bucket deletion.

   If the owner needs a longer-lived archive, export the required objects
   before their lifecycle expiry. Delete the bucket only when the owner has
   explicitly decided that no retained review evidence is needed, using the
   exact derived bucket name and confirming the destructive prompt:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 r2 bucket delete <INSTANCE_NAME>-review-evidence
   ```

   Do not remove or shorten the lifecycle merely because the application was
   uninstalled, and never delete a bucket selected by wildcard or guessed
   name.

9. Revoke the Cloudflare automation token. For interactive access, run
   `corepack pnpm dlx wrangler@4.124.0 logout`.

GitHub's installation operation and Cloudflare's Wrangler/D1 commands are the
authoritative references for these external destructive actions:
[GitHub App installation](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app),
[Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/),
[R2 bucket operations](https://developers.cloudflare.com/r2/buckets/create-buckets/),
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
