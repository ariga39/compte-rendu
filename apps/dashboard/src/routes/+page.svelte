<script lang="ts">
  let { data } = $props();
  import { Button, Column, Grid, Row } from 'carbon-components-svelte';
  import StatCard from '#lib/components/StatCard.svelte';
  import TaskDrawer from '#lib/components/TaskDrawer.svelte';
  import TaskTable from '#lib/components/TaskTable.svelte';
  import Toolbar from '#lib/components/Toolbar.svelte';
  import { createDashboard, createExpiryClock } from '#lib/dashboard.svelte.ts';
  import { absoluteTime } from '#lib/format.ts';
  import { buildOverview, identityDeadline, overviewActive } from '#lib/model.ts';
  import {
    closeTask,
    openTask,
    recordListScroll,
    restoreListPosition,
    selectedTaskId,
  } from '#lib/task-drawer.svelte.ts';
  import type { OverviewModel } from '#lib/types.ts';

  const dash = createDashboard<OverviewModel>({
    dehydrated: () => data.dehydrated,
    key: () => '/',
    urls: () => ['/api/dashboard'],
    build: (results, timing) => buildOverview(results, timing),
    isActive: (model) => overviewActive(model),
  });

  const clock = createExpiryClock();

  let selected = $derived(selectedTaskId());
  let taskIds = $derived(dash.data ? dash.data.current.tasks.map((task) => task.runId) : []);

  function closeDrawer() {
    closeTask();
  }

  let previousSelected: string | null = null;
  $effect(() => {
    const current = selectedTaskId();
    if (previousSelected === null && current !== null) recordListScroll();
    if (previousSelected !== null && current === null) restoreListPosition(previousSelected);
    previousSelected = current;
  });

  $effect(() => {
    const model = dash.data;
    if (!model) {
      clock.clear();
      return;
    }
    clock.schedule(model.current.tasks.map(identityDeadline));
  });
</script>

<header class="page-head">
  <h1 tabindex="-1" data-testid="list-heading">Overview</h1>
</header>

{#if dash.error && dash.data}
  <div role="alert" data-testid="error-notice" class="notice error">
    {dash.error === 'offline'
      ? 'You are offline. Updates will resume when you reconnect.'
      : 'Could not refresh reviews. Showing the last available data.'}
    <span class="muted">Last updated: {dash.lastGoodAt ? absoluteTime(new Date(dash.lastGoodAt).toISOString()) : 'not yet'}.</span>
    <Button size="small" on:click={dash.refresh}>Retry</Button>
  </div>
{/if}

<div class="list-detail" class:with-detail={selected !== null}>
  <div class="list-pane">
    {#if dash.data}
      <Toolbar lastGoodAt={dash.lastGoodAt} onRefresh={dash.refresh} />
      <section class="stats-grid" data-testid="stats">
        <Grid>
          <Row>
            <Column sm={2} md={2} lg={4}>
              <StatCard label="Queued" sub="Waiting to start" value={dash.data.overview.counts.queued} />
            </Column>
            <Column sm={2} md={2} lg={4}>
              <StatCard
                label="In progress"
                sub="Preparing, reviewing or publishing"
                value={dash.data.overview.counts.claimed}
              />
            </Column>
            <Column sm={2} md={2} lg={4}>
              <StatCard
                label="Published"
                sub="Received in the past 24 hours"
                value={dash.data.overview.counts.publishedLast24h}
              />
            </Column>
            <Column sm={2} md={2} lg={4}>
              <StatCard
                label="Failed"
                sub="Received in the past 24 hours"
                value={dash.data.overview.counts.failedLast24h}
              />
            </Column>
          </Row>
        </Grid>
      </section>
      <section>
        <h2 class="section-title">Current reviews</h2>
        {#if dash.data.current.tasks.length}
          <TaskTable
            tasks={dash.data.current.tasks}
            now={clock.now}
            stale={dash.error !== null}
            compact={selected !== null}
            selectedRunId={selected}
            onSelect={openTask}
          />
        {:else}
          <div class="empty">No reviews in progress or waiting.</div>
        {/if}
        {#if dash.data.current.nextCursor}
          <div class="toolbar">
            <a class="bx--btn bx--btn--tertiary" href="/history" data-testid="view-all-current">View all reviews</a>
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
          <Button size="small" on:click={dash.refresh}>Retry</Button>
        </div>
      </section>
    {/if}
  </div>
  {#if selected}
    <TaskDrawer runId={selected} {taskIds} onClose={closeDrawer} />
  {/if}
</div>
