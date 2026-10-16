<script lang="ts">
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import TaskRow from '#lib/components/TaskRow.svelte';
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

  let draft = $state({
    view: 'history' as View,
    status: 'all' as StatusFilter,
    cleanup: 'all' as CleanupFilter,
    from: '',
    to: '',
  });

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
        view: draft.view,
        status: draft.status,
        cleanup: draft.cleanup,
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
  <label class="field">
    View
    <select name="view" bind:value={draft.view} class="input">
      <option value="history">All history</option>
      <option value="current">Current work</option>
      <option value="cleanup">Cleanup attention</option>
    </select>
  </label>
  <label class="field">
    Outcome
    <select name="status" bind:value={draft.status} class="input">
      <option value="all">All outcomes</option>
      <option value="active">Queued or in progress</option>
      <option value="published">Published</option>
      <option value="failed">Failed</option>
      <option value="superseded">Superseded</option>
    </select>
  </label>
  <label class="field">
    Cleanup
    <select name="cleanup" bind:value={draft.cleanup} class="input">
      <option value="all">All cleanup</option>
      <option value="pending">Pending</option>
      <option value="destroyed">Cleaned up</option>
      <option value="failed">Failed</option>
      <option value="unknown">Not recorded</option>
    </select>
  </label>
  <label class="field">
    From (UTC)
    <input type="date" name="from" bind:value={draft.from} class="input" />
  </label>
  <label class="field">
    To (UTC)
    <input type="date" name="to" bind:value={draft.to} class="input" />
  </label>
  <button type="button" data-testid="apply" class="btn" onclick={apply}>Apply filters</button>
</section>

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
  <section>
    {#if dash.data.page.tasks.length}
      {#each dash.data.page.tasks as task (task.runId)}
        <TaskRow {task} now={clock.now} stale={dash.error !== null} />
      {/each}
    {:else}
      <div class="empty">No reviews match these filters.</div>
    {/if}
  </section>
  <div class="toolbar">
    {#if dash.data.page.nextCursor}
      <button
        type="button"
        data-testid="next-page"
        class="btn"
        onclick={() => older(dash.data?.page.nextCursor ?? '')}
      >
        Older runs
      </button>
    {:else}
      <span class="muted">End of history</span>
    {/if}
    {#if filters.cursor}
      <button type="button" data-testid="back-to-latest" class="btn" onclick={latest}>Back to latest</button>
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
      <button type="button" class="btn" onclick={dash.refresh}>Try again</button>
    </div>
  </section>
{/if}
