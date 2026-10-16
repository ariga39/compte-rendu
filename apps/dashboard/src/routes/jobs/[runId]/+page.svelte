<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import Badge from '#lib/components/Badge.svelte';
  import { createDashboard, createExpiryClock } from '#lib/dashboard.svelte.ts';
  import {
    absoluteTime,
    cleanupLabel,
    cleanupNote,
    cleanupTone,
    failurePhaseLabel,
    failureReasonLabel,
    formatDuration,
    milestoneLabel,
    outcomeSummary,
    relativeTime,
    statusLabel,
    statusTone,
  } from '#lib/format.ts';
  import {
    buildDetail,
    detailActive,
    identityDeadline,
    liveIdentity,
    mergeMilestones,
  } from '#lib/model.ts';
  import type { DetailModel, ExecutionStage, ProcessingStage } from '#lib/types.ts';

  const runId = $derived(page.params.runId ?? '');
  const encodedRunId = $derived(encodeURIComponent(runId));

  const dash = createDashboard<DetailModel>({
    key: () => `/jobs/${runId}`,
    urls: () => [`/api/jobs/${encodedRunId}`],
    build: (results, timing) => buildDetail(results, timing),
    isActive: (model) => detailActive(model),
    detail: true,
  });

  const clock = createExpiryClock();

  let backHref = $state('/history');
  let knownPredecessor = $state(false);

  afterNavigate(({ from }) => {
    const fromUrl = from?.url;
    if (fromUrl && fromUrl.pathname === '/history') {
      backHref = `${fromUrl.pathname}${fromUrl.search}`;
      knownPredecessor = true;
    } else {
      backHref = '/history';
      knownPredecessor = false;
    }
  });

  function onBack(event: MouseEvent) {
    if (!knownPredecessor) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    window.history.back();
  }

  $effect(() => {
    const model = dash.data;
    if (!model || dash.error) {
      clock.clear();
      return;
    }
    clock.schedule([identityDeadline(model.task)]);
  });

  const identity = $derived(
    dash.error || !dash.data ? null : liveIdentity(dash.data.task, clock.now),
  );
  const title = $derived(
    identity
      ? `${identity.repositoryFullName} #${identity.pullRequestNumber}`
      : 'Anonymous review',
  );
  const timeline = $derived(dash.data ? mergeMilestones(dash.data.detail) : []);
</script>

{#snippet timeFact(label: string, value: string | null | undefined)}
  <div class="fact">
    <b>{label}</b>
    {#if value}
      <time datetime={value}>{absoluteTime(value)}</time>
      <span class="muted">({relativeTime(value)})</span>
    {:else}
      <span class="muted">Not recorded</span>
    {/if}
  </div>
{/snippet}

{#snippet textFact(label: string, value: string)}
  <div class="fact"><b>{label}</b><span>{value}</span></div>
{/snippet}

{#if dash.error === 'notfound'}
  <section class="detail">
    <h1>Page not found</h1>
    <p class="muted">This dashboard address does not identify a task.</p>
    <a class="btn" href="/history" data-back data-testid="back" onclick={onBack}>Back to history</a>
  </section>
{:else if dash.data}
  {#if dash.error}
    <div role="alert" class="notice error">
      {dash.error === 'offline'
        ? 'You are offline. Updates will resume when you reconnect.'
        : 'Could not refresh reviews. Showing the last available data.'}
      <span class="muted">Last updated: {dash.lastGoodAt ? absoluteTime(new Date(dash.lastGoodAt).toISOString()) : 'not yet'}.</span>
      <button type="button" class="btn" onclick={dash.refresh}>Retry</button>
    </div>
  {/if}
  <section class="detail">
    <a class="btn" href={backHref} data-back data-testid="back" onclick={onBack}>← Back to history</a>
    <h1>{title}</h1>
    <p class="task-badges">
      <Badge tone={statusTone(dash.data.task)}>{statusLabel(dash.data.task)}</Badge>
      <Badge tone={cleanupTone(dash.data.task)}>{cleanupLabel(dash.data.task)}</Badge>
    </p>
    {#if identity}
      <p>
        <a href={identity.pullRequestUrl} target="_blank" rel="noopener noreferrer">
          Open pull request on GitHub
        </a>
      </p>
    {/if}

    <h2>Status</h2>
    <p>{outcomeSummary(dash.data.task)}</p>

    {#if dash.data.task.failure}
      <div class="notice error" role="alert">
        <strong>{failurePhaseLabel(dash.data.task.failure.phase)}</strong><br />
        {failureReasonLabel(dash.data.task.failure.reason)}
      </div>
    {/if}

    <h2>Timeline</h2>
    {#if timeline.length}
      <ol class="timeline">
        {#each timeline as milestone (milestone.stage + milestone.startedAt)}
          <li>
            <strong>{milestoneLabel(milestone.stage as ExecutionStage | ProcessingStage)}</strong><br />
            <time datetime={milestone.startedAt}>{absoluteTime(milestone.startedAt)}</time>
            <span class="muted">({relativeTime(milestone.startedAt)})</span>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="muted">Not recorded</p>
    {/if}

    <h2>Timing</h2>
    <div class="facts">
      {@render timeFact('Received', dash.data.task.receivedAt)}
      {@render timeFact('Accepted', dash.data.task.claimedAt)}
      {@render timeFact('Finished', dash.data.task.terminalAt)}
      {@render textFact('Time in queue', formatDuration(dash.data.task.queueWaitMs))}
      {@render textFact('Total time', formatDuration(dash.data.task.totalDurationMs))}
      {@render textFact(
        'Last progress update',
        dash.data.task.lastProgressAt ? relativeTime(dash.data.task.lastProgressAt) : 'Not recorded',
      )}
    </div>

    <h2>Execution details</h2>
    <div class="facts">
      {@render timeFact('Execution started', dash.data.task.executionStartedAt)}
      {@render timeFact('Result processing observed', dash.data.task.submissionCompletedAt)}
      {@render timeFact('Cleanup attempt finished', dash.data.task.cleanupCompletedAt)}
    </div>

    <h2>Cleanup</h2>
    <div class="cleanup-block">
      <Badge tone={cleanupTone(dash.data.task)}>{cleanupLabel(dash.data.task)}</Badge>
      <p class="muted">{cleanupNote(dash.data.task)}</p>
    </div>
  </section>
{:else if dash.loading}
  <p class="muted" aria-busy="true">Loading reviews…</p>
{:else}
  <section>
    <h1 class="page-head">Could not load reviews</h1>
    <p class="muted">
      {dash.error === 'offline' ? 'You are offline.' : 'Could not load reviews right now.'}
    </p>
    <div class="toolbar">
      <button type="button" class="btn" onclick={dash.refresh}>Try again</button>
    </div>
  </section>
{/if}
