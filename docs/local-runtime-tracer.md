# Local runtime tracer

`pnpm test` includes a real local workerd tracer for the ingress-to-core path.
It proves that a signed eligible webhook crosses the named `CORE` service
binding, applies the core D1 migration, records a scheduled delivery/run, and
captures exactly one immutable Runner Job submission. It also proves that an
invalid signature returns `400` with no Runner capture and no D1 delivery or
run.

This does not prove Runner Job or Sandbox lifecycle, callback delivery, real
GitHub App/webhook delivery, or the real model/agent path. Those require a
deployed end-to-end environment.
