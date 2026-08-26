# Local runtime tracer

`pnpm test` includes a real local workerd tracer for the ingress-to-core path.
It proves that a signed eligible webhook crosses the named `CORE` service
binding, applies the core D1 migration, records a scheduled delivery/run, and
captures the immutable Workflow create input. It also proves that an invalid
signature returns `400` with no Workflow capture and no D1 delivery or run.

This does not prove Cloudflare Workflow retry/deadline behavior, Runner Job or
Sandbox lifecycle, real GitHub App/webhook delivery, or the real model/agent
path. Those require a deployed end-to-end environment.
