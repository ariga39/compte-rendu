# Security boundaries and limitations

This describes controls in the current code, not a penetration test or a guarantee
against platform vulnerabilities. The [archived FMEA](archive/security-fmea.md)
and [early Sandbox threat model](archive/docker-sandbox-security-threat-model.md)
record historical assumptions and observations, not current deployment policy.

## Trust boundaries

| Boundary                                | Control                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| GitHub → public Worker                  | HMAC verification, bounded payload, installation allowlist and event policy                         |
| Maintainer → review admission           | Current GitHub permission and immutable head checks                                                 |
| Dashboard operator → application Worker | GitHub App user session, current GitHub identity, instance UID allowlist and same-origin mutations  |
| Runner → public Worker                  | Authenticated claim, progress, read-token renewal and callback with persisted job/attempt ownership |
| Agent → GitHub                          | Repository-scoped read token injected through the runtime proxy; no publication credential          |
| Agent → model                           | Direct-provider proxy, or restricted expiring job grant to the managed inference Worker             |
| Inference Worker → AI Gateway           | Account-scoped Gateway Run token and BYOK alias from the frozen grant mapping                       |
| Runner → host resources                 | Per-job runtime ownership, bounded commands, deadlines, redaction and confirmed teardown            |
| Core module → public dashboard          | DB-only projection; unknown/private/expired repository identity removed server-side                 |

The public SvelteKit Worker holds the GitHub App private key and Runner secrets.
Its Core module publishes reviews; it is an internal code boundary, not a separate
private Worker. Only the allowlisted public API, authenticated Runner routes and
signed webhook routes reach that module. The model's
result cannot choose the target repository, commit, URL or publisher. Core checks
freshness and agreement between callback, manifest and Markdown. Publication
recovery verifies the App author, commit and expected review state; a marker alone
is insufficient.

## Static agent policy

OpenCode runs standalone with fresh per-job state, without repository configuration
or host skills, MCP configuration or SSH-agent sharing. One reviewed `code-review` skill
and its license/attribution files are embedded in the Runner and staged into
each job's isolated configuration; they do not grant additional permissions.
The packaged policy allows
read/search and bounded Git/GitHub read commands. It denies repository programs,
builds/tests, edits and GitHub writes. Repository contents and PR discussion are
untrusted evidence, not instructions. Model compliance is not the outer security
boundary.

The final response uses the `DECISION` header plus raw Markdown (the earlier
JSON `decision` + `markdown` form is still accepted), verified from the completed
V2 session export. A bounded same-session correction runs before revocation and
cleanup. There is no submission plugin, child-report schema or coverage ledger.
Prompt style and the TLDR template are not security or validity gates.

## Runtime isolation and egress

Docker sbx uses a microVM. Runner selects the `shell` kit and its pinned image,
then executes OpenCode inside it. Per-job network rules are restrictive only when
the operator's host baseline is deny-all and other global/organization rules do
not add access. Runner does not establish or periodically repair that baseline.
Inspect effective scoped policy during installation and upgrades.

microsandbox runs each job in a local KVM microVM with read-only staging,
host-side TLS credential injection and deny-by-default HTTPS rules scoped to the
inference hostname and GitHub API. Cleanup verifies the original catalog, exact
VM name and `created_at` age. See the [microsandbox guide](microsandbox.md).

Managed inference permits the configured HTTPS inference hostname. Grant control uses the application origin and a Runner credential kept outside the Sandbox. The inference Worker constructs its upstream URL and headers from its own configuration and the frozen grant.

## Credentials and lifecycle

- GitHub read tokens are limited to the target repository and expire upstream.
  Runner removes local token sources, secret registration and scoped rules during
  cleanup. It does not currently revoke the GitHub installation token upstream.
- Service-mode grants expire after four review budgets (currently six hours)
  and cannot be renewed.
  Revocation rejects later admissions and seals usage for open requests. Unconfirmed revocation fails the review with
  bounded retries; the fixed expiry bounds the credential, and Sandbox cleanup is still attempted independently.
- Relay D1 persists grants and revocations across Worker restarts. Runner revokes each job with bounded retries and relies on the grant's fixed expiry after a crash.
- The upstream credential belongs to the account’s AI Gateway BYOK configuration.
- A stopped OpenCode client is not proof its server sessions stopped. Confirmed
  Sandbox destruction and grant revocation end job capabilities.

Normal completion, failure, timeout and cancellation attempt cleanup. Hard process
or host failure can leave a claimed run and a timestamped Sandbox behind. Both
backends sweep only the reserved `compte-rendu-<epoch>-<jobId>` shape after the
attempt budget plus a finalization margin, skip live local jobs, require complete
inventory, and verify absence after removal. Broad sbx sweeping only considers
UUID job identities; exact cleanup from a trusted manifest may name a direct
claim. sbx expects create-time non-editable scoped rules to cascade from `rm` and
fails closed on a surviving unremovable attachment. Microsandbox checks the
original catalog and `created_at`; a same-name lookup in another catalog is not
absence proof. A physical sweep never changes Core. Expiration of an unknown
pending Core claim releases same-PR scheduling without attesting to VM
destruction; a known failed cleanup remains blocking until the retained-evidence
confirmation callback is accepted.

## Evidence and observability

Routine diagnostics use bounded identifiers and error categories, not raw
credentials, URLs, request/response bodies or provider exceptions. Failure to log
must not stop cleanup. Private host evidence and private R2 bundles contain richer
review/session material and require restricted access and retention controls;
they are not dashboard data.

R2 lifecycle expiration is an operator deployment setting. Host recovery evidence
has no automatic retention policy. The public dashboard uses persisted D1 state,
not live Runner/process inspection. Missing telemetry does not establish failure
or liveness. Optional PostHog events are secondary, best effort and disabled unless
configured; they are not the product state or an authorization dependency.

## Source anchors

- Ingress: `apps/ingress/src/`
- Ownership, publication and projection: `apps/core/src/core-worker.ts`,
  `runner-protocol.ts`, `review-publication.ts`, `review-admission.ts`,
  `review-lifecycle-store.ts`, `check-run-store.ts`, `cancellation-store.ts`,
  `dashboard-metadata-store.ts`, `github-review-adapter.ts`, `dashboard.ts`
- Runner and runtimes: `apps/runner/src/runner.ts`, `sandbox-runtime-*.ts`
- Grant and upstream boundaries: `apps/inference-worker/src/grants.ts`, `relay.ts`
- Agent permissions and prompt: `apps/runner/src/opencode-multi-review.ts`,
  `review-prompt.ts`
- Bundled review method and provenance: `apps/runner/skills/code-review/SKILL.md`,
  `apps/runner/src/review-skill.ts` (packaged with `LICENSE.md` and `NOTICE.md`)
