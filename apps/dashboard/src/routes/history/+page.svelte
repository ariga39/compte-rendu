<script lang="ts">
  let { data } = $props();
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Button, Select, SelectItem } from 'carbon-components-svelte';
  import TaskDrawer from '#lib/components/TaskDrawer.svelte';
  import TaskTable from '#lib/components/TaskTable.svelte';
  import Toolbar from '#lib/components/Toolbar.svelte';
  import { createDashboard, createExpiryClock } from '#lib/dashboard.svelte.ts';
  import {
    buildFilterQuery,
    cleanHistorySearch,
    dateBound,
    historyRequestUrl,
    readFilters,
  } from '#lib/filters.ts';
  import { absoluteTime } from '#lib/format.ts';
  import { historyScroll } from '#lib/history-scroll.ts';
  import { buildHistory, historyActive, identityDeadline } from '#lib/model.ts';
  import {
    closeTask,
    openTask,
    recordListScroll,
    restoreListPosition,
    selectedTaskId,
  } from '#lib/task-drawer.svelte.ts';
  import type { HistoryModel, StatusFilter } from '#lib/types.ts';

  let search = $derived(page.url.search);
  let filters = $derived(readFilters(search));
  let selected = $derived(selectedTaskId());

  const dash = createDashboard<HistoryModel>({
    dehydrated: () => data.dehydrated,
    key: () => `/history${search}`,
    urls: () => [historyRequestUrl(search)],
    build: (results, timing) => buildHistory(results, timing),
    isActive: (model) => historyActive(model),
  });

  let taskIds = $derived(dash.data ? dash.data.page.tasks.map((task) => task.runId) : []);

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

  let pendingRestore = $state<number | null>(null);

  beforeNavigate((navigation) => {
    const from = navigation.from?.url;
    if (from && from.pathname === '/history') {
      historyScroll.set(from.search, window.scrollY);
    }
  });

  afterNavigate((navigation) => {
    if (navigation.type === 'popstate' && page.url.pathname === '/history') {
      const saved = historyScroll.get(page.url.search);
      if (saved != null) pendingRestore = saved;
    }
  });

  $effect(() => {
    if (pendingRestore == null || !dash.data) return;
    const target = pendingRestore;
    pendingRestore = null;
    requestAnimationFrame(() => window.scrollTo(0, target));
  });

  const clock = createExpiryClock();

  let draft = $state({ status: 'all', from: '', to: '' });

  $effect(() => {
    const model = dash.data;
    if (!model) {
      clock.clear();
      return;
    }
    clock.schedule(model.page.tasks.map(identityDeadline));
  });

  $effect(() => {
    draft = {
      status: filters.status,
      from: filters.fromDate ?? '',
      to: filters.toDate ?? '',
    };
  });

  $effect(() => {
    const clean = cleanHistorySearch(search);
    if (clean !== search.replace(/^\?/, '')) {
      void goto(`/history${clean ? `?${clean}` : ''}`, { replaceState: true });
    }
  });

  function apply() {
    const query = buildFilterQuery(
      {
        status: draft.status as StatusFilter,
        from: dateBound(draft.from || null, 'start'),
        to: dateBound(draft.to || null, 'end'),
        fromDate: null,
        toDate: null,
        cursor: null,
      },
      false,
    );
    void goto(`/history${query ? `?${query}` : ''}`);
  }

  function latest() {
    const query = buildFilterQuery({ ...filters, cursor: null }, false);
    void goto(`/history${query ? `?${query}` : ''}`);
  }

  function older(cursor: string) {
    void goto(`/history?${buildFilterQuery({ ...filters, cursor }, true)}`);
  }
</script>

<header class="page-head">
  <h1>Review history</h1>
  {#if dash.data}
    <Toolbar lastGoodAt={dash.lastGoodAt} onRefresh={dash.refresh} />
  {/if}
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
    <section class="filter-bar">
      <Select name="status" bind:selected={draft.status} labelText="Status">
        <SelectItem value="all" text="All statuses" />
        <SelectItem value="queued" text="Queued" />
        <SelectItem value="in_progress" text="In progress" />
        <SelectItem value="published" text="Published" />
        <SelectItem value="failed" text="Failed" />
        <SelectItem value="superseded" text="Superseded" />
      </Select>
      <div class="bx--form-item">
        <label class="bx--label" for="filter-from">From (UTC)</label>
        <input id="filter-from" class="bx--text-input" type="date" name="from" bind:value={draft.from} />
      </div>
      <div class="bx--form-item">
        <label class="bx--label" for="filter-to">To (UTC)</label>
        <input id="filter-to" class="bx--text-input" type="date" name="to" bind:value={draft.to} />
      </div>
      <Button size="field" data-testid="apply" on:click={apply}>Apply filters</Button>
    </section>

    {#if dash.data}
      <section>
        {#if dash.data.page.tasks.length}
          <TaskTable
            tasks={dash.data.page.tasks}
            now={clock.now}
            stale={dash.error !== null}
            compact={selected !== null}
            selectedRunId={selected}
            onSelect={openTask}
          />
        {:else}
          <div class="empty">No reviews match these filters.</div>
        {/if}
      </section>
      <div class="toolbar">
        {#if dash.data.page.nextCursor}
          <Button
            size="small"
            data-testid="next-page"
            on:click={() => older(dash.data?.page.nextCursor ?? '')}
          >
            Older runs
          </Button>
        {:else}
          <span class="muted">End of history</span>
        {/if}
        {#if filters.cursor}
          <Button size="small" data-testid="back-to-latest" on:click={latest}>Back to latest</Button>
        {/if}
      </div>
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
