# Installation and operations

This guide installs one SvelteKit Worker and the self-hosted Runner.
For diagnosis, upgrades, rollback and uninstall, use [Operations](operations.md).
It assumes one Cloudflare account, one or more explicitly allowlisted GitHub App installations, and the
repository checkout that contains this file. It does not create resources or
credentials by itself.

Values in angle brackets are operator choices. Do not replace them with values
from another installation.

## External LLM service status

The [LLM service deployment guide](llm-service.md) covers the standalone
host service and LiteLLM backend: routes, credentials, optional subscription setup, systemd
startup, and listener checks. Deploy it independently of the Runner.

For an sbx Runner, follow [Connecting an sbx Runner](llm-service.md#connecting-an-sbx-runner)
to configure the private control socket, route alias and local inference URL.
Changing `REVIEW_MODEL_CONFIG.baseUrl` alone is insufficient: service mode must
also manage per-job grant issuance and revocation. OpenShell continues to use
its gateway model provider; this service integration does not yet support it.

## What is deployed

The repository deploys these resources:

| Resource           | Configuration name                                                           | Purpose                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public Worker      | `<INSTANCE_NAME>-ingress`                                                    | Serves the public dashboard and receives GitHub webhooks and authenticated Runner claim/callback/progress requests. Use the generated workers.dev route or an instance custom domain. |
| D1 database        | `<INSTANCE_NAME>-review-state`, binding `REVIEW_DB`                          | Stores delivery, approval, and run state.                                                                                                                                             |
| R2 evidence bucket | `<INSTANCE_NAME>-review-evidence`, binding `EVIDENCE_BUCKET`                 | Private bucket storing one bounded JSON evidence bundle per Job; lifecycle expiration is configured at deployment.                                                                    |
| Runner Job service | Self-hosted runner reached through the Worker’s `RUNNER` VPC Service binding | Owns one authenticated asynchronous review attempt and fresh Docker Sandbox cleanup.                                                                                                  |

The request path is:

```text
GitHub webhook
    → <INSTANCE_NAME>-ingress (public, verifies WEBHOOK_SECRET)
    → internal authorization and review coordinator
       → REVIEW_DB / EVIDENCE_BUCKET / RUNNER VPC Service (targeted cancellation only)
       → GitHub App installation token for GitHub API operations

Idle Runner
    → <INSTANCE_NAME>-ingress `/runner-claim` (RUNNER_CALLBACK_TOKEN)
    → internal coordinator atomic D1 claim
    → Runner Job execution and cleanup
    → <INSTANCE_NAME>-ingress `/runner-callback` (same token)
```

For a newer head that supersedes a reachable running old-head Job, Core uses
the private `RUNNER` VPC Service for the authenticated targeted
`DELETE /jobs/:id`, waits for the Runner's terminal cleanup confirmation, and
only then permits the newer queued run to be claimed. Core does not use this
binding to submit new Jobs. The Tunnel and VPC Service remain required for
that cancellation path.

The tracked [`apps/dashboard/wrangler.jsonc`](../apps/dashboard/wrangler.jsonc)
is the neutral deployment template. Core and ingress remain internal code modules;
there is no Worker-to-Worker `CORE` binding. From the repository root, render one
deployment-only sibling configuration for the chosen instance:

```sh
corepack pnpm render:wrangler <INSTANCE_NAME> <GITHUB_APP_ID> <D1_DATABASE_ID> <RUNNER_VPC_SERVICE_ID> '<GITHUB_INSTALLATION_IDS_JSON>' '<GITHUB_BOT_AUTHOR_IDS_JSON>'
```

For example, instance `petit-chiba` produces
`apps/dashboard/wrangler.petit-chiba.jsonc`, with names derived as
`petit-chiba-ingress`, `petit-chiba-review-state`, and
`petit-chiba-review-evidence`. Instance names never require editing the repository or
the tracked templates. The renderer keeps the tracked placeholders unchanged
and refuses to overwrite an existing generated config.

`<GITHUB_INSTALLATION_IDS_JSON>` must be a non-empty JSON array of positive
numeric GitHub App installation IDs, for example `[123456789]`. It is written
only to the generated ingress config as `ALLOWED_INSTALLATION_IDS`; the tracked
template remains a placeholder. Ingress fails closed with HTTP `503` when the
value is missing or malformed, and ignores signed events from installations outside the
allowlist before calling the internal coordinator.

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

PostHog capture is optional and disabled unless the PostHog argument is supplied
with an enabled JSON object. The project API key is a non-secret ingestion key;
never provide a PostHog Personal API key. For example:

```sh
corepack pnpm render:wrangler petit-chiba <GITHUB_APP_ID> <D1_DATABASE_ID> <RUNNER_VPC_SERVICE_ID> '<GITHUB_INSTALLATION_IDS_JSON>' '[]' \
  '{"enabled":true,"projectApiKey":"phc_<PROJECT_KEY>","host":"https://us.i.posthog.com","deployment":"petit-chiba","environment":"production"}'
```

The renderer writes these values only to the generated, gitignored Core
configuration: `POSTHOG_ENABLED`, `POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST`,
`POSTHOG_DEPLOYMENT`, and `POSTHOG_ENVIRONMENT`. Omit the object, or set
`enabled` to `false`, to send no PostHog requests. An enabled configuration
requires an HTTPS host, a `phc_` project API key, a bounded deployment alias,
and `production` or `staging`; missing values are reported locally and do not
change review scheduling, Runner claims, callbacks, evidence, or publication.

Independent deployed instances require distinct product GitHub Apps because
each App has one webhook URL and secret; this does not require a router.

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
| Pull requests         | Write | Publish the body-only `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` review.                                                                                                                                                      |
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

- `Check run`: `rerequested`, for the standard individual Check re-run.
- `Check suite`: `rerequested`, for the standard suite re-run. Checks write
  permission is required; GitHub documents these events as automatically
  subscribed for Apps with that permission. Verify delivery when enabling an
  installation. Other Check lifecycle actions and custom requested actions
  are ignored.

- `Repository`: `privatized`, `deleted`, and `transferred` invalidate retained
  public identity. Other repository actions do not schedule reviews.
- Installation removal/suspension and removal of repositories from an installation
  invalidate the corresponding cached identities. These App installation events
  are handled independently of review scheduling. GitHub delivers
  `installation` and `installation_repositories` to all Apps by default; they
  cannot be manually subscribed or unsubscribed.

Do not subscribe to push, review, status, or issue events;
they are not part of this Worker contract. GitHub's event reference lists the
available event actions:
[Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

Manual command reactions are compact operator feedback: `eyes` means the
authorized command was claimed and scheduled, `confused` means the command
was denied, the pull request was missing or draft, or the run was superseded,
and `-1` means the accepted run ended failed. A successful run keeps only
`eyes`; its published review is the completion signal. A failed run
also publishes one ordinary PR comment so automatic and manual runs both have
a visible terminal notification. Automatic reviews do not react to a command.
Reaction writes target the originating numeric comment id and may be replayed
safely with the same app and content.

The Check Run is progress display rather than a replacement for those terminal
notifications. It is created as `queued`, becomes `in_progress` when claimed,
and completes as `success`, `failure`, or `cancelled`. Its `external_id` is the
Core run id and it is always attached to that run's immutable head SHA. A Check
API failure must not block the Review or failure comment.

After a review fails, a user with `write`, `maintain`, or `admin` permission can
use the standard Checks re-run control or post a new `/ai-review` comment.
Both routes load the current PR revision and share admission/deduplication;
a re-run creates a new run and Sandbox while retaining the failed history.
Check-origin requests do not add comment reactions. The integration only
re-runs a failed Check owned by this deployment and ignores unrelated Checks.

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
- Active delivery: enabled only after the Worker is deployed and the
  ingress secret is present.

GitHub signs deliveries with the configured secret in
`X-Hub-Signature-256`; the ingress verifies that HMAC before forwarding any
event. Follow GitHub's
[webhook validation guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
for the secret and signature requirements. Never put the App private-key
value, webhook secret, installation token, model key, or a private-key file
path in this repository or in an issue/comment.

## Sandbox host and Runner

Before starting, install Docker Sandboxes with `sbx` 0.48.0, complete Docker
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

Host policy is operator state, not daemon state. The origin of any unintended
global allow rules is not established here; the same default allow rules were
present in a pre-upgrade policy backup, so do not attribute them to the upgrade.
Treat an `sbx` upgrade as a checkpoint: inspect the effective rules with
`sbx policy ls --type network --include-inactive` (add `--wide` to see rule IDs)
and remove each unintended editable global allow rule by its exact ID:

```sh
sbx policy rm network --id <RULE_ID> --force
```

Removing individual IDs preserves unrelated policy. Do not use
`sbx policy init deny-all` as an upgrade step: `policy init` is one-time setup
and fails against an already-initialized policy. `sbx policy reset` deletes all
custom policies and stops the daemon (stopping running sandboxes); reserve it
for an explicitly dedicated, drained host with a backup, and re-initialize
afterward. The Runner adds only its own per-job allow rules on top of the host
baseline; it never establishes the host default.

Install the repository dependencies and build the runner. The resolver command
must not contain a model secret; `MODEL_SECRET_COMMAND` is never sent to the
Worker:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @compte-rendu/runner build
```

### Offline Sandbox template deployment

The Runner uses the versioned custom template
`ghcr.io/ariga39/petit-chiba-opencode:2.0.32-gh2.98.0`. When the NUC should
not pull from a registry, build and transfer the ordinary OCI image from a
trusted build host, then load it into the NUC's separate Sandbox image store.
Do not run these commands inside a review Sandbox or as a Runner Job, and do
not put credentials in the image:

```sh
docker buildx build \
  --platform linux/amd64 \
  --load \
  --tag ghcr.io/ariga39/petit-chiba-opencode:2.0.32-gh2.98.0 \
  apps/runner/sandbox-template

docker image save \
  ghcr.io/ariga39/petit-chiba-opencode:2.0.32-gh2.98.0 \
  -o petit-chiba-opencode.tar
```

Transfer `petit-chiba-opencode.tar` to the NUC using the operator's approved
offline transfer method. On the NUC, load and probe the image before starting
the Runner:

```sh
sbx template load /path/to/petit-chiba-opencode.tar
sbx create \
  --name petit-chiba-template-probe \
  --no-share-skills \
  --template ghcr.io/ariga39/petit-chiba-opencode:2.0.32-gh2.98.0 \
  --cpus 4 \
  --memory 8g \
  shell /path/to/non-sensitive-probe-workspace
sbx exec petit-chiba-template-probe opencode --version
sbx exec petit-chiba-template-probe gh version
sbx rm --force petit-chiba-template-probe
rm /path/to/petit-chiba-opencode.tar
```

The version probes must report OpenCode `opencode v2.0.32` and GitHub CLI `2.98.0`.
Keep the loaded template for the Runner. A later registry deployment may
replace the local tag with a fully qualified registry reference plus its
recorded digest, but registry access and a digest are optional for this
offline path. Continue with the Runner start below only after the probe and
cleanup succeed.

The Runner also launches the `shell` built-in agent with this same pinned
template, then runs `opencode` and `gh` inside it with `sbx exec`. This is
deliberate: the built-in `opencode` agent kit declares its own
`permissions.network.allow` list (AI providers, package registries, code hosts,
Ubuntu archives and more) and applies it to the sandbox's scoped policy, so
selecting `opencode` as the launcher auto-provisions that egress on top of the
host default. The `shell` kit has no such default allow list, so the Runner's
explicit per-job `policy allow` rules (the configured model host and
`api.github.com:443`) are the only egress the review sandbox has — provided the
host default is `deny-all` and no other global or organization-governance allow
rules are active. This is long-standing shipped kit behavior, not a 0.48 change;
the upgrade only made it worth verifying.

### Runner configuration

Use the pinned OpenCode 2 image. Runner uses standalone mode with fresh per-job
state and proxy-only credentials; never copy personal OpenCode auth/state into
the image or job. It translates `REVIEW_MODEL_CONFIG` to native V2 provider/model
settings. Final output is JSON `decision` + `markdown`, with one same-session
correction before cleanup; no submission plugin is installed. See
[review decisions](review-decisions-design.md).

The environment example below is **direct-provider mode**. For the recommended
host LLM service and configurable multi-model selection, use
[the service-mode environment](llm-service.md#connecting-an-sbx-runner) instead;
that mode uses job grants and does not require `MODEL_SECRET_COMMAND`.

The runner listens only on IPv4 loopback port `8080`. It runs as the persistent
service below on the host that also runs the remotely managed Tunnel connector.
On a first installation, create its environment file with mode `0600` and put
each required variable on one line in systemd `EnvironmentFile` syntax. Values
are not shell-expanded, so do not use `export` or backslash continuations, and
keep the JSON on one line. On an upgrade, keep the existing file and values;
the `install` command truncates the destination:

```sh
install -m 0600 /dev/null <ABSOLUTE_RUNNER_ENV_FILE>
${EDITOR:-vi} <ABSOLUTE_RUNNER_ENV_FILE>
```

```ini
REVIEW_MODEL_CONFIG={"id":"opencode-go/deepseek-flash","definition":{"name":"DeepSeek V4.1 Flash","reasoning":true,"interleaved":{"field":"reasoning_content"},"limit":{"context":1000000,"output":384000},"cost":{"input":0.15,"output":0.6,"cache_read":0.003}}}
MODEL_SECRET_COMMAND=<host-secret-resolver-command>
RUNNER_AUTH_TOKEN=<runner-application-token>
RUNNER_CALLBACK_URL=https://<INGRESS_HOST>/runner-callback
RUNNER_CALLBACK_TOKEN=<static-runner-callback-token>
RUNNER_CONCURRENCY=1
```

Confirm the file is still mode `0600` after editing; never commit it. The
`RUNNER_AUTH_TOKEN` and `RUNNER_CALLBACK_TOKEN` values belong only in this file
and the matching Worker secrets.

`REVIEW_MODEL_CONFIG` is required deployment configuration, read once when the
Runner starts. Its `id` selects an `opencode-go/<model-id>` model; there is no
default model. The optional `definition` registers that model when the pinned
OpenCode image's bundled catalog does not contain it. The example above uses
the [official model metadata](https://models.dev) for DeepSeek V4.1 Flash.
For a model already in the bundled catalog, supply only `id`.

Change this JSON in the Runner's service environment and restart the Runner to
switch models; a source change, rebuild, or Worker deployment is unnecessary.
The selected ID is used consistently by OpenCode and the evidence manifest.
Missing or invalid model configuration prevents queue claims and returns `503`
for authenticated Job admission.

To use a gateway compatible with the selected `opencode-go` model, add an
optional `baseUrl`, for example `"baseUrl": "https://model.example.com/v1"`.
It must be an absolute HTTPS URL without embedded credentials, a query, a
fragment, or wildcard hostname. When omitted, OpenCode uses the official provider endpoint. The
Runner sets the configured URL in OpenCode 2's provider and model
`settings.baseURL`, scopes the
Docker credential proxy to its hostname, and allows model traffic only to its
host and port (443 by default). Cleanup removes that Job's exact network rule.

Set `MODEL_SECRET_COMMAND` to a host resolver for the API key belonging to that
gateway, then restart the Runner with both settings applied. Keep the key out
of `REVIEW_MODEL_CONFIG`; the Sandbox receives only Docker's placeholder, and
the host proxy supplies the credential. Review permissions remain unchanged.
Under `sbx` 0.48 the command runs from a fresh temporary host directory, so use
an absolute program path and absolute file references (for example
`/usr/bin/cat /run/secrets/model-key`); relative commands such as `cat token` no
longer resolve against the project or daemon working directory. Keep the helper
and every file it reads outside writable sandbox mounts.

### Sandbox runtime selection

The Runner executes reviews through a per-job sandbox runtime adapter.
`RUNNER_SANDBOX_RUNTIME` selects `sbx` (the default, unchanged production path)
or `openshell`. An unknown value, or an incomplete OpenShell configuration,
fails at startup before any claim or admission.

OpenShell additionally requires:

- `OPENSHELL_IMAGE` — the review image, for example a locally built
  `compte-rendu-openshell:<tag>` from `apps/runner/openshell-template/Dockerfile`.
  The Docker `sbx` template reference is never reused.
- a gateway: `OPENSHELL_GATEWAY` (a registered name) or
  `OPENSHELL_GATEWAY_ENDPOINT` (for example `http://127.0.0.1:18670`).
- `OPENSHELL_MODEL_PROVIDER` — the pre-provisioned model provider name; its
  credential lives gateway-side, so OpenShell never runs `MODEL_SECRET_COMMAND`.
- optional `OPENSHELL_GITHUB_PROFILE` (default `cr-github`) and
  `RUNNER_SANDBOX_CLI` (default `openshell`).

TLS certificate verification stays enabled for HTTPS or named gateways;
`OPENSHELL_GATEWAY_INSECURE` only turns verification off. An explicit
`http://127.0.0.1:<port>` loopback endpoint is plaintext by design, not a
verification failure. The gateway ships no provider profiles, so import the
non-secret samples from `apps/runner/openshell-template/` before starting the
Runner:

```sh
openshell profile import -f apps/runner/openshell-template/cr-model.yaml
openshell profile import -f apps/runner/openshell-template/cr-github.yaml
```

Import into the same workspace the Runner operates in (default `default`) rather
than `--global`: provider creation and the startup preflight are workspace
scoped, and a global import is not merged into that workspace. The Runner's
startup preflight pages `provider list --output json` and fails closed unless
the configured model provider is present.

Create the pre-provisioned model provider from the host environment without
putting the key on the command line: set `OPENCODE_API_KEY` in the environment
and pass the bare key so OpenShell reads it from the child process environment,
never argv:

```sh
OPENCODE_API_KEY="$(cat /run/secrets/model-key)" \
  openshell provider create --name cr158-model --type cr-model --credential OPENCODE_API_KEY
```

On a host that runs only the Runner and manages the OpenShell gateway
separately, the unit's `ExecStart` is just the Node process — there is no
`sg kvm` / `sbx daemon start` prefix. If you edit the base unit that already
defines an `ExecStart`, clear it with a blank assignment before the new one;
otherwise systemd keeps the first `ExecStart`:

```ini
[Service]
ExecStart=
ExecStart=<ABSOLUTE_NODE> <REPO_ROOT>/apps/runner/dist/runner.js
```

Alternatively, leave the base unit untouched and supply the Node-only
`ExecStart` as a drop-in override (for example
`~/.config/systemd/user/<RUNNER_UNIT>.d/openshell.conf` with the same two lines); a
drop-in replaces the accumulated value the same way. The gateway is started and
supervised separately (for example by its own container or service); the Runner
only needs `RUNNER_SANDBOX_CLI` to resolve the `openshell` binary and the
gateway endpoint/name.

`cr-model` declares the model credential `OPENCODE_API_KEY`, permits only
`POST` to `opencode.ai` under `protocol: rest` + `enforcement: enforce`, and
allows only `/usr/local/bin/opencode`. `cr-github` gives
`/usr/local/bin/gh` read-only REST and `read-only` GraphQL to `api.github.com`
only. The Runner creates one unique GitHub provider per job and deletes only
that provider during cleanup. OpenShell sandboxes use the fixed in-sandbox paths
`/workspace/checkout`, `/workspace/config`, and `/workspace/evidence`.

The Runner derives its claim URL by resolving `/runner-claim` on the same
origin as `RUNNER_CALLBACK_URL`; no separate claim URL environment variable is
required in production. `RUNNER_CALLBACK_TOKEN` authenticates both public
Runner routes; keep it identical to the ingress secret and do not create a
second claim bearer.

`RUNNER_CONCURRENCY` is an optional positive integer that bounds how many
independent review Jobs the Runner executes at once; it defaults to `1`, which
preserves the previous serialized behavior. Set it to `2` or higher to overlap
reviews for different pull requests. Same repository/PR work is always
serialized until the prior Sandbox is confirmed destroyed, and a slot is held
through evidence archival, Sandbox cleanup, and the terminal callback. An
empty, zero, negative, fractional, or non-numeric value is rejected before
the Runner claims or admits any work. Size the host for the chosen value: each
concurrent review runs its own Sandbox with `--cpus 4` and `--memory 8g` plus
one 30-minute agent budget, so `RUNNER_CONCURRENCY=2` needs roughly twice the
CPU, memory, disk, and model throughput of the default. Prefer the smallest
value that removes head-of-line blocking. This setting reuses the existing D1
durable queue and adds no new queue, scheduler, or retry system. The Runner
reads this environment variable once at startup. For changes without restarting,
configure the TOML settings file below.

### Reload concurrency without restarting

The optional `RUNNER_SETTINGS_FILE` selects one TOML file. Its `concurrency`
value takes precedence over `RUNNER_CONCURRENCY` (and the programmatic
concurrency option). Without a settings file, the environment/default behavior
above is unchanged.

Create the file once, as the Runner user; keep it outside Sandbox writable
mounts. Preserve an existing file when upgrading:

```sh
mkdir -p ~/.config/compte-rendu
(umask 077; printf 'concurrency = 3\n' > ~/.config/compte-rendu/runner-settings.toml)
```

Add its absolute path to the existing Runner environment file:

```ini
RUNNER_SETTINGS_FILE=/home/<RUNNER_USER>/.config/compte-rendu/runner-settings.toml
```

After existing reviews finish, restart the Runner once to enable file loading.
Subsequent edits to this TOML file reload automatically without a restart:

```toml
concurrency = 3
```

Use a positive integer; unsupported keys and invalid TOML are rejected. Save by
atomic replacement (write a temporary file in the same directory, then rename
it over the settings file) to avoid exposing a partially written configuration.
The Runner uses `smol-toml` for parsing, `chokidar` for file events and editor
replacement handling, and Effect Schema for validation.

Increasing the limit wakes the claim loop. Decreasing it lets admitted Jobs and
in-flight claims finish; new work waits until occupancy is below the new limit.
Cleanup and terminal callbacks continue to hold their slots. A missing or
invalid initial file prevents startup. A missing, unreadable, or invalid later
update retains the last valid limit and records a warning; a subsequent valid
save recovers automatically. Successful reload logs include the effective
concurrency. Inspect them with:

```sh
journalctl --user -u <RUNNER_UNIT> -f
```

Only concurrency reloads. Changing `RUNNER_SETTINGS_FILE` itself, model settings,
credentials, or sandbox runtime still requires restarting the Runner. An
invalid file retained on disk must be fixed before a later restart.

### KVM permissions and the persistent Runner service

Docker Sandbox microVMs require `/dev/kvm`. On Debian-family hosts the device
is owned by the `kvm` group. Account membership is necessary but not sufficient:
a long-running `systemd --user` manager, the Runner service it spawned, and any
already-running `sandboxd` retain the supplementary group list they had when
they started. Adding the account to `kvm` and then restarting only the Runner
unit does not refresh that list, so a newly started daemon can still fail with
`KVM error: Permission denied` even though `id`, a fresh SSH session, or an
existing daemon appears to work. Do not treat an interactive login, `id USER`,
or a reused daemon as proof of the service startup path.

Confirm the device, the group, and the account membership once:

```sh
ls -l /dev/kvm
getent group kvm
sudo usermod -aG kvm <RUNNER_USER>
```

Throughout this section, `<RUNNER_UNIT>` is the complete systemd user unit
filename ending in `.service`, for example `compte-rendu-runner.service`. Stop
the idle Runner and any running daemon before replacing them, so the explicit
daemon startup below cannot `--detach` into the stale daemon:

```sh
systemctl --user stop <RUNNER_UNIT>
sbx daemon stop
```

For a first installation, create a minimal base unit that reads the environment
file above. `sg kvm` sets the command's effective group to `kvm` from the
current `/etc/group` and passes that effective group to its descendants:

```ini
# ~/.config/systemd/user/<RUNNER_UNIT>
[Unit]
Description=Compte rendu Runner

[Service]
WorkingDirectory=<REPO_ROOT>
Environment=PATH=<SBX_BIN_DIR>:<NODE_BIN_DIR>:/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=<ABSOLUTE_RUNNER_ENV_FILE>
UnsetEnvironment=SSH_AUTH_SOCK SSH_AGENT_PID
ExecStart=/usr/bin/sg kvm -c "<SBX_BIN_DIR>/sbx daemon start --detach && exec <ABSOLUTE_NODE> <REPO_ROOT>/apps/runner/dist/runner.js"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

A `systemd --user` service does not inherit the login shell PATH, and the
Runner invokes `sbx` by name, so `PATH` must include the `sbx` binary directory,
the Node.js binary directory, and the system sbin/bin directories (the daemon
also needs `mkfs.ext4`). Preserve an existing `path.conf` drop-in if present;
otherwise add the equivalent `PATH` to the existing unit or a drop-in.

An existing deployment that already has a unit uses a drop-in instead; the bare
`ExecStart=` line resets the inherited command before the replacement is added:

```ini
# ~/.config/systemd/user/<RUNNER_UNIT>.d/kvm.conf
[Service]
UnsetEnvironment=SSH_AUTH_SOCK SSH_AGENT_PID
ExecStart=
ExecStart=/usr/bin/sg kvm -c "<SBX_BIN_DIR>/sbx daemon start --detach && exec <ABSOLUTE_NODE> <REPO_ROOT>/apps/runner/dist/runner.js"
```

Keep deployment variables in the environment file rather than inlining
credentials in the unit. Do not use `ExecStartPre` for the daemon: systemd kills
leftover `ExecStartPre` children before `ExecStart`, so the daemon would not
survive. Do not add a `--policy` flag to `sbx daemon start`; host policy is
initialized once above.

Enable lingering so the user service starts at boot and survives the last login
session ending:

```sh
sudo loginctl enable-linger <RUNNER_USER>
systemctl --user daemon-reload
systemctl --user enable --now <RUNNER_UNIT>
```

Prove the effective permissions in the actual service process and in the newly
started daemon rather than in the operator shell. `sg kvm` sets the effective
GID, so compare the effective `Gid:` field (the second field) with the `kvm` GID
from `getent group kvm`; `Groups:` may or may not also list it:

```sh
systemctl --user show -p MainPID --value <RUNNER_UNIT>
grep -E '^(Gid|Groups):' /proc/<MAINPID>/status
sandboxd_dir="$(dirname "$(sbx daemon status | awk '/^Socket:/ {print $2}')")"
grep -E '^(Gid|Groups):' "/proc/$(cat "$sandboxd_dir/sandboxd.pid")/status"
```

The effective `Gid:` in both outputs must equal the `kvm` GID. Then create, run
a harmless command in, and destroy one real Sandbox through that service-started
daemon with plain `sbx` client calls, and confirm no scoped probe resource
remains:

```sh
sbx create --name compte-rendu-kvm-probe --no-share-skills --template ghcr.io/ariga39/petit-chiba-opencode:2.0.32-gh2.98.0 --cpus 4 --memory 8g shell /path/to/non-sensitive-probe-workspace
sbx exec compte-rendu-kvm-probe opencode --version
sbx rm --force compte-rendu-kvm-probe
sbx ls
```

`sbx ls` must not list `compte-rendu-kvm-probe`.

## Cloudflare provisioning

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
   corepack pnpm render:wrangler <INSTANCE_NAME> <GITHUB_APP_ID> <D1_DATABASE_ID> <RUNNER_VPC_SERVICE_ID> '<GITHUB_INSTALLATION_IDS_JSON>' '<GITHUB_BOT_AUTHOR_IDS_JSON>' ['<POSTHOG_CONFIG_JSON>'] ['<GITHUB_CHECK_NAME>']
   ```

   This writes `apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc`. Use these generated paths
   for every deployment operation below; never modify the tracked templates.

4. Apply the tracked D1 migration remotely. Use the binding name from the
   generated config, not a guessed database identifier:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 d1 migrations list REVIEW_DB --remote --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc
   corepack pnpm dlx wrangler@4.124.0 d1 migrations apply REVIEW_DB --remote --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc
   ```

   Apply **all** pending files from [the migration directory](../apps/core/migrations/)
   in order. They cover run state, ownership/cleanup, evidence, publication,
   Checks, dashboard visibility/lifecycle, branch refs, decisions and frozen
   review configuration. Do not edit applied migrations or replace the database.
   New Core code must not run against an older schema.

   Legacy Durable Object migration history belongs only to the retired Core
   Worker. The unified public Worker does not own those classes; do not copy
   their migration entries into its configuration. See the existing-installation
   migration procedure in [Operations](operations.md#update-and-rollback).

5. Enter the two core secrets. Each command prompts for the value; do not
   append a value to the command line, use `echo`, or redirect a secret from a
   shell command:

   Before these `secret put` commands, create a dedicated Compte rendu
   product GitHub App and generate/download its private key. Supply that App's
   numeric, non-secret App ID to the renderer command in step 3.

   The local repository-operations App and private key are not the product
   identity; do not reuse them. Do not install or approve the App yet; after
   the Worker is deployed, complete the final webhook configuration and
   installation sequence in step 8. Follow GitHub's
   [private-key guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
   when generating and downloading the key.

   ```sh
   corepack pnpm dlx wrangler@4.124.0 secret put GITHUB_APP_PRIVATE_KEY --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc
   corepack pnpm dlx wrangler@4.124.0 secret put RUNNER_AUTH_TOKEN --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc
   ```

   The private key and Runner authentication credential belong only to
   `<INSTANCE_NAME>-ingress`; the model credential remains on the runner host.
   Cloudflare's `secret put` creates and deploys a new Worker version
   immediately, so complete the D1 migration before these commands. Worker
   secrets are encrypted bindings and are intentionally separate from
   plaintext `vars`:
   [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

6. Enter the webhook and Runner callback secrets into the same Worker:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 secret put WEBHOOK_SECRET --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc
   corepack pnpm dlx wrangler@4.124.0 secret put RUNNER_CALLBACK_TOKEN --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc
   ```

   `WEBHOOK_SECRET` must match the GitHub App. `RUNNER_CALLBACK_TOKEN` must
   match the Runner and authenticates claim, callback and progress requests.

7. Build and deploy the single SvelteKit Worker:

   ```sh
   corepack pnpm build
   corepack pnpm dlx wrangler@4.124.0 deploy --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc
   ```

   Confirm `RUNNER`, `REVIEW_DB`, `EVIDENCE_BUCKET`, `ASSETS` and the Cron
   trigger are present. Record the public URL as `<INGRESS_URL>`; the retained
   name is `<INSTANCE_NAME>-ingress` so existing domains and callback URLs remain
   stable. No separate Core Worker deployment is needed.

8. After the Worker is deployed, configure the final webhook URL as
   `<INGRESS_URL>`, set the matching webhook secret, and confirm the final
   permissions and all subscriptions listed in [GitHub App setup](#github-app-permissions-and-installation),
   including `pull_request`, `issue_comment`, `check_run`, `check_suite` and repository metadata events. Only
   then perform the one GitHub App installation or approval for the selected
   repositories. Activate delivery after installation and send a test delivery
   only after activation.

9. Keep the generated, gitignored instance configurations for upgrades. They
   include choices such as account, domain, assets, Cron and Check branding.
   The renderer refuses to overwrite them. Back them up privately; do not discard
   instance settings and regenerate a default configuration for an upgrade.
   On each upgrade, merge tracked template changes into those retained files as
   described in [Update and rollback](operations.md#update-and-rollback).

The deployed variables-versus-secrets inventory is deliberately small:

| Worker                    | Plain variable                                               | Secrets                                                                                  | Non-secret bindings                                |
| ------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `<INSTANCE_NAME>-ingress` | `GITHUB_APP_ID`, allowlists, branding and telemetry settings | `GITHUB_APP_PRIVATE_KEY`, `RUNNER_AUTH_TOKEN`, `WEBHOOK_SECRET`, `RUNNER_CALLBACK_TOKEN` | `REVIEW_DB`, `EVIDENCE_BUCKET`, `RUNNER`, `ASSETS` |

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

These checks can prove local behavior such as a signed webhook reaching the internal coordinator,
D1 queue/claim state changes, Runner pull capture, and the relevant public
behavior.
They do not prove the deployed
Runner service, Docker Sandbox lifecycle, GitHub publication, or model
usefulness. Green local mechanics alone do not prove that a review is useful;
use the deployed acceptance gate below for that. See
[`docs/local-runtime-tracer.md`](local-runtime-tracer.md) for the tracer's
limits.

### Multi-model review configuration

Deploy Core migration `0012_review_configuration.sql` and the multi-model-capable
Runner before enabling a selection. This execution path requires sbx, OpenCode 2,
and the external LLM service. A selection can contain one reviewer; it runs directly with the same prompt
and output contract used for multiple reviewers. Jobs retain the selection
frozen when admitted. OpenShell does not support this multi-model path yet.

Configure each selected route in the host LLM service first (see
[LLM service configuration](llm-service.md)). Use distinct, stable route IDs such
as `deepseek-v4.1-flash` and `step-5-preview`, both using `chat-completions` for
this OpenCode adapter. Configure the upstream model and full base URL in LiteLLM YAML; keep the
job-derived OpenCode Go session header through the trusted Node service.
Restart the services only when active requests have drained;
service route definitions are not hot-reloaded. Preserve old routes until jobs
that reference them finish.

Set a dedicated `REVIEW_CONFIGURATION_TOKEN` secret on Core. The protected
`GET /api/review-configuration` and `PUT /api/review-configuration` endpoints on
the ingress origin require `Authorization: Bearer <operator token>`. They are
not public dashboard APIs; do not put this token in browser code or URL parameters.
The Runner callback token does not authorize configuration changes.

Read the current configuration, then send its `revision` with a complete
replacement selection. For example, if GET returned revision 0:

```json
{
  "revision": 0,
  "selection": {
    "reviewers": ["deepseek-v4.1-flash", "step-5-preview"],
    "synthesis": "deepseek-v4.1-flash"
  }
}
```

A successful PUT returns the new revision. A stale revision returns 409: reload
and reconcile the setting before saving again. Invalid settings are rejected.
To return new jobs to single-model review, PUT the current revision with
`"selection": null`. Changes apply only to newly admitted jobs; queued and
running jobs retain their frozen selection. No Runner restart is required for
this selection change.

Each job uses one Sandbox and one concurrency slot. A supervisor asks the
configured models for independent reviews and combines their reports into one
final decision and Markdown review. The agent manages the internal workflow;
child reports do not have to follow a separate submission schema. All sessions
share the job deadline and route-restricted grant. The retained `multi-review.json`,
session exports, and manifest record the frozen selection and available session
evidence. Runner validates the final submission and root-session completion.
The public dashboard shows one job and one final decision; it has no settings editor.

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
   `<HEAD_SHA>` with the submitted decision (`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`). It must contain a useful, readable
   Markdown review body (actionable findings in prose or a clear no-findings
   conclusion), and its URL must be retained as
   `<PR_URL>#pullrequestreview-<REVIEW_ID>`.
3. Query the deployed D1 binding and require the delivery and run to be
   terminal and to retain the exact recorded base/head SHAs:

   ```sh
   corepack pnpm dlx wrangler@4.124.0 d1 execute REVIEW_DB --remote --config apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc --command "SELECT delivery_id, status, base_sha, head_sha FROM deliveries WHERE delivery_id = '<DELIVERY_ID>'; SELECT run_id, status, base_sha, head_sha, runner_job_id, runner_attempt, evidence_key, evidence_status, evidence_size, evidence_sha256, execution_started_at, submission_completed_at, cleanup_completed_at FROM review_runs WHERE delivery_id = '<DELIVERY_ID>';"
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

## Public dashboard

The existing Ingress serves `/`, `/history`, `/help`, and `/jobs/<RUN_ID>`. The Help
page explains navigation, task states, cleanup, refresh, and privacy. Its source is
`apps/dashboard/src/lib/content/help.md`, compiled into the page by mdsvex at build time. Its public
read APIs use only D1 through Core. Opening or refreshing these pages never
queries GitHub or the Runner. The pages expose operational status and recorded
milestones, not review bodies, evidence, logs, credentials, or administrative
controls. A claimed row is a durable assignment, not proof of a live process.

Set the optional Core variable `DASHBOARD_ORIGIN` to the canonical HTTPS origin
of the deployed Ingress, without a path, query, or fragment. Enable it only after
the page and API routes are available. New and recovered product Check Runs use
this origin for their permanent `/jobs/<RUN_ID>` details link. An empty value
omits the link. GitHub retains its own Check page; this does not change links
on unrelated Actions jobs or other Apps' checks.

### Repository identity and background refresh

Apply `0009_dashboard_lifecycle.sql` before deploying the updated Workers.
Apply the additive `0010_review_branch_refs.sql` before or with the updated
Core; older Ingress payloads without branch names still admit and record null
refs. Existing runs keep null refs and display the recorded head commit only.
Run `corepack pnpm build` before deploying Ingress: the SvelteKit dashboard
workspace emits `apps/dashboard/build`, served by the existing Ingress `ASSETS`
binding. Keep the `assets` block when updating an existing generated Wrangler
config. `run_worker_first: true` preserves API, webhook and authenticated Runner
routing; SvelteKit renders dashboard pages on the server before browser hydration.
The build contains no repository or task data; browsers read the public Core
API through Ingress.
Keep the Worker Cron Trigger `* * * * *` in the deployment-specific Wrangler
configuration as well as the tracked template. The scheduled handler refreshes
shared repository metadata independently of dashboard traffic. It checks due
repositories in bounded batches with a two-minute target interval. Public
identity expires after five minutes; failed refreshes never extend that lifetime.
The UI also removes expired identity and clears names and links on refresh errors.

Enable the Repository webhook subscription above for prompt visibility-change
notifications. A repository observed as private or inaccessible loses its public
identity.
Without such an observation, a visibility change can remain visible until the
five-minute expiry. Already disclosed information cannot be retracted. Runs
whose source visibility was private remain protected even if the repository
later becomes public. Missing or expired identity appears as **Anonymous review**;
counts, outcome, and recorded milestones remain visible.

Before rollout, privately inventory repositories with retained runs and verify
that background throughput and the installation's remaining GitHub quota can
sustain the refresh interval. Do not put that inventory, repository names,
installation IDs, quota samples, or production measurements in public repository
documents. Keep operator evidence outside the checkout with restricted access.
Cloudflare's [Worker limits](https://developers.cloudflare.com/workers/platform/limits/)
apply to scheduled invocations too; account for token requests, metadata requests,
and database operations when measuring capacity.

For historical enrichment, verify each distinct retained repository through the
correct GitHub App installation. Record currently verified public identity and
legacy eligibility separately from the original source snapshot. Restrict this
operation to missing legacy eligibility; never replace a known private snapshot
or assume every historical repository was public. Unresolved repositories remain
anonymous. Do not backfill missing lifecycle timestamps, stages, or outcomes.
Repeatable enrichment must leave already recorded provenance and all review data
intact. Retain only aggregate completion counts in private rollout records.

### Compatible rollout and acceptance

Deploy additive D1 migrations, then Core and Ingress, before updating the Runner.
Older terminal callbacks remain accepted; their missing stage data is shown as
not recorded. Drain active Runner work before its restart, preserving runtime,
model, credentials, and configured concurrency. Runner stage reporting is bounded
and best effort; terminal callbacks carry cumulative milestones for recovery.

Verify overview, filtered history, pagination, an existing task deep link, neutral
missing-task handling, and an unavailable database response. Inspect complete
JSON responses as well as rendered HTML for anonymous tasks. Confirm that page
refreshes cause no GitHub or Runner calls, and that the metadata Cron completes
its refresh cycle. Check public identity expiry during refresh failure, browser
resume, and offline operation. Validate a new product Check's own run URL when a
normal review occurs; do not treat a browser screenshot as proof of lifecycle
or publication correctness.

For local browser verification, install the pinned Playwright Chromium build with
`corepack pnpm exec playwright install chromium`, then run
`corepack pnpm build` and `corepack pnpm test:dashboard`. The browser suite uses
TypeScript and the Playwright test runner; `corepack pnpm check` includes its strict
type check. CI runs the same suite. A preinstalled compatible
Chromium may be selected with `PLAYWRIGHT_CHROMIUM_PATH`; it is only a test setting.

## GitHub Check name

Set the optional Core Worker variable `GITHUB_CHECK_NAME` in its Wrangler `vars`
to brand the Check for each deployment, for example `Ariga39 AI Review`. Omitted
or blank values use `Compte-rendu review`. The dashboard header and browser title
use the same Core setting, fetched via `/api/dashboard-config`; no separate
frontend setting or rebuild is needed. This endpoint exposes only the display name.
The same name is used for creation, recovery, and Check Suite lookup.

Existing deployments that need the old name must explicitly set
`GITHUB_CHECK_NAME = "Petit Chiba Review"` before upgrading.
Drain active reviews before changing the effective name. Existing Checks keep their
original name; Check Suite lookup uses the newly configured name. If repository
branch protection requires the old Check name, update that requirement when
switching names.

For an existing deployment, edit `vars.GITHUB_CHECK_NAME` in its retained
`apps/dashboard/wrangler.<INSTANCE_NAME>.jsonc` and deploy the Worker. Preserve this setting
when merging template updates or restoring a rollback configuration; do not run
the renderer over existing files.

For the first render only, the renderer accepts the name as its final optional
argument. Include the Bot allowlist and PostHog arguments when supplying it; use
`[]` and `{"enabled":false}` when those options are unused. For example:

```sh
corepack pnpm render:wrangler ariga39-ai-reviewers <GITHUB_APP_ID> <D1_DATABASE_ID> <RUNNER_VPC_SERVICE_ID> '<GITHUB_INSTALLATION_IDS_JSON>' '[]' '{"enabled":false}' 'Ariga39 AI Review'
```
