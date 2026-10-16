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

<section class="mb-7 max-w-[760px]">
  <span class="text-xs font-extrabold uppercase tracking-[0.16em] text-accent">Durable history</span>
  <h1 class="my-1.5 mb-4 text-[clamp(1.6rem,3.2vw,2.35rem)] font-extrabold leading-tight tracking-[-0.03em]">Every admitted run.</h1>
  <p class="text-muted-ink">Newest first. Filters stay in the URL; changing one returns to the latest page.</p>
</section>

<section class="my-2.5 rounded-[14px] border border-line bg-gradient-to-br from-panel to-[#111820] p-[18px]">
  <div class="flex flex-wrap items-end gap-2.5">
    <label class="grid gap-1 text-xs text-muted-ink">
      View
      <select
        name="view"
        bind:value={draft.view}
        class="rounded-[9px] border border-line bg-panel px-3 py-2 text-ink"
      >
        <option value="history">All history</option>
        <option value="current">Current work</option>
        <option value="cleanup">Cleanup attention</option>
      </select>
    </label>
    <label class="grid gap-1 text-xs text-muted-ink">
      Outcome
      <select
        name="status"
        bind:value={draft.status}
        class="rounded-[9px] border border-line bg-panel px-3 py-2 text-ink"
      >
        <option value="all">All outcomes</option>
        <option value="active">Active</option>
        <option value="published">Published</option>
        <option value="failed">Failed</option>
        <option value="superseded">Superseded</option>
      </select>
    </label>
    <label class="grid gap-1 text-xs text-muted-ink">
      Cleanup
      <select
        name="cleanup"
        bind:value={draft.cleanup}
        class="rounded-[9px] border border-line bg-panel px-3 py-2 text-ink"
      >
        <option value="all">All cleanup</option>
        <option value="pending">Pending</option>
        <option value="destroyed">Destroyed</option>
        <option value="failed">Failed</option>
        <option value="unknown">Unknown</option>
      </select>
    </label>
    <label class="grid gap-1 text-xs text-muted-ink">
      From
      <input
        type="date"
        name="from"
        bind:value={draft.from}
        class="rounded-[9px] border border-line bg-panel px-3 py-2 text-ink"
      />
    </label>
    <label class="grid gap-1 text-xs text-muted-ink">
      To
      <input
        type="date"
        name="to"
        bind:value={draft.to}
        class="rounded-[9px] border border-line bg-panel px-3 py-2 text-ink"
      />
    </label>
    <button
      type="button"
      data-testid="apply"
      class="cursor-pointer rounded-[9px] border border-line bg-panel px-3 py-2 text-ink hover:border-accent"
      onclick={apply}
    >
      Apply filters
    </button>
  </div>
</section>

{#if dash.error}
  <div
    role="alert"
    data-testid="error-notice"
    class="my-[18px] rounded-xl border border-[#75464b] bg-[#111923] px-4 py-3 text-danger"
  >
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
  <p class="my-3.5 text-sm text-muted-ink">
    A row can leave an active-only filter after it completes. Older pages keep the same cursor.
  </p>
  <section>
    {#if dash.data.page.tasks.length}
      {#each dash.data.page.tasks as task (task.runId)}
        <TaskRow {task} now={clock.now} stale={dash.error !== null} />
      {/each}
    {:else}
      <div class="rounded-[14px] border border-dashed border-line p-8 text-center text-muted-ink">
        No runs match these filters.
      </div>
    {/if}
  </section>
  <div class="my-[18px] flex flex-wrap items-end justify-between gap-2.5">
    {#if dash.data.page.nextCursor}
      <button
        type="button"
        data-testid="next-page"
        class="cursor-pointer rounded-[9px] border border-line bg-panel px-3 py-2 text-ink"
        onclick={() => older(dash.data?.page.nextCursor ?? '')}
      >
        Older runs
      </button>
    {:else}
      <span class="text-muted-ink">End of history</span>
    {/if}
    {#if filters.cursor}
      <button
        type="button"
        data-testid="back-to-latest"
        class="cursor-pointer rounded-[9px] border border-line bg-panel px-3 py-2 text-ink"
        onclick={latest}
      >
        Back to latest
      </button>
    {/if}
  </div>
{:else if dash.error === 'notfound'}
  <section class="max-w-[760px]">
    <span class="text-xs font-extrabold uppercase tracking-[0.16em] text-accent">Not found</span>
    <h1 class="my-1.5 mb-4 text-[clamp(1.6rem,3.2vw,2.35rem)] font-extrabold">Page not found</h1>
    <p class="text-muted-ink">This dashboard address does not identify a page.</p>
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
