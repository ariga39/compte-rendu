<script lang="ts">
  import Badge from '#lib/components/Badge.svelte';
  import StatCard from '#lib/components/StatCard.svelte';
  import TaskRow from '#lib/components/TaskRow.svelte';
  import Toolbar from '#lib/components/Toolbar.svelte';
  import { createDashboard, createExpiryClock } from '#lib/dashboard.svelte.ts';
  import { absoluteTime } from '#lib/format.ts';
  import { buildOverview, identityDeadline, overviewActive } from '#lib/model.ts';
  import type { OverviewModel } from '#lib/types.ts';

  const dash = createDashboard<OverviewModel>({
    key: () => '/',
    urls: () => ['/api/dashboard', '/api/jobs?view=current', '/api/jobs?view=cleanup'],
    build: (results, timing) => buildOverview(results, timing),
    isActive: (model) => overviewActive(model),
  });

  const clock = createExpiryClock();

  $effect(() => {
    const model = dash.data;
    if (!model) {
      clock.clear();
      return;
    }
    clock.schedule([...model.current.tasks, ...model.cleanup.tasks].map(identityDeadline));
  });
</script>

<header class="page-head">
  <h1>Review activity</h1>
</header>

{#if dash.error}
  <div role="alert" data-testid="error-notice" class="notice error">
    {dash.error === 'offline'
      ? 'You are offline. Updates will resume when you reconnect.'
      : 'Could not refresh reviews. Showing the last available data.'}
    <span class="muted">Last updated: {dash.lastGoodAt ? absoluteTime(new Date(dash.lastGoodAt).toISOString()) : 'not yet'}.</span>
    <button type="button" class="btn" onclick={dash.refresh}>Retry</button>
  </div>
{/if}

{#if dash.data}
  <Toolbar lastGoodAt={dash.lastGoodAt} onRefresh={dash.refresh} />
  <section data-testid="stats" class="stat-strip">
    <StatCard label="Queued" sub="Waiting to start" value={dash.data.overview.counts.queued} />
    <StatCard label="In progress" sub="Accepted for processing" value={dash.data.overview.counts.claimed} />
    <StatCard label="Published" sub="Received in the past 24 hours" value={dash.data.overview.counts.publishedLast24h} />
    <StatCard label="Failed" sub="Received in the past 24 hours" value={dash.data.overview.counts.failedLast24h} />
  </section>
  <section>
    <h2 class="section-title">Current reviews</h2>
    {#if dash.data.current.tasks.length}
      {#each dash.data.current.tasks as task (task.runId)}
        <TaskRow {task} now={clock.now} stale={dash.error !== null} />
      {/each}
    {:else}
      <div class="empty">No reviews in progress or waiting.</div>
    {/if}
    {#if dash.data.current.nextCursor}
      <div class="toolbar">
        <a class="btn" href="/history?view=current" data-testid="view-all-current">View all current work</a>
      </div>
    {/if}
  </section>
  <section>
    <h2 class="section-title">
      Cleanup needs attention
      <Badge tone={dash.data.overview.cleanupAttention > 0 ? 'bad' : 'muted'}>
        {String(dash.data.overview.cleanupAttention)}
      </Badge>
    </h2>
    <p class="muted">Reviews with failed cleanup or cleanup still pending after the review ended.</p>
    {#if dash.data.cleanup.tasks.length}
      {#each dash.data.cleanup.tasks as task (task.runId)}
        <TaskRow {task} now={clock.now} stale={dash.error !== null} />
      {/each}
    {:else}
      <div class="empty">No cleanup issues.</div>
    {/if}
    {#if dash.data.cleanup.nextCursor}
      <div class="toolbar">
        <a class="btn" href="/history?view=cleanup" data-testid="view-all-cleanup">View all cleanup exceptions</a>
      </div>
    {/if}
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
