# LLM service

The standalone Node service is the first implementation slice of the
[external LLM service design](llm-service-design.md). It supplies authenticated
inference and job grants; Runner/Sandbox wiring is a subsequent integration slice.
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
protocol = "chat-completions"
model = "deepseek-v4.1-flash"
baseUrl = "https://your-provider.example/v1"
credentialFile = "/home/runner/.config/compte-rendu-llm/deepseek-key"

[[routes]]
id = "subscription-review"
protocol = "codex-responses"
model = "gpt-6.1-sol"
baseUrl = "https://chatgpt.com/backend-api"
credentialFile = "/home/runner/.config/compte-rendu-llm/subscription.json"
```

Names are examples, not a claim that every account offers those models. Each
route is fixed at startup. Clients send the route ID as `model`; the service
replaces it with the configured upstream model. No runtime hot reload or model
fallback is implemented. The client must use the route's matching HTTP protocol.

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

## Connecting the Runner

There is currently no Runner setting for the LLM service control socket or grant
lifecycle. `LLM_SERVICE_CONFIG` belongs to the LLM service process only. Keep the
existing Runner model setup until the following integration is implemented and
verified:

1. After claiming a job, Runner requests one grant for its frozen route allowlist
   and checks that the job deadline fits within the grant's two-hour expiry.
2. The Sandbox receives that grant through its credential mechanism, with its
   agent endpoint pointing at a protected, reachable service address. Sandbox
   `127.0.0.1` is not host loopback. Do not expose the listener publicly or reuse
   the upstream API key as a job token.
3. Runner revokes the grant on every completion/cancellation/setup-failure path,
   independently of evidence export and Sandbox destruction. A failed grant or
   service call must not fall back to direct upstream access.
4. Validate sbx first, then OpenShell's per-job model provider. Confirm real tool
   turns, credential redaction, cancellation and final review publication before
   migrating an instance. Real subscription login/refresh remains a separate gate.

This is an implementation dependency, not an operator action that can be achieved
by changing `MODEL_SECRET_COMMAND` or `REVIEW_MODEL_CONFIG` today. The existing
[Runner installation](installation.md#first-installation) remains the supported
production path until that integration lands.

## Public boundaries

The Unix socket exposes only:

- `POST /grants` with `{ "jobId": "...", "routes": ["deepseek-review"] }`:
  returns 201 and `{ "token": "...", "expiresAt": "ISO timestamp" }`.
- `POST /grants/revoke` with `{ "jobId": "..." }`: returns 204, idempotently.

The socket is mode 0600, inside a private directory. Its filesystem permissions
are the control-plane authentication. HTTP bearer tokens cannot administer grants.
Duplicate issuance returns 409. Revocation of an unknown job prevents delayed
issuance for that identity during the two-hour tombstone lifetime. If an issuance
response is lost, the caller must fail the job and revoke by identity, never retry
issuance within that job. Grants expire exactly two hours after issuance and have
no renewal API. Revocation/expiry also cancels active inference.

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
Runner grant issuance/finalization, sbx/OpenShell credential migration, protected
Sandbox networking, maintenance pause and per-job usage reporting remain separate
integration work. Do not turn on this service for production jobs until those
applicable gates pass.
