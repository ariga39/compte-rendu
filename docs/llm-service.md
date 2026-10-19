# LLM service

The host runs two processes: the compte-rendu Node service owns job grants,
route authorization, cancellation and sanitized diagnostics; LiteLLM Proxy owns
model routing, provider credentials and protocol adaptation. Sandbox and Runner
addresses stay unchanged. Neither process is exposed publicly.

## Build and configuration

Build the Node service with Node 24 and the locked workspace dependencies:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @compte-rendu/llm-service build
```

The Node artifact no longer needs pi-ai. Install the tested Python backend into
its own virtual environment (Python 3.13, with `venv`/ensurepip installed):

```sh
python3 -m venv /absolute/path/litellm-venv
/absolute/path/litellm-venv/bin/pip install -r apps/llm-service/litellm/requirements.txt
```

Alternatively use `uv venv --python python3 /absolute/path/litellm-venv` and
`uv pip install --python /absolute/path/litellm-venv/bin/python -r
apps/llm-service/litellm/requirements.txt`. The pinned Prisma package is needed by
LiteLLM 1.106.0 error handling even when no database is configured. This setup
uses our existing job grants, not LiteLLM virtual keys, and needs no PostgreSQL.

Create a separate private directory for each instance, mode 0700, with files
mode 0600. Keep all secrets outside repository checkouts and Sandbox mounts.
Copy [config.example.yaml](../apps/llm-service/litellm/config.example.yaml) there
and edit it. `model_name` is the LiteLLM alias; `model: openai/<id>` selects the
OpenAI-compatible protocol, even when the model is DeepSeek or Step. Set the
actual `api_base` for that instance, preserving its full prefix. Official
OpenCode Go uses `https://opencode.ai/inference/go/openai/v1`; a custom gateway
may use a different prefix. Do not replace a custom URL with the official URL.

Supply `OPENCODE_GO_API_KEY` and a separately generated `LITELLM_MASTER_KEY` in
a private systemd EnvironmentFile. Edit the file; do not put secret values in
command-line arguments, logs or committed YAML. The backend key is distinct
from both upstream credentials and sandbox job tokens. Store the identical
backend key alone in a private file for the Node service to read.

Set `LLM_SERVICE_CONFIG` to the Node TOML's absolute path:

```toml
controlSocket = "/run/user/1000/compte-rendu-llm/control.sock"
port = 8090

[upstream]
baseUrl = "http://127.0.0.1:4000"
credentialFile = "/home/runner/.config/compte-rendu-llm/backend-key"

[[routes]]
id = "deepseek-review"
protocol = "chat-completions"
model = "deepseek-review"

[[routes]]
id = "step-review"
protocol = "chat-completions"
model = "step-review"
```

`upstream.baseUrl` is a loopback origin, without `/v1`, query or fragment.
Both HTTP and HTTPS require `localhost`, `127.0.0.1`, or `[::1]`; remote backend
addresses are rejected. The Node service appends the
selected `/v1/chat/completions` or `/v1/responses` path. A route's `id` is the
sandbox-facing alias and `model` names the LiteLLM alias. Use `protocol =
"responses"` for a Responses client. Routes and configuration load at startup;
no hot reload or automatic provider fallback is introduced.

The Node service generates `x-opencode-session` and `session_id` from the
verified grant's job ID. It does not forward incoming HTTP headers or accept
client-supplied routing/credential overrides. The example enables LiteLLM header
forwarding only behind this trusted boundary, preserving OpenCode Go session
routing for both official and custom endpoints. Keep the LiteLLM master key out
of every Sandbox and do not expose its management API to agents. The pinned
LiteLLM generic OpenAI Responses path forwards `x-opencode-session` but drops
`session_id`; do not assume that header reaches a Responses supplier. Subscription
session binding requires its separate provider-specific acceptance test.

## Optional ChatGPT subscription

LiteLLM owns this provider. Add an alias with `litellm_params.model:
chatgpt/<supported-model>` and `model_info.mode: responses` to its YAML, then
configure a matching Node route. This is separate from an OpenAI API key. The
current OpenCode Runner integration uses Chat Completions; LiteLLM supports a
Chat-to-Responses bridge for supported subscription models. Test the selected
model and tool calls before selecting it for reviews.

With that instance's LiteLLM stopped, log in from a terminal:

```sh
umask 077
export CHATGPT_TOKEN_DIR=/absolute/private/path/chatgpt
/absolute/path/litellm-venv/bin/python -c 'from litellm.llms.chatgpt.authenticator import Authenticator; Authenticator().get_access_token()'
```

Open the printed verification URL and enter its device code. Set the same
`CHATGPT_TOKEN_DIR` in the LiteLLM unit. The directory must persist and be writable
by its service user. Do not copy a developer CLI's rotating auth cache. One
LiteLLM process uses one ChatGPT account; different accounts need separate
instances. Run one worker and one owner of that file. LiteLLM 1.106.0 uses
in-place file writes and does not serialize simultaneous refreshes: this is a
known upstream limitation, not a guarantee supplied by our Node service. Do not
share the file between instances or start parallel login/refresh processes.
Subscription token counts are available, but recorded dollar spend is zero.
No subscription route is enabled by the provided example or by migration.

## Host services

Create separate user units per instance. Use different ports, keys, configuration
directories, control sockets and subscription stores for the two deployments.
Keep the Runner unit and its cgroup independent.

`~/.config/systemd/user/<INSTANCE_NAME>-litellm.service`:

```ini
[Unit]
Description=compte-rendu LiteLLM backend

[Service]
Type=simple
EnvironmentFile=/absolute/private/path/litellm.env
Environment=LITELLM_LOCAL_MODEL_COST_MAP=True
UMask=0077
ExecStart=/absolute/path/litellm-venv/bin/litellm --config /absolute/private/path/litellm.yaml --host 127.0.0.1 --port 4000 --num_workers 1
Restart=on-failure

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/<INSTANCE_NAME>-llm.service`:

```ini
[Unit]
Description=compte-rendu job-authorized LLM service
Wants=<INSTANCE_NAME>-litellm.service
After=<INSTANCE_NAME>-litellm.service

[Service]
Type=simple
WorkingDirectory=/absolute/path/compte-rendu
Environment=LLM_SERVICE_CONFIG=/absolute/private/path/service.toml
UMask=0077
ExecStart=/absolute/path/node apps/llm-service/dist/llm-service.js
Restart=on-failure

[Install]
WantedBy=default.target
```

Start the backend, then the Node service. Both listeners bind to loopback; the
control socket must be mode 0600. Node inference without a job token returns
401, and GET on the control socket's `/grants` returns 405. Startup checks alone
do not prove model access: issue a grant through the socket, consume a complete
model/tool response, then revoke it and confirm the old token is rejected.
Never print the token or place it in command-line arguments.

### Upgrade from the pi-ai backend

Before changing traffic, install and start LiteLLM on an unused loopback port
with independent keys. Validate each existing alias, custom base URL, streaming
tool calls and session header. Keep the old artifact, TOML, and its complete
runtime dependency tree in a separate release directory for rollback. The old
Node bundle externalizes pi-ai: copying its JavaScript alone is insufficient,
and installing this revision in its workspace removes the required package.
Drain both instances before replacing Node configuration/artifacts: restarting
Node invalidates grants and interrupts active requests. Restarting LiteLLM also
interrupts active model calls. `concurrency = 0` is not a valid drain mechanism.

Replace per-route `provider/baseUrl/credentialFile` with the `[upstream]` section
and aliases above; old configuration fails validation rather than silently using
another provider. The old Node `login` command is removed. After switching,
verify both routes through fresh job grants and verify revocation. Runner/Core
configuration does not change when existing route IDs are preserved. No D1
migration is needed. Rollback restores the old Node artifact, its preserved
runtime dependencies and old TOML. If the old dependency tree was not preserved,
rebuild/install the old revision with its own frozen lockfile in a separate
directory before switching back. Never silently change backend for an already
executing job.

## Connecting an sbx Runner

This integration uses OpenCode's Chat Completions provider with the `sbx`
runtime. Codex/Responses and OpenShell service integration are separate work;
configuring this mode with OpenShell is rejected rather than using its shared
upstream provider.

Install and check the LLM service first. Then configure the Runner's existing
private environment file (systemd `EnvironmentFile` syntax, one-line JSON):

```dotenv
RUNNER_LLM_SERVICE_SOCKET=/run/user/1000/compte-rendu-llm/control.sock
REVIEW_MODEL_CONFIG={"id":"opencode-go/deepseek-review","baseUrl":"http://host.docker.internal:8090/v1","definition":{"name":"DeepSeek review","reasoning":true,"interleaved":{"field":"reasoning_content"},"limit":{"context":1000000,"output":384000}}}
```

Replace the socket, port and model metadata for your deployment. The suffix
`deepseek-review` must equal the service's route `id`, whose protocol must be
`chat-completions`; the TOML maps it to a LiteLLM alias, whose upstream model is configured in YAML.
An alias needs its model definition in OpenCode configuration. Metadata in the
example is illustrative and must match the selected upstream.

`MODEL_SECRET_COMMAND` is not used in service mode. The Runner requests a new
grant for each owned job before Sandbox setup. Its lifetime is
`4 × REVIEW_ATTEMPT_BUDGET_MS` from the shared contracts package: the current
30-minute review budget gives a two-hour grant. Changing that budget updates
both grant expiry and revocation-record retention when the service is rebuilt.
The Runner writes the grant to a private, temporary host file outside Sandbox mounts; sbx's credential proxy reads
that file and gives the agent only a placeholder. Never put a job token or
upstream credential in the Runner environment file.

### Local transport and egress

For a same-host service, use exactly
`http://host.docker.internal:<PORT>/v1`. The HTTP exception is restricted to this
sbx service mode and an explicit port. Ordinary direct model endpoints still
require HTTPS. The LLM service remains bound to `127.0.0.1`; do not bind it to a
LAN address or expose it through the public Worker or Tunnel.

sbx 0.48 rewrites `host.docker.internal` to `localhost` before policy evaluation
and credential substitution. Runner therefore installs a per-job rule for
`localhost:<PORT>` and scopes the secret to `localhost`. The agent sends the
placeholder through sbx's local transport; the host proxy substitutes the real
grant on its loopback connection to the service. The port must match the
service TOML; do not point it at another local process. A real sbx 0.48 probe
verified both the loopback peer and credential substitution. Repeat this probe
when upgrading sbx before switching review traffic. This is not a recipe for sending
real bearer tokens over arbitrary plaintext network connections.

Keep host default policy deny-all and remove unrelated global or organization
allow rules as described in the installation manual. Service-enabled jobs need
only the local service route and their existing GitHub API allowance; they no
longer need direct access to the model supplier. The service host itself needs
outbound access to the configured supplier.

### Switch traffic and verify

1. Stop new admissions and let current jobs finish using your existing operational
   drain procedure; concurrency zero is invalid. Do not restart a Runner that
   owns the shared sbx daemon while either instance still has active jobs.
2. Start the independent LLM service, apply the Runner environment changes, and
   restart that Runner. No Core/Ingress binding or database change is required.
3. Trigger one review of a known PR. Verify the final review addresses the pinned
   diff, the callback and published review agree, and Sandbox cleanup is
   `destroyed`. Inspect the private evidence for credential leakage without
   printing token values.
4. Exercise cancellation and a service failure before increasing traffic. Grant
   issuance is never retried within a job. Failed issuance or unconfirmed
   revocation must not produce a review vote or fall back to direct credentials.

Runner revokes the grant when agent work ends, before evidence export and Sandbox
cleanup, and on cancellation. Revocation failure does not skip Sandbox cleanup.
The grant expiry (currently two hours) remains the upper bound if the control
service is unreachable.
Runner records only the job identity in a pending-revocation marker before
requesting a grant. After a crash, a new Runner revokes those identities before
claiming or admitting more jobs; unreadable or unresolved records keep admission
closed. After repairing service or storage availability, restart the Runner to
retry this startup recovery. Keep the instance's evidence directory across Runner restarts, and do not
share it between concurrently running Runners. This recovery does not recreate
jobs or replace the existing operational cleanup of orphan Sandboxes.
Keep the service in its own systemd unit/cgroup; do not make its lifetime depend
on the Runner unit.

To roll back, drain jobs, remove `RUNNER_LLM_SERVICE_SOCKET`, restore the previous
`REVIEW_MODEL_CONFIG` and host `MODEL_SECRET_COMMAND`, then restart the Runner.
Only new jobs use the restored route; interrupted jobs require an explicit new
review trigger. Stop the LLM service only after its callers are drained.

## Public boundaries

The Unix socket exposes only:

- `POST /grants` with `{ "jobId": "...", "routes": ["deepseek-review"] }`:
  returns 201 and `{ "token": "...", "expiresAt": "ISO timestamp" }`.
- `POST /grants/revoke` with `{ "jobId": "..." }`: returns 204, idempotently.

The socket is mode 0600, inside a private directory. Its filesystem permissions
are the control-plane authentication. HTTP bearer tokens cannot administer grants.
Duplicate issuance returns 409. Revocation of an unknown job prevents delayed
issuance for that identity during the same budget-derived tombstone lifetime.
If an issuance response is lost, the caller must fail the job and revoke by identity, never retry
issuance within that job. Grants expire exactly `4 × REVIEW_ATTEMPT_BUDGET_MS`
after issuance and have no renewal API. Revocation/expiry also cancels active inference.

The loopback listener exposes only `POST /v1/chat/completions` and
`POST /v1/responses`, with `Authorization: Bearer <job token>`. Both endpoints always return SSE: the service forces upstream `stream: true` and
`store: false`. Clients must consume a streaming response; non-streaming output
is not supported. Review tool execution stays in the agent. Chat tool declarations
allow only `function`; Responses allow `function` and `custom`. Hosted tools
(such as web search, file search, code interpreter and MCP) and
`web_search_options` are rejected before contacting LiteLLM. Unsupported top-level fields
are rejected instead of silently ignored. Nested protocol payloads are handled by LiteLLM. Upstream HTTP
errors become sanitized failures; interrupted streams are not successful results.

Messages, tools, reasoning, image parts and provider-native replay data are
forwarded without conversion to an intermediate agent Context. LiteLLM performs
provider adaptation. Our service validates the request envelope and forbids
client routing/credential overrides; it retains bounded SSE error sanitization
and completion checks. Normal response events and usage remain native. This
change does not add persistent per-job usage storage.

A client `prompt_cache_key` remains a cache hint, not job identity or authority.
The authenticated grant supplies routing session headers. Neither guarantees a
cache hit.

Control bodies are bounded at 16 KiB; inference bodies at 16 MiB. The larger bound
allows substantial review context/tool transcripts while bounding per-request
buffering, and is independent of the Runner claim/callback body limits. Each model
request has a two-minute total timeout, including credential resolution, in
addition to grant expiry. Native response output is streamed with backpressure and a 16 MiB total bound
(to bound buffering and network queues).
No extra output-token cap is injected: supported client limits are forwarded.

## OpenCode recovery and terminal state

OpenCode 2 can recover a `provider.invalid-output` stream error while its CLI
still exits with code 1. Runner accepts this observed compatibility case only
for exit codes 0 or 1 when the complete, matching session export ends with a succeeded outcome,
succeeded final idle, and final assistant `finish: stop`, and contains exactly
one completed `submit_review` matching the JSONL submission. Every recoverable
error must belong to that same session and have the observed HTTP 200 error
shape. Unknown errors, other nonzero exits, timeout, truncation, duplicate or
inconsistent results, and incomplete evidence still fail without publication.

The original CLI exit code and error events remain in the evidence. A sanitized
`Runner accepted recovered OpenCode session` log records the job/session identity
when reconciliation succeeds. CLI exit or client disconnection alone never proves
that a server-managed session has stopped; the exported terminal state is required.
Grant revocation and confirmed Sandbox destruction still run before final success.

## Diagnosing interrupted model streams

The service emits `llm.request.started` and `llm.request.finished` records to its
systemd journal. Match `jobId` to the Runner job identity and `requestId` to one
model request; an agent can make several requests during the same job. Terminal
records include route/protocol, elapsed milliseconds, upstream HTTP
status, received bytes, and observed completion and `[DONE]` markers. They omit
credentials, request/response bodies, URLs, and raw upstream error messages.

Use the instance's LLM service unit, for example:

```sh
journalctl --user -u <LLM_UNIT> --since '2026-10-19 01:45:00 UTC' --until '2026-10-19 02:00:00 UTC' -o cat
```

- `service-timeout`: the service's two-minute deadline expired.
- `provider-request-aborted`: the outbound LiteLLM request was aborted. Correlate
  with caller and service lifecycle records to establish why.
- `request-aborted` / `client-cancelled`: the caller, grant lifecycle, or service
  shutdown cancelled the request, or the response consumer cancelled its stream.
- `upstream-http-error` / `upstream-fetch-error`: HTTP rejection or a failure
  before upstream response headers arrived.
- `upstream-stream-error`: reading the upstream body failed.
- `incomplete-stream`: upstream EOF arrived without successful native completion.
  `[DONE]` alone does not establish completion.
- `upstream-error-event`, `invalid-stream`, or `stream-too-large`: the service
  rejected the stream for the stated reason.
- `credential-or-request-failure`: credential resolution or request setup failed.
- `completed`: the upstream stream completed and was consumed by the service's
  response bridge. This is not proof of a successful review or publication.

These records locate the boundary observed by this service. An upstream read
failure does not distinguish a custom gateway failure from its provider's failure;
correlate the timestamp with gateway/provider logs before attributing a cause.
Historical failures without these records remain inconclusive.

## Verification and remaining integration

Tests cover grant authorization/revocation, native request forwarding, trusted
session headers, private backend credentials, sanitized HTTP/SSE failures,
completion markers and cancellation. Release acceptance also runs the real
pinned LiteLLM backend against configured model routes; a synthetic upstream
fixture proves protocol plumbing but does not prove a useful model review.

OpenShell service integration, persistent job usage reporting and new coding-agent
runtimes remain separate work. ChatGPT subscription activation needs its own
login, refresh and model/tool acceptance; it is not enabled by this migration.
