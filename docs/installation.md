# Installation and operations

This is the short operator manual for the two-Worker Compte rendu deployment.
It assumes one Cloudflare account, one GitHub App installation, and the
repository checkout that contains this file. It does not create resources or
credentials by itself.

Values in angle brackets are operator choices. Do not replace them with values
from another installation.

## What is deployed

The repository deploys these resources:

| Resource                | Configuration name                                                              | Purpose                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Public Worker           | `compte-rendu-ingress`                                                          | Receives GitHub webhooks. `workers_dev` is enabled.                                                                           |
| Private Worker          | `compte-rendu-core`                                                             | Owns authorization, GitHub API calls, orchestration, and run state. `workers_dev` is disabled.                                |
| Service binding         | `CORE` → `compte-rendu-core`                                                    | Lets ingress call core without a public core URL.                                                                             |
| D1 database             | `compte-rendu-review-state`, binding `REVIEW_DB`                                | Stores delivery, approval, run, and finding-fingerprint state.                                                                |
| Workflow                | `compte-rendu-review`, binding `REVIEW_WORKFLOW`, class `ReviewWorkflow`        | Carries one review through checkout, agent execution, validation, and publication.                                            |
| Sandbox container class | `Sandbox`                                                                       | Runs the fixed checkout and read-only OpenCode review. The config requests the `lite` instance type and at most one instance. |
| Durable Object classes  | `Sandbox` and `ReviewLeaseDurableObject`; binding `REVIEW_LEASE` for the latter | Provides Sandbox access and a per-run cleanup lease/alarm.                                                                    |

The request path is:

```text
GitHub webhook
    → compte-rendu-ingress (public, verifies WEBHOOK_SECRET)
    → CORE service binding
    → compte-rendu-core (private)
       → REVIEW_DB / REVIEW_WORKFLOW / REVIEW_LEASE / Sandbox
       → GitHub App installation token for GitHub API operations
```

Cloudflare service bindings are internal Worker-to-Worker calls and can be
used to isolate a Worker from the public Internet. The target Worker must be
deployed before the Worker that declares the binding:
[Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).

The source of truth for names and bindings is
[`apps/core/wrangler.jsonc`](../apps/core/wrangler.jsonc) and
[`apps/ingress/wrangler.jsonc`](../apps/ingress/wrangler.jsonc). The source
also deliberately keeps D1's `database_id` as
`REPLACE_WITH_D1_DATABASE_ID`; this manual never invents that value.

## Access and credentials

### Wrangler authentication

This repository does not include Wrangler as a dependency. Use the temporary
package invocation below; it is the package-run form documented by Cloudflare
and keeps the repository dependency set unchanged.

```sh
corepack pnpm dlx wrangler@latest --version
```

Record and verify the version printed by that command before an installation
or update. For a repeatable operation, replace `@latest` in the commands
below with the exact version that was verified. Do not use
`pnpm exec wrangler`: there is no local Wrangler binary in this repository.

For an interactive operator session, use Wrangler OAuth:

```sh
corepack pnpm dlx wrangler@latest login
corepack pnpm dlx wrangler@latest whoami
```

`wrangler login` opens an OAuth authorization flow. It is not a custom API
token permission editor, so there is no hand-selected API-token permission
list to record for this path. Grant access only to the Cloudflare account
that owns this deployment, and revoke the local OAuth authorization with
`wrangler logout` when the operator session should end. See
[Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/).

For unattended use, create a custom Cloudflare API token scoped to the one
deployment account. The least account-level write groups needed by this
repository's create/migrate/deploy sequence are:

| Account permission    | Why it is needed                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Workers Scripts: Edit | Deploy both Workers and their configured service binding, Workflow, Durable Object, secret versions, and Worker triggers. |
| D1: Edit              | Create the D1 database and apply its migrations.                                                                          |
| Containers: Edit      | Deploy the configured `Sandbox` container class.                                                                          |

Select the single Cloudflare account as the token resource. No zone resource
or zone permission is needed: ingress uses `workers_dev`, not a zone route.
Do not add KV, R2, Pages, DNS, Workers Routes, or administrative permissions
for this repository. `Workers Tail: Read` is an optional addition only when
the operator chooses to use the troubleshooting `wrangler tail` command; it
is not needed to create, migrate, or deploy this product. The permission names
and account/zone scope
model are maintained in Cloudflare's
[API token permission catalog](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
Cloudflare's
[GitHub Actions authentication guidance](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
also shows the account-scoped custom-token pattern for Workers deployment.

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
corepack pnpm dlx wrangler@latest whoami
unset CLOUDFLARE_API_TOKEN
```

Do not print the variable, commit it, put it in a repository `.env` file, or
leave it in a shared shell transcript.

### GitHub App permissions and installation

Configure the GitHub App with only these repository permissions:

| GitHub App permission | Level | Concrete operation in this repository                                                                                                                                     |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata              | Read  | Resolve the repository by numeric ID, validate repository metadata, and check the `/ai-review` commenter's collaborator permission before approving a public fork review. |
| Contents              | Read  | Fetch the repository at the exact base/head SHAs in the Sandbox checkout. GitHub documents Contents as the permission for HTTP-based Git access.                          |
| Pull requests         | Read  | Load PR facts and current head SHA, list changed files, and find existing reviews for idempotent publication.                                                             |
| Pull requests         | Write | Create the `COMMENT` review with inline findings.                                                                                                                         |
| Issues                | Read  | Make the `issue_comment` webhook available for PR comments. The handler accepts only a created comment whose body is exactly `/ai-review`.                                |

The endpoint-to-permission mapping should be checked against GitHub's
[permission-to-endpoint reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
when GitHub changes an endpoint. The general rule to request the minimum is in
[choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app).

Subscribe the App to:

- `Pull requests`: `opened`, `reopened`, `synchronize`, and
  `ready_for_review` (all four are accepted by `apps/ingress/src/index.ts`).
- `Issue comment`: `created`. The product path is only a comment on a pull
  request with the exact body `/ai-review`.

Do not subscribe to push, review, check, status, issue, or repository events;
they are not part of this Worker contract. GitHub's event reference lists the
available event actions:
[Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads).

Install the App on the owning account with **Only select repositories**, then
select the target repository or repositories. Do not choose all repositories
unless that is an explicit operator decision. GitHub describes this choice in
[Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

Enable the App webhook with:

- Webhook URL: `<INGRESS_URL>`, the public URL printed or shown for
  `compte-rendu-ingress` after deployment. This repository does not establish a
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

Before starting, enable a `workers.dev` subdomain for the Cloudflare account;
this deployment uses it for the public ingress URL. Deploying the `Sandbox`
Container requires the current Workers Paid plan; see Cloudflare's
[workers.dev setup](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
and [Containers pricing](https://developers.cloudflare.com/containers/pricing/).

Run these commands from the repository root. Every `wrangler` command below
uses the temporary invocation described above.

1. Install and check the repository:

   ```sh
   corepack pnpm install --frozen-lockfile
   corepack pnpm check
   corepack pnpm test
   corepack pnpm build
   ```

2. Create the D1 database with the configured name:

   ```sh
   corepack pnpm dlx wrangler@latest d1 create compte-rendu-review-state
   ```

   Copy only the returned `database_id` into
   `apps/core/wrangler.jsonc`, replacing
   `REPLACE_WITH_D1_DATABASE_ID`. Do not copy any account ID, token, or other
   output into the repository. Verify that the file contains the expected
   database name, `REVIEW_DB` binding, and a real operator-supplied ID before
   continuing.

3. Apply the tracked D1 migration remotely. Use the binding name from the
   config, not a guessed database identifier:

   ```sh
   corepack pnpm dlx wrangler@latest d1 migrations list REVIEW_DB --remote --config apps/core/wrangler.jsonc
   corepack pnpm dlx wrangler@latest d1 migrations apply REVIEW_DB --remote --config apps/core/wrangler.jsonc
   ```

   The current migration is
   `apps/core/migrations/0001_review_state.sql`. It creates delivery,
   approval, run, and finding-fingerprint tables. D1 migration files are
   versioned and applied in order; see
   [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

4. Enter the two core secrets. Each command prompts for the value; do not
   append a value to the command line, use `echo`, or redirect a secret from a
   shell command:

   Before these `secret put` commands, create the GitHub App registration and
   generate/download its private key. The webhook URL may remain unset or
   inactive during installation; set `<INGRESS_URL>` and activate the webhook
   after ingress has been deployed. Follow GitHub's
   [private-key guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
   when generating and downloading the key.

   ```sh
   corepack pnpm dlx wrangler@latest secret put GITHUB_APP_PRIVATE_KEY --config apps/core/wrangler.jsonc
   corepack pnpm dlx wrangler@latest secret put MODEL_API_KEY --config apps/core/wrangler.jsonc
   ```

   The private key and model credential belong only to `compte-rendu-core`.
   Cloudflare's `secret put` creates and deploys a new Worker version
   immediately, so complete the D1 migration before these commands. Worker
   secrets are encrypted bindings and are intentionally separate from
   plaintext `vars`:
   [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

5. Deploy the private core Worker first:

   ```sh
   corepack pnpm dlx wrangler@latest deploy --config apps/core/wrangler.jsonc
   ```

   Confirm the deployment reports the configured Workflow, `Sandbox`,
   `REVIEW_LEASE`, and `REVIEW_DB` bindings without a missing-secret or
   missing-D1 error.

6. Enter the ingress webhook secret only after core is deployed, then deploy
   public ingress second:

   ```sh
   corepack pnpm dlx wrangler@latest secret put WEBHOOK_SECRET --config apps/ingress/wrangler.jsonc
   corepack pnpm dlx wrangler@latest deploy --config apps/ingress/wrangler.jsonc
   ```

   The `secret put` command itself creates an ingress version; the explicit
   deploy then publishes the current checkout with the same secret. The
   `WEBHOOK_SECRET` value must match the GitHub App webhook secret exactly.
   Record the resulting public ingress URL as the operator's
   `<INGRESS_URL>`. The `CORE` binding points to the already deployed
   `compte-rendu-core`; deploying in the opposite order can fail because the
   target service does not exist yet.

7. Configure and install the GitHub App as described above, then activate its
   webhook with `<INGRESS_URL>`. Send a test delivery only after activation.

The deployed variables-versus-secrets inventory is deliberately small:

| Worker                 | Plain variable  | Secrets                                   | Non-secret bindings                                       |
| ---------------------- | --------------- | ----------------------------------------- | --------------------------------------------------------- |
| `compte-rendu-ingress` | None            | `WEBHOOK_SECRET`                          | `CORE` → `compte-rendu-core`                              |
| `compte-rendu-core`    | `GITHUB_APP_ID` | `GITHUB_APP_PRIVATE_KEY`, `MODEL_API_KEY` | `REVIEW_DB`, `REVIEW_WORKFLOW`, `Sandbox`, `REVIEW_LEASE` |

`GITHUB_APP_ID` is an application identifier, not a secret. Its value is
already represented in the core Wrangler config; do not duplicate it in a
secret or invent a replacement. Installation IDs, repository IDs, PR numbers,
SHAs, `deliveryId`s, `runId`s, and `sandboxId`s are runtime data, not values to
hard-code in the manual.

## Verification

### Local verification

The proportionate repository checks are:

```sh
corepack pnpm check
corepack pnpm test
corepack pnpm build
git diff --check
```

`corepack pnpm test` includes the local workerd tracer. It proves the signed
eligible webhook crosses the named `CORE` binding, applies the D1 migration,
records a scheduled delivery/run, and captures the immutable Workflow input.
It also proves an invalid signature returns HTTP `400`, produces no Workflow
capture, and leaves no D1 delivery or run. It does **not** prove real
Cloudflare Workflow retry/deadline behavior, Container/Sandbox lifecycle,
GitHub delivery, or real model/agent behavior;
the limits are recorded in [`docs/local-runtime-tracer.md`](local-runtime-tracer.md).

### Small deployed E2E set

Perform these with a disposable or intentionally chosen installed repository;
do not paste repository contents or model output into tickets.

1. **Eligible automatic review.** Open a non-draft PR in a private repository,
   or a same-repository public PR. Confirm the GitHub delivery succeeds, one
   review is published on the exact head SHA, and the run reaches a terminal
   state with Sandbox cleanup.
2. **Signature rejection.** Send a synthetic request directly to
   `<INGRESS_URL>`; do not use a real GitHub repository payload:

   ```sh
   curl -i -X POST '<INGRESS_URL>' \
     -H 'Content-Type: application/json' \
     -H 'X-GitHub-Event: pull_request' \
     -H 'X-GitHub-Delivery: <UNIQUE_DELIVERY_ID>' \
     -H 'X-Hub-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000' \
     --data '{}'
   ```

   The body is intentionally minimal and synthetic. Confirm HTTP `400`, then
   run this read-only D1 query with the same unique ID:

   ```sh
   corepack pnpm dlx wrangler@latest d1 execute REVIEW_DB --remote --config apps/core/wrangler.jsonc --command "SELECT delivery_id FROM deliveries WHERE delivery_id = '<UNIQUE_DELIVERY_ID>'; SELECT run_id FROM review_runs WHERE delivery_id = '<UNIQUE_DELIVERY_ID>';"
   ```

   Both result sets should be empty: there must be no matching delivery row
   and no matching `review_runs` row (and therefore no corresponding run). Do
   not substitute a real webhook payload, repository contents, credentials, or
   model/session data for this test.

3. **Public fork approval and freshness.** Open/update a public fork PR and
   confirm it does not run automatically. A maintainer with `write`,
   `maintain`, or `admin` permission comments exactly `/ai-review`; confirm
   only that observed head SHA is scheduled. Push a new head and confirm the
   old run cannot publish against it; a new manual command is required.

Do not treat a successful local tracer run as evidence for the Sandbox/model
case in item 1. The deployed test is the only one of these checks that
exercises the real GitHub App, Workflow, Container/Sandbox, and model path.

## Operations and troubleshooting

The code emits structured operational events without webhook payloads,
repository contents, diffs, model output, credentials, or session transcripts.
Use the Cloudflare Worker logs or `wrangler tail` only to correlate identifiers:

```sh
corepack pnpm dlx wrangler@latest tail compte-rendu-ingress
corepack pnpm dlx wrangler@latest tail compte-rendu-core
```

Use the GitHub delivery page for `deliveryId` and then search logs for the
same value. A scheduled core event adds `runId`; runner and lease events add
`sandboxId`. The useful chain is:

```text
deliveryId → core scheduled → runId → runner/lease sandboxId → workflow/publication outcome
```

Identifier values are sanitized by the application before logging. Do not
work around that sanitization by logging request bodies, git URLs with
credentials, Sandbox files, OpenCode stdout/stderr, model prompts, or session
artifacts.

| Symptom                               | Check first                                                                            | Safe action                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| GitHub delivery is `400`              | `WEBHOOK_SECRET`, `X-Hub-Signature-256`, and the raw configured URL                    | Re-enter the same high-entropy secret in GitHub and ingress, then redeliver. Do not disable signature checking.                 |
| Ingress is `503` / `core_unavailable` | Core deployment name, `CORE` service binding, and core availability                    | Deploy or update core first, then ingress. Redeliver the GitHub event.                                                          |
| Core is `503` / scheduling failure    | D1 migration, required core secrets, Workflow binding, and the GitHub App installation | Correct the missing binding/credential or installation permission, then redeliver. Do not create a second database.             |
| Run fails at checkout                 | `runId`, `sandboxId`, and runner reason `checkout`                                     | Check Contents read access and installation scope. Never put the installation token in a log or retry an old Sandbox manually.  |
| Run fails at agent or cleanup         | Runner/workflow/lease records for the same IDs                                         | Preserve the lease path and allow cleanup retry. Treat a cleanup failure as a failed run until the lease reports destruction.   |
| No review is published                | Publication reason, current PR head SHA, and Pull requests write permission            | If the head changed, issue a new review command. If publication is uncertain, check the existing review marker before retrying. |
| Public fork PR does nothing           | Comment body and commenter permission                                                  | Use the exact `/ai-review` command from a maintainer with `write`, `maintain`, or `admin`; a new head needs a new command.      |

## Update and rollback

For a normal compatible release:

1. Run `corepack pnpm check`, `corepack pnpm test`, and
   `corepack pnpm build` against the immutable checkout being released.
2. If there is a new migration, review it and apply it remotely with the D1
   migration command above. Prefer additive, backward-compatible changes.
3. Deploy `compte-rendu-core`.
4. Deploy `compte-rendu-ingress`.
5. Redeliver one controlled GitHub event and inspect the identifier chain.

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
3. Delete the public `compte-rendu-ingress` Worker, then the private
   `compte-rendu-core` Worker, in that order. Do not use `--force`. Verify the
   Workflow, `Sandbox`, Durable Object classes, and service binding are no
   longer deployed with the Workers.

   ```sh
   corepack pnpm dlx wrangler@latest delete --config apps/ingress/wrangler.jsonc
   corepack pnpm dlx wrangler@latest delete --config apps/core/wrangler.jsonc
   ```

4. Retain or export only the minimal D1 state required by the owner. If it is
   no longer needed, delete `compte-rendu-review-state` only after the Workers
   are gone and the retention decision is recorded:

   ```sh
   corepack pnpm dlx wrangler@latest d1 delete compte-rendu-review-state
   ```

   D1 deletion is irreversible for this deployment's live state; stop and
   confirm the database name at the prompt. Do not delete a different
   database, and never use a broad wildcard or guessed identifier.

5. Revoke the Cloudflare automation token. For interactive access, run
   `corepack pnpm dlx wrangler@latest logout`.

GitHub's installation operation and Cloudflare's Wrangler/D1 commands are the
authoritative references for these external destructive actions:
[GitHub App installation](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app),
[Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/),
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

## Official references

- [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Cloudflare account-scoped custom token for GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [GitHub App permission selection](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub permission-to-endpoint reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- [GitHub webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [GitHub App installation scope](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)
- [GitHub App private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
