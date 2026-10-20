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

## Operations and troubleshooting

The code emits structured operational events without webhook payloads,
repository contents, diffs, model output, credentials, or session transcripts.
Use the Cloudflare Worker logs or `wrangler tail` only to correlate identifiers:

```sh
corepack pnpm dlx wrangler@4.124.0 tail <INSTANCE_NAME>-ingress
```

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

For a self-hosted Runner, read its systemd journal alongside the matching LLM
service journal. Use an explicit UTC time window and retain the job/run IDs:

```sh
journalctl --user -u <RUNNER_UNIT> --utc --since '<START UTC>' --until '<END UTC>'
journalctl --user -u <INSTANCE_NAME>-llm.service --utc --since '<START UTC>' --until '<END UTC>'
```

Interpret the boundaries separately:

- Checkout command records carry the exit code and bounded, sanitized error
  output on failure. An exit code such as 128 alone does not identify a GitHub,
  authentication, DNS, TLS, disk, or network fault. Check cancellation, timeout,
  process errors, and output truncation before drawing a conclusion.
- LLM request records correlate `jobId` and `requestId`, route/protocol, HTTP
  status, received bytes, duration, terminal markers, and outcome. See
  [LLM diagnostics](llm-service.md). A stream failure received from a gateway
  does not establish whether the gateway or its upstream caused it.
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
  same PR even when other PRs continue normally.

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
Core terminal/publication boundary. The SDK additionally supplies its standard
timestamp/UUID and library/server/geolocation-disable metadata; it receives no
repository, PR thread, review body, or session content. PostHog is a lossy
secondary surface: its request, configuration, or transport failure is locally
diagnosable and cannot change D1/GitHub/R2 outcomes. Core uses one immediate
workerd capture per request and registers it with `waitUntil()`.

| Symptom                            | Check first                                                                              | Safe action                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub delivery is `400`           | `WEBHOOK_SECRET`, `X-Hub-Signature-256`, and the raw configured URL                      | Re-enter the same high-entropy secret in GitHub and ingress, then redeliver. Do not disable signature checking.                                        |
| Core is `503` / scheduling failure | D1 migration, required core secrets, Runner VPC binding, and the GitHub App installation | Correct the missing binding/credential or installation permission, then redeliver. Do not create a second database.                                    |
| Run fails at checkout              | `runId`, `sandboxId`, and runner reason `checkout`                                       | Check Contents read access and installation scope. Never put the installation token in a log or retry an old Sandbox manually.                         |
| Run fails at agent or cleanup      | Runner records for the same IDs                                                          | Treat a cleanup failure as a failed run until forced Sandbox cleanup succeeds.                                                                         |
| No review is published             | Publication reason, current PR head SHA, and Pull requests write permission              | If the head changed, issue a new review command. If publication is uncertain, check the existing review marker before retrying.                        |
| Public fork PR does nothing        | Comment body and commenter permission                                                    | Use the exact `/ai-review` command from a maintainer with `write`, `maintain`, or `admin`; a new head needs a new command.                             |
| Bot-authored PR does nothing       | Pull request author type, numeric author ID, and `ALLOWED_BOT_AUTHOR_IDS`                | Automatic Bot PRs are ignored unless their positive numeric author ID is configured; use exact `/ai-review` from a maintainer when a review is useful. |

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

| Request                    | Effect                                         |
| -------------------------- | ---------------------------------------------- |
| `POST /maintenance/drain`  | Stop new claims and new direct job admissions. |
| `GET /maintenance`         | Inspect current drain status.                  |
| `POST /maintenance/resume` | Reopen admission and wake the claim loop.      |

The response contains `draining`, `drained`, `activeJobs`, `claimInFlight`,
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

Wait for `drained: true` before restarting. It requires maintenance mode, no
active jobs or in-flight claim, no halted claim loop and no terminal job with
unconfirmed cleanup. Inspect failures rather than forcing a restart to clear
these conditions. Resume never clears an ownership-related claim halt or failed
cleanup. If maintenance is cancelled, send `POST /maintenance/resume` with the
same curl configuration. Drain is in-memory: a restarted Runner begins normal
claiming automatically.

Drained means local work and callback attempts finished, not that Core accepted
every callback. Check terminal callback failures and the dashboard before
replacement; unresolved delivery uses the recovery guidance below. If multiple
Runners share an sbx daemon/cgroup or inference service, drain each affected
Runner and check Sandbox inventory before restarting shared services.

For the first upgrade from a Runner without these endpoints, arrange a quiet
window and wait for queued and claimed work to finish. Disabling webhooks alone
does not remove queued work; zero concurrency is invalid.

Back up artifacts/configuration before replacement. Deploy additive Core/contracts
support before a Runner that emits a new result shape. Do not interrupt live jobs
just to update documentation or the dashboard. A service restart invalidates
in-memory LLM grants; it cannot resume an old agent job.

A hard crash can leave owned Sandboxes ([#66](https://github.com/ariga39/compte-rendu/issues/66)).
An exhausted terminal callback can leave Core showing a claimed run even after
local cleanup. Use the explicit recovery operation below; never clear D1 ownership
or rerun an old Sandbox merely to make the dashboard look settled.

### Replay a lost terminal callback

Runner retains the exact bounded terminal callback as `callback.json` in the
job's evidence directory, before attempting delivery. Like the other evidence,
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
curl --fail --silent --show-error --config "$RUNNER_CURL_CONFIG" \
  --request POST --header 'content-type: application/json' \
  --data-binary @recovery-request.json \
  "$RUNNER_ORIGIN/maintenance/replay-callback"
```

Runner reads only its configured evidence directory, validates the retained
callback, artifact sizes/hashes, identities, revisions and confirmed cleanup,
then sends one bounded request through its configured authenticated callback
URL. It does not start a Sandbox or rerun the model. Missing, inconsistent or
unconfirmed evidence is rejected; archives from before callback retention was
introduced cannot be reconstructed by this operation.

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
interrupted publication it checks the existing review marker, author, commit
and review state before publishing. Repeating the operation uses the same run
and cannot intentionally create a new review attempt. Retained evidence is not
deleted after acceptance. If delivery remains uncertain, inspect the callback
and Core diagnostics before retrying; do not edit the evidence or clear ownership.

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
