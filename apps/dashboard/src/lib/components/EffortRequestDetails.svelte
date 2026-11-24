<script lang="ts">
  import { EffortJobDetail as EffortJobDetailSchema } from '@compte-rendu/contracts';
  import type { EffortJobDetail, EffortRequestDetail } from '@compte-rendu/contracts';
  import { Option, Schema } from 'effect';
  import Badge from '#lib/components/Badge.svelte';

  let { runId, operator }: { runId: string; operator: boolean } = $props();
  let loading = $state(false);
  let detail = $state<EffortJobDetail | null>(null);
  let error = $state<string | null>(null);
  let requests = $state<EffortRequestDetail[]>([]);

  // A drawer or full-page navigation reuses the component instance. Never show
  // one review's request ledger under another run ID.
  $effect(() => {
    const current = runId;
    if (current.length === 0) return;
    detail = null;
    requests = [];
    error = null;
  });

  const controls = (
    value: { reasoning_effort?: string; thinking?: { type: 'disabled' } } | null,
    omitted: 'Not sent' | 'Not reported',
  ) => {
    if (value === null) return omitted;
    if (value.reasoning_effort !== undefined) return `reasoning_effort=${value.reasoning_effort}`;
    if (value.thinking !== undefined) return `thinking.type=${value.thinking.type}`;
    return omitted;
  };
  const resultLabel = (result: string) =>
    result === 'complete'
      ? 'Complete'
      : result === 'rejected'
        ? 'Rejected'
        : 'Record incomplete';
  const resultTone = (result: string) =>
    result === 'complete' ? 'good' : result === 'rejected' ? 'bad' : 'warn';
  const fallbackLabel = (fallback: string | null) =>
    fallback === 'switched'
      ? 'Switched to upstream default'
      : fallback === 'shared'
        ? 'Already using upstream default'
        : fallback === 'failed'
          ? 'Fallback failed'
          : 'No fallback';

  async function load(cursor?: string) {
    if (loading) return;
    loading = true;
    error = null;
    try {
      const target =
        '/api/jobs/' +
        encodeURIComponent(runId) +
        '/effort-details' +
        (cursor === undefined ? '' : '?cursor=' + encodeURIComponent(cursor));
      const reply = await fetch(target, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      });
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
      if (Option.isNone(decoded)) {
        error = 'The request details could not be read.';
        return;
      }
      detail = decoded.value;
      requests = cursor === undefined ? [...decoded.value.requests] : [...requests, ...decoded.value.requests];
    } catch {
      error = 'Could not load request details. This may be temporary.';
    } finally {
      loading = false;
    }
  }
</script>

{#if operator}
  <section class="effort-requests" aria-label="Per-request thinking effort">
    <h2>Request effort details</h2>
    <p class="muted">
      Authorized request-level records are kept for the relay ledger retention period. They
      show what was sent and what the upstream reported, not its internal thinking strength.
    </p>
    {#if detail === null}
      <button
        class="bx--btn bx--btn--tertiary bx--btn--sm"
        data-testid="load-effort-details"
        disabled={loading}
        onclick={() => load()}
      >
        {loading ? 'Loading…' : 'Load request details'}
      </button>
    {:else if requests.length === 0}
      <p class="muted">No request-level records were retained.</p>
    {:else}
      <ol class="requests">
        {#each requests as request (request.requestId)}
          <li data-testid={`effort-request-${request.requestId}`}>
            <div class="request-head">
              <span>{request.route} · configured {request.selected ?? 'Default'}</span>
              <span class="muted">Request <code>{request.requestId}</code></span>
              <Badge tone={request.fallback === 'failed' ? 'bad' : request.fallback === null ? 'muted' : 'warn'}>
                {fallbackLabel(request.fallback)}
              </Badge>
            </div>
            {#if request.reason}<p class="muted">{request.reason}</p>{/if}
            {#if request.attempts.length === 0}
              <p class="muted" data-testid={`effort-empty-attempts-${request.requestId}`}>
                <Badge tone="warn">Record incomplete</Badge>
                No attempt row was retained (the Worker may have crashed or the request is
                still pending).
              </p>
            {:else}
              <ol class="attempts">
                {#each request.attempts as attempt (attempt.attempt)}
                  <li>
                    <span>Attempt {attempt.attempt}</span>
                    <Badge tone={resultTone(attempt.result)}>{resultLabel(attempt.result)}</Badge>
                    <span class="muted">Sent: {controls(attempt.sent, 'Not sent')}</span>
                    <span class="muted">Reported: {controls(attempt.reported, 'Not reported')}</span>
                  </li>
                {/each}
              </ol>
            {/if}
          </li>
        {/each}
      </ol>
      {#if detail.nextCursor !== null}
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
    {#if error}<p class="notice" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .effort-requests { margin-bottom: 1.5rem; }
  .requests, .attempts { list-style: none; padding: 0; display: grid; gap: 0.75rem; }
  .requests > li { border-top: 1px solid #393939; padding-top: 0.75rem; }
  .request-head { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .attempts { margin-top: 0.5rem; }
  .attempts li { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .muted { color: #c6c6c6; font-size: 0.875rem; }
  .notice { color: #ff8389; }
</style>
