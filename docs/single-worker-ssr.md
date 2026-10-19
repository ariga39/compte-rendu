# Single Worker SvelteKit application

Status: implementation in progress ([#202](https://github.com/ariga39/compte-rendu/issues/202)).

## Outcome

One SvelteKit Worker serves the dashboard, public API, GitHub webhook and Runner
endpoints. Overview, history and job detail HTML contains the DB-backed public
projection before JavaScript runs, so both browsers and AI readers can inspect
links directly. Help remains Markdown rendered to HTML. Browser refresh,
filtering and detail drawers continue to use TanStack Query.

## Application boundary

Keep Core's existing domain and persistence modules. Call them inside the same
Worker instead of using a `CORE` service binding. Reuse the ingress verification
logic for raw webhook signatures, installation scope and Runner authentication;
never expose internal normalized-event or trusted-callback routes directly.
One Worker owns D1, R2, the Runner VPC binding, secrets and scheduled metadata
refresh. Login is outside this change; SvelteKit server hooks provide a natural
place to add sessions later.

SSR and JSON endpoints consume the same public projection. Page data must never
contain raw repository records, secrets, callbacks or evidence. No shared mutable
per-request QueryClient or public-identity page cache. Initial server data seeds
client rendering; client updates continue respecting identity expiry and tab
visibility. Unavailable data is an explicit error, not a fabricated empty list.

## Query lifecycle

Use TanStack Query's server prefetch and hydration APIs. A document load creates
its own QueryClient, fetches the public projection, dehydrates successful cache
entries and clears the temporary client. The page hydrates its request-local
rendering client before creating query observers. Only raw public data and wall
clock request timestamps cross the boundary; browser identity-expiry timers are
reconstructed using its own monotonic clock.

Query observers are disabled on the server. The browser uses the same query keys
and hydrated cache, without an immediate duplicate fetch. Browser navigation and
subsequent refresh remain managed by Query (visibility, offline state,
cancellation and Retry-After included). No shared server QueryClient is used.

References: [TanStack Svelte SSR guide](https://tanstack.com/query/latest/docs/framework/svelte/ssr),
[installed v6.3.1 hydration API](https://github.com/TanStack/query/blob/%40tanstack%2Fsvelte-query%406.3.1/packages/svelte-query/src/useHydrate.ts),
and [SvelteKit Cloudflare adapter](https://svelte.dev/docs/kit/adapter-cloudflare).

## Delivery and migration

Retain public domains and paths, database/bucket IDs, branding, allowlists and
Runner callback credentials. Add bindings and secrets to the existing public
Worker before switching traffic. Disable the old Core Cron once the unified
Worker owns scheduling; preserve its previous deployment for rollback until
acceptance completes. No data backfill or new task lifecycle is required.

Verify the built SvelteKit application under workerd: public HTML without JS,
private identity redaction, signed webhook admission, unauthenticated callback
rejection, public API behavior, scheduled refresh and browser hydration/refresh.
Deploy only merged code and verify both installations.
