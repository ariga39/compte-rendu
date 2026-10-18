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

Set `LLM_SERVICE_CONFIG` to an absolute TOML filename:

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

Example user unit, replacing the absolute paths:

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
