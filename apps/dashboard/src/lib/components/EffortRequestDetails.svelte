<script lang="ts">
  import {
    EffortJobDetail as EffortJobDetailSchema,
    isResponsesEffortControls,
  } from '@compte-rendu/contracts';
  import type {
    EffortJobDetail,
    EffortRequestDetail,
    EffortRequestStatus,
    RouteEffortControls,
  } from '@compte-rendu/contracts';
  import { Option, Schema } from 'effect';
  import Badge from '#lib/components/Badge.svelte';
  import type { BadgeTone } from '#lib/format.ts';

  let { runId, operator }: { runId: string; operator: boolean } = $props();

  let loading = $state(false);
  let loaded = $state(false);
  let detail = $state<EffortJobDetail | null>(null);
  let requests = $state<EffortRequestDetail[]>([]);
  let error = $state<string | null>(null);
  let routeFilter = $state('');
  // The grant's frozen route list survives filtering. Discovered routes only
  // cover a genuinely legacy grant without a mapping.
  let frozenRoutes = $state<string[]>([]);
  let discoveredRoutes = $state<string[]>([]);
  // A drawer or full-page navigation reuses the component instance. Every load
  // carries a version so a late reply cannot overwrite a newer run or route.
  let loadVersion = 0;
  let activeRunId = $state('');

  $effect(() => {
    const current = runId;
    if (current.length === 0 || activeRunId === current) return;
    activeRunId = current;
    loadVersion += 1;
    loading = false;
    loaded = false;
    detail = null;
    requests = [];
    error = null;
    routeFilter = '';
    frozenRoutes = [];
    discoveredRoutes = [];
  });

  const knownRoutes = $derived.by(() => {
    const source = frozenRoutes.length > 0 ? frozenRoutes : discoveredRoutes;
    return [...new Set(source)];
  });

  type RequestState = 'complete' | 'incomplete' | 'pending';
  const requestState = (request: EffortRequestDetail): RequestState => {
    if (request.status === 'complete') return 'complete';
    if (request.status === 'incomplete') return 'incomplete';
    // A persisted incomplete attempt is authoritative even before the grant
    // revocation flips the request row, so never project it as still running.
    return request.attempts.some((attempt) => attempt.result === 'incomplete')
      ? 'incomplete'
      : 'pending';
  };
  const stateLabel: Record<RequestState, string> = {
    complete: 'Complete',
    incomplete: 'Incomplete',
    pending: 'Pending',
  };
  const stateTone: Record<RequestState, BadgeTone> = {
    complete: 'good',
    incomplete: 'warn',
    pending: 'info',
  };

  const emptyAttempt = (
    request: EffortRequestDetail,
  ): { label: string; tone: BadgeTone; text: string } => {
    const state = requestState(request);
    if (state === 'complete')
      return {
        label: 'Attempt detail not recorded',
        tone: 'muted',
        text: 'The request completed, but its relay recorded no attempt-level detail.',
      };
    if (state === 'pending')
      return {
        label: 'No completion record',
        tone: 'info',
        text: 'No terminal completion or attempt record was retained for this request.',
      };
    return {
      label: 'No attempt record',
      tone: 'warn',
      text: 'The request did not complete and no attempt detail was saved.',
    };
  };

  const resultLabel = (result: string) =>
    result === 'complete' ? 'Complete' : result === 'rejected' ? 'Rejected' : 'Interrupted';
  const resultTone = (result: string): BadgeTone =>
    result === 'complete' ? 'good' : result === 'rejected' ? 'bad' : 'warn';
  const fallbackLabel = (fallback: string) =>
    fallback === 'switched'
      ? 'Switched to upstream default'
      : fallback === 'shared'
        ? 'Shared upstream default'
        : fallback === 'failed'
          ? 'Fallback failed'
          : fallback;
  const fallbackTone = (fallback: string): BadgeTone =>
    fallback === 'failed' ? 'bad' : 'warn';

  const controlLabel = (value: RouteEffortControls): string => {
    if (isResponsesEffortControls(value)) return `reasoning.effort=${value.reasoning.effort}`;
    if (value.reasoning_effort !== undefined) return `reasoning_effort=${value.reasoning_effort}`;
    return `thinking.type=${value.thinking?.type ?? 'disabled'}`;
  };
  // A null control only says no wire effort field was retained. The value can
  // also be an unrecognised client passthrough, so never infer "upstream
  // default" from it.
  const sentLabel = (attempt: EffortRequestDetail['attempts'][number]) =>
    attempt.sent === null ? 'No allowlisted effort recorded' : controlLabel(attempt.sent);
  // A null report can mean the provider omitted the field or supplied a value
  // outside the wire allowlist, so never claim the upstream said nothing.
  const NO_RECOGNIZED_REPORT = 'No recognized effort recorded';
  const reportedLabel = (attempt: EffortRequestDetail['attempts'][number]) =>
    attempt.reported === null ? NO_RECOGNIZED_REPORT : controlLabel(attempt.reported);
  const differs = (attempt: EffortRequestDetail['attempts'][number]) =>
    attempt.sent !== null &&
    attempt.reported !== null &&
    JSON.stringify(attempt.sent) !== JSON.stringify(attempt.reported);

  const generationLabel = (request: EffortRequestDetail) =>
    request.generation !== null && request.generation > 0 ? ` · gen ${request.generation}` : '';
  const configuredLabel = (request: EffortRequestDetail) =>
    `${request.selected ?? 'Default'}${generationLabel(request)}`;

  async function load(cursor?: string) {
    if (loading) return;
    const version = ++loadVersion;
    const targetRun = runId;
    const targetRoute = routeFilter;
    loading = true;
    error = null;
    try {
      const params = new URLSearchParams();
      if (cursor !== undefined) params.set('cursor', cursor);
      if (targetRoute.length > 0) params.set('route', targetRoute);
      const query = params.size === 0 ? '' : '?' + params.toString();
      const target = '/api/jobs/' + encodeURIComponent(targetRun) + '/effort-details' + query;
      const reply = await fetch(target, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (version !== loadVersion || targetRun !== runId || targetRoute !== routeFilter) return;
      if (reply.status === 404) {
        error = 'Request details are no longer retained for this review.';
        return;
      }
      if (!reply.ok) {
        error = 'Could not load request details. This may be temporary.';
        return;
      }
      const decoded = Schema.decodeUnknownOption(EffortJobDetailSchema, {
        onExcessProperty: 'error',
      })(await reply.json());
      if (version !== loadVersion || targetRun !== runId || targetRoute !== routeFilter) return;
      if (Option.isNone(decoded)) {
        error = 'The request details could not be read.';
        return;
      }
      detail = decoded.value;
      loaded = true;
      frozenRoutes = [...decoded.value.routes];
      const discovered = new Set(discoveredRoutes);
      for (const request of decoded.value.requests) discovered.add(request.route);
      discoveredRoutes = [...discovered];
      requests =
        cursor === undefined
          ? [...decoded.value.requests]
          : [...requests, ...decoded.value.requests];
    } catch {
      if (version !== loadVersion || targetRun !== runId || targetRoute !== routeFilter) return;
      error = 'Could not load request details. This may be temporary.';
    } finally {
      if (version === loadVersion && targetRun === runId) loading = false;
    }
  }

  function chooseRoute(next: string) {
    if (next === routeFilter) return;
    routeFilter = next;
    detail = null;
    requests = [];
    error = null;
    void load();
  }
</script>

{#if operator}
  <section class="effort-requests" aria-label="Per-request thinking effort">
    <h2>Request effort details</h2>
    <p class="muted">
      Authorized request-level records are kept for the relay ledger retention period. They show
      what was sent and what the upstream reported, not its internal thinking strength.
    </p>
    {#if !loaded}
      <button
        class="bx--btn bx--btn--tertiary bx--btn--sm"
        data-testid="load-effort-details"
        disabled={loading}
        onclick={() => load()}
      >
        {loading ? 'Loading…' : 'Load request details'}
      </button>
    {:else}
      {#if knownRoutes.length >= 2 || routeFilter !== ''}
        <div class="filter-bar">
          <label class="route-filter">
            <span>Route</span>
            <select
              data-testid="effort-route-filter"
              value={routeFilter}
              disabled={loading}
              onchange={(event) => chooseRoute(event.currentTarget.value)}
            >
              <option value="">All routes</option>
              {#each knownRoutes as route (route)}
                <option value={route}>{route}</option>
              {/each}
            </select>
          </label>
          {#if routeFilter !== ''}
            <span class="muted">Showing {routeFilter} only.</span>
          {/if}
        </div>
      {/if}
      {#if requests.length === 0}
        {#if loading}
          <p class="muted" aria-busy="true">Loading request details…</p>
        {:else}
          <p class="muted">No request-level records were retained for this selection.</p>
        {/if}
      {:else}
        <ol class="requests">
          {#each requests as request, index (request.requestId)}
            {@const state = requestState(request)}
            {@const empty = request.attempts.length === 0 ? emptyAttempt(request) : null}
            <li>
              <details class="request" data-testid={`effort-request-${request.requestId}`}>
                <summary
                  class="request-head"
                  data-testid={`effort-toggle-${request.requestId}`}
                >
                  <span class="head-main">
                    <span class="index">#{index + 1}</span>
                    <span class="route" title={request.route}>{request.route}</span>
                    <Badge tone={stateTone[state]}>{stateLabel[state]}</Badge>
                    {#if request.fallback !== null}
                      <Badge tone={fallbackTone(request.fallback)}>
                        {fallbackLabel(request.fallback)}
                      </Badge>
                    {/if}
                    <span class="configured">configured {configuredLabel(request)}</span>
                  </span>
                  {#if empty !== null}
                    <span
                      class="empty-attempts"
                      data-testid={`effort-empty-attempts-${request.requestId}`}
                    >
                      <Badge tone={empty.tone}>{empty.label}</Badge>
                      <span class="muted">{empty.text}</span>
                    </span>
                  {:else}
                    {@const last = request.attempts[request.attempts.length - 1]!}
                    <span
                      class="final-attempt"
                      data-testid={`effort-final-${request.requestId}`}
                    >
                      <span class="attempt-tag">
                        Attempt {last.attempt}
                        {#if last.result !== 'complete'}
                          <Badge tone={resultTone(last.result)}>{resultLabel(last.result)}</Badge>
                        {/if}
                      </span>
                      <span class="muted">Sent: <code>{sentLabel(last)}</code></span>
                      <span class="muted">
                        Reported:
                        {#if last.reported === null}
                          {reportedLabel(last)}
                        {:else}
                          <code>{controlLabel(last.reported)}</code>
                        {/if}
                      </span>
                      {#if differs(last)}
                        <Badge tone="warn">Differs from sent</Badge>
                      {/if}
                    </span>
                  {/if}
                </summary>
                <div class="request-body">
                  <dl class="request-facts">
                    <div>
                      <dt>Request ID</dt>
                      <dd>
                        <code data-testid={`effort-request-id-${request.requestId}`}>
                          {request.requestId}
                        </code>
                      </dd>
                    </div>
                    {#if request.fallback !== null || request.reason !== null}
                      <div>
                        <dt>Fallback</dt>
                        <dd>
                          {request.fallback === null
                            ? 'Not recorded'
                            : fallbackLabel(request.fallback)}{#if request.reason}{` · ${request.reason}`}{/if}
                        </dd>
                      </div>
                    {/if}
                  </dl>
                  {#if request.attempts.length > 1}
                    <ol class="attempts">
                      {#each request.attempts as attempt (attempt.attempt)}
                        <li
                          data-testid={`effort-attempt-${request.requestId}-${attempt.attempt}`}
                        >
                          <div class="attempt-head">
                            <strong>Attempt {attempt.attempt}</strong>
                            <Badge tone={resultTone(attempt.result)}>
                              {resultLabel(attempt.result)}
                            </Badge>
                          </div>
                          <dl class="attempt-facts">
                            <div>
                              <dt>Sent</dt>
                              <dd><code>{sentLabel(attempt)}</code></dd>
                            </div>
                            <div>
                              <dt>Reported</dt>
                              <dd>
                                {#if attempt.reported === null}
                                  <span class="muted">{reportedLabel(attempt)}</span>
                                {:else}
                                  <code>{controlLabel(attempt.reported)}</code>
                                {/if}
                              </dd>
                            </div>
                          </dl>
                        </li>
                      {/each}
                    </ol>
                  {/if}
                </div>
              </details>
            </li>
          {/each}
        </ol>
        {#if detail !== null && detail.nextCursor !== null}
          <button
            class="bx--btn bx--btn--tertiary bx--btn--sm"
            data-testid="load-more-effort-details"
            disabled={loading}
            onclick={() => load(detail?.nextCursor ?? undefined)}
          >
            {loading ? 'Loading…' : 'Load more requests'}
          </button>
        {/if}
      {/if}
    {/if}
    {#if error}<p class="notice" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .effort-requests {
    margin-bottom: 1.5rem;
    min-width: 0;
  }
  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  .route-filter {
    display: inline-flex;
    gap: 0.375rem;
    align-items: center;
    font-size: 0.875rem;
    min-width: 0;
  }
  .route-filter select {
    max-width: 100%;
    min-width: 0;
  }
  .requests,
  .attempts {
    list-style: none;
    padding: 0;
    display: grid;
    gap: 0.5rem;
    margin: 0;
  }
  .requests > li {
    border-top: 1px solid #393939;
    padding-top: 0.5rem;
    min-width: 0;
  }
  .request {
    min-width: 0;
  }
  /* Keep the native summary marker: a grid/flex summary loses its
     disclosure triangle, so the children stack as block-level rows. */
  .request-head {
    cursor: pointer;
    min-width: 0;
  }
  .head-main,
  .empty-attempts,
  .final-attempt {
    margin-top: 0.25rem;
  }
  .head-main,
  .final-attempt,
  .empty-attempts,
  .attempt-tag,
  .attempt-head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    align-items: center;
    min-width: 0;
  }
  .index {
    color: #8d8d8d;
    font-variant-numeric: tabular-nums;
  }
  .route {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .configured {
    color: #c6c6c6;
    font-size: 0.8125rem;
  }
  .final-attempt {
    font-size: 0.8125rem;
  }
  .final-attempt code,
  .request-facts code,
  .attempt-facts code {
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .request-body {
    margin-top: 0.5rem;
    padding-left: 0.75rem;
    border-left: 1px solid #393939;
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }
  .request-facts,
  .attempt-facts {
    display: grid;
    grid-template-columns: 6.5rem minmax(0, 1fr);
    gap: 0.25rem 0.5rem;
    margin: 0;
    font-size: 0.8125rem;
  }
  .request-facts > div,
  .attempt-facts > div {
    display: contents;
  }
  .request-facts dt,
  .attempt-facts dt {
    color: #c6c6c6;
  }
  .request-facts dd,
  .attempt-facts dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .attempts > li {
    display: grid;
    gap: 0.25rem;
  }
  .attempt-head strong {
    font-size: 0.875rem;
  }
  .muted {
    color: #c6c6c6;
    font-size: 0.8125rem;
  }
  .notice {
    color: #ff8389;
  }
</style>
