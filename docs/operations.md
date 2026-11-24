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

The command invokes `gh` for GitHub and
`corepack pnpm dlx wrangler@4.124.0 --config ...` for the deployed D1 and R2
bindings. There is no default database or bucket name: use the generated
config and resource names for the intended instance. Authenticate `gh` or
provide `GH_TOKEN` for repositories that require it. To include a retained
historical Workflow whose instance ID is the run ID, also set
`DIAGNOSTIC_WORKFLOW_NAME=<INSTANCE_NAME>-review`.

Missing sources are reported without suppressing available sources. Normal
diagnosis never uses SSH; it mentions SSH only as a fallback for Runner-host
loss or cleanup recovery. Output contains sanitized identities, states,
timestamps, bounded stderr metadata, and artifact presence/size/hash—not
credentials, repository contents, review bodies, or raw model/session/tool
output.

## Operator cancellation

The per-instance numeric GitHub UID list in `DASHBOARD_MODEL_EDITOR_IDS` authorizes both model changes and review cancellation. The dashboard verifies the current account on every cancellation request.

An authorized same-origin `POST /api/jobs/:runId/cancel` accepts a queued review immediately (200). A claimed review returns 202 until Runner confirms cleanup. Repeating the request retrieves its current cancellation state. A 409 means publication or another terminal outcome already won. Cancelling never withdraws a published GitHub review.

The Worker ends the GitHub Check and requests a stop using the recorded Runner job and attempt. The minute cron retries pending deliveries if the Worker or Runner was unavailable. A Runner 404 leaves cleanup unconfirmed. A known failed cleanup uses the verified maintenance procedure below. Expired pending cleanup does not qualify for that procedure; only an exact late original callback can update it, and any actual orphan is identified and removed through backend ownership. A later run is blocked only while the cancelled claim is inside the 90-minute execution budget; after that budget later reviews proceed automatically. Cleanup visibility and queue blocking are independent: cancelled pending cleanup remains visible until confirmed.

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
  destruction. A failed or unconfirmed cleanup can block the next job for the
  same PR until its 90-minute claim budget expires or destruction is confirmed;
  other PRs continue normally.

The dashboard remains a projection of Core's persisted state, not a live Runner
probe. PostHog is lifecycle telemetry, not the diagnostic source for command or
transport failures. Preserve a failed run's identifiers and local evidence before
restarting services; a restart cannot recreate error output that was never kept.

When enabled, Core also sends only three personless PostHog events:
`review scheduled`, `review claimed`, and `review finished`. Each event uses
the existing opaque `run_id` as `distinct_id` and disables person profiles.
The allowlisted properties contain only lifecycle state, bounded durations,
deployment/environment, trigger, publication/evidence/cleanup status, and
closed failure codes. `total_duration_ms` covers durable scheduling through the
Core terminal/publication boundary. The bounded sender adds only a timestamp, a
random event UUID, a server marker, and a geolocation-disable flag. It POSTs one
event to the configured host's `/batch/` endpoint with a three-second timeout,
no retry, and redirects rejected; it receives no repository, PR thread, review
body, or session content. PostHog is a lossy secondary surface: its
request, configuration, or transport failure is locally diagnosable and cannot
change D1/GitHub/R2 outcomes. Core uses one immediate workerd capture per
validated lifecycle event and registers each with `waitUntil()`.

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

For a normal compatible release:

1. Run `corepack pnpm check`, `corepack pnpm test`, and
   `corepack pnpm build` against the immutable checkout being released.
2. If there is a new migration, review it and apply it remotely with the D1
   migration command in the installation guide. Prefer additive, backward-compatible changes.
3. Back up the existing gitignored instance configurations. Compare the tracked
   `apps/dashboard/wrangler.jsonc` template between
   the deployed and target revisions, then merge the relevant changes into the
   retained instance files: new bindings/variables, migrations, compatibility
   settings, assets and Cron changes. Preserve instance account/resource IDs,
   `DASHBOARD_ORIGIN`, domains, allowlists, branding and deliberate overrides; reconcile changed
   defaults rather than blindly replacing them. Render only when instance files
   are absent, then restore those instance settings from the backup. Deploy using
   `apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc`.
4. If Runner changed, finish the drain procedure below, back up its artifact,
   install the tested merged build and restart it. Verify the artifact hash,
   service health, configured concurrency and grant recovery status.
5. Verify the behavior affected by the release. For publication changes, inspect
   a controlled review's exact revision, output and visible GitHub publication;
   do not create reviews solely for screenshots.

### Review deadline rollout

Core sets a 90-minute deadline at claim time. Deploy the application Worker with
`POST /runner-read-token` before upgrading a Runner that rotates tokens. A successful refresh
replaces the sbx token file or updates the active microsandbox VM's GitHub secret. If renewal fails,
the Runner uses the earlier of the claim deadline and the current token's expiry
minus one minute.
The callback and evidence manifest identify the limiting clock for an exhausted
attempt. The dashboard reports a timeout.

Drain before replacing the Runner binary. Queued jobs receive their deadline when
claimed after resume. The inference Worker issues six-hour grants, independently
of the execution deadline.

### Migrating an existing two-Worker installation

Keep the public Worker name/domain, D1 and R2 IDs, VPC service, allowlists,
branding, `DASHBOARD_ORIGIN` and all existing credentials. Render the new dashboard
configuration only when absent, then transfer those retained values. Put the
GitHub App private key and Runner auth secret on the public Worker using secure
operator input; never write them to its config. If model configuration is enabled,
transfer the existing `REVIEW_CONFIGURATION_TOKEN` to the public Worker too; it
is optional and must stay unset when that operator API is disabled. Build and deploy the merged
SvelteKit Worker. Check SSR, webhook signatures, Runner authentication and Cron.

Disable the old Core Worker's Cron when the unified Worker takes ownership of
metadata refresh. Retain the previous deployments and private configuration for
rollback until verification completes. The old Core's Durable Object retirement
migration history belongs to that Worker; do not copy it into the public Worker.
To roll back this migration, restore the previous ingress deployment and Core
Cron together. Database and bucket contents remain in place.

If a release is bad, stop webhook delivery if it is generating new runs. Roll
back the affected Worker to its last known-good deployment in the Cloudflare
Workers deployment controls. Use the matching application build and compatible database schema. Do not delete D1 tables or edit the applied migration ledger to undo
a release. A schema rollback is a separate, reviewed migration or an operator
approved D1 recovery action.

## Drain before maintenance

Runner exposes authenticated maintenance endpoints on its private loopback HTTP
service. Use the existing `RUNNER_AUTH_TOKEN`; these routes are not forwarded by
the public dashboard Worker.

| Request                             | Effect                                                   |
| ----------------------------------- | -------------------------------------------------------- |
| `POST /maintenance/drain`           | Pause new claims while admitted jobs finish.             |
| `GET /maintenance`                  | Inspect current drain status.                            |
| `POST /maintenance/resume`          | Reopen admission and wake the claim loop.                |
| `POST /maintenance/replay-callback` | Replay a retained terminal callback; see recovery below. |
| `POST /maintenance/recover-cleanup` | Confirm cleanup after exact Sandbox removal; see below.  |

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
successful startup grant and Sandbox ownership scans, no active jobs or in-flight claim, no
halted claim loop and no terminal job with unconfirmed cleanup. The startup scan
keeps the claim gate closed when any pending marker is invalid, unreadable, or
bound to another issuer/generation. Inspect failures rather than forcing a
restart to clear these conditions. Resume only clears the maintenance pause. It
may retry the Sandbox ownership scan, but it never retries or clears the startup
grant scan, an ownership-related claim halt or failed cleanup. If maintenance is
cancelled, send `POST /maintenance/resume` with the same curl configuration.
Drain is in-memory: a restarted Runner begins normal claiming automatically only
after its startup scan succeeds.

The explicit cleanup recovery is not a general repair for invalid or foreign
markers. It accepts only a retained failed-cleanup job for the active sbx or
microsandbox runtime where the request and evidence match the exact
job/run/attempt/evidence/SHAs, host cleanup was confirmed, and both the retained
manifest and callback still record failed cleanup. Any marker it uses must match
the active issuer/generation; an invalid marker or any mismatch is rejected. On
success it revokes the recorded grant, removes its marker and retries the startup
scan in the same process.

For a foreign issuer/generation marker, restore the original issuer origin,
generation, catalog and credentials, then restart to retry the startup scan. Use
the matching recovery only if that job also has eligible retained failed cleanup.
Do not delete the marker or repoint it to another backend. For an invalid marker,
first verify the associated grant has expired or has been revoked, and that no
Sandbox or cleanup obligation remains. Remove that marker only after those
obligations are confirmed; otherwise keep the claim gate closed and investigate
instead of deleting it. A restart does not repair an invalid marker.

A successful startup scan is not a continuous scan of all grants. A terminal
revocation failure after startup fails that job without a vote and leaves its
marker. Admission and claims stay open in the running process. Drain remains
blocked if Sandbox destruction is unconfirmed. Grants have a fixed lifetime
of four review budgets: the token stops authenticating at expiry, but the marker
is not resolved by expiry and a subsequent startup scan must still
confirm revocation through the original issuer and clear the marker.

Drained means local work and callback attempts finished, not that Core accepted
every callback. Check terminal callback failures and the dashboard before
replacement; unresolved delivery uses the recovery guidance below. If multiple
Runners share an sbx daemon/cgroup or inference service, drain each affected
Runner and check Sandbox inventory before restarting shared services.

Look up a completed review by run ID on the dashboard or through
`GET /api/jobs/:runId`. Core keeps the outcome and evidence reference in D1.
Keep the Runner evidence directory and instance identity stable across restarts.
The Runner uses local ownership records to find resources left by an interrupted
job. When a backend becomes reachable again, cleanup retries against that
backend and removes the local record after verifying absence. Historical review
details remain available through Core even after the private Runner job endpoint
returns 404. Archived evidence has its own retention policy.

For the first upgrade from a Runner without these endpoints, arrange a quiet
window and wait for queued and claimed work to finish. Disabling webhooks alone
does not remove queued work; zero concurrency is invalid.

Back up artifacts/configuration before replacement. Deploy additive Core/contracts
support before a Runner that emits a new result shape. Do not interrupt live jobs
just to update documentation or the dashboard. Relay grants survive Worker restarts in D1. On startup the Runner resolves pending revocations before accepting work. Interrupted agent jobs cannot resume.

A hard crash can leave owned sbx resources. On startup Runner checks its private
`sandbox-owners/<instanceId>/` records under the evidence root and removes only a
provably owned Sandbox, its exact scoped network policies and its scoped secrets.
`instanceId` is `RUNNER_INSTANCE_ID` or `port-<PORT>`, so co-located Runners
sharing an evidence root do not reconcile each other's live jobs. If the returned
name or exact workspace/config path does not match, inspection fails, native
secret absence cannot be confirmed, or removal cannot be confirmed, the record is
retained for automatic retry. A single foreign or malformed record does not gate
unrelated jobs. An authenticated `sbx ls` probe failure marks a backend-wide
outage and pauses new claims until access returns. Microsandbox similarly checks
the original catalog and VM owner label. An unresolved ownership record keeps
drain pending. Use the recovery event to inspect the record and the exact backend
resource. Restore backend access for transient failures. For a foreign or malformed
record, verify the actual owner and rule out any local cleanup obligation before
moving the record aside. Leave foreign VMs untouched. The ownership scan retries
automatically after 30 seconds; maintenance resume can trigger it immediately.

### Recover failed cleanup

Restoring backend access allows the Runner to retry orphan cleanup automatically. The probe resumes claims after a backend-wide sbx outage.

A run with `cleanup=failed` is recovered through the verified maintenance procedure below. Expired `cleanup=pending` does not qualify for that procedure; only an exact late original callback can update it, and an actual orphan is identified and removed through backend ownership rather than this recovery endpoint. Cancelled, superseded, and expired scheduling-timeout pending cleanup remains visible in cleanup attention until confirmed. An expired failed scheduling timeout with only pending cleanup blocks later reviews only while its durable claim is inside the 90-minute execution budget; after that budget, later reviews proceed automatically while the retained `pending` status remains visible as an orphan-cleanup risk. Cleanup visibility and queue blocking are independent. Restarting Runner does not clear that database ownership. While a blocker is inside the budget, the queued task displays “Waiting for previous review cleanup”; an ordinary running review does not produce this warning.

After restoring Docker authentication, confirm the original job has stopped and
identify its exact Sandbox from the retained manifest (`compte-rendu-<jobId>`).
Inspect it with `sbx inspect <sandboxName>` and, if it still exists, remove only
that Sandbox with `sbx rm --force <sandboxName>`. Verify its absence with another
inspect; authentication or transport failures are not proof of absence. Do not
remove other jobs' Sandboxes or use a bulk prune. The recovery endpoint does not
perform this removal for you.

For microsandbox, confirm absence in the original Runner catalog as described in
the [backend guide](microsandbox.md).

Then use the correct instance's authenticated Runner maintenance endpoint. Prepare `recovery-request.json` with the same six
identity fields shown in the callback replay section below, taken from the
retained manifest. Then run:

```sh
curl --fail-with-body --silent --show-error --config "$RUNNER_CURL_CONFIG" \
  --request POST --header 'content-type: application/json' \
  --data-binary @recovery-request.json \
  "$RUNNER_ORIGIN/maintenance/recover-cleanup"
```

This operation accepts retained failed sbx or microsandbox
callbacks, including jobs cancelled after their Core run was superseded, with
valid callback evidence and the runtime's host-cleanup confirmation
(`hostCleanupConfirmed: true` for sbx and microsandbox). It verifies the immutable identity and artifact
hashes, requires the exact Sandbox to be absent, removes only its scoped sbx
network policies and secrets, and revokes its LLM grant when configured.
An existing Sandbox is never deleted by this recovery operation. Authentication
errors, truncated inventory or failed removal leave cleanup unresolved.

Runner also pauses new claims when a failed sbx cleanup is followed by a failed
authenticated inventory probe, confirming a host-wide access outage. Other
healthy Runners can keep claiming. It retries the probe on its idle cadence and,
when access returns, immediately makes the same retained-evidence and
exact-absence recovery eligible for each affected in-memory job without holding
unrelated claims. The bounded retry also runs while drained. After a transient report or verification
failure, expensive cleanup work is retried at most once every 30 seconds per
pending job; unrelated claim polling continues. A Core 409 on the cleanup report
replays the retained verified terminal callback and retries the same report once
in the same recovery invocation; a repeated 409 is permanent. Only 408/429/5xx or
timeout/network failures remain retryable afterward. Other 4xx responses or a
permanent callback rejection stop automatic delivery with a bounded
job/run/status diagnostic. When exact absence fails
because the owned Sandbox still exists, Runner runs the ownership reaper only for
that job before the next attempt and skips every other ownership record. An
accepted report reopens the same-PR queue. A single job cleanup failure that does
not fail the inventory probe leaves unrelated work claimable. A restart can lose a staged claim. Later reviews of that PR become eligible automatically
once the original 90-minute claim budget expires.

The original callback, manifest and terminal failure stay unchanged. Runner writes
`cleanup-recovery.json` separately and sends an authenticated recovery report.
Core retains a separate `cleanup-recoveries/` audit object and updates only the
matching failed, superseded or cancelled run's cleanup state and completion time. The original
terminal status and job identity remain unchanged; confirmed destruction releases
the same-PR queue block without discarding recovery identity. New same-PR work can
then be claimed. A delayed original callback cannot reverse
this confirmation. HTTP 202 means Core accepted the report. Retrying the operation
is safe; concurrent recovery of the same local job is rejected. Drain cannot
finish while a recovery operation is in progress.

HTTP 400 rejects invalid identity input; 401 rejects authentication; 409 rejects
active jobs, mismatched or unsupported evidence; 502 means cleanup or report
delivery was not confirmed; 503 means callback configuration is unavailable.
Check the database-backed dashboard after recovery. A local audit file alone is
not proof that Core accepted the report.

Older archives without host-cleanup confirmation, missing retained callbacks,
failed host-directory removal and retired-backend ownership recovery are unsupported.
Do not add confirmation fields to historical evidence or fabricate callbacks.
Those cases require separately verified operator recovery; this endpoint is not
a general orphan-Sandbox sweep. Local host paths are deliberately not loaded from
an archive and recursively deleted.

### Replay a lost terminal callback

When the evidence directory is available, Runner retains the exact bounded
terminal callback as `callback.json` there before attempting delivery. Like the other evidence,
this file is private (mode 0600); it contains review/session evidence but no
callback credential. Keep it outside Sandbox mounts and do not upload it to an
issue. Delivery still proceeds if retaining this extra recovery copy fails.

On the correct Runner host and instance, match the local `manifest.json` with
the run being recovered: evidence ID, job ID, run ID, attempt, and immutable
base/head SHAs. Confirm the terminal cleanup is `destroyed`. Create a local
request file containing these assertions, rather than the callback payload:

```json
{
  "evidenceId": "<evidence UUID>",
  "jobId": "<job ID>",
  "runId": "<run ID>",
  "attempt": 1,
  "baseSha": "<full base SHA>",
  "headSha": "<full head SHA>"
}
```

Using the same private curl configuration and loopback origin as maintenance:

```sh
curl --fail-with-body --silent --show-error --config "$RUNNER_CURL_CONFIG" \
  --request POST --header 'content-type: application/json' \
  --data-binary @recovery-request.json \
  "$RUNNER_ORIGIN/maintenance/replay-callback"
```

Runner reads only its configured evidence directory, validates the retained
callback, artifact sizes/hashes, identities, revisions and confirmed cleanup,
then sends one bounded request through its configured authenticated callback
URL. For the size-limited failure callback, which omits embedded artifacts,
recovery requires the rewritten local manifest marked `callback-too-large` and
applies the same identity, revision and cleanup checks. It does not start a Sandbox
or rerun the model. Missing, inconsistent or
unconfirmed evidence is rejected; archives from before callback retention was
introduced cannot be reconstructed by this operation. The same limitation applies
to failures before an evidence directory or valid manifest exists, and to local
retention failures. Preserve the diagnostics and investigate those cases separately.

Successful delivery returns HTTP 202 with `{"accepted": true}`. Rejections include
a fixed `reason` without artifact contents: 400 for invalid assertions, 404 for
an unknown evidence directory, 409 for an active job or unusable evidence, 413
for an oversized callback, 502 for rejected/failed delivery and 504 for a delivery
timeout. Missing callback configuration returns 503. An old archive without
`callback.json` is reported as `missing-callback`; never fabricate that file.

An accepted replay means Core accepted the callback, **not** that a review was
published. Inspect the job's database-backed dashboard status and GitHub review.
Core retains its existing ownership and revision checks: an obsolete revision
may become superseded, and an already failed run is not reopened. For an
interrupted publication, Core looks for the App-authored marker on the recorded
commit with the expected verdict. A matching review completes the run. A
transient lookup error leaves it pending. Once a publication claim has been
outstanding for a full review attempt budget, a successful lookup with no
matching review settles the run as `publication_uncertain`. Reconciliation never
issues another review POST for that claim. Inspect the GitHub PR before starting
a new review.

The application cron also reconciles up to four such publications per tick
using the D1 ownership and the hash-verified R2 evidence already retained for
the callback. Missing or inconsistent evidence leaves the run pending for
investigation or authenticated callback replay. Repeating the operation uses the same run
and cannot intentionally create a new review attempt. Retained evidence is not
deleted after acceptance. If delivery remains uncertain, inspect the callback
and Core diagnostics before retrying; do not edit the evidence or clear ownership.

Terminal Check delivery is independent of publication. If GitHub transiently
rejects the final PATCH, D1 retains pending work for that run's exact Check. The
same cron retries it from the persisted terminal status and decision, including
after a Worker restart, late Check setup or a duplicate callback. A bounded sweep
takes the least recently attempted rows first, so a permanently unavailable Check
does not block later deliveries. Retries only update the recorded Check; they do
not create another Check or post another review, and a terminal Check is never
moved back to an earlier state. Existing historical completed Checks are not swept.
Manual cancellation continues to use its own Check reconciliation timestamps.

## Uninstall and cleanup

This is destructive. Confirm the repository owner wants the run history and
that no review is in flight before proceeding.

1. Disable the GitHub App webhook.
2. Uninstall the GitHub App from every selected repository. Confirm no new
   deliveries arrive, then delete the App registration if it is no longer
   needed and revoke its private key.
3. Use the retained deployment-only configuration to delete the public Worker.
   If an old Core Worker was retained after migration, remove it separately only
   after confirming it has no active consumers. Do not use `--force`.

   ```sh
   corepack pnpm dlx wrangler@4.124.0 delete --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc
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
