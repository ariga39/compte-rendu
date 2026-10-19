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
DIAGNOSTIC_WRANGLER_CONFIG=apps/core/wrangler.<INSTANCE_NAME>.jsonc \
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
corepack pnpm dlx wrangler@4.124.0 tail <INSTANCE_NAME>-core
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

| Symptom                               | Check first                                                                              | Safe action                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub delivery is `400`              | `WEBHOOK_SECRET`, `X-Hub-Signature-256`, and the raw configured URL                      | Re-enter the same high-entropy secret in GitHub and ingress, then redeliver. Do not disable signature checking.                                        |
| Ingress is `503` / `core_unavailable` | Core deployment name, `CORE` service binding, and core availability                      | Deploy or update core first, then ingress. Redeliver the GitHub event.                                                                                 |
| Core is `503` / scheduling failure    | D1 migration, required core secrets, Runner VPC binding, and the GitHub App installation | Correct the missing binding/credential or installation permission, then redeliver. Do not create a second database.                                    |
| Run fails at checkout                 | `runId`, `sandboxId`, and runner reason `checkout`                                       | Check Contents read access and installation scope. Never put the installation token in a log or retry an old Sandbox manually.                         |
| Run fails at agent or cleanup         | Runner records for the same IDs                                                          | Treat a cleanup failure as a failed run until forced Sandbox cleanup succeeds.                                                                         |
| No review is published                | Publication reason, current PR head SHA, and Pull requests write permission              | If the head changed, issue a new review command. If publication is uncertain, check the existing review marker before retrying.                        |
| Public fork PR does nothing           | Comment body and commenter permission                                                    | Use the exact `/ai-review` command from a maintainer with `write`, `maintain`, or `admin`; a new head needs a new command.                             |
| Bot-authored PR does nothing          | Pull request author type, numeric author ID, and `ALLOWED_BOT_AUTHOR_IDS`                | Automatic Bot PRs are ignored unless their positive numeric author ID is configured; use exact `/ai-review` from a maintainer when a review is useful. |

## Update and rollback

For a normal compatible release:

1. Run `corepack pnpm check`, `corepack pnpm test`, and
   `corepack pnpm build` against the immutable checkout being released.
2. If there is a new migration, review it and apply it remotely with the D1
   migration command in the installation guide. Prefer additive, backward-compatible changes.
3. Back up and reuse the existing gitignored instance configurations, preserving
   account, domain, assets, Cron, bindings and branding. Render only if the files
   are absent, then restore all instance-specific settings. Deploy using `apps/core/wrangler.<INSTANCE_NAME>.jsonc` and
   `apps/ingress/wrangler.<INSTANCE_NAME>.jsonc`.
4. If Runner changed, finish the drain procedure below, back up its artifact,
   install the tested merged build and restart it. Verify the artifact hash,
   service health, configured concurrency and grant recovery status.
5. Verify the behavior affected by the release. For publication changes, inspect
   a controlled review's exact revision, output and visible GitHub publication;
   do not create reviews solely for screenshots.

The core-before-ingress order preserves the service-binding contract. For an
incompatible change, pause GitHub webhook delivery first, deploy a compatible
core, then ingress, and reactivate delivery only after verification.

If a release is bad, stop webhook delivery if it is generating new runs. Roll
back the affected Worker to its last known-good deployment in the Cloudflare
Workers deployment controls. If both Workers changed, choose an order that
preserves their service-binding/schema compatibility; do not assume arbitrary
old/new combinations work. Do not delete D1 tables or edit the applied migration ledger to undo
a release. A schema rollback is a separate, reviewed migration or an operator
approved D1 recovery action.

## Drain and recovery limitations

There is no operator-controlled Runner pause/drain API yet
([#194](https://github.com/ariga39/compte-rendu/issues/194)). Arrange a quiet
window, prevent new triggers, and wait for both queued and claimed work to finish
before restarting Runner or its inference services. Disabling webhooks alone does
not remove already queued work. Zero concurrency is invalid. If multiple Runners
share an sbx daemon/cgroup, check all affected instances and Sandbox inventory;
a single empty dashboard is insufficient.

Back up artifacts/configuration before replacement. Deploy additive Core/contracts
support before a Runner that emits a new result shape. Do not interrupt live jobs
just to update documentation or the dashboard. A service restart invalidates
in-memory LLM grants; it cannot resume an old agent job.

A hard crash can leave owned Sandboxes ([#66](https://github.com/ariga39/compte-rendu/issues/66)).
An exhausted terminal callback can leave Core showing a claimed run even after
local cleanup. There is no supported callback-recovery command yet
([#195](https://github.com/ariga39/compte-rendu/issues/195)). Preserve evidence,
verify exact ownership and publication markers, and reconcile deliberately; never
clear D1 ownership or rerun an old Sandbox merely to make the dashboard look settled.

## Uninstall and cleanup

This is destructive. Confirm the repository owner wants the run history and
that no review is in flight before proceeding.

1. Disable the GitHub App webhook.
2. Uninstall the GitHub App from every selected repository. Confirm no new
   deliveries arrive, then delete the App registration if it is no longer
   needed and revoke its private key.
3. Use the retained deployment-only instance configurations. Delete the public `<INSTANCE_NAME>-ingress` Worker, then the private
   `<INSTANCE_NAME>-core` Worker, in that order. Deleting the Workers removes
   their service and VPC bindings. Do not use `--force`.

   ```sh
   corepack pnpm dlx wrangler@4.124.0 delete --config apps/ingress/wrangler.<INSTANCE_NAME>.jsonc
   corepack pnpm dlx wrangler@4.124.0 delete --config apps/core/wrangler.<INSTANCE_NAME>.jsonc
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
