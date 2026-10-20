# Security boundaries and limitations

This describes controls in the current code, not a penetration test or a guarantee
against platform vulnerabilities. The [archived FMEA](archive/security-fmea.md)
and [early Sandbox threat model](archive/docker-sandbox-security-threat-model.md)
record historical assumptions and observations, not current deployment policy.

## Trust boundaries

| Boundary                       | Control                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| GitHub → public Worker         | HMAC verification, bounded payload, installation allowlist and event policy                |
| Maintainer → review admission  | Current GitHub permission and immutable head checks                                        |
| Runner → public Worker         | Authenticated claim/progress/callback, persisted job/attempt ownership                     |
| Agent → GitHub                 | Repository-scoped read token injected through the runtime proxy; no publication credential |
| Agent → model                  | Direct-provider proxy, or restricted expiring job grant to the private LLM service         |
| Node LLM service → LiteLLM     | Private backend credential and loopback endpoint; trusted route/job headers                |
| Runner → host resources        | Per-job runtime ownership, bounded commands, deadlines, redaction and confirmed teardown   |
| Core module → public dashboard | DB-only projection; unknown/private/expired repository identity removed server-side        |

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
or host skills, MCP configuration or SSH-agent sharing. The packaged policy allows
read/search and bounded Git/GitHub read commands. It denies repository programs,
builds/tests, edits and GitHub writes. Repository contents and PR discussion are
untrusted evidence, not instructions. Model compliance is not the outer security
boundary.

The final response is JSON `decision` + `markdown`, verified from the completed
V2 session export. A bounded same-session correction runs before revocation and
cleanup. There is no submission plugin, child-report schema or coverage ledger.
Prompt style and the TLDR template are not security or validity gates.

## Runtime isolation and egress

Docker sbx uses a microVM. Runner selects the `shell` kit and its pinned image,
then executes OpenCode inside it. Per-job network rules are restrictive only when
the operator's host baseline is deny-all and other global/organization rules do
not add access. Runner does not establish or periodically repair that baseline.
Inspect effective scoped policy during installation and upgrades.

OpenShell's ordinary Docker backend is container isolation, not automatically a
microVM. Its gateway owns model/GitHub provider injection and policy. Runner checks
resource ownership labels and recorded identities before deletion and requires
positive deletion confirmation. It does not interpret transport errors as absence.
OpenShell does not currently support this project's LLM-service/multi-model path.

LLM service mode deliberately permits one private host inference endpoint; it is
not accurate to claim that all host network access is impossible. The control Unix
socket and upstream keys are outside Sandbox access. Only the configured inference
port and GitHub read destination are intended allowances. Verify those boundaries
on the selected runtime; isolation strength alone is not a product acceptance test.

## Credentials and lifecycle

- GitHub read tokens are limited to the target repository and expire upstream.
  Runner removes local token sources, secret registration and scoped rules during
  cleanup. It does not currently revoke the GitHub installation token upstream.
- Service-mode grants expire after four review budgets and cannot be renewed.
  Revocation aborts active requests. Unconfirmed revocation fails the review and
  leaves a recovery marker; Sandbox cleanup is still attempted independently.
- Grant-service restart invalidates in-memory grants. Runner startup retries
  pending grant revocations, but does not reconstruct interrupted agent jobs.
- Supplier keys and optional subscription state belong to LiteLLM, not the agent.
  ChatGPT subscription refresh/activation has separate limitations in
  [the service guide](llm-service.md#optional-chatgpt-subscription); API-key operation
  does not establish subscription refresh safety.
- A stopped OpenCode client is not proof its server sessions stopped. Confirmed
  Sandbox destruction and grant revocation end job capabilities.

Normal completion, failure, timeout and cancellation attempt cleanup. Hard process
or host failure can leave an owned Sandbox and a claimed run behind. Automatic
orphan reconciliation is not implemented ([#66](https://github.com/ariga39/compte-rendu/issues/66)).
Never delete a same-name foreign resource or release same-PR serialization based
on an ambiguous cleanup result.

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
  `review-state-store.ts`, `github-review-adapter.ts`, `dashboard.ts`
- Runner and runtimes: `apps/runner/src/runner.ts`, `sandbox-runtime-*.ts`
- Grant and upstream boundaries: `apps/llm-service/src/service.ts`, `upstream.ts`
- Agent permissions and prompt: `apps/runner/src/opencode-multi-review.ts`,
  `review-prompt.ts`
