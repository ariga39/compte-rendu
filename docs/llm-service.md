# LLM service

The standalone Node service is the first implementation slice of the
[external LLM service design](llm-service-design.md). It supplies authenticated
inference and job grants. The sbx Runner can use it through the integration below.
It does not automatically change either deployed review instance.

## Build and configuration

Use Node >= 22.19 (production currently uses Node 24), then:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @compte-rendu/llm-service build
```

Run the built entry inside its installed workspace. `pi-ai` remains an external
runtime dependency; copying only `dist/llm-service.js` is insufficient.

On the service host, create an instance-specific configuration directory as the
service user. These commands preserve existing files on upgrades:

```sh
install -d -m 0700 ~/.config/<INSTANCE_NAME>-llm
(umask 077; touch ~/.config/<INSTANCE_NAME>-llm/service.toml)
chmod 0600 ~/.config/<INSTANCE_NAME>-llm/service.toml
$EDITOR ~/.config/<INSTANCE_NAME>-llm/service.toml
```

Set `LLM_SERVICE_CONFIG` to that file's absolute path. Fill in the routes below;
**remove routes you will not use**. Every configured route's credential file must
exist before the service starts. Use the subscription login command below to
create its file before starting the service.

Example TOML (replace paths, port, route IDs and model names for this instance):

```toml
controlSocket = "/run/user/1000/compte-rendu-llm/control.sock"
port = 8090

[[routes]]
id = "deepseek-review"
provider = "openai-compatible"
protocol = "chat-completions"
model = "deepseek-v4.1-flash"
baseUrl = "https://your-provider.example/v1"
credentialFile = "/home/runner/.config/compte-rendu-llm/deepseek-key"

[[routes]]
id = "subscription-review"
provider = "openai-codex"
protocol = "codex-responses"
model = "gpt-6.1-sol"
baseUrl = "https://chatgpt.com/backend-api"
credentialFile = "/home/runner/.config/compte-rendu-llm/subscription.json"
```

Names are examples, not a claim that every account offers those models. Each
route is fixed at startup. Clients send the route ID as `model`; the service
replaces it with the configured upstream model. No runtime hot reload or model
fallback is implemented. The client must use the route's matching HTTP protocol.

Choose `provider` independently of `baseUrl`. It is required; existing configuration
files must add it before upgrading. Supported combinations are:

| Provider            | Protocol           | pi-ai adapter                                       |
| ------------------- | ------------------ | --------------------------------------------------- |
| `opencode-go`       | `chat-completions` | Native OpenCode Go provider                         |
| `openai-compatible` | `chat-completions` | Custom provider using pi-ai’s OpenAI-compatible API |
| `openai-codex`      | `codex-responses`  | Native ChatGPT subscription provider                |

For OpenCode Go, use `provider = "opencode-go"`. The official base URL is
`https://opencode.ai/inference/go/openai/v1`; a custom gateway URL works with the
same provider selection. The service passes the authenticated grant’s job ID as
pi-ai’s `sessionId`, so its native provider supplies the required routing header.
Requests within a job retain that identity; client-supplied session headers are
not forwarded. A custom URL does not turn an OpenCode Go route into a generic
provider. Use `openai-compatible` only for an explicitly generic endpoint.
Unknown providers or incompatible provider/protocol pairs fail at startup.

The model API key file contains only the key. Keep credential directories mode
0700 and files mode 0600; files readable by other users are rejected. TOML contains
paths, never credential values. The subscription file is created by login, not by
copying an existing Codex/OpenCode auth cache. Use separate configuration, files,
ports and control sockets for separate production instances.

For an API-key route, create its file without putting the secret in shell
arguments or shell history, then paste the key in the editor:

```sh
(umask 077; touch ~/.config/<INSTANCE_NAME>-llm/deepseek-key)
chmod 0600 ~/.config/<INSTANCE_NAME>-llm/deepseek-key
$EDITOR ~/.config/<INSTANCE_NAME>-llm/deepseek-key
```

The `credentialFile` value must be the absolute path to that file. For a second
instance, use different configuration/credential directories, control socket,
HTTP port and systemd unit. These resources are local to the host; no new
Cloudflare binding or D1 migration is required for this standalone service.

## Subscription login and exclusive ownership

With the service stopped, create its private credential directory, then run:

```sh
LLM_SERVICE_CONFIG=/absolute/path/service.toml \
  node apps/llm-service/dist/llm-service.js login subscription-review
```

Follow the displayed device URL and code. The service delegates login and refresh
to pi-ai's ChatGPT subscription provider. It serializes refresh in-process and
atomically replaces the mode-0600 credential file. Authentication errors are
sanitized; the CLI never prints the resulting credential.

The service and login command automatically acquire an exclusive OS lock beside
each subscription credential file (`<file>.owner.lock`), using `/usr/bin/flock`
on Linux. A second owner fails before login or inference starts. Stop the service
before re-login; do not delete lock files while an owner is running. The lock is
released on shutdown or process exit. Do not share this file with developer CLIs or another
service instance. This first version does not implement distributed locks or
cross-host credential sharing.

## Host service

Run as the same user as its Runner, with a private control socket directory.
The HTTP listener is intentionally **127.0.0.1 only**. A future Sandbox integration
must establish an authenticated, protected network path; exposing this port
publicly is not an installation step.

Save the following as
`~/.config/systemd/user/<INSTANCE_NAME>-llm.service` (create the directory if
needed), replacing the absolute paths. Install util-linux so `/usr/bin/flock`
is available. Keep the checked-out workspace and installed dependencies on disk;
this is a Node service, not a Worker deployment or a standalone copied bundle.

Example user unit:

```ini
[Unit]
Description=compte-rendu LLM service

[Service]
Type=simple
WorkingDirectory=/absolute/path/compte-rendu
Environment=LLM_SERVICE_CONFIG=/absolute/path/service.toml
UMask=0077
ExecStart=/absolute/path/node apps/llm-service/dist/llm-service.js
Restart=on-failure

[Install]
WantedBy=default.target
```

Keep this unit independent of the Runner unit and cgroup. An occupied/stale socket
causes startup failure; the service does not unlink arbitrary socket paths. If a
crash leaves one, verify no old service owns it before removing it. A restart
invalidates all in-memory grants and interrupts in-flight requests. Drain callers
before planned maintenance; `concurrency = 0` is not a valid Runner setting.

### Start and check the service

Run as the service user, after configuring credentials and completing any
subscription login:

```sh
systemctl --user daemon-reload
systemctl --user enable --now <INSTANCE_NAME>-llm.service
systemctl --user status <INSTANCE_NAME>-llm.service
journalctl --user -u <INSTANCE_NAME>-llm.service -n 30 --no-pager
```

For unattended operation after logout/reboot, an administrator enables lingering
once with `sudo loginctl enable-linger <RUNNER_USER>`. The unit should log
`LLM service listening on 127.0.0.1:<PORT>`. Check both boundaries:

```sh
stat -c '%a %n' <CONTROL_SOCKET>
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  -X POST http://127.0.0.1:<PORT>/v1/chat/completions
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  --unix-socket <CONTROL_SOCKET> http://localhost/grants
```

Expect socket mode `600`, HTTP `401` without a job token, and control `405`
(GET is not allowed). These checks prove startup and listener separation only;
they do not prove model access. A successful inference probe must issue a fresh
grant via the private socket, call an allowed route with that token, consume the
complete stream, and revoke the job in a finalization path. Keep the token in
process memory; do not print it or pass it as a command-line argument.

Configuration is loaded at startup. After editing TOML, drain callers and run
`systemctl --user restart <INSTANCE_NAME>-llm.service`; old grants become invalid.
For a binary update, build the selected revision with its locked dependencies
before restarting. Keep the previous revision and configuration for rollback;
rolling back also invalidates grants and does not resume interrupted jobs.

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
`chat-completions`; the actual upstream model is configured in the service TOML.
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
`POST /v1/responses`, with `Authorization: Bearer <job token>`. Both require
`stream: true`. Tool execution stays in the agent: only client-executed function
tools (plus Responses custom tools) are supported. Unsupported top-level fields
or hosted tool types are rejected instead of silently ignored. Upstream HTTP
errors become sanitized failures; interrupted streams are not successful results.

Control bodies are bounded at 16 KiB; inference bodies at 16 MiB. The larger bound
allows substantial review context/tool transcripts while bounding per-request
buffering, and is independent of the Runner claim/callback body limits. Each model
request has a two-minute total timeout, including credential resolution, in
addition to grant expiry. Native response output is streamed with backpressure and a 16 MiB total bound
(to bound the provider parser's retained output as well as network queues).
No extra output-token cap is injected: supported client limits are forwarded.

## Verification and remaining integration

Tests exercise the HTTP/control boundaries, token lifecycle, route restrictions,
stream cancellation and failure, private credentials, serialized refresh and
refresh persistence after service recreation. Local live DeepSeek acceptance
used the built service, a newly issued grant and a synthetic code-review tool
loop; it identified a shipping-threshold regression and returned `request_changes`.
The revoked token then received HTTP 401. This is a loopback service probe, not a
published GitHub review or Sandbox acceptance.

Dedicated real ChatGPT login/refresh and real Codex/OpenCode client acceptance
remain rollout gates; simulated auth and protocol tests do not establish them.
OpenShell credential migration, a product-level maintenance pause and per-job
usage reporting remain separate work. Complete the applicable client, cancellation
and publication checks above before switching a production instance.
