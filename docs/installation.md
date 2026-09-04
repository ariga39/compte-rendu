# Installation and operations

This is the short operator manual for the two-Worker Compte rendu deployment.
It assumes one Cloudflare account, one or more explicitly allowlisted GitHub App installations, and the
repository checkout that contains this file. It does not create resources or
credentials by itself.

Values in angle brackets are operator choices. Do not replace them with values
from another installation.

## What is deployed

The repository deploys these resources:

| Resource           | Configuration name                                                       | Purpose                                                                                                            |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Public Worker      | `<INSTANCE_NAME>-ingress`                                                | Receives GitHub webhooks and authenticated Runner claim/callback requests. `workers_dev` is enabled.               |
| Private Worker     | `<INSTANCE_NAME>-core`                                                   | Owns authorization, GitHub API calls, orchestration, and run state. `workers_dev` is disabled.                     |
| Service binding    | `CORE` → `<INSTANCE_NAME>-core`                                          | Lets ingress call core without a public core URL.                                                                  |
| D1 database        | `<INSTANCE_NAME>-review-state`, binding `REVIEW_DB`                      | Stores delivery, approval, and run state.                                                                          |
| R2 evidence bucket | `<INSTANCE_NAME>-review-evidence`, binding `EVIDENCE_BUCKET`             | Private bucket storing one bounded JSON evidence bundle per Job; lifecycle expiration is configured at deployment. |
| Runner Job service | Self-hosted runner reached through the core `RUNNER` VPC Service binding | Owns one authenticated asynchronous review attempt and fresh Docker Sandbox cleanup.                               |

The request path is:

```text
GitHub webhook
    → <INSTANCE_NAME>-ingress (public, verifies WEBHOOK_SECRET)
    → CORE service binding
    → <INSTANCE_NAME>-core (private)
       → REVIEW_DB / EVIDENCE_BUCKET / RUNNER VPC Service (targeted cancellation only)
       → GitHub App installation token for GitHub API operations

Idle Runner
    → <INSTANCE_NAME>-ingress `/runner-claim` (RUNNER_CALLBACK_TOKEN)
    → <INSTANCE_NAME>-core atomic D1 claim
    → Runner Job execution and cleanup
    → <INSTANCE_NAME>-ingress `/runner-callback` (same token)
```

For a newer head that supersedes a reachable running old-head Job, Core uses
the private `RUNNER` VPC Service for the authenticated targeted
`DELETE /jobs/:id`, waits for the Runner's terminal cleanup confirmation, and
only then permits the newer queued run to be claimed. Core does not use this
binding to submit new Jobs. The Tunnel and VPC Service remain required for
that cancellation path.

Cloudflare service bindings are internal Worker-to-Worker calls and can be
used to isolate a Worker from the public Internet. The target Worker must be
deployed before the Worker that declares the binding:
[Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).

The tracked configs at
[`apps/core/wrangler.jsonc`](../apps/core/wrangler.jsonc) and
[`apps/ingress/wrangler.jsonc`](../apps/ingress/wrangler.jsonc) are neutral
templates. From the repository root, render deployment-only sibling configs
for the chosen instance:

```sh
corepack pnpm render:wrangler <INSTANCE_NAME> <GITHUB_APP_ID> <D1_DATABASE_ID> <RUNNER_VPC_SERVICE_ID> '<GITHUB_INSTALLATION_IDS_JSON>' '<GITHUB_BOT_AUTHOR_IDS_JSON>'
```

For example, instance `petit-chiba` produces
`apps/core/wrangler.petit-chiba.jsonc` and
`apps/ingress/wrangler.petit-chiba.jsonc`, with names derived as
`petit-chiba-core`, `petit-chiba-ingress`, `petit-chiba-review-state`, and
`petit-chiba-review-evidence`. Instance names never require editing the repository or
the tracked templates. The renderer keeps the tracked placeholders unchanged
and refuses to overwrite an existing generated config.

`<GITHUB_INSTALLATION_IDS_JSON>` must be a non-empty JSON array of positive
numeric GitHub App installation IDs, for example `[123456789]`. It is written
only to the generated ingress config as `ALLOWED_INSTALLATION_IDS`; the tracked
template remains a placeholder. Ingress fails closed with HTTP `503` when the
value is missing or malformed, and ignores signed events from installations outside the
allowlist before contacting `CORE`.

`<GITHUB_BOT_AUTHOR_IDS_JSON>` is an optional JSON array of positive numeric
GitHub user IDs, for example `[49699333]`. The renderer writes it to
`ALLOWED_BOT_AUTHOR_IDS`; omitting it writes `[]`, preserving the default that
automatic Bot pull requests are ignored. Ingress ignores Bot events when this
value is missing, malformed, or does not contain the event's numeric user ID.
It does not affect human pull requests or manual `/ai-review` commands. Do not
use Bot login names or app slugs as configuration values.

To obtain a Bot account's numeric ID without writing to GitHub, query a pull
request it created with `gh api repos/<OWNER>/<REPO>/pulls/<NUMBER> --jq
'.user.id'`, or use the `pull_request.user.id` field from a verified webhook.
Each independent deployment and its GitHub App must configure its own
`ALLOWED_BOT_AUTHOR_IDS` value.

Independent deployed instances require distinct product GitHub Apps because
each App has one webhook URL and secret; this does not require a router.

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

## Access and credentials

### Wrangler authentication

This repository does not include Wrangler as a dependency. Use the temporary
package invocation below; it is the package-run form documented by Cloudflare
and keeps the repository dependency set unchanged.

```sh
corepack pnpm dlx wrangler@4.124.0 --version
```

Verify that command reports `4.124.0` before an installation or update. Every
Wrangler example in this manual uses that exact version. Do not use
`pnpm exec wrangler`: there is no local Wrangler binary in this repository.

For an interactive operator session, use Wrangler OAuth:

```sh
corepack pnpm dlx wrangler@4.124.0 login
corepack pnpm dlx wrangler@4.124.0 whoami
```

`wrangler login` opens an OAuth authorization flow. It uses OAuth scopes, not
custom API-token permissions. The
following are separate authorization layers:

| Operation                                             | Cloudflare account member role                             | Wrangler OAuth scope     | Custom API-token permission                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bind an existing VPC Service while deploying a Worker | `Connectivity Directory Bind` (or `Admin`)                 | `connectivity:admin`     | There is no `Connectivity Directory: Bind` token permission. The token must be issued by a member with the role and include `Workers Scripts Write`. |
| Provision, update, or delete a VPC Service            | `Connectivity Directory Admin`                             | `connectivity:admin`     | There is no `Connectivity Directory: Admin` token permission; a custom token must be issued by a member with the Admin role.                         |
| Deploy Workers, bindings, secrets, and triggers       | The issuing member must also be authorized for the account | `workers_scripts:write`  | `Workers Scripts Write`; add `D1 Edit` for D1 create/migrate operations.                                                                             |
| Create the evidence bucket and configure retention    | The issuing member must also be authorized for the account | Wrangler's account grant | `Workers R2 Storage Edit`.                                                                                                                           |
| Tail Worker logs                                      | Account access for the issuing member                      | `workers_tail:read`      | Optional `Workers Tail Read`; not needed for installation or deployment.                                                                             |

Wrangler 4.124.0's normal/default OAuth grant currently includes
`connectivity:admin`. That is an OAuth scope in the Wrangler grant, not the
Cloudflare account member role and not a custom API-token permission; the
member-role and token rules above still apply independently.

The member role `Connectivity Directory Bind` is sufficient for attaching an
existing VPC Service; Admin is required for VPC Service provisioning and
deletion. Wrangler OAuth uses the broader `connectivity:admin` scope for both
operations. Do not describe either member role as a custom token permission.
Select the single deployment account as the
token resource; no zone, DNS, Access, KV, Pages, or Workers Routes permission
is needed for this product. R2 bucket creation and lifecycle configuration do
require `Workers R2 Storage Edit`. See Cloudflare's
[VPC Service roles](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#required-roles),
[OAuth scopes](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.124.0/packages/workers-auth/src/core/scopes.ts),
and [API-token permission catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

Tunnel administration is a separate operation. Wrangler 4.124.0 requires a
separate Tunnel-capable custom API token for Tunnel administration; do not rely
on the deployment OAuth session. Use the account-level **Cloudflare Tunnel >
Edit** token permission for Wrangler's Tunnel commands. Direct documented API
calls may instead use one of the documented `Cloudflare One Connectors Write`,
`Cloudflare One Connector: cloudflared Write`, or `Cloudflare Tunnel Write`
permissions. Keep this token out of the repository and Wrangler configuration.
Expose this separate Tunnel-capable API token only while running the pinned Tunnel
commands or the documented token-retrieval API in the section below. Unset it
before returning to deployment OAuth or the deployment custom token for VPC
Service, D1, Worker, secret, or log operations.

API-token lifetime is an operator choice, not a repository setting. Choose a
finite TTL, store the token only in the operator's protected credential
handling, rotate it before expiry, and revoke it immediately if exposed.
Cloudflare documents that tokens otherwise do not expire by default and that a
roll invalidates the previous secret:
[restrict tokens](https://developers.cloudflare.com/fundamentals/api/how-to/restrict-tokens/)
and [roll tokens](https://developers.cloudflare.com/fundamentals/api/how-to/roll-token/).

If a token is needed in a shell, avoid putting it in a command argument or
shell history. For a one-off local session, read it without echoing and clear
the variable after the command:

```sh
read -rsp 'Cloudflare API token: ' CR_CLOUDFLARE_API_TOKEN
printf '\n'
export CLOUDFLARE_API_TOKEN="$CR_CLOUDFLARE_API_TOKEN"
unset CR_CLOUDFLARE_API_TOKEN
corepack pnpm dlx wrangler@4.124.0 whoami
unset CLOUDFLARE_API_TOKEN
```

Do not print the variable, commit it, put it in a repository `.env` file, or
leave it in a shared shell transcript.

### Workers VPC Tunnel and service lifecycle

Wrangler's Tunnel command group is experimental in 4.124.0. With the
separate Tunnel-capable API token available to Wrangler, create and inspect
the remotely managed Tunnel with these exact commands:

```sh
corepack pnpm dlx wrangler@4.124.0 tunnel create <TUNNEL_NAME>
corepack pnpm dlx wrangler@4.124.0 tunnel list
corepack pnpm dlx wrangler@4.124.0 tunnel info <TUNNEL_ID>
corepack pnpm dlx wrangler@4.124.0 tunnel delete <TUNNEL_ID>
```

There is no `wrangler tunnel token` command. Retrieve the connector token
from the Dashboard's **Add a replica** action, or use Cloudflare's documented
API from a protected operator shell:

```sh
curl --request GET \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/cfd_tunnel/<TUNNEL_ID>/token" \
  --header "Authorization: Bearer <TUNNEL_API_TOKEN>"
```

The connector token is a secret: anyone who obtains it can run another
replica of the Tunnel. Store it only in protected host secret management and
rotate it if exposed. Do not put it in this repository, a Wrangler config, or
an issue/comment.

Install `cloudflared` 2025.7.0 or later (latest is recommended). The
connector uses QUIC; leave its protocol at `auto` or set it to `quic`, and
allow outbound UDP port 7844 from the connector host. Install it as a
persistent service rather than relying on an interactive shell:

```sh
cloudflared --version
sudo cloudflared service install '<TUNNEL_CONNECTOR_TOKEN>'
sudo systemctl enable --now cloudflared
sudo systemctl is-active cloudflared
```

Before creating the VPC Service or deploying a Worker binding, require both
`systemctl is-active cloudflared` and a **Healthy/Connected** connector status
in the Cloudflare Dashboard for `<TUNNEL_ID>`. Workers VPC uses persistent
outbound connections and creates no public hostname, DNS record, Access
application, or inbound-firewall dependency. Do not add public Tunnel ingress
for this private Runner path.

Create, inspect, list, and delete the fixed plaintext HTTP VPC Service with
the exact commands below. Create it only after the Tunnel and healthy
connector exist:

```sh
corepack pnpm dlx wrangler@4.124.0 vpc service create <RUNNER_SERVICE_NAME> \
  --type http \
  --tunnel-id <TUNNEL_ID> \
  --ipv4 127.0.0.1 \
  --http-port 8080
corepack pnpm dlx wrangler@4.124.0 vpc service get <VPC_SERVICE_ID>
corepack pnpm dlx wrangler@4.124.0 vpc service list
corepack pnpm dlx wrangler@4.124.0 vpc service delete <VPC_SERVICE_ID>
```

The create response supplies `<VPC_SERVICE_ID>` for the generated core
Worker's `vpc_services[].service_id` binding. The target is the Runner's
plaintext loopback listener at `127.0.0.1:8080`. Core must call
`http://runner.internal/jobs/...`: `https` selects TLS on the final origin hop,
which this plaintext Runner does not provide. The `runner.internal` host is a
binding host, not public DNS, and the configured VPC Service port remains 8080.

Keep the resource order explicit: `Tunnel → connector → VPC Service → Worker
binding`. Cleanup reverses it: `Worker deletion/unbind → VPC Service deletion
→ connector stop/uninstall → Tunnel deletion`. A VPC Service must not point at
a deleted Tunnel, and a deployed Worker must not retain a binding to a deleted
VPC Service.

### GitHub App permissions and installation

Configure the GitHub App with only these repository permissions:

| GitHub App permission | Level | Concrete operation in this repository                                                                                                                                                                                         |
| --------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata              | Read  | Resolve the repository by numeric ID, validate repository metadata, and check the `/ai-review` commenter's collaborator permission before approving a public fork review.                                                     |
| Contents              | Read  | Fetch the repository at the exact base/head SHAs in the Sandbox checkout. GitHub documents Contents as the permission for HTTP-based Git access.                                                                              |
| Pull requests         | Read  | Load PR facts and current head SHA, and find existing reviews for idempotent publication.                                                                                                                                     |
| Pull requests         | Write | Create the body-only `COMMENT` review.                                                                                                                                                                                        |
| Issues                | Write | Make the `issue_comment` webhook available for PR comments, create command reactions, and publish one ordinary PR comment when a Review fails. The handler accepts only a created comment whose body is exactly `/ai-review`. |
| Checks                | Write | Create one head-SHA-bound Check Run per review run and update its queued, in-progress, success, failure, or cancelled state.                                                                                                  |

Before applying the D1 migration or deploying either Worker, approve the
GitHub App installation's **Checks: Write** permission. Existing installations
must approve this permission change explicitly; an unapproved permission must
block the rollout. After approval, verify one successful run transitions its
Check from `queued` to `in_progress` to `success`, and one controlled failed
run transitions from `queued` to `in_progress` to `failure`, with the matching
terminal Review or failure comment.

The endpoint-to-permission mapping should be checked against GitHub's
[permission-to-endpoint reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
when GitHub changes an endpoint. The general rule to request the minimum is in
[choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app).

Subscribe the App to:

- `Pull requests`: `opened`, `reopened`, `synchronize`, and
  `ready_for_review` (all four are accepted by `apps/ingress/src/index.ts` for
  non-Bot authors and configured Bot author IDs; other Bot-authored automatic
  events are ignored).
- `Issue comment`: `created`. The product path is only a comment on a pull
  request with the exact body `/ai-review`.

Do not subscribe to push, review, check, status, issue, or repository events;
they are not part of this Worker contract. GitHub's event reference lists the
available event actions:
[Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

Manual command reactions are compact operator feedback: `eyes` means the
authorized command was claimed and scheduled, `confused` means the command
was denied, the pull request was missing or draft, or the run was superseded,
and `-1` means the accepted run ended failed. A successful run keeps only
`eyes`; its published `COMMENT` review is the completion signal. A failed run
also publishes one ordinary PR comment so automatic and manual runs both have
a visible terminal notification. Automatic reviews do not react to a command.
Reaction writes target the originating numeric comment id and may be replayed
safely with the same app and content.

The Check Run is progress display rather than a replacement for those terminal
notifications. It is created as `queued`, becomes `in_progress` when claimed,
and completes as `success`, `failure`, or `cancelled`. Its `external_id` is the
Core run id and it is always attached to that run's immutable head SHA. A Check
API failure must not block the Review or failure comment.

Install the App on the owning account with **Only select repositories**, then
select the target repository or repositories. Do not choose all repositories
unless that is an explicit operator decision. GitHub describes this choice in
[Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

Pass the numeric installation ID for each enabled App installation in the
renderer allowlist. The allowlist is deployment configuration, not a repository
or owner-name lookup, and it must include every installation whose webhook this
Worker is intended to accept.

Enable the App webhook with:

- Webhook URL: `<INGRESS_URL>`, the public URL printed or shown for
  `<INSTANCE_NAME>-ingress` after deployment. This repository does not establish a
  fixed hostname.
- Webhook secret: one high-entropy value, entered into both GitHub and the
  ingress `WEBHOOK_SECRET` Worker secret.
- Active delivery: enabled only after both Workers are deployed and the
  ingress secret is present.

GitHub signs deliveries with the configured secret in
`X-Hub-Signature-256`; the ingress verifies that HMAC before forwarding any
event. Follow GitHub's
[webhook validation guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
for the secret and signature requirements. Never put the App private-key
value, webhook secret, installation token, model key, or a private-key file
path in this repository or in an issue/comment.

## First installation

Before starting, install Docker Sandboxes with `sbx` 0.39.0, complete Docker
login, ensure the service environment exposes both the Sandboxes daemon and
`mkfs.ext4`, and initialize the host policy once. An auto-started `sandboxd`
inherits the service's `PATH`; on Debian, `mkfs.ext4` is normally in
`/usr/sbin`, so include the system sbin directories in the PATH used to start
the Runner:

```sh
PATH="<SBX_BIN_DIR>:/usr/local/sbin:/usr/sbin:/sbin:$PATH"
command -v sandboxd
command -v mkfs.ext4
```

The two `command -v` checks must succeed in the same service environment that
starts the Runner. Then initialize the host policy once:

```sh
sbx policy init deny-all
```

Install the repository dependencies and build the runner. The resolver command
must not contain a model secret; `MODEL_SECRET_COMMAND` is never sent to the
Worker:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @compte-rendu/runner build
```

### Offline Sandbox template deployment

The Runner uses the versioned custom template
`ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0`. When the NUC should
not pull from a registry, build and transfer the ordinary OCI image from a
trusted build host, then load it into the NUC's separate Sandbox image store.
Do not run these commands inside a review Sandbox or as a Runner Job, and do
not put credentials in the image:

```sh
docker buildx build \
  --platform linux/amd64 \
  --load \
  --tag ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0 \
  apps/runner/sandbox-template

docker image save \
  ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0 \
  -o petit-chiba-opencode.tar
```

Transfer `petit-chiba-opencode.tar` to the NUC using the operator's approved
offline transfer method. On the NUC, load and probe the image before starting
the Runner:

```sh
sbx template load /path/to/petit-chiba-opencode.tar
sbx create \
  --name petit-chiba-template-probe \
  --template ghcr.io/ariga39/petit-chiba-opencode:1.18.25-gh2.98.0 \
  --cpus 4 \
  --memory 8g \
  opencode /path/to/non-sensitive-probe-workspace
sbx exec petit-chiba-template-probe opencode --version
sbx exec petit-chiba-template-probe gh version
sbx rm --force petit-chiba-template-probe
rm /path/to/petit-chiba-opencode.tar
```

The version probes must report OpenCode `1.18.25` and GitHub CLI `2.98.0`.
Keep the loaded template for the Runner. A later registry deployment may
replace the local tag with a fully qualified registry reference plus its
recorded digest, but registry access and a digest are optional for this
offline path. Continue with the Runner start below only after the probe and
cleanup succeed.

The runner listens only on IPv4 loopback port `8080`. Start it on the host that
also runs the remotely managed Tunnel connector:

```sh
MODEL_SECRET_COMMAND='<host-secret-resolver-command>' \
RUNNER_AUTH_TOKEN='<runner-application-token>' \
RUNNER_CALLBACK_URL='https://<INGRESS_HOST>/runner-callback' \
RUNNER_CALLBACK_TOKEN='<static-runner-callback-token>' \
corepack pnpm --filter @compte-rendu/runner start
```

The Runner derives its claim URL by resolving `/runner-claim` on the same
origin as `RUNNER_CALLBACK_URL`; no separate claim URL environment variable is
required in production. `RUNNER_CALLBACK_TOKEN` authenticates both public
Runner routes; keep it identical to the ingress secret and do not create a
second claim bearer.

Create the remotely managed Tunnel first with the pinned `tunnel create`
command above, and retain its returned `<TUNNEL_ID>`. Retrieve its connector
token from the Dashboard's **Add a replica** action or the documented API
above. Install the connector persistently on this host:

```sh
cloudflared --version
sudo cloudflared service install '<TUNNEL_CONNECTOR_TOKEN>'
sudo systemctl enable --now cloudflared
sudo systemctl is-active cloudflared
```

Use `cloudflared` 2025.7.0 or later, with protocol `auto` or `quic`, and allow
outbound UDP port 7844. Before continuing, require the local service to be
active and the Dashboard to show a **Healthy/Connected** connector for the
exact `<TUNNEL_ID>`. Only then register the Runner's fixed HTTP target and
retain the returned VPC Service UUID for the renderer:

```sh
corepack pnpm dlx wrangler@4.124.0 vpc service create <RUNNER_SERVICE_NAME> \
  --type http \
  --tunnel-id <TUNNEL_ID> \
  --ipv4 127.0.0.1 \
  --http-port 8080
```

Pass that UUID to `render:wrangler` as `<RUNNER_VPC_SERVICE_ID>`. Set the
same bearer value in `RUNNER_AUTH_TOKEN` on the runner host and the core
Worker secret; the model resolver command and token stay on the runner host.

The VPC Service UUID is deployment data and does not belong in the tracked
template. Also enable a `workers.dev` subdomain for the public ingress URL. See
[workers.dev setup](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

Run these commands from the repository root. Every `wrangler` command below
uses the temporary invocation described above.

1. Install and check the repository:

   ```sh
   corepack pnpm install --frozen-lockfile
   corepack pnpm check
   corepack pnpm test
   corepack pnpm build
   ```

2. Choose an instance name and create the D1 database with its derived name:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 d1 create <INSTANCE_NAME>-review-state
   ```

   Create the private R2 bucket and apply one 90-day official R2 lifecycle
   rule. The rule name and `reviews/` prefix are positional arguments in
   Wrangler 4.124.0; this is bucket configuration, not application cleanup
   code:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 r2 bucket create <INSTANCE_NAME>-review-evidence
   corepack pnpm dlx wrangler@4.124.0 r2 bucket lifecycle add <INSTANCE_NAME>-review-evidence review-evidence-retention reviews/ --expire-days 90 --force
   ```

   The lifecycle rule is evaluated by Cloudflare R2 and expires objects under
   `reviews/` automatically. Do not add a cleanup Worker, cron, or maintenance
   process.

   Copy only the returned `database_id` into the renderer command below. Do
   not edit either tracked template or copy any account ID, token, or other
   output into the repository.

3. Render deployment-only configs from the repository root:

   ```sh
   corepack pnpm render:wrangler <INSTANCE_NAME> <GITHUB_APP_ID> <D1_DATABASE_ID> <RUNNER_VPC_SERVICE_ID> '<GITHUB_INSTALLATION_IDS_JSON>' '<GITHUB_BOT_AUTHOR_IDS_JSON>'
   ```

   This writes `apps/core/wrangler.<INSTANCE_NAME>.jsonc` and
   `apps/ingress/wrangler.<INSTANCE_NAME>.jsonc`. Use these generated paths
   for every deployment operation below; never modify the tracked templates.

4. Apply the tracked D1 migration remotely. Use the binding name from the
   generated config, not a guessed database identifier:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 d1 migrations list REVIEW_DB --remote --config apps/core/wrangler.<INSTANCE_NAME>.jsonc
   corepack pnpm dlx wrangler@4.124.0 d1 migrations apply REVIEW_DB --remote --config apps/core/wrangler.<INSTANCE_NAME>.jsonc
   ```

   Apply all tracked migrations in order:
   `apps/core/migrations/0001_review_state.sql` creates the deliveries,
   approvals, and review-runs tables plus the active-PR index. It also retains
   an unused legacy finding-fingerprints table; body-only publication does not
   populate or use it. `apps/core/migrations/0002_allow_manual_retry.sql` rebuilds
   `review_runs` while preserving its rows, then permits another run for a
   head after a failed or superseded run by making uniqueness apply only to
   `scheduled` and `completed` rows; it retains the active-PR index. D1
   `0003_runner_evidence.sql` adds only evidence object metadata and execution
   timestamps, while `0004_runner_admission.sql` adds the claimed Runner Job
   identity, attempt, and originating manual comment id.
   `0005_publication_claim.sql` adds the atomic publication claim used to keep
   concurrent duplicate callbacks from creating duplicate terminal
   publications. `0006_review_check_runs.sql` stores the GitHub Check Run id and
   setup state. New admissions begin in pending setup, but Runner claims never
   wait for this progress-only GitHub API work. Check success records the id,
   Check API failure records degraded visibility, and an interrupted pending
   setup remains claimable without manual D1 repair.
   `0007_check_setup_lease.sql` adds the short ownership lease that prevents an
   active delivery replay from creating a second Check while allowing a later
   replay to recover an interrupted setup. The one-minute lease exceeds
   Cloudflare's 30-second post-response `waitUntil()` execution limit, so an
   expired owner is no longer running. D1 migration files are versioned and
   applied in order; see
   [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

   The generated core config also retains the legacy Durable Object migration
   history: `v1` provisions `Sandbox` and `ReviewLeaseDurableObject`, then `v2`
   deletes both classes. Do not remove, rename, or reorder these migration
   entries. Applying `v2` permanently deletes any stored objects for those
   retired classes; export anything the owner must retain before deploying the
   core Worker. Existing environments receive only the unapplied `v2` step.

5. Enter the two core secrets. Each command prompts for the value; do not
   append a value to the command line, use `echo`, or redirect a secret from a
   shell command:

   Before these `secret put` commands, create a dedicated Compte rendu
   product GitHub App and generate/download its private key. Supply that App's
   numeric, non-secret App ID to the renderer command in step 3.

   The local repository-operations App and private key are not the product
   identity; do not reuse them. Do not install or approve the App yet; after
   both Workers are deployed, complete the final webhook configuration and
   installation sequence in step 8. Follow GitHub's
   [private-key guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
   when generating and downloading the key.

   ```sh
   corepack pnpm dlx wrangler@4.124.0 secret put GITHUB_APP_PRIVATE_KEY --config apps/core/wrangler.<INSTANCE_NAME>.jsonc
   corepack pnpm dlx wrangler@4.124.0 secret put RUNNER_AUTH_TOKEN --config apps/core/wrangler.<INSTANCE_NAME>.jsonc
   ```

   The private key and Runner authentication credential belong only to
   `<INSTANCE_NAME>-core`; the model credential remains on the runner host.
   Cloudflare's `secret put` creates and deploys a new Worker version
   immediately, so complete the D1 migration before these commands. Worker
   secrets are encrypted bindings and are intentionally separate from
   plaintext `vars`:
   [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

6. Deploy the private core Worker first:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 deploy --config apps/core/wrangler.<INSTANCE_NAME>.jsonc
   ```

   Confirm the deployment reports the `RUNNER` VPC Service, `REVIEW_DB`, and
   `EVIDENCE_BUCKET` bindings without a missing-secret or
   missing-D1 error.

7. Enter the ingress webhook secret only after core is deployed, then deploy
   public ingress second:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 secret put WEBHOOK_SECRET --config apps/ingress/wrangler.<INSTANCE_NAME>.jsonc
   corepack pnpm dlx wrangler@4.124.0 secret put RUNNER_CALLBACK_TOKEN --config apps/ingress/wrangler.<INSTANCE_NAME>.jsonc
   corepack pnpm dlx wrangler@4.124.0 deploy --config apps/ingress/wrangler.<INSTANCE_NAME>.jsonc
   ```

   The `secret put` command itself creates an ingress version; the explicit
   deploy then publishes the current checkout with the same secret. The
   `WEBHOOK_SECRET` value must match the GitHub App webhook secret exactly.
   `RUNNER_CALLBACK_TOKEN` must be the same static bearer value configured on
   the Runner and authenticates both `/runner-claim` and `/runner-callback`.
   Record the resulting public ingress URL as the operator's
   `<INGRESS_URL>`. The `CORE` binding points to the already deployed
   `<INSTANCE_NAME>-core`; deploying in the opposite order can fail because the
   target service does not exist yet.

8. After both Workers are deployed, configure the final webhook URL as
   `<INGRESS_URL>`, set the matching webhook secret, and confirm the final
   permissions plus `pull_request` and `issue_comment` subscriptions. Only
   then perform the one GitHub App installation or approval for the selected
   repositories. Activate delivery after installation and send a test delivery
   only after activation.

9. Keep the generated configs through installation and the deployed E2E/D1
   verification session. After verification is complete, remove exactly the
   two deployment-only configs:

   ```sh
   rm apps/core/wrangler.<INSTANCE_NAME>.jsonc apps/ingress/wrangler.<INSTANCE_NAME>.jsonc
   ```

   Render them again for a later deployment; the tracked templates remain
   unchanged.

The deployed variables-versus-secrets inventory is deliberately small:

| Worker                    | Plain variable                                       | Secrets                                       | Non-secret bindings                                  |
| ------------------------- | ---------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| `<INSTANCE_NAME>-ingress` | `ALLOWED_INSTALLATION_IDS`, `ALLOWED_BOT_AUTHOR_IDS` | `WEBHOOK_SECRET`, `RUNNER_CALLBACK_TOKEN`     | `CORE` → `<INSTANCE_NAME>-core`                      |
| `<INSTANCE_NAME>-core`    | `GITHUB_APP_ID`                                      | `GITHUB_APP_PRIVATE_KEY`, `RUNNER_AUTH_TOKEN` | `REVIEW_DB`, `EVIDENCE_BUCKET`, `RUNNER` VPC Service |

`GITHUB_APP_ID`, `ALLOWED_INSTALLATION_IDS`, and `ALLOWED_BOT_AUTHOR_IDS` are
deployment configuration, not secrets. Supply them only through the renderer:
copy the dedicated product App ID into its core argument and pass the numeric
installation and optional Bot author IDs in its ingress arguments. Do not leave
either required placeholder, duplicate either value in a secret, or reuse the
repository-operations App identity. Repository IDs, PR numbers,
SHAs, `deliveryId`s, `runId`s, and `sandboxId`s are runtime data, not values to
hard-code in the manual.

## Verification

### Local checks

Run the proportionate repository checks against the immutable checkout:

```sh
corepack pnpm check
corepack pnpm test
corepack pnpm build
git diff --check
```

These checks can prove local behavior such as a signed webhook reaching CORE,
D1 queue/claim state changes, Runner pull capture, and the relevant public
behavior.
They do not prove the deployed
Runner service, Docker Sandbox lifecycle, GitHub publication, or model
usefulness. Green local mechanics alone do not prove that a review is useful;
use the deployed acceptance gate below for that. See
[`docs/local-runtime-tracer.md`](local-runtime-tracer.md) for the tracer's
limits.

### First-deployment acceptance gate

Use exactly one explicitly allowlisted GitHub App installation and one
intentionally selected real, low-risk pull request in a repository that it
can access. Do not add a manufactured rejected-installation probe. Before
triggering the review, record the repository, PR number, exact base SHA, exact
head SHA, and the single installation ID in the generated config.

1. Trigger one eligible review through the real GitHub webhook. Confirm the
   delivery is accepted and record its `<DELIVERY_ID>` and the resulting
   `<RUN_ID>`.
2. Confirm GitHub shows one visible body-only review for that PR and exact
   `<HEAD_SHA>` with event type `COMMENT`. It must contain a useful, readable
   Markdown review body (actionable findings in prose or a clear no-findings
   conclusion), and its URL must be retained as
   `<PR_URL>#pullrequestreview-<REVIEW_ID>`.
3. Query the deployed D1 binding and require the delivery and run to be
   terminal and to retain the exact recorded base/head SHAs:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 d1 execute REVIEW_DB --remote --config apps/core/wrangler.<INSTANCE_NAME>.jsonc --command "SELECT delivery_id, status, base_sha, head_sha FROM deliveries WHERE delivery_id = '<DELIVERY_ID>'; SELECT run_id, status, base_sha, head_sha, runner_job_id, runner_attempt, evidence_key, evidence_status, evidence_size, evidence_sha256, execution_started_at, submission_completed_at, cleanup_completed_at FROM review_runs WHERE delivery_id = '<DELIVERY_ID>';"
   ```

   The expected terminal state for this successful gate is `completed` for
   both rows, with the recorded `<BASE_SHA>` and `<HEAD_SHA>` unchanged. The
   run must also report `evidence_status = complete`, all three execution
   timestamps, and the admitted Runner Job identity.

   Fetch that exact private R2 object without Runner SSH, writing it to an
   operator-chosen local file with mode `0600`:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 r2 object get <INSTANCE_NAME>-review-evidence/<EVIDENCE_KEY> --remote --file <EVIDENCE_FILE>
   ```

   Require the downloaded byte size and SHA-256 to match `evidence_size` and
   `evidence_sha256` from D1. The JSON object must contain the same run, Job,
   and evidence identities plus the named manifest, JSONL, stderr, validated
   review, session-list, and matching session-export fields. Do not publish
   the private object or its session content.

4. Perform a fresh current-head check and require the GitHub PR head to still
   equal the recorded SHA:

   ```sh
   gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER> --jq '{base: .base.sha, head: .head.sha, url: .html_url}'
   ```

   Finally, confirm the Runner log reports the Sandbox cleanup as `destroyed`
   for `<RUN_ID>` and that no Sandbox remains on the host:

   ```sh
   sbx ls
   ```

   `sbx ls` must be empty. Do not treat a successful local tracer or a
   successful HTTP request as evidence that the published review is useful.

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
   migration command above. Prefer additive, backward-compatible changes.
3. Render deployment-only configs again with the same
   `corepack pnpm render:wrangler <INSTANCE_NAME> <GITHUB_APP_ID> <D1_DATABASE_ID> <RUNNER_VPC_SERVICE_ID> '<GITHUB_INSTALLATION_IDS_JSON>' '<GITHUB_BOT_AUTHOR_IDS_JSON>'`
   inputs, then deploy using `apps/core/wrangler.<INSTANCE_NAME>.jsonc` and
   `apps/ingress/wrangler.<INSTANCE_NAME>.jsonc`.
4. Redeliver one controlled GitHub event and inspect the identifier chain.

The core-before-ingress order preserves the service-binding contract. For an
incompatible change, pause GitHub webhook delivery first, deploy a compatible
core, then ingress, and reactivate delivery only after verification.

If a release is bad, stop webhook delivery if it is generating new runs. Roll
back the affected Worker to its last known-good deployment in the Cloudflare
Workers deployment controls; if both Workers changed, roll back core before
ingress. Do not delete D1 tables or edit the applied migration ledger to undo
a release. A schema rollback is a separate, reviewed migration or an operator
approved D1 recovery action.

## Uninstall and cleanup

This is destructive. Confirm the repository owner wants the run history and
that no review is in flight before proceeding.

1. Disable the GitHub App webhook.
2. Uninstall the GitHub App from every selected repository. Confirm no new
   deliveries arrive, then delete the App registration if it is no longer
   needed and revoke its private key.
3. Render deployment-only configs again with the same
   `corepack pnpm render:wrangler <INSTANCE_NAME> <GITHUB_APP_ID> <D1_DATABASE_ID> <RUNNER_VPC_SERVICE_ID> '<GITHUB_INSTALLATION_IDS_JSON>' '<GITHUB_BOT_AUTHOR_IDS_JSON>'`
   inputs. Delete the public `<INSTANCE_NAME>-ingress` Worker, then the private
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

## Official references

- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Cloudflare account-scoped custom token for GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Workers VPC getting started](https://developers.cloudflare.com/workers-vpc/get-started/)
- [Workers VPC Service configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)
- [Workers VPC Wrangler commands](https://developers.cloudflare.com/workers-vpc/reference/wrangler-commands/)
- [Workers VPC Tunnel requirements](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/#create-and-run-tunnel-cloudflared)
- [GitHub App permission selection](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub permission-to-endpoint reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- [GitHub webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [GitHub App installation scope](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)
- [GitHub App private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
