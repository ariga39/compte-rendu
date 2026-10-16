<script lang="ts">
  import Badge from '#lib/components/Badge.svelte';
  import StatCard from '#lib/components/StatCard.svelte';
  import TaskRow from '#lib/components/TaskRow.svelte';
  import Toolbar from '#lib/components/Toolbar.svelte';
  import { createDashboard, createExpiryClock } from '#lib/dashboard.svelte.ts';
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

<section class="mb-7 max-w-[760px]">
  <span class="text-xs font-extrabold uppercase tracking-[0.16em] text-accent">Persisted review activity</span>
  <h1 class="my-1.5 mb-4 text-[clamp(1.6rem,3.2vw,2.35rem)] font-extrabold leading-tight tracking-[-0.03em]">Review activity</h1>
  <p class="text-muted-ink">A read-only view of admitted work, durable outcomes and cleanup facts. A claimed row is an observation, not a live process.</p>
</section>

{#if dash.error}
  <div role="alert" class="my-[18px] rounded-xl border border-[#75464b] bg-[#111923] px-4 py-3 text-danger" data-testid="error-notice">
    {dash.error === 'offline' ? 'You appear to be offline.' : 'The dashboard is temporarily unavailable.'}
    Showing the last refresh from {dash.lastGoodAt ? new Date(dash.lastGoodAt).toISOString() : 'not yet'}.
    <button
      type="button"
      class="ml-2 cursor-pointer rounded-[9px] border border-line bg-panel px-3 py-1.5 text-ink"
      onclick={dash.refresh}
    >
      Retry
    </button>
  </div>
{/if}

{#if dash.data}
  <Toolbar lastGoodAt={dash.lastGoodAt} onRefresh={dash.refresh} />
  <section data-testid="stats" class="my-7 grid grid-cols-4 gap-3 max-md:grid-cols-2 max-sm:grid-cols-2">
    <StatCard label="Queued" sub="Current database state" value={dash.data.overview.counts.queued} />
    <StatCard label="Claimed" sub="Current database state" value={dash.data.overview.counts.claimed} />
    <StatCard label="Published" sub="Received in the last 24 hours" value={dash.data.overview.counts.publishedLast24h} />
    <StatCard label="Failed" sub="Received in the last 24 hours" value={dash.data.overview.counts.failedLast24h} />
  </section>
  <section class="mt-9">
    <h2 class="mb-3 text-xl">Current work</h2>
    {#if dash.data.current.tasks.length}
      {#each dash.data.current.tasks as task (task.runId)}
        <TaskRow {task} now={clock.now} stale={dash.error !== null} />
      {/each}
    {:else}
      <div class="rounded-[14px] border border-dashed border-line p-8 text-center text-muted-ink">
        No current work is recorded.
      </div>
    {/if}
    {#if dash.data.current.nextCursor}
      <p>
        <a
          class="inline-block rounded-[9px] border border-line bg-panel px-3 py-2"
          href="/history?view=current"
          data-testid="view-all-current"
        >
          View all current work
        </a>
      </p>
    {/if}
  </section>
  <section class="mt-9">
    <h2 class="mb-3 text-xl">
      Cleanup needs attention <Badge tone="warn">{String(dash.data.overview.cleanupAttention)}</Badge>
    </h2>
    <p class="text-muted-ink">
      Failed cleanup and terminal runs whose resources are still pending appear here. Historical unknown cleanup is not treated as an active leak.
    </p>
    {#if dash.data.cleanup.tasks.length}
      {#each dash.data.cleanup.tasks as task (task.runId)}
        <TaskRow {task} now={clock.now} stale={dash.error !== null} />
      {/each}
    {:else}
      <div class="rounded-[14px] border border-dashed border-line p-8 text-center text-muted-ink">
        No cleanup needs attention.
      </div>
    {/if}
    {#if dash.data.cleanup.nextCursor}
      <p>
        <a
          class="inline-block rounded-[9px] border border-line bg-panel px-3 py-2"
          href="/history?view=cleanup"
          data-testid="view-all-cleanup"
        >
          View all cleanup exceptions
        </a>
      </p>
    {/if}
  </section>
{:else if dash.loading}
  <p class="text-muted-ink" aria-busy="true">Loading…</p>
{:else}
  <section class="max-w-[760px]">
    <span class="text-xs font-extrabold uppercase tracking-[0.16em] text-accent">Unavailable</span>
    <h1 class="my-1.5 mb-4 text-[clamp(1.6rem,3.2vw,2.35rem)] font-extrabold">
      We could not load the dashboard.
    </h1>
    <button
      type="button"
      class="cursor-pointer rounded-[9px] border border-line bg-panel px-3 py-2"
      onclick={dash.refresh}
    >
      Try again
    </button>
  </section>
{/if}
