# Sandbox/OpenCode remote PoC

This note records the reusable outcome of the 2026-08-26 Cloudflare Sandbox
1.0/OpenCode proof of concept. It separates Cloudflare's documented platform
properties from observations made during this PoC. It intentionally omits
credentials, repository contents, raw agent sessions, and deployment-specific
identifiers.

## Outcome and remaining proof

The PoC proved that the deployed Sandbox could make a real request through
OpenCode to the configured remote model route. A direct OpenCode CLI invocation
using OpenCode `1.18.22` and model
`opencode-go/deepseek-v4-flash` produced an assistant reply whose text was
exactly `PONG`, exited with code `0`, and had empty stderr. The observed command
duration was approximately `8.55` seconds. These are **PoC observations**, not
Cloudflare service guarantees. The repository pins the observed OpenCode
version in [`apps/core/Dockerfile`](../apps/core/Dockerfile).

The successful minimal invocation was:

```sh
opencode run --format json \
  --model opencode-go/deepseek-v4-flash \
  "Reply with exactly PONG and nothing else."
```

The corresponding OpenCode session also existed and was readable. Its
sanitized data cross-checked all of the following **PoC observations**:

- provider: `opencode-go`;
- model: `deepseek-v4-flash`;
- assistant finish reason: `stop`;
- token-accounting and cost fields were present for the completed response.

This is stronger evidence than process health or resource metrics alone: the
model response and persisted session metadata agree that the remote route was
connected. It does **not** yet prove a complete repository checkout and review,
output validation, publication, or clean-break Sandbox destruction.

## Instance sizing

Cloudflare currently documents these relevant predefined Container instance
types in its official
[Limits and Instance Types](https://developers.cloudflare.com/containers/platform-details/limits/)
table:

| Instance type | vCPU | Memory  | Disk |
| ------------- | ---- | ------- | ---- |
| `lite`        | 1/16 | 256 MiB | 2 GB |
| `basic`       | 1/4  | 1 GiB   | 4 GB |
| `standard-1`  | 1/2  | 4 GiB   | 8 GB |

The successful minimal route check ran on `basic`. During that run, the
`cloudchamber` cgroup reported `memory.peak = 836567040` bytes (about
`797.8 MiB`, or 78% of the documented `basic` memory), while `memory.events`
reported no OOM or OOM kill. These values are **PoC observations** from one
minimal prompt; they are not a workload capacity benchmark.

Consequently:

- `lite` is not an acceptable basis for evaluating OpenCode/Bun in this
  product;
- `basic` is sufficient only for the minimal route/session validation that was
  performed;
- the next full review validation must use at least `standard-1`. Its 4 GiB
  memory, 1/2 vCPU, and 8 GB disk make it the next predefined validation tier,
  not a claim that production capacity is already proven.

Do not declare `basic` adequate for full review merely because the minimal
`PONG` call completed without OOM. A full run adds checkout data, repository
analysis, a longer agent session, and cleanup pressure that this PoC did not
exercise.

## Deployment and SSH gates

A Worker deploy is not a readiness signal for its Containers. Cloudflare's
official [Rollouts](https://developers.cloudflare.com/containers/platform-details/rollouts/)
documentation states that deploy success means a rollout started, not that
instance replacement finished; Worker activation occurs before the image and
rollout steps. In this PoC, starting the agent during a rollout invalidated
earlier runs. Therefore use this operating gate:

1. Deploy the Worker/Container configuration once.
2. Poll `wrangler containers list` and wait for the target application to show
   `STATE=ready` before creating a fresh Sandbox or invoking OpenCode. This is
   the minimum **PoC operating gate**, not proof that a rollout completed or an
   instance is running. Wrangler derives `ready` when the application has no
   failed, starting, scheduling, or active instances; it is not a rollout
   state. See the first-party
   [`containers list` implementation](https://github.com/cloudflare/workers-sdk/blob/wrangler%404.124.0/packages/wrangler/src/containers/list.ts#L14-L28)
   and the official
   [Wrangler Containers command reference](https://developers.cloudflare.com/workers/wrangler/commands/containers/#list).
3. After the fresh Sandbox starts, use
   `wrangler containers instances <APPLICATION_ID>` and require the target
   instance to be `running` before SSH inspection. The official
   [`containers instances` reference](https://developers.cloudflare.com/workers/wrangler/commands/containers/#containers-instances)
   distinguishes instance states from the application-level list.
4. Do not reuse a Sandbox from an interrupted run or deploy again while the
   validation call is in flight.

For the PoC, configure `ssh.enabled: true` explicitly, but do not treat it as
sufficient. Cloudflare's official
[Container SSH](https://developers.cloudflare.com/containers/ssh/)
documentation says the switch defaults to enabled, while access still
requires a matching public key in `authorized_keys`; only `ssh-ed25519` is
supported and the target instance must be running. Configure both without
placing a private key in Wrangler configuration:

```jsonc
{
  "containers": [
    {
      // Other Container properties are omitted.
      "ssh": { "enabled": true },
      "authorized_keys": [
        {
          "name": "<OPERATOR_KEY_NAME>",
          "public_key": "ssh-ed25519 <PUBLIC_KEY_DATA>",
        },
      ],
    },
  ],
}
```

## Safe session verification

Run session inspection inside the same Sandbox runtime environment that owns
the OpenCode data. OpenCode's official
[CLI documentation](https://opencode.ai/docs/cli/#session) supports JSON output
for session listing, and its
[`export --sanitize` option](https://opencode.ai/docs/cli/#export) redacts
sensitive transcript/file data:

```sh
opencode session list --format json
opencode export <SESSION_ID> --sanitize
```

Use the JSON listing explicitly. The default table formatter failed in the
tested image because `less` was absent; that is a **PoC observation** about the
image, not an OpenCode platform guarantee. Inspect only the response text and
the provider, model, finish, token, and cost metadata needed to validate the
route. Treat even sanitized export output as transient diagnostic data; do not
commit or paste the full export.

Never record any of the following in repository documents, logs, tickets, or
review comments:

- model or platform credentials, private keys, tokens, or `auth.json`;
- an unsanitized session or full session transcript;
- raw private repository contents or exported agent sessions;
- private Cloudflare account, application, or instance IDs.

## Next validation

The next PoC slice is one full, read-only OpenCode review on a fresh
`standard-1` Sandbox after the application reaches `ready`. Capture only the
terminal result, timing, bounded resource measurements, sanitized session
metadata, and confirmation of eventual Sandbox destruction. Keep the
successful minimal `PONG` result as the model-route baseline; do not repeat it
as a substitute for the full review.
