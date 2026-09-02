# Local runtime tracer

`pnpm test` includes a real local workerd tracer for the ingress-to-core path.
It proves that a signed eligible webhook crosses the named `CORE` service
binding, applies the core D1 migration, and records a scheduled delivery/run.
The test then authenticates the public `/runner-claim` route with the shared
Runner callback token and pulls one immutable Job input, while asserting that
normal new work does not use the private VPC cancellation binding. It also
proves that an invalid signature returns `400` with no Runner capture and no
D1 delivery or run.

This does not prove Runner Job or Sandbox lifecycle, callback delivery, real
GitHub App/webhook delivery, or the real model/agent path. Those require a
deployed end-to-end environment.
