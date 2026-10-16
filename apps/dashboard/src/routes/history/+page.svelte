<script lang="ts">
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Button, Select, SelectItem } from 'carbon-components-svelte';
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
  import type { CleanupFilter, HistoryModel, StatusFilter, View } from '#lib/types.ts';

  let search = $derived(page.url.search);
  let filters = $derived(readFilters(search));

  const dash = createDashboard<HistoryModel>({
    key: () => `/history${search}`,
    urls: () => [historyRequestUrl(search)],
    build: (results, timing) => buildHistory(results, timing),
    isActive: (model) => historyActive(model),
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

  let draft = $state({ view: 'history', status: 'all', cleanup: 'all', from: '', to: '' });

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
      view: filters.view,
      status: filters.status,
      cleanup: filters.cleanup,
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
        view: draft.view as View,
        status: draft.status as StatusFilter,
        cleanup: draft.cleanup as CleanupFilter,
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
</header>

<section class="filter-bar">
  <Select name="view" bind:selected={draft.view} labelText="View">
    <SelectItem value="history" text="All history" />
    <SelectItem value="current" text="Current reviews" />
    <SelectItem value="cleanup" text="Cleanup attention" />
  </Select>
  <Select name="status" bind:selected={draft.status} labelText="Outcome">
    <SelectItem value="all" text="All outcomes" />
    <SelectItem value="active" text="Queued or in progress" />
    <SelectItem value="published" text="Published" />
    <SelectItem value="failed" text="Failed" />
    <SelectItem value="superseded" text="Superseded" />
  </Select>
  <Select name="cleanup" bind:selected={draft.cleanup} labelText="Cleanup">
    <SelectItem value="all" text="All cleanup" />
    <SelectItem value="pending" text="Pending" />
    <SelectItem value="destroyed" text="Cleaned up" />
    <SelectItem value="failed" text="Failed" />
    <SelectItem value="unknown" text="Not recorded" />
  </Select>
  <div class="bx--form-item">
    <label class="bx--label" for="filter-from">From (UTC)</label>
    <input id="filter-from" class="bx--text-input" type="date" name="from" bind:value={draft.from} />
  </div>
  <div class="bx--form-item">
    <label class="bx--label" for="filter-to">To (UTC)</label>
    <input id="filter-to" class="bx--text-input" type="date" name="to" bind:value={draft.to} />
  </div>
  <Button size="small" data-testid="apply" on:click={apply}>Apply filters</Button>
</section>

{#if dash.error}
  <div role="alert" data-testid="error-notice" class="notice error">
    {dash.error === 'offline'
      ? 'You are offline. Updates will resume when you reconnect.'
      : 'Could not refresh reviews. Showing the last available data.'}
    <span class="muted">Last updated: {dash.lastGoodAt ? absoluteTime(new Date(dash.lastGoodAt).toISOString()) : 'not yet'}.</span>
    <Button size="small" on:click={dash.refresh}>Retry</Button>
  </div>
{/if}

{#if dash.data}
  <Toolbar lastGoodAt={dash.lastGoodAt} onRefresh={dash.refresh} />
  <section>
    {#if dash.data.page.tasks.length}
      <TaskTable tasks={dash.data.page.tasks} now={clock.now} stale={dash.error !== null} />
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
      <Button size="small" on:click={dash.refresh}>Try again</Button>
    </div>
  </section>
{/if}
