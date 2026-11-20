# Local runtime tracer

`pnpm test` includes a real local workerd tracer for the in-process application.
It proves that a signed eligible webhook passes through the ingress and Core
modules, applies the D1 migrations, and records a scheduled delivery/run.
The test then authenticates the public `/runner-claim` route with the shared
Runner callback token and pulls one immutable Job input, while asserting that
normal new work does not use the private VPC cancellation binding. It also
proves that an invalid signature returns `400` with no Runner capture and no
D1 delivery or run. The same suite covers native Check re-requests for failed and operator-cancelled runs, the GitHub retry action for an operator-cancelled run, and renewal of a repository read token through the authenticated application endpoint.

Source: [runtime tests](../tests/runtime/tracer-runtime.test.ts).

The tracer injects the GitHub boundary and does not mount the SvelteKit entry.
The built-Worker SSR suite separately covers that entry and its public routing.

This does not prove Runner Job or Sandbox lifecycle, callback delivery, real
GitHub App/webhook delivery, or the real model/agent path. Those require a
deployed end-to-end environment.
